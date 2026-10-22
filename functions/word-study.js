import { randomUUID } from 'node:crypto';
import { getApps, initializeApp } from 'firebase-admin/app';
import { FieldValue, getFirestore, Timestamp } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { checkpointCamera } from './domain.js';
import {settleWordStats} from './word-stats.js';

const db = getFirestore(getApps()[0] ?? initializeApp(), 'study-data');
const options = {region:'asia-northeast3',maxInstances:2,minInstances:0,memory:'256MiB',cpu:'gcf_gen1',concurrency:1,timeoutSeconds:30};
function owner(request) {
  if (!request.auth) throw new HttpsError('unauthenticated','스터디 계정으로 로그인해 주세요.');
  if (request.auth.token.email_verified !== true) throw new HttpsError('failed-precondition','스터디 계정의 이메일을 인증해 주세요.');
  return request.auth.uid;
}
function controller(value) {
  if (typeof value !== 'string' || !/^[a-f0-9-]{36}$/.test(value)) throw new HttpsError('invalid-argument','학습 제어 ID가 올바르지 않습니다.');
  return value;
}
function reply(id, session, now) {
  return {sessionId:id,session:{...session,startedAtMs:session.startedAt.toMillis(),serverNowMs:now.toMillis()}};
}

function interruptCamera(tx, ref, camera, wordSessionId, now, present) {
  if (!camera?.cameraMode || camera.status !== 'active') return null;
  if (!present && camera.wordSessionId !== wordSessionId) return ref.id;
  const checkpoint = checkpointCamera({...camera,startedAtMs:camera.startedAt.toMillis()},now.toMillis(),false);
  tx.update(ref,{...checkpoint,wordSessionId:present?wordSessionId:null,wordLeaseUntilMs:present?now.toMillis()+30000:null,sequence:(camera.sequence||0)+1,updatedAt:now});
  return ref.id;
}

export const startWordStudy = onCall(options, async request => {
  const uid = owner(request), controllerId = controller(request.data?.controllerId);
  const profileRef = db.doc(`users/${uid}`), sessionRef = profileRef.collection('sessions').doc();
  return db.runTransaction(async tx => {
    const snapshot = await tx.get(profileRef), profile = snapshot.data();
    if (!profile) throw new HttpsError('failed-precondition','스터디 계정을 먼저 설정해 주세요.');
    const now = Timestamp.fromMillis(Math.floor(Date.now()/1000)*1000);
    let cameraRef, camera;
    if (profile.wordStudySessionId) {
      const existing = await tx.get(profileRef.collection('sessions').doc(profile.wordStudySessionId));
      const session = existing.data();
      if (session?.status === 'active' && session.source === 'superword' && session.controllerId === controllerId) return reply(existing.id,session,now);
      throw new HttpsError('already-exists','다른 SP word 창에서 학습 중입니다. 해당 창을 먼저 닫아 주세요.');
    }
    if (profile.activeSessionId) {
      const existing = await tx.get(profileRef.collection('sessions').doc(profile.activeSessionId));
      const session = existing.data();
      if (session?.status === 'active' && session.source === 'superword' && session.controllerId === controllerId) return reply(existing.id, session, now);
      if (session?.status !== 'active' || !session.cameraMode) throw new HttpsError('already-exists','다른 학습이 진행 중입니다. 먼저 해당 학습을 종료해 주세요.');
      cameraRef=existing.ref;camera=session;
    }
    const subjects = profile.subjects || [];
    let subject = subjects.find(row => row.name === '영단어');
    if (!subject) {
      if (subjects.length >= 30) throw new HttpsError('failed-precondition','과목이 30개입니다. 영단어 과목을 추가할 공간을 마련해 주세요.');
      subject = {id:`s_${randomUUID()}`,name:'영단어'};
    }
    const session = {uid,subjectId:subject.id,source:'superword',activityMode:true,controllerId,status:'active',sequence:0,segments:[],accumulatedSeconds:0,activeSinceMs:null,leaseUntilMs:null,cameraStatus:'paused',startedAt:now,createdAt:now,cameraSessionId:cameraRef?.id||null,presenceUntilMs:now.toMillis()+30000};
    if(cameraRef)interruptCamera(tx,cameraRef,camera,sessionRef.id,now,false);
    tx.create(sessionRef,session);
    tx.create(db.doc(`wordStudyLeases/${sessionRef.id}`),{uid,sessionId:sessionRef.id,expiresAtMs:now.toMillis()+30000});
    tx.update(profileRef,{activeSessionId:cameraRef?.id||sessionRef.id,wordStudySessionId:sessionRef.id,wordCameraSessionId:cameraRef?.id||null,wordPresenceUntilMs:null,wordAppUntilMs:session.presenceUntilMs,wordTracking:false,subjects:subjects.some(row=>row.id===subject.id)?subjects:[...subjects,subject],updatedAt:now});
    return reply(sessionRef.id,session,now);
  });
});

export const syncWordStudy = onCall(options, async request => {
  const uid = owner(request), controllerId = controller(request.data?.controllerId);
  const {sessionId,sequence,tracking} = request.data || {};
  const present=request.data?.present ?? tracking;
  if (typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]{20,128}$/.test(sessionId) || !Number.isSafeInteger(sequence) || sequence < 1 || typeof tracking !== 'boolean' || typeof present !== 'boolean') throw new HttpsError('invalid-argument','학습 상태가 올바르지 않습니다.');
  return db.runTransaction(async tx => {
    const ref = db.doc(`users/${uid}/sessions/${sessionId}`), snapshot = await tx.get(ref), session = snapshot.data();
    if (!session || session.status !== 'active') throw new HttpsError('failed-precondition','진행 중인 영단어 학습이 없습니다.');
    if (session.source !== 'superword' || !session.activityMode || session.controllerId !== controllerId) throw new HttpsError('permission-denied','학습을 시작한 단어앱에서만 제어할 수 있습니다.');
    const now = Timestamp.now();
    if (sequence <= session.sequence) return {...reply(ref.id,session,now),ignored:true};
    const cameraRef=session.cameraSessionId?db.doc(`users/${uid}/sessions/${session.cameraSessionId}`):null;
    const camera=cameraRef?(await tx.get(cameraRef)).data():null;
    const counting=tracking&&present;
    const cameraId=cameraRef?interruptCamera(tx,cameraRef,camera,sessionId,now,counting):null;
    const presenceUntilMs=present?now.toMillis()+30000:now.toMillis();
    const update = {...checkpointCamera({...session,startedAtMs:session.startedAt.toMillis()},now.toMillis(),tracking&&present),presenceUntilMs};
    const delta=settleWordStats(tx,db,uid,sessionId,session.subjectId,update.segments,session.settledSegments||[],now);
    update.settledSegments=update.segments;
    tx.update(ref,{...update,sequence,updatedAt:now});
    const wordSnapshot={sessionId,subjectId:session.subjectId,segments:update.segments,activeSinceMs:update.activeSinceMs,leaseUntilMs:update.leaseUntilMs,serverNowMs:now.toMillis()};
    tx.update(db.doc(`users/${uid}`),{wordStudySessionId:sessionId,wordCameraSessionId:cameraId,wordPresenceUntilMs:counting?presenceUntilMs:null,wordAppUntilMs:presenceUntilMs,wordTracking:counting,wordSnapshot,...(delta>0?{studyRevision:FieldValue.increment(1)}:{}),updatedAt:now});
    tx.set(db.doc(`wordStudyLeases/${sessionId}`),{uid,sessionId,expiresAtMs:presenceUntilMs});
    return reply(ref.id,{...session,...update,sequence},now);
  });
});
