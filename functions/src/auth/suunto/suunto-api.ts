'use strict';

import * as functions from 'firebase-functions'
import * as cookieParser from "cookie-parser";
import * as crypto from "crypto";
import * as admin from "firebase-admin";
import {generateIDFromParts} from "../../utils";
import {Request} from "firebase-functions/lib/providers/https";
import * as requestPromise from "request-promise-native";
import {suuntoApiAuth} from "./suunto-api-auth";
import {getTokenData} from "../../service-tokens";
import { ServiceNames } from '@sports-alliance/sports-lib/lib/meta-data/meta-data.interface';
import { ServiceTokenInterface } from '@sports-alliance/sports-lib/lib/service-tokens/service-token.interface';


// const OAUTH_REDIRECT_PATH = `https://${process.env.GCLOUD_PROJECT}.firebaseapp.com/popup.html`;
const OAUTH_SCOPES = 'workout';

// const OAUTH_CALLBACK_PATH = '/authPopup.html';

// Path to the OAuth handlers.
// const OAUTH_REDIRECT_URI_LOCALHOST = `http://localhost:4200/assets/authPopup.html`;
// const OAUTH_REDIRECT_URI_BETA = `https://beta.quantified-self.io/assets/authPopup.html`;
// const OAUTH_REDIRECT_URI = `https://quantified-self.io/assets/authPopup.html`;


/**
 * Redirects the User to the authentication consent screen. Also the 'state' cookie is set for later state
 * verification.
 */
export const authRedirect = functions.region('europe-west2').https.onRequest(async (req, res) => {
  const oauth2 = suuntoApiAuth();
  const state = req.cookies ? req.cookies.state : crypto.randomBytes(20).toString('hex');
  const signInWithService = req.query.signInWithService === 'true';
  console.log('Setting state cookie for verification:', state);
  const requestHost = req.get('host');
  let secureCookie = true;
  if (requestHost && requestHost.indexOf('localhost:') === 0) {
    secureCookie = false;
  }
  console.log('Need a secure cookie (i.e. not on localhost)?', secureCookie);
  res.cookie('state', state, {maxAge: 3600000, secure: secureCookie, httpOnly: true});
  res.cookie('signInWithService', signInWithService, {maxAge: 3600000, secure: secureCookie, httpOnly: true});
  const redirectUri = oauth2.authorizationCode.authorizeURL({
    redirect_uri: determineRedirectURI(req),
    scope: OAUTH_SCOPES,
    state: state
  });
  console.log('Redirecting to:', redirectUri);
  res.redirect(redirectUri);
});
/**
 * Exchanges a given auth code passed in the 'code' URL query parameter for a Firebase auth token.
 * The request also needs to specify a 'state' query parameter which will be checked against the 'state' cookie.
 * The Firebase custom auth token, display name, photo URL and Suunto app acces token are sent back in a JSONP callback
 * function with function name defined by the 'callback' query parameter.
 */
export const authToken = functions.region('europe-west2').https.onRequest(async (req, res) => {
  const oauth2 = suuntoApiAuth();
  cookieParser()(req, res, async () => {
    try {
      const currentDate = new Date();
      const signInWithService = req.cookies.signInWithService === 'true';
      console.log('Should sign in:', signInWithService);
      console.log('Received verification state:', req.cookies.state);
      console.log('Received state:', req.query.state);
      // if (!req.cookies.state) {
      //   throw new Error('State cookie not set or expired. Maybe you took too long to authorize. Please try again.');
      // } else if (req.cookies.state !== req.query.state) {
      //   throw new Error('State validation failed');
      // }

      console.log('Received auth code:', req.query.code);
      const results = await oauth2.authorizationCode.getToken({
        code: String(req.query.code),
        redirect_uri: determineRedirectURI(req), // @todo fix,
      });

      // console.log('Auth code exchange result received:', results);

      // We have an access token and the user identity now.
      const accessToken = results.access_token;
      const suuntoAppUserName = results.user;

      // Create a Firebase account and get the Custom Auth Token.
      let firebaseToken;
      if (signInWithService) {
        firebaseToken = await createFirebaseAccount(suuntoAppUserName, accessToken);
      }
      return res.jsonp({
        firebaseAuthToken: firebaseToken,
        serviceAuthResponse: <ServiceTokenInterface>{
          accessToken: results.access_token,
          refreshToken: results.refresh_token,
          tokenType: results.token_type,
          expiresAt: currentDate.getTime() + (results.expires_in * 1000),
          scope: results.scope,
          userName: results.user,
          dateCreated: currentDate.getTime(),
          dateRefreshed: currentDate.getTime(),
        },
        serviceName: ServiceNames.SuuntoApp
      });
    } catch (error) {
      return res.jsonp({
        error: error.toString(),
      });
    }
  });
});

/**
 * Deauthorizes a Suunto app account upon user request
 */
