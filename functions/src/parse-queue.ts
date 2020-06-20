'use strict';

import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import * as requestPromise from "request-promise-native";
import {EventImporterFIT} from "@sports-alliance/sports-lib/lib/events/adapters/importers/fit/importer.fit";
import {EventInterface} from "@sports-alliance/sports-lib/lib/events/event.interface";
import * as Pako from "pako";
import {generateIDFromParts} from "./utils";
import {MetaData} from "@sports-alliance/sports-lib/lib/meta-data/meta-data";
import {ServiceNames} from "@sports-alliance/sports-lib/lib/meta-data/meta-data.interface";
import {getTokenData} from "./service-tokens";
import {QueueItemInterface} from "@sports-alliance/sports-lib/lib/queue-item/queue-item.interface";


const TIMEOUT_IN_SECONDS = 540;
const RETRY_COUNT = 10;
const LIMIT = 200;
const MEMORY = "2GB";

export const parseQueue = functions.region('europe-west2').runWith({timeoutSeconds: TIMEOUT_IN_SECONDS, memory: MEMORY }).pubsub.schedule('every 20 minutes').onRun(async (context) => {
  // @todo add queue item sort date for creation
  const querySnapshot = await admin.firestore().collection('suuntoAppWorkoutQueue').where('processed', '==', false).where("retryCount", "<", RETRY_COUNT).limit(LIMIT).get(); // Max 10 retries
  console.log(`Found ${querySnapshot.size} queue items to process`);
  let count = 0;
  for (const queueItem of querySnapshot.docs) {
    try {
      await processQueueItem(queueItem);
      count++;
      console.log(`Parsed queue item ${count}/${querySnapshot.size} and id ${queueItem.id}`)
    } catch (e) {
      console.error(e);
      console.error(new Error(`Error parsing queue item #${count} of ${querySnapshot.size} and id ${queueItem.id}`))
    }
  }
  console.log(`Parsed ${count} queue items out of ${querySnapshot.size}`);
});

export async function processQueueItem(queueItem: any) {

  console.log(`Processing queue item ${queueItem.id} and username ${queueItem.data().userName} at retry count ${queueItem.data().retryCount}`);
  // queueItem.data() is never undefined for query queueItem snapshots
  const tokenQuerySnapshots = await admin.firestore().collectionGroup('tokens').where("userName", "==", queueItem.data()['userName']).get();

  // If there is no token for the user skip @todo or retry in case the user reconnects?
  if (!tokenQuerySnapshots.size) {
    console.error(`No token found for queue item ${queueItem.id} and username ${queueItem.data().userName} increasing count just in case`);
    return increaseRetryCountForQueueItem(queueItem, new Error(`No tokens found`));
  }

  let processedCount = 0;
  for (const tokenQueryDocumentSnapshot of tokenQuerySnapshots.docs) {

    let serviceToken;

    // So if 2 tokens exist for 1 queue item then it will
    // IF refresh fails it will go and try to import the for the next token
    // If import fails for the next token it will increase count (fail ) and try from start.
    try {
      serviceToken = await getTokenData(tokenQueryDocumentSnapshot);
    }catch (e) {
      console.error(e);
      console.error(new Error(`Refreshing token failed skipping this token with id ${tokenQueryDocumentSnapshot.id}`));
      continue
    }

    const parent1 = tokenQueryDocumentSnapshot.ref.parent;
    if (!parent1) {
      throw new Error(`No parent found for ${tokenQueryDocumentSnapshot.id}`);
    }
    const parentID = parent1.parent!.id;

    console.log(`Found user id ${parentID} for queue item ${queueItem.id} and username ${queueItem.data().userName}`);

    let result;
    try {
      console.time('DownloadFit');
      result = await requestPromise.get({
        headers: {
          'Authorization': serviceToken.accessToken,
          'Ocp-Apim-Subscription-Key': functions.config().suuntoapp.subscription_key,
        },
        encoding: null,
        url: `https://cloudapi.suunto.com/v2/workout/exportFit/${queueItem.data()['workoutID']}`,
      });
      console.timeEnd('DownloadFit');
      console.log(`Downloaded FIT file for ${queueItem.id} and token user ${serviceToken.userName}`)
    } catch (e) {
      if (e.statusCode === 403){
        console.error(new Error(`Could not get workout for ${queueItem.id} and token user ${serviceToken.userName} due to 403, increasing retry by 20`))
        await increaseRetryCountForQueueItem(queueItem, e, 20);
        continue;
      }
      if (e.statusCode === 500){
        console.error(new Error(`Could not get workout for ${queueItem.id} and token user ${serviceToken.userName} due to 500 increasing retry by 20`))
        await increaseRetryCountForQueueItem(queueItem, e, 20);
        continue;
      }
      // @todo -> Update to max retry if 403 not found that happens quite often.
      console.error(new Error(`Could not get workout for ${queueItem.id} and token user ${serviceToken.userName}. Trying to refresh token and update retry count from ${queueItem.data().retryCount} to ${queueItem.data().retryCount + 1} -> ${e.message}`));
      await increaseRetryCountForQueueItem(queueItem, e);
      continue;
    }

    try {
      const event = await EventImporterFIT.getFromArrayBuffer(result);
      event.name = event.startDate.toJSON(); // @todo improve
      console.log(`Created Event from FIT file of ${queueItem.id} and token user ${serviceToken.userName} test`);
      // Id for the event should be serviceName + workoutID
      const metaData = new MetaData(ServiceNames.SuuntoApp, queueItem.data()['workoutID'], queueItem.data()['userName'], new Date());
      // @todo move metadata to its own document for firestore read/write rules
      await setEvent(parentID, generateIDFromParts(['suuntoApp', queueItem.data()['workoutID']]), event, metaData);
      console.log(`Created Event ${event.getID()} for ${queueItem.id} user id ${parentID} and token user ${serviceToken.userName} test`);
      processedCount++;
      console.log(`Parsed ${processedCount}/${tokenQuerySnapshots.size} for ${queueItem.id}`);
      // await queueItem.ref.delete();
    } catch (e) {
      // @todo should delete event  or separate catch
      console.error(e);
      console.error(new Error(`Could not save event for ${queueItem.id} trying to update retry count from ${queueItem.data().retryCount} and token user ${serviceToken.userName} to ${queueItem.data().retryCount + 1}`));
      await increaseRetryCountForQueueItem(queueItem, e);
      continue;
    }
  }

  if (processedCount !== tokenQuerySnapshots.size) {
    console.error(new Error(`Could not process all tokens for ${queueItem.id} will try again later. Processed ${processedCount}`));
    return;
  }

  // For each ended so we can set it to processed
  return updateToProcessed(queueItem);

}

