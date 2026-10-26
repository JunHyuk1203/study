import {FieldValue, Timestamp} from './platform-store.js';
import {HttpsError} from './platform-http.js';
import {advanceStreak, checkpointCamera, MAX_SESSION_MS, WORD_LEASE_MS, splitStudyInterval} from './domain.js';
import {creditFocusTime} from './focus-time.js';
import {settleWordStats} from './word-stats.js';
import {readActivityRoom,publishRoomActivity} from './room-service.js';

export async function finishSession(db, uid, sessionId, expiredBeforeMs = null) {
  if (typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]{20,128}$/.test(sessionId)) throw new HttpsError('invalid-argument', '학습 기록 ID가 올바르지 않습니다.');
  const profileRef = db.doc(`users/${uid}`);
  const sessionRef = profileRef.collection('sessions').doc(sessionId);
  const summaryRef = profileRef.collection('stats').doc('summary');
  return db.runTransaction(async (transaction) => {
    const [profileDoc, sessionDoc, summaryDoc] = await transaction.getAll(profileRef, sessionRef, summaryRef);
    if (!profileDoc.exists || !sessionDoc.exists) throw new HttpsError('not-found', '학습 기록이 없습니다.');
    const session = sessionDoc.data();
    // Recheck inside the transaction: a heartbeat may have renewed this lease
    // after the cleanup query selected it.
    if (expiredBeforeMs != null && (session.presenceUntilMs ?? session.leaseUntilMs ?? session.startedAt.toMillis()+WORD_LEASE_MS) > expiredBeforeMs) return {notExpired:true};
    if (session.status === 'finished') {
      transaction.delete(db.doc(`wordStudyLeases/${sessionId}`));
      return { creditedSeconds: session.creditedSeconds, alreadyFinished: true, studyRevision: profileDoc.data()?.studyRevision || 0 };
    }
    const profile = profileDoc.data();
    const wordSession=session.source==='superword';
    if (profile.activeSessionId !== sessionId && !(wordSession && profile.wordStudySessionId===sessionId)) throw new HttpsError('failed-precondition', '진행 중인 학습 기록이 일치하지 않습니다.');
    const cameraRef=wordSession&&session.cameraSessionId?profileRef.collection('sessions').doc(session.cameraSessionId):null;
    const camera=cameraRef?(await transaction.get(cameraRef)).data():null;
    const now = Timestamp.fromMillis(Math.floor(Date.now() / 1000) * 1000);
    const startedMs = session.startedAt.toMillis();
    const endedMs = Math.max(startedMs,Math.min(now.toMillis(), startedMs + MAX_SESSION_MS, session.presenceUntilMs??Infinity));
    const activity=await readActivityRoom(transaction,db,uid,profile);
    const checkpoint = session.cameraMode || session.activityMode ? checkpointCamera({ ...session, startedAtMs: startedMs }, endedMs, false) : null;
    if(activity&&(!activity.room.members[uid]?.activitySource||activity.room.members[uid].activitySource===(wordSession?'word':'camera')))publishRoomActivity(transaction,activity,uid,profile,null,now.toMillis(),'',wordSession?'word':'camera');
    if(camera?.status==='active' && camera.wordSessionId===sessionId)transaction.update(cameraRef,{...checkpointCamera({...camera,startedAtMs:camera.startedAt.toMillis()},now.toMillis(),false),wordSessionId:null,wordLeaseUntilMs:null,wordPaused:false,sequence:(camera.sequence||0)+1,updatedAt:now});
    const segments = checkpoint ? checkpoint.segments : splitStudyInterval(startedMs, endedMs);
    const creditedSeconds = segments.reduce((sum, segment) => sum + segment.seconds, 0);
    const buckets = new Map();
    const weeks = new Map();
    for (const segment of segments) {
      for (const [collection, period] of [['dailyStats', segment.date], ['weeklyStats', segment.week], ['monthlyStats', segment.month]]) {
        const path = `users/${uid}/${collection}/${period}`;
        buckets.set(path, (buckets.get(path) ?? 0) + segment.seconds);
      }
      weeks.set(segment.week, (weeks.get(segment.week) ?? 0) + segment.seconds);
    }
    if(wordSession)settleWordStats(transaction,db,uid,sessionId,session.subjectId,segments,session.settledSegments||[],now);
    for (const [path, seconds] of wordSession?[]:buckets) {
      transaction.set(db.doc(path), { uid, totalSeconds: FieldValue.increment(seconds), subjectSeconds: { [session.subjectId]: FieldValue.increment(seconds) }, updatedAt: now }, { merge: true });
    }
    if (creditedSeconds > 0) {
      if(session.verificationType==='face-browser')creditFocusTime(transaction, db, uid, sessionId, creditedSeconds, now);
      const streak = advanceStreak(summaryDoc.data() ?? {}, segments.map(segment => segment.date));
      transaction.set(summaryRef, { uid, totalSeconds: FieldValue.increment(creditedSeconds), sessionCount: FieldValue.increment(1), ...streak, updatedAt: now }, { merge: true });
      for (const [week, seconds] of session.verificationType==='face-browser'?weeks:[]) {
        const ranking = { uid, displayName: profile.displayName, totalSeconds: FieldValue.increment(seconds), updatedAt: now };
        transaction.set(db.doc(`leaderboards/${week}/entries/${uid}`), ranking, { merge: true });
        if (profile.schoolId) transaction.set(db.doc(`schoolLeaderboards/${profile.schoolId}/weeks/${week}/entries/${uid}`), ranking, { merge: true });
      }
    }
    transaction.update(sessionRef, { ...(checkpoint || {}), ...(wordSession?{settledSegments:segments}:{}),status: 'finished', endedAt: Timestamp.fromMillis(endedMs), creditedSeconds, capped: now.toMillis() > endedMs, updatedAt: now });
    transaction.delete(db.doc(`wordStudyLeases/${sessionId}`));
    transaction.update(profileRef, {activeSessionId:wordSession?(profile.activeSessionId===sessionId?null:profile.activeSessionId):(profile.wordStudySessionId||null),...(wordSession?{wordStudySessionId:null,wordCameraSessionId:null,wordPresenceUntilMs:null,wordAppUntilMs:null,wordTracking:false,wordSnapshot:null}:session.cameraMode?{wordCameraSessionId:null}:{}), studyRevision: FieldValue.increment(1), updatedAt: now });
    return { creditedSeconds, alreadyFinished: false, studyRevision:(profile.studyRevision || 0)+1 };
  });
}
export async function expireUserSessions(db, uid) {
  const profile=(await db.doc(`users/${uid}`).get()).data();
  const ids=[...new Set([profile?.wordStudySessionId,profile?.activeSessionId].filter(Boolean))];
  const cutoff=Date.now();
  for(const id of ids){
    const session=(await db.doc(`users/${uid}/sessions/${id}`).get()).data();
    if(!session||session.status==='finished'){
      const ref=db.doc(`users/${uid}`);
      await db.runTransaction(async tx=>{
        const current=(await tx.get(ref)).data();
        if(!current)return;
        const update={};
        if(current.activeSessionId===id)update.activeSessionId=current.wordStudySessionId!==id?current.wordStudySessionId||null:null;
        if(current.wordStudySessionId===id)Object.assign(update,{wordStudySessionId:null,wordCameraSessionId:null,wordPresenceUntilMs:null,wordAppUntilMs:null,wordTracking:false,wordSnapshot:null});
        if(Object.keys(update).length)tx.update(ref,update);
      });
    } else if((session.presenceUntilMs??session.leaseUntilMs??session.startedAt.toMillis()+WORD_LEASE_MS)<=cutoff)await finishSession(db,uid,id,cutoff);
  }
  return {checked:true};
}
