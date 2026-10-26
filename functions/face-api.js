import {getAuth} from 'firebase-admin/auth';
import {getApps,initializeApp} from 'firebase-admin/app';
import {getFirestore} from './platform-store.js';
import {onCall,HttpsError} from './platform-http.js';
import {createFaceService} from './face-service.js';
import {createFaceKms,faceKmsConfigured} from './face-kms.js';
import {FACE_ORIGIN} from './face-protocol.js';
import {onSchedule} from './platform-scheduler.js';
import {cleanupFaceSecurity} from './face-cleanup.js';

const app=getApps()[0]??initializeApp(),db=getFirestore(app,'study-data');
const invoke=createFaceService({db,kms:createFaceKms(),projectId:app.options.projectId||process.env.GCLOUD_PROJECT,configured:faceKmsConfigured});
const options={region:'asia-northeast3',maxInstances:2,cors:[FACE_ORIGIN],timeoutSeconds:60};
const endpoint=name=>onCall(options,async request=>{
  if(request.rawRequest?.headers?.origin!==FACE_ORIGIN&&request.faceOrigin!==FACE_ORIGIN)throw new HttpsError('permission-denied','정식 학습 사이트에서만 얼굴 등록을 사용할 수 있습니다.');
  if(!request.faceTokenFresh){
    const header=request.rawRequest?.headers?.authorization||'';
    try{const token=await getAuth(app).verifyIdToken(header.replace(/^Bearer /,''),true);request={...request,auth:{uid:token.uid,token}};}
    catch{throw new HttpsError('unauthenticated','계정을 다시 인증해 주세요.');}
  }
  return invoke(name,request);
});
export const getFaceEnrollmentStatus=endpoint('getFaceEnrollmentStatus');
export const beginDailyFaceAuth=endpoint('beginDailyFaceAuth');
export const completeDailyFaceAuth=endpoint('completeDailyFaceAuth');
export const beginFaceEnrollment=endpoint('beginFaceEnrollment');
export const sealFaceKeyEnvelope=endpoint('sealFaceKeyEnvelope');
export const commitFaceEnrollment=endpoint('commitFaceEnrollment');
export const beginFaceUnlock=endpoint('beginFaceUnlock');
export const unlockFaceKeyEnvelope=endpoint('unlockFaceKeyEnvelope');
export const revokeFaceEnrollment=endpoint('revokeFaceEnrollment');
export const cancelFaceEnrollment=endpoint('cancelFaceEnrollment');
export const lockFaceEnrollment=endpoint('lockFaceEnrollment');
export const cleanupFaceSecurityMetadata=onSchedule({region:'asia-northeast3',schedule:'every 60 minutes',timeZone:'Asia/Seoul'},()=>cleanupFaceSecurity(db));
