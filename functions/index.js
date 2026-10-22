import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { checkpointCamera, WORD_LEASE_MS, validDisplayName, weekKey } from './domain.js';
import { planSubjects } from './plan-domain.js';
import { changePlan } from './plan-service.js';
import {finishSession as finishSessionRecord, expireUserSessions} from './session-lifecycle.js';
export { searchSchools, saveSchool, getSchoolOverview, getUpcomingExams, chatWithStudy, getStudyBriefing, getAiUsage } from './integrations.js';
export { startWordStudy, syncWordStudy } from './word-study.js';
export {saveWordStudyLink,restoreWordStudyLink,removeWordStudyLink} from './word-link.js';

const app = getApps()[0] ?? initializeApp();
const db = getFirestore(app, 'study-data');
const options = { region: 'asia-northeast3', maxInstances: 2, minInstances: 0, memory: '256MiB', cpu: 'gcf_gen1', concurrency: 1, timeoutSeconds: 30 };

function userId(request, verified = false) {
  if (!request.auth) throw new HttpsError('unauthenticated', '로그인이 필요합니다.');
  if (verified && request.auth.token.email_verified !== true) throw new HttpsError('failed-precondition', '이메일을 인증해 주세요.');
  return request.auth.uid;
}

export const ensureProfile = onCall(options, async (request) => {
  const uid = userId(request);
  const name = request.data?.displayName;
  if (!validDisplayName(name)) throw new HttpsError('invalid-argument', '닉네임은 2~20자로 입력해 주세요.');
  const ref = db.doc(`users/${uid}`);
  return db.runTransaction(async (transaction) => {
    const existing = await transaction.get(ref);
    if (!existing.exists) {
      const now = Timestamp.now();
      transaction.create(ref, { uid, displayName: name.trim(), schoolId: null, activeSessionId: null, createdAt: now, updatedAt: now });
    }
    return { uid };
  });
});

export const updateAccount = onCall(options, async (request) => {
  const uid = userId(request);
  if (!validDisplayName(request.data?.displayName)) throw new HttpsError('invalid-argument', '닉네임은 2~20자로 입력해 주세요.');
  // Ownership, school membership, scores and roles are never taken from client input.
  const ref = db.doc(`users/${uid}`);
  await db.runTransaction(async (transaction) => {
    const profile = await transaction.get(ref);
    if (!profile.exists) throw new HttpsError('not-found', '계정 프로필이 없습니다.');
    const week = weekKey(new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10));
    const rankingRefs = [db.doc(`leaderboards/${week}/entries/${uid}`)];
    if (profile.data().schoolId) rankingRefs.push(db.doc(`schoolLeaderboards/${profile.data().schoolId}/weeks/${week}/entries/${uid}`));
    const rankingRows = await transaction.getAll(...rankingRefs);
    const update = { displayName: request.data.displayName.trim(), updatedAt: Timestamp.now() };
    transaction.update(ref, update);
    for (const row of rankingRows) if (row.exists) transaction.update(row.ref, update);
  });
  return { updated: true };
});

export const updateStudyPlan = onCall(options, request => changePlan(db,userId(request),request.data?.action,request.data));

export const startStudySession = onCall(options, async (request) => {
  const uid = userId(request, true);
  const subjectId = request.data?.subjectId;
  const cameraMode = request.data?.cameraMode === true;
  const controllerId = request.data?.controllerId;
  if (cameraMode && (typeof controllerId !== 'string' || !/^[a-f0-9-]{36}$/.test(controllerId))) throw new HttpsError('invalid-argument', '카메라 제어 ID가 올바르지 않습니다.');
  const profileRef = db.doc(`users/${uid}`);
  const sessionRef = profileRef.collection('sessions').doc();
  await expireUserSessions(db,uid);
  let session;
  await db.runTransaction(async (transaction) => {
    const profile = await transaction.get(profileRef);
    if (!profile.exists) throw new HttpsError('failed-precondition', '계정 프로필을 먼저 생성해 주세요.');
    if (!planSubjects(profile.data()).some(row => row.id === subjectId)) throw new HttpsError('invalid-argument', '설정에 추가한 과목을 선택해 주세요.');
    if (profile.data().activeSessionId) throw new HttpsError('already-exists', '진행 중인 학습을 먼저 종료해 주세요.');
    if(profile.data().wordHandoffUntilMs>Date.now())throw new HttpsError('failed-precondition','단어앱 학습으로 전환 중입니다. 잠시 후 다시 시작해 주세요.');
    const now = Timestamp.fromMillis(Math.floor(Date.now() / 1000) * 1000);
    session = { uid, subjectId, status: 'active', presenceUntilMs:now.toMillis()+WORD_LEASE_MS,...(controllerId?{controllerId}:{}),
      ...(cameraMode ? { cameraMode: true, controllerId, sequence: 0, segments: [], accumulatedSeconds: 0, activeSinceMs: null, leaseUntilMs: null, cameraStatus: 'paused' } : {}) };
    transaction.create(sessionRef, { ...session, startedAt: now, createdAt: now });
    transaction.set(db.doc(`wordStudyLeases/${sessionRef.id}`),{uid,sessionId:sessionRef.id,expiresAtMs:session.presenceUntilMs});
    session = { ...session, startedAtMs: now.toMillis(), serverNowMs: now.toMillis() };
    transaction.update(profileRef, { activeSessionId: sessionRef.id, updatedAt: now });
  });
  return { sessionId: sessionRef.id, session };
});

