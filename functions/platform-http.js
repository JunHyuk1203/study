import {onCall as cloudOnCall, HttpsError} from 'firebase-functions/v2/https';
export {HttpsError};
export function onCall(options, handler) {
  if (process.env.STUDY_BACKEND !== 'selfhost') return cloudOnCall(options, handler);
  return Object.assign(handler, {run:handler, studyKind:'callable', studyOptions:options});
}
