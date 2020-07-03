'use strict';

import * as functions from 'firebase-functions'
import * as admin from "firebase-admin";
import * as requestPromise from "request-promise-native";
import {getTokenData} from "../service-tokens";
import {
    generateIDFromParts,
    getUserIDFromFirebaseToken,
    isCorsAllowed,
    setAccessControlHeadersOnResponse
} from "../utils";
import {ServiceNames} from "@sports-alliance/sports-lib/lib/meta-data/meta-data.interface";
import { UserServiceMetaInterface } from '@sports-alliance/sports-lib/lib/users/user.service.meta.interface';
import { SuuntoAppWorkoutQueueItemInterface } from '../queue/queue-item.interface';


const BATCH_SIZE = 450;

/**
 * Add to the workout queue the workouts of a user for a selected date range
 */
export const addSuuntoAppHistoryToQueue = functions.region('europe-west2').https.onRequest(async (req, res) => {
  // Directly set the CORS header
  if (!isCorsAllowed(req) || (req.method !== 'OPTIONS' && req.method !== 'POST')) {
    console.error(`Not allowed`);
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

  const userID = await getUserIDFromFirebaseToken(req);
  if (!userID){
    res.status(403).send('Unauthorized');
    return;
  }



  const startDate = new Date(req.body.startDate);
  const endDate = new Date(req.body.endDate);

  // First check last history import
  const userServiceMetaDocumentSnapshot = await admin.firestore().collection('users').doc(userID).collection('meta').doc(ServiceNames.SuuntoApp).get();
  if (userServiceMetaDocumentSnapshot.exists) {
    const data = <UserServiceMetaInterface>userServiceMetaDocumentSnapshot.data();
    const nextHistoryImportAvailableDate = new Date(data.didLastHistoryImport + ((data.processedActivitiesFromLastHistoryImportCount / 500) * 24 * 60 * 60 * 1000));   // 7 days for  285,7142857143 per day
    if ((nextHistoryImportAvailableDate > new Date()) && data.processedActivitiesFromLastHistoryImportCount !== 0) {
      console.error(`User ${userID} tried todo history import while not allowed`);
      res.status(403);
      res.send(`History import cannot happen before ${nextHistoryImportAvailableDate}`);
      return
    }
  }

  const tokenQuerySnapshots = await admin.firestore().collection('suuntoAppAccessTokens').doc(userID).collection('tokens').get();

  console.log(`Found ${tokenQuerySnapshots.size} tokens for user ${userID}`);

  // Get the history for those tokens
  let totalProcessedWorkoutsCount = 0;
  let processedBatchesCount = 0;
  for (const tokenQueryDocumentSnapshot of tokenQuerySnapshots.docs) {

    let serviceToken;
    try {
      serviceToken = await getTokenData(tokenQueryDocumentSnapshot, false);
    }catch (e) {
      console.error(`Refreshing token failed skipping this token with id ${tokenQueryDocumentSnapshot.id}`);
      res.status(500);
      res.send();
      return;
    }

    let result: any;
    try {
      result = await requestPromise.get({
        headers: {
          'Authorization': serviceToken.accessToken,
          'Ocp-Apim-Subscription-Key': functions.config().suuntoapp.subscription_key,
          json: true,
        },
        url: `https://cloudapi.suunto.com/v2/workouts?since=${startDate.getTime()}&until=${endDate.getTime()}&limit=1000000`,
      });
      result = JSON.parse(result);
      // console.log(`Deauthorized token ${doc.id} for ${userID}`)
    } catch (e) {
      console.error(`Could not get history for token ${tokenQueryDocumentSnapshot.id} for user ${userID}`, e);
      res.status(500);
      res.send();
      return;
    }

    if (result.error !== null) {
      console.error(`Could not get history for token ${tokenQueryDocumentSnapshot.id} for user ${userID} due to service error`, result.error);
      res.status(500);
      res.send();
      return;
    }

    // Filter on dates
    result.payload = result.payload.filter((activity: any) => (new Date(activity.startTime)) >= startDate &&  (new Date(activity.startTime)) <= endDate)

    if (result.payload.length === 0) {
      console.log(`No workouts to add to history for token ${tokenQueryDocumentSnapshot.id} for user ${userID}`);
      continue;
    }

    console.log(`Found ${result.payload.length} workouts for the dates of ${startDate} to ${endDate} for token ${tokenQueryDocumentSnapshot.id} for user ${userID}`);

    const batchCount = Math.ceil(result.payload.length / BATCH_SIZE);
    const batchesToProcess: any[] = [];
    (Array(batchCount)).fill(null).forEach((justNull, index) => {
      const start = index * BATCH_SIZE;
      const end = (index + 1) * BATCH_SIZE;
      batchesToProcess.push(result.payload.slice(start, end))
    });

    console.log(`Created ${batchCount} batches for token ${tokenQueryDocumentSnapshot.id} for user ${userID}`);
    for (const batchToProcess of batchesToProcess) {
      const batch = admin.firestore().batch();
      let processedWorkoutsCount = 0;
      for (const payload of batchToProcess) {
        // Maybe do a get or insert it at another queue
        batch.set(admin.firestore().collection('suuntoAppWorkoutQueue').doc(generateIDFromParts([serviceToken.userName, payload.workoutKey])),
          <SuuntoAppWorkoutQueueItemInterface>{
            userName: serviceToken.userName,
            workoutID: payload.workoutKey,
            retryCount: 0, // So it can be re-processed
            processed: false, //So it can be re-processed
          });
        processedWorkoutsCount++;
      }
      // Try to commit it
      try {
        processedBatchesCount++;
        totalProcessedWorkoutsCount += processedWorkoutsCount;
        batch.set(
          admin.firestore().collection('users').doc(userID).collection('meta').doc(ServiceNames.SuuntoApp),
          <UserServiceMetaInterface>{
            didLastHistoryImport: (new Date()).getTime(),
            processedActivitiesFromLastHistoryImportCount: totalProcessedWorkoutsCount,
          }, {merge: true});

        await batch.commit();
        console.log(`Batch #${processedBatchesCount} with ${processedWorkoutsCount} activities saved for token ${tokenQueryDocumentSnapshot.id} and user ${userID} `);

      } catch (e) {
        console.error(`Could not save batch ${processedBatchesCount} for token ${tokenQueryDocumentSnapshot.id} and user ${userID} due to service error aborting`, e);
        processedBatchesCount--;
        totalProcessedWorkoutsCount -= processedWorkoutsCount;
        continue; // Unnecessary but clear to the user that it will continue
      }
    }
    console.log(`${processedBatchesCount} out of ${batchesToProcess.length} processed and saved for token ${tokenQueryDocumentSnapshot.id} and user ${userID} `);
  }

  console.log(`${totalProcessedWorkoutsCount} workouts via ${processedBatchesCount} batches added to queue for user ${userID}`);
  // @todo make sure all went fine else return error

  // Respond
  res.status(200);
  res.send({result: 'History items added to queue'});

});