export const syncStudyCamera = onCall(options, async request => {
  const uid = userId(request, true);
  await expireUserSessions(db,uid);
  const { sessionId, controllerId, sequence, tracking } = request.data || {};
  if (typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]{20,128}$/.test(sessionId) || !Number.isSafeInteger(sequence) || sequence < 1 || typeof tracking !== 'boolean') throw new HttpsError('invalid-argument', '카메라 상태가 올바르지 않습니다.');
  return db.runTransaction(async transaction => {
    const ref = db.doc(`users/${uid}/sessions/${sessionId}`);
    const record = await transaction.get(ref);
    const session = record.data();
    // Session finish and checkpoints serialize on this same document. Reading
    // the profile again on every heartbeat adds no protection to that invariant.
    if (!session || session.status !== 'active') throw new HttpsError('failed-precondition', '진행 중인 기록이 없습니다.');
    if (!session.cameraMode || controllerId !== session.controllerId) throw new HttpsError('permission-denied', '학습을 시작한 카메라에서만 제어할 수 있습니다.');
    if (sequence <= session.sequence) return { ignored: true, session:{...session,startedAtMs:session.startedAt.toMillis(),serverNowMs:Date.now()} };
    const wordPaused=Boolean(session.wordSessionId && session.wordLeaseUntilMs>Date.now());
    const update = {...checkpointCamera({ ...session, startedAtMs: session.startedAt.toMillis() }, Date.now(), tracking&&!wordPaused),wordPaused,...(!wordPaused?{wordSessionId:null,wordLeaseUntilMs:null}:{wordSessionId:session.wordSessionId,wordLeaseUntilMs:session.wordLeaseUntilMs})};
    const updatedAt = Timestamp.now();
    transaction.update(ref, { ...update, sequence, presenceUntilMs:updatedAt.toMillis()+WORD_LEASE_MS, updatedAt });
    transaction.set(db.doc(`wordStudyLeases/${sessionId}`),{uid,sessionId,expiresAtMs:updatedAt.toMillis()+WORD_LEASE_MS});
    return { ignored: false, cameraStatus: update.cameraStatus, session: { ...update, presenceUntilMs:updatedAt.toMillis()+WORD_LEASE_MS, sequence, serverNowMs: updatedAt.toMillis() } };
  });
});

export const finishStudySession = onCall(options, request => finishSession(userId(request, true), request.data?.sessionId));
export const expireStudySessions = onCall(options, request => expireUserSessions(db,userId(request,true)));
export const heartbeatStudySession = onCall(options, async request => {
  const uid=userId(request,true),{sessionId,controllerId}=request.data||{};
  await expireUserSessions(db,uid);
  if(typeof sessionId!=='string'||!/^[A-Za-z0-9_-]{20,128}$/.test(sessionId))throw new HttpsError('invalid-argument','학습 기록 ID가 올바르지 않습니다.');
  return db.runTransaction(async tx=>{
    const ref=db.doc(`users/${uid}/sessions/${sessionId}`),session=(await tx.get(ref)).data();
    if(!session||session.status!=='active')throw new HttpsError('failed-precondition','진행 중인 기록이 없습니다.');
    if(session.cameraMode||session.activityMode||!controllerId||session.controllerId!==controllerId)throw new HttpsError('permission-denied','학습을 시작한 창에서만 제어할 수 있습니다.');
    const now=Timestamp.now(),presenceUntilMs=now.toMillis()+WORD_LEASE_MS;
    tx.update(ref,{presenceUntilMs,updatedAt:now});
    tx.set(db.doc(`wordStudyLeases/${sessionId}`),{uid,sessionId,expiresAtMs:presenceUntilMs});
    return {session:{...session,presenceUntilMs,serverNowMs:now.toMillis()}};
  });
});

// Pause camera credit before word tracking, keeping its controller alive to resume.
export const prepareWordStudy = onCall(options, async request => {
  const uid=userId(request,true),profileRef=db.doc(`users/${uid}`);
  return db.runTransaction(async tx=>{
    const profile=(await tx.get(profileRef)).data();
    if(!profile)throw new HttpsError('failed-precondition','스터디 계정을 먼저 설정해 주세요.');
    const sessionId=profile.activeSessionId;
    const session=sessionId?(await tx.get(profileRef.collection('sessions').doc(sessionId))).data():null;
    if(session?.status==='active'&&!session.cameraMode){
      if(session.source==='superword')return {cameraStopped:true};
      throw new HttpsError('already-exists','진행 중인 학습을 먼저 종료해 주세요.');
    }
    const now=Timestamp.now(),until=now.toMillis()+WORD_LEASE_MS;
    const cameraId=session?.status==='active'&&session.cameraMode?sessionId:null;
    if(cameraId)tx.update(profileRef.collection('sessions').doc(cameraId),{
      ...checkpointCamera({...session,startedAtMs:session.startedAt.toMillis()},now.toMillis(),false),
      wordSessionId:profile.wordStudySessionId||'handoff',wordLeaseUntilMs:until,wordPaused:true,
      sequence:(session.sequence||0)+1,updatedAt:now,
    });
    tx.update(profileRef,{wordHandoffUntilMs:until,...(cameraId?{wordCameraSessionId:cameraId,wordPresenceUntilMs:until}:{})});
    // Keep the existing response field for older word clients: credit is stopped.
    return {cameraStopped:true,...(cameraId?{pausedSessionId:cameraId}:{})};
  });
});

const finishSession=(uid,...args)=>finishSessionRecord(db,uid,...args);

// A browser can be killed before pagehide or its keepalive request runs.
// Expired word leases credit at most the final 10-second server-observed window.
export const closeExpiredWordStudies = onSchedule({...options,schedule:'every 1 minutes',timeZone:'Asia/Seoul'}, async () => {
  const cutoff = Date.now();
  const leases = await db.collection('wordStudyLeases').where('expiresAtMs','<=',cutoff).limit(100).get();
  for (const lease of leases.docs) {
    const {uid,sessionId} = lease.data();
    await finishSession(uid,sessionId,cutoff);
  }
});
