import { getApps, initializeApp } from 'firebase-admin/app';
import { FieldValue, getFirestore, Timestamp } from 'firebase-admin/firestore';
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { creditFocusTime } from './focus-time.js';
import { advanceStreak, checkpointCamera, MAX_SESSION_MS, splitStudyInterval, SUBJECTS, validDisplayName, weekKey } from './domain.js';
export { searchSchools, saveSchool, getSchoolOverview, getUpcomingExams, chatWithStudy, getStudyBriefing, getAiUsage } from './integrations.js';

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

export const startStudySession = onCall(options, async (request) => {
  const uid = userId(request, true);
  const subjectId = request.data?.subjectId;
  if (!SUBJECTS.includes(subjectId)) throw new HttpsError('invalid-argument', '과목을 선택해 주세요.');
  const cameraMode = request.data?.cameraMode === true;
  const controllerId = request.data?.controllerId;
  if (cameraMode && (typeof controllerId !== 'string' || !/^[a-f0-9-]{36}$/.test(controllerId))) throw new HttpsError('invalid-argument', '카메라 제어 ID가 올바르지 않습니다.');
  const profileRef = db.doc(`users/${uid}`);
  const sessionRef = profileRef.collection('sessions').doc();
  await db.runTransaction(async (transaction) => {
    const profile = await transaction.get(profileRef);
    if (!profile.exists) throw new HttpsError('failed-precondition', '계정 프로필을 먼저 생성해 주세요.');
    if (profile.data().activeSessionId) throw new HttpsError('already-exists', '진행 중인 학습을 먼저 종료해 주세요.');
    const now = Timestamp.fromMillis(Math.floor(Date.now() / 1000) * 1000);
    transaction.create(sessionRef, { uid, subjectId, status: 'active', startedAt: now, createdAt: now,
      ...(cameraMode ? { cameraMode: true, controllerId, sequence: 0, segments: [], accumulatedSeconds: 0, activeSinceMs: null, leaseUntilMs: null, cameraStatus: 'paused' } : {}) });
    transaction.update(profileRef, { activeSessionId: sessionRef.id, updatedAt: now });
  });
  return { sessionId: sessionRef.id };
});

export const syncStudyCamera = onCall(options, async request => {
  const uid = userId(request, true);
  const { sessionId, controllerId, sequence, tracking } = request.data || {};
  if (typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]{20,128}$/.test(sessionId) || !Number.isSafeInteger(sequence) || sequence < 1 || typeof tracking !== 'boolean') throw new HttpsError('invalid-argument', '카메라 상태가 올바르지 않습니다.');
  return db.runTransaction(async transaction => {
    const ref = db.doc(`users/${uid}/sessions/${sessionId}`);
    const [record, profile] = await transaction.getAll(ref, db.doc(`users/${uid}`));
    const session = record.data();
    if (!session || profile.data()?.activeSessionId !== sessionId || session.status !== 'active') throw new HttpsError('failed-precondition', '진행 중인 기록이 없습니다.');
    if (!session.cameraMode || controllerId !== session.controllerId) throw new HttpsError('permission-denied', '학습을 시작한 카메라에서만 제어할 수 있습니다.');
    if (sequence <= session.sequence) return { ignored: true };
    const update = checkpointCamera({ ...session, startedAtMs: session.startedAt.toMillis() }, Date.now(), tracking);
    transaction.update(ref, { ...update, sequence, updatedAt: Timestamp.now() });
    return { ignored: false, cameraStatus: update.cameraStatus };
  });
});

export const finishStudySession = onCall(options, async (request) => {
  const uid = userId(request, true);
  const sessionId = request.data?.sessionId;
  if (typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]{20,128}$/.test(sessionId)) throw new HttpsError('invalid-argument', '학습 기록 ID가 올바르지 않습니다.');
  const profileRef = db.doc(`users/${uid}`);
  const sessionRef = profileRef.collection('sessions').doc(sessionId);
  const summaryRef = profileRef.collection('stats').doc('summary');
  return db.runTransaction(async (transaction) => {
    const [profileDoc, sessionDoc, summaryDoc] = await transaction.getAll(profileRef, sessionRef, summaryRef);
    if (!profileDoc.exists || !sessionDoc.exists) throw new HttpsError('not-found', '학습 기록이 없습니다.');
    const session = sessionDoc.data();
    if (session.status === 'finished') return { creditedSeconds: session.creditedSeconds, alreadyFinished: true };
    const profile = profileDoc.data();
    if (profile.activeSessionId !== sessionId) throw new HttpsError('failed-precondition', '진행 중인 학습 기록이 일치하지 않습니다.');
    const now = Timestamp.fromMillis(Math.floor(Date.now() / 1000) * 1000);
    const startedMs = session.startedAt.toMillis();
    const endedMs = Math.min(now.toMillis(), startedMs + MAX_SESSION_MS);
    const checkpoint = session.cameraMode ? checkpointCamera({ ...session, startedAtMs: startedMs }, now.toMillis(), false) : null;
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
    for (const [path, seconds] of buckets) {
      transaction.set(db.doc(path), { uid, totalSeconds: FieldValue.increment(seconds), subjectSeconds: { [session.subjectId]: FieldValue.increment(seconds) }, updatedAt: now }, { merge: true });
    }
    if (creditedSeconds > 0) {
      creditFocusTime(transaction, db, uid, sessionId, creditedSeconds, now);
      const streak = advanceStreak(summaryDoc.data() ?? {}, segments.map(segment => segment.date));
      transaction.set(summaryRef, { uid, totalSeconds: FieldValue.increment(creditedSeconds), sessionCount: FieldValue.increment(1), ...streak, updatedAt: now }, { merge: true });
      for (const [week, seconds] of weeks) {
        const ranking = { uid, displayName: profile.displayName, totalSeconds: FieldValue.increment(seconds), updatedAt: now };
        transaction.set(db.doc(`leaderboards/${week}/entries/${uid}`), ranking, { merge: true });
        if (profile.schoolId) transaction.set(db.doc(`schoolLeaderboards/${profile.schoolId}/weeks/${week}/entries/${uid}`), ranking, { merge: true });
      }
    }
    transaction.update(sessionRef, { ...(checkpoint || {}), status: 'finished', endedAt: Timestamp.fromMillis(endedMs), creditedSeconds, capped: now.toMillis() > endedMs, updatedAt: now });
    transaction.update(profileRef, { activeSessionId: null, updatedAt: now });
    return { creditedSeconds, alreadyFinished: false };
  });
});