async function increaseRetryCountForQueueItem(queueItem: any, error: Error, incrementBy = 1) {
  const data: QueueItemInterface = queueItem.data();
  data.retryCount += incrementBy;
  data.totalRetryCount = (data.totalRetryCount + incrementBy) || incrementBy;
  data.errors = data.errors || [];
  data.errors.push({
    error: error.message,
    atRetryCount: data.totalRetryCount,
    date: (new Date()).getTime(),
  });

  try {
    await queueItem.ref.update(JSON.parse(JSON.stringify(data)));
    console.info(`Updated retry count for ${queueItem.id} to ${data.retryCount + incrementBy}`);
  } catch (e) {
    console.error(new Error(`Could not update retry count on ${queueItem.id}`))
  }
}

async function updateToProcessed(queueItem: any) {
  try {
    await queueItem.ref.update({
      'processed': true,
      'processedAt': (new Date()).getTime(),
    });
    console.log(`Updated to processed  ${queueItem.id}`);
  } catch (e) {
    console.error(new Error(`Could not update processed state for ${queueItem.id}`));
  }
}

async function setEvent(userID: string, eventID:string , event: EventInterface, metaData: MetaData) {
  const writePromises: Promise<any>[] = [];
  event.setID(eventID);
  event.getActivities()
    .forEach((activity, index) => {
      activity.setID(generateIDFromParts([<string>event.getID(), index.toString()]));
      writePromises.push(
        admin.firestore().collection('users')
          .doc(userID)
          .collection('events')
          .doc(<string>event.getID())
          .collection('activities')
          .doc(<string>activity.getID())
          .set(activity.toJSON()));

      activity.getAllExportableStreams().forEach((stream) => {
        // console.log(`Stream ${stream.type} has size of GZIP ${getSize(Buffer.from((Pako.gzip(JSON.stringify(stream.data), {to: 'string'})), 'binary'))}`);
        writePromises.push(
          admin.firestore()
            .collection('users')
            .doc(userID)
            .collection('events')
            .doc(<string>event.getID())
            .collection('activities')
            .doc(<string>activity.getID())
            .collection('streams')
            .doc(stream.type)
            .set({
              type: stream.type,
              data: Buffer.from((Pako.gzip(JSON.stringify(stream.getData()), {to: 'string'})), 'binary'),
            }))
      });
    });
  writePromises.push( admin.firestore()
    .collection('users')
    .doc(userID)
    .collection('events')
    .doc(<string>event.getID()).collection('metaData').doc(metaData.serviceName).set(metaData.toJSON()));
  try {
    await Promise.all(writePromises);
    console.log(`Wrote ${writePromises.length+1} documents for event with id ${eventID}`);
    return admin.firestore().collection('users').doc(userID).collection('events').doc(<string>event.getID()).set(event.toJSON());
  } catch (e) {
    console.error(e);
    debugger;
    return
    // Try to delete the parent entity and all subdata
    // await this.deleteAllEventData(user, event.getID());
  }
}