export const deauthorize = functions.region('europe-west2').https.onRequest(async (req, res) => {
  // Directly set the CORS header
  if (!isCorsAllowed(req) || (req.method !== 'OPTIONS' && req.method !== 'POST')) {
    console.error(`Not allowed `)
    res.status(403);
    res.send();
    return
  }

  setAccessControlHeadersOnResponse(req, res);

  if (req.method === 'OPTIONS') {
    res.status(200);
    res.send();
    return;
  }

  if (!req.headers.authorization) {
    console.error(`No authorization'`);
    res.status(403);
    res.send();
    return
  }

  let decodedIdToken;
  try {
    decodedIdToken = await admin.auth().verifyIdToken(req.headers.authorization);
  } catch (e) {
    console.error(e);
    console.error(`Could not verify user token aborting operation`);
    res.status(500);
    res.send();
    return;
  }

  if (!decodedIdToken) {
    console.error(`Could not verify and decode token`);
    res.status(500);
    res.send();
    return;
  }

  const tokenQuerySnapshots = await admin.firestore().collection('suuntoAppAccessTokens').doc(decodedIdToken.uid).collection('tokens').get();

  console.log(`Found ${tokenQuerySnapshots.size} tokens for user ${decodedIdToken.uid}`);

  // Deauthorize all tokens for that user
  for (const tokenQueryDocumentSnapshot of tokenQuerySnapshots.docs) {

    let serviceToken;
    try {
      serviceToken = await getTokenData(tokenQueryDocumentSnapshot, true);
    } catch (e) {
      console.error(`Refreshing token failed skipping this token with id ${tokenQueryDocumentSnapshot.id}`);
      continue
    }

    try {
      await requestPromise.get({
        headers: {
          'Authorization': `Bearer ${serviceToken.accessToken}`,
        },
        url: `https://cloudapi-oauth.suunto.com/oauth/deauthorize?client_id=${functions.config().suuntoapp.client_id}`,
      });
      console.log(`Deauthorized token ${tokenQueryDocumentSnapshot.id} for ${decodedIdToken.uid}`)
    } catch (e) {
      console.error(e);
      console.error(`Could not deauthorize token ${tokenQueryDocumentSnapshot.id} for ${decodedIdToken.uid}`);
      res.status(500);
      res.send({result: 'Could not deauthorize'});
      return;
    }

    // Now get from all users the same username token
    // Note this will return the current doc as well
    const otherUsersTokensQuerySnapshot = await admin.firestore().collectionGroup('tokens').where("userName", "==", serviceToken.userName).get();

    console.log(`Found ${otherUsersTokensQuerySnapshot.size} tokens for token username ${serviceToken.userName}`);

    try {
      for (const otherUserQueryDocumentSnapshot of otherUsersTokensQuerySnapshot.docs) {
        await otherUserQueryDocumentSnapshot.ref.delete();
        console.log(`Deleted token ${otherUserQueryDocumentSnapshot.id}`);
      }
    } catch (e) {
      console.error(e);
      console.error(`Could not delete token ${tokenQueryDocumentSnapshot.id} for ${decodedIdToken.uid}`);
      res.status(500);
      res.send({result: 'Could not delete token'});
      return;
    }
    console.log(`Deleted successfully token ${tokenQueryDocumentSnapshot.id} for ${decodedIdToken.uid}`);
  }

  res.status(200);
  res.send({result: 'Deauthorized'});

});


/**
 * Creates a Firebase account with the given user profile and returns a custom auth token allowing
 * signing-in this account.
 *
 * @returns {Promise<string>} The Firebase custom auth token in a promise.
 */
async function createFirebaseAccount(serviceUserID: string, accessToken: string) {
  // The UID we'll assign to the user.
  const uid = generateIDFromParts(['suuntoApp', serviceUserID]);

  // Save the access token to the Firestore
  // const databaseTask  = admin.firestore().collection('suuntoAppAccessTokens').doc(`${uid}`).set({accessToken: accessToken});

  // Create or update the user account.
  try {
    await admin.auth().updateUser(uid, {
      displayName: serviceUserID,
      // photoURL: photoURL,
    })
  } catch (e) {
    if (e.code === 'auth/user-not-found') {
      await admin.auth().createUser({
        uid: uid,
        displayName: serviceUserID,
        // photoURL: photoURL,
      });
    }
  }
  // Create a Firebase custom auth token.
  const token = await admin.auth().createCustomToken(uid);
  console.log('Created Custom token for UID "', uid, '" Token:', token);
  return token;
}

export function determineRedirectURI(req: Request): string {
  return String(req.query.redirect_uri); // @todo should check for authorized redirects as well
}

export function setAccessControlHeadersOnResponse(req: Request, res: functions.Response) {
  res.set('Access-Control-Allow-Origin', `${req.get('origin')}`);
  res.set('Access-Control-Allow-Methods', 'POST');
  res.set('Access-Control-Allow-Headers', 'origin, content-type, accept, authorization');
  return res;
}

export function isCorsAllowed(req: Request) {
  return ['http://localhost:4200', 'https://quantified-self.io', 'https://beta.quantified-self.io'].indexOf(<string>req.get('origin')) !== -1
}
