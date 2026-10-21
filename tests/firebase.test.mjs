import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { collection, doc, getDoc, getDocs, limit, orderBy, query, setDoc } from 'firebase/firestore';
import { initializeApp, deleteApp } from 'firebase/app';
import { connectAuthEmulator, createUserWithEmailAndPassword, getAuth, GoogleAuthProvider, signInWithCredential, signInWithEmailAndPassword, signOut } from 'firebase/auth';
import { getFirestore, Timestamp } from '../functions/node_modules/firebase-admin/lib/firestore/index.js';
import { ensureProfile, finishStudySession, startStudySession, updateAccount } from '../functions/index.js';
import { splitStudyInterval } from '../functions/domain.js';

const projectId = 'demo-study';
let environment;
let clientApp;

before(async () => {
  assert.ok(process.env.FIRESTORE_EMULATOR_HOST, 'Tests must run only inside Firestore emulator');
  assert.ok(process.env.FIREBASE_AUTH_EMULATOR_HOST, 'Tests must run only inside Auth emulator');
  environment = await initializeTestEnvironment({ projectId, firestore: { rules: await readFile(new URL('../firestore.rules', import.meta.url), 'utf8') } });
  await environment.withSecurityRulesDisabled(async context => {
    const db = context.firestore();
    await setDoc(doc(db, 'users/alice'), { uid: 'alice', schoolId: 'school-a', displayName: 'Alice' });
    await setDoc(doc(db, 'users/bob'), { uid: 'bob', schoolId: 'school-b', displayName: 'Bob' });
    await setDoc(doc(db, 'users/alice/dailyStats/2026-10-21'), { totalSeconds: 300 });
    await setDoc(doc(db, 'leaderboards/2026-10-19/entries/alice'), { uid: 'alice', displayName: 'Alice', totalSeconds: 300 });
    await setDoc(doc(db, 'schoolLeaderboards/school-a/weeks/2026-10-19/entries/alice'), { uid: 'alice', totalSeconds: 300 });
  });
});

after(async () => {
  if (clientApp) await deleteApp(clientApp);
  if (environment) await environment.cleanup();
});

test('anonymous and other accounts cannot read private account data', async () => {
  await assertFails(getDoc(doc(environment.unauthenticatedContext().firestore(), 'users/alice')));
  await assertFails(getDoc(doc(environment.authenticatedContext('bob').firestore(), 'users/alice')));
  await assertSucceeds(getDoc(doc(environment.authenticatedContext('alice').firestore(), 'users/alice')));
  await assertFails(getDoc(doc(environment.authenticatedContext('bob').firestore(), 'users/alice/dailyStats/2026-10-21')));
});

test('clients cannot forge profiles, school membership, sessions, or ranking scores', async () => {
  const db = environment.authenticatedContext('alice').firestore();
  for (const [path, data] of [
    ['users/alice', { uid: 'alice', schoolId: 'school-b' }],
    ['users/alice/sessions/fake', { creditedSeconds: 999999 }],
    ['users/alice/dailyStats/2026-10-21', { totalSeconds: 999999 }],
    ['leaderboards/2026-10-19/entries/alice', { totalSeconds: 999999 }],
  ]) await assertFails(setDoc(doc(db, path), data, { merge: true }));
});

test('ranking queries require authentication and a maximum of fifty rows', async () => {
  const anonymous = environment.unauthenticatedContext().firestore();
  const db = environment.authenticatedContext('alice').firestore();
  const rows = collection(db, 'leaderboards/2026-10-19/entries');
  await assertFails(getDocs(query(collection(anonymous, 'leaderboards/2026-10-19/entries'), limit(50))));
  await assertFails(getDocs(rows));
  await assertFails(getDocs(query(rows, limit(51))));
  await assertSucceeds(getDocs(query(rows, orderBy('totalSeconds', 'desc'), orderBy('uid'), limit(50))));
});

test('school rankings are readable only by members of that school', async () => {
  const path = 'schoolLeaderboards/school-a/weeks/2026-10-19/entries';
  await assertSucceeds(getDocs(query(collection(environment.authenticatedContext('alice').firestore(), path), limit(50))));
  await assertFails(getDocs(query(collection(environment.authenticatedContext('bob').firestore(), path), limit(50))));
});

test('callables reject unauthenticated requests and unverified study sessions', async () => {
  await assert.rejects(() => ensureProfile.run({ data: { displayName: '가짜' } }), error => error.code === 'unauthenticated');
  await assert.rejects(() => startStudySession.run({ auth: { uid: 'unverified', token: { email_verified: false } }, data: { subjectId: 'math' } }), error => error.code === 'failed-precondition');
});

test('profile input cannot overwrite UID, school membership, scores, or roles', async () => {
  const auth = { uid: 'profile-owner', token: {} };
  await ensureProfile.run({ auth, data: { displayName: '실제회원', uid: 'another-user', schoolId: 'fake-school', role: 'admin' } });
  await updateAccount.run({ auth, data: { displayName: '새닉네임', schoolId: 'fake-school', totalSeconds: 999 } });
  const profile = (await getFirestore(undefined, 'study-data').doc('users/profile-owner').get()).data();
  assert.equal(profile.uid, auth.uid);
  assert.equal(profile.displayName, '새닉네임');
  assert.equal(profile.schoolId, null);
  assert.equal(profile.role, undefined);
  assert.equal(profile.totalSeconds, undefined);
});

