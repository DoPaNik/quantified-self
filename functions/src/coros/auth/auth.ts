import * as functions from "firebase-functions";
import { AuthorizationCode } from "simple-oauth2";
import { PRODUCTION_URL, STAGING_URL, USE_STAGING } from '../constants';


const ACCESS_TOKEN_PATH = `/oauth2/accesstoken`;
// @todo move this else
const REFRESH_TOKEN_PATH = `/oauth2/refresh-token?client_id=${functions.config().corosapi.client_id}&client_secret=${functions.config().corosapi.client_secret}`
/**
 * Creates a configured simple-oauth2 client for COROS API
 */
export function COROSAPIAuth(refresh = false): AuthorizationCode {
  // COROS API OAuth 2 setup
  return new AuthorizationCode({
    client: {
      id: functions.config().corosapi.client_id,
      secret: functions.config().corosapi.client_secret,
    },
    auth: {
      tokenHost: USE_STAGING ? STAGING_URL : PRODUCTION_URL,
      // tokenPath: '/oauth2/token',
      authorizePath: '/oauth2/authorize',
      tokenPath: refresh ? REFRESH_TOKEN_PATH : ACCESS_TOKEN_PATH
    },
    options: {
      // authorizationMethod: 'body',
    },
  });
}
