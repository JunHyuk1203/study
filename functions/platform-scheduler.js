import {onSchedule as cloudOnSchedule} from 'firebase-functions/v2/scheduler';
export function onSchedule(options, handler) {
  if (process.env.STUDY_BACKEND !== 'selfhost') return cloudOnSchedule(options, handler);
  return Object.assign(handler, {run:handler, studyKind:'schedule', studyOptions:options});
}