test('session finish is idempotent and atomically updates statistics and ranking', async () => {
  const auth = { uid: 'study-owner', token: { email_verified: true } };
  const db = getFirestore(undefined, 'study-data');
  await ensureProfile.run({ auth, data: { displayName: '공부회원' } });
  const { sessionId } = await startStudySession.run({ auth, data: { subjectId: 'math', durationSeconds: 999999 } });
  await assert.rejects(() => startStudySession.run({ auth, data: { subjectId: 'math' } }), error => error.code === 'already-exists');
  await assert.rejects(() => finishStudySession.run({ auth: { uid: 'other', token: { email_verified: true } }, data: { sessionId } }), error => error.code === 'not-found');
  const start = Math.floor(Date.now() / 1000) * 1000 - 120000;
  await db.doc(`users/${auth.uid}/sessions/${sessionId}`).update({ startedAt: Timestamp.fromMillis(start) });
  const first = await finishStudySession.run({ auth, data: { sessionId, durationSeconds: 999999 } });
  const second = await finishStudySession.run({ auth, data: { sessionId } });
  assert.ok(first.creditedSeconds >= 120 && first.creditedSeconds < 150);
  assert.equal(second.creditedSeconds, first.creditedSeconds);
  assert.equal(second.alreadyFinished, true);
  const summary = (await db.doc(`users/${auth.uid}/stats/summary`).get()).data();
  assert.equal(summary.totalSeconds, first.creditedSeconds);
  assert.equal(summary.sessionCount, 1);
  assert.equal(summary.currentStreak, 1);
  const session = (await db.doc(`users/${auth.uid}/sessions/${sessionId}`).get()).data();
  assert.equal(session.status, 'finished');
  assert.equal((await db.doc(`users/${auth.uid}`).get()).data().activeSessionId, null);
  const segments = splitStudyInterval(start, session.endedAt.toMillis());
  const expected = new Map();
  for (const segment of segments) {
    for (const [collection, key] of [['dailyStats', segment.date], ['weeklyStats', segment.week], ['monthlyStats', segment.month]]) {
      const path = `users/${auth.uid}/${collection}/${key}`;
      expected.set(path, (expected.get(path) ?? 0) + segment.seconds);
    }
    const path = `leaderboards/${segment.week}/entries/${auth.uid}`;
    expected.set(path, (expected.get(path) ?? 0) + segment.seconds);
  }
  for (const [path, seconds] of expected) {
    const row = (await db.doc(path).get()).data();
    assert.equal(row.totalSeconds, seconds, path);
    if (!path.startsWith('leaderboards/')) assert.equal(row.subjectSeconds.math, seconds, path);
  }
  await updateAccount.run({ auth, data: { displayName: '바뀐닉네임', totalSeconds: 999999 } });
  for (const [path, seconds] of expected) {
    if (!path.startsWith('leaderboards/')) continue;
    const row = (await db.doc(path).get()).data();
    assert.equal(row.displayName, '바뀐닉네임');
    assert.equal(row.totalSeconds, seconds);
  }
});

test('concurrent starts permit exactly one active session', async () => {
  const auth = { uid: 'concurrent-owner', token: { email_verified: true } };
  await ensureProfile.run({ auth, data: { displayName: '동시회원' } });
  const results = await Promise.allSettled([
    startStudySession.run({ auth, data: { subjectId: 'math' } }),
    startStudySession.run({ auth, data: { subjectId: 'english' } }),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected' && result.reason.code === 'already-exists').length, 1);
});

test('email registration/login/logout and Google credentials use Auth without creating DB profiles', async () => {
  clientApp = initializeApp({ apiKey: 'fake-emulator-key', projectId, authDomain: `${projectId}.firebaseapp.com` }, 'auth-test');
  const auth = getAuth(clientApp);
  connectAuthEmulator(auth, `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}`, { disableWarnings: true });
  const email = `study-${Date.now()}@example.test`;
  const password = 'Study-test-password-123';
  const signup = await createUserWithEmailAndPassword(auth, email, password);
  const uid = signup.user.uid;
  assert.equal((await getFirestore(undefined, 'study-data').doc(`users/${uid}`).get()).exists, false);
  await signOut(auth);
  const login = await signInWithEmailAndPassword(auth, email, password);
  assert.equal(login.user.uid, uid);
  await signOut(auth);
  const google = await signInWithCredential(auth, GoogleAuthProvider.credential(JSON.stringify({ sub: 'google-test-user', email: 'google@example.test', email_verified: true, name: 'Google Test' })));
  assert.equal(google.user.providerData[0].providerId, 'google.com');
  assert.equal((await getFirestore(undefined, 'study-data').doc(`users/${google.user.uid}`).get()).exists, false);
  await signOut(auth);
});
