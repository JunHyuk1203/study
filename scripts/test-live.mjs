// Explicit production smoke test: creates one temporary QA account and removes its own data.
// No real user's credentials or data are read. CLI access tokens stay in memory.
import { createRequire } from 'node:module';
import { randomBytes, randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { initializeApp as initializeClient, deleteApp as deleteClient } from 'firebase/app';
import { createUserWithEmailAndPassword, getAuth as clientAuth, signInWithEmailAndPassword, signOut } from 'firebase/auth';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { doc, getDoc, getFirestore as clientFirestore } from 'firebase/firestore';
import { firebaseConfig } from '../firebase-config.js';
import { splitStudyInterval, weekKey } from '../functions/domain.js';
import { briefingPeriod } from '../functions/briefing-period.js';

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
  const controllerId=randomUUID();
  const cameraStart=await invoke('startStudySession',{subjectId:'math',cameraMode:true,controllerId});
  sessionId=cameraStart.data.sessionId;
  assert.equal(cameraStart.data.session?.controllerId,controllerId,'Deployed start must return server session state');
  const synced=await invoke('syncStudyCamera',{sessionId,controllerId,tracking:true,sequence:1});
  assert.ok(Number.isFinite(synced.data.session?.activeSinceMs),'Deployed sync must return the authoritative timer window');
  await new Promise(resolve=>setTimeout(resolve,2200));
  await invoke('syncStudyCamera',{sessionId,controllerId,tracking:false,sequence:2});
  const cameraFinish=await invoke('finishStudySession',{sessionId});
  assert.equal(cameraFinish.data.studyRevision,2,'Each completed session invalidates cached statistics once');
  assert.ok(cameraFinish.data.creditedSeconds>=2&&cameraFinish.data.creditedSeconds<30);
  const period=briefingPeriod(),cachedText='배포 캐시 검증용 임시 브리핑';
  await adminDb.patch(`${documentRoot}/users/${uid}/integrations/briefing`,{fields:{
    date:{stringValue:period.date},periodId:{stringValue:period.id},text:{stringValue:cachedText},
    model:{stringValue:'gemini-3.8-flash'},updatedAt:{timestampValue:new Date().toISOString()},
  }});
  const briefing=await invoke('getStudyBriefing');
  assert.equal(briefing.data.text,cachedText);assert.equal(briefing.data.cached,true);assert.equal(briefing.data.periodId,period.id);
  successful = true;
  console.log('PASS: live email signup/login, account update, study start/finish, private stats, Focus Time, ranking, idempotent finish, camera server replies, cache revision and stored briefing reuse without AI generation.');
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
