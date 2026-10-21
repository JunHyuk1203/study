// Explicit production smoke test: creates one temporary QA account and removes its own data.
// No real user's credentials or data are read. CLI access tokens stay in memory.
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { initializeApp as initializeClient, deleteApp as deleteClient } from 'firebase/app';
import { createUserWithEmailAndPassword, getAuth as clientAuth, signInWithEmailAndPassword, signOut } from 'firebase/auth';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { doc, getDoc, getFirestore as clientFirestore } from 'firebase/firestore';
import { firebaseConfig } from '../firebase-config.js';
import { splitStudyInterval, weekKey } from '../functions/domain.js';

const require = createRequire(import.meta.url);
const functionRequire = createRequire(new URL('../functions/package.json', import.meta.url));
const cliAuth = require('firebase-tools/lib/auth');
const { requireAuth } = require('firebase-tools/lib/requireAuth');
const { initializeApp: initializeAdmin, deleteApp: deleteAdmin } = functionRequire('firebase-admin/app');
const { getAuth: adminAuth } = functionRequire('firebase-admin/auth');
const { Client } = require('firebase-tools/lib/apiv2');
const projectId = firebaseConfig.projectId;
const account = cliAuth.getProjectDefaultAccount(process.cwd());
if (!account) throw new Error('Firebase CLI login is required');
await requireAuth({ project: projectId, nonInteractive: true, ...account });
const administrator = initializeAdmin({ projectId, credential: {
  async getAccessToken() {
    const token = await cliAuth.getAccessToken(account.tokens.refresh_token, ['https://www.googleapis.com/auth/cloud-platform']);
    return { access_token: token.access_token, expires_in: token.expires_in || 3600 };
  },
} }, 'production-smoke-admin');
const adminDb = new Client({ urlPrefix: 'https://firestore.googleapis.com', auth: true });
const documentRoot = `/v1/projects/${projectId}/databases/study-data/documents`;
const app = initializeClient(firebaseConfig, 'production-smoke-client');
const auth = clientAuth(app);
const db = clientFirestore(app, 'study-data');
const functions = getFunctions(app, 'asia-northeast3');
const invoke = (name, data) => httpsCallable(functions, name)(data);
const marker = `qa-${randomBytes(10).toString('hex')}`;
const email = `${marker}@example.test`;
const password = randomBytes(24).toString('base64url');
let uid;
let sessionId;
let successful = false;
try {
  const signup = await createUserWithEmailAndPassword(auth, email, password);
  uid = signup.user.uid;
  await adminAuth(administrator).updateUser(uid, { emailVerified: true });
  await signOut(auth);
  await signInWithEmailAndPassword(auth, email, password);
  await invoke('ensureProfile', { displayName: '임시검증계정' });
  const profile = await getDoc(doc(db, 'users', uid));
  assert.equal(profile.data().uid, uid);
  await invoke('updateAccount', { displayName: '검증계정' });
  const start = await invoke('startStudySession', { subjectId: 'math' });
  sessionId = start.data.sessionId;
  await new Promise(resolve => setTimeout(resolve, 2200));
  const result = await invoke('finishStudySession', { sessionId, durationSeconds: 999999 });
  assert.ok(result.data.creditedSeconds >= 2 && result.data.creditedSeconds < 30);
  const repeat = await invoke('finishStudySession', { sessionId });
  assert.equal(repeat.data.alreadyFinished, true);
  const summary = await getDoc(doc(db, 'users', uid, 'stats', 'summary'));
  assert.equal(summary.data().totalSeconds, result.data.creditedSeconds);
  assert.equal(summary.data().sessionCount, 1);
  const wallet = await getDoc(doc(db, 'users', uid, 'stats', 'focusTime'));
  assert.equal(wallet.data().balanceSeconds, result.data.creditedSeconds);
  assert.equal(wallet.data().earnedSeconds, result.data.creditedSeconds);
  const session = (await getDoc(doc(db, 'users', uid, 'sessions', sessionId))).data();
  for (const segment of splitStudyInterval(session.startedAt.toMillis(), session.endedAt.toMillis())) {
    const rank = await getDoc(doc(db, 'leaderboards', segment.week, 'entries', uid));
    assert.equal(rank.data().totalSeconds, segment.seconds);
  }
  successful = true;
  console.log('PASS: live email signup/login, account creation/update, study start/finish, private stats, Focus Time credit without duplicate credit, ranking and idempotent finish.');
} finally {
  await signOut(auth).catch(() => {});
  if (uid) {
    const user = await adminAuth(administrator).getUser(uid);
    assert.equal(user.email, email, 'Cleanup must target only the account created by this test');
    const collections = await adminDb.post(`${documentRoot}/users/${uid}:listCollectionIds`, { pageSize: 100 });
    for (const collectionId of collections.body.collectionIds || []) {
      const rows = await adminDb.get(`${documentRoot}/users/${uid}/${collectionId}`, { queryParams: { pageSize: 100 } });
      for (const row of rows.body.documents || []) {
        assert.ok(row.name.startsWith(`projects/${projectId}/databases/study-data/documents/users/${uid}/`));
        await adminDb.delete(`/v1/${row.name}`);
      }
    }
    const weeks = new Set([Date.now(), Date.now() - 12 * 3600000].map(now => weekKey(new Date(now + 9 * 3600000).toISOString().slice(0, 10))));
    for (const week of weeks) await adminDb.delete(`${documentRoot}/leaderboards/${week}/entries/${uid}`);
    await adminDb.delete(`${documentRoot}/users/${uid}`);
    await adminAuth(administrator).deleteUser(uid);
    console.log('CLEANUP: temporary QA account, private study data and ranking entries removed.');
  }
  await deleteClient(app);
  await deleteAdmin(administrator);
}
if (!successful) process.exitCode = 1;
