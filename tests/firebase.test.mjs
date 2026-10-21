import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { collection, doc, getDoc, getDocs, limit, orderBy, query, setDoc } from 'firebase/firestore';
import { initializeApp, deleteApp } from 'firebase/app';
import { connectAuthEmulator, createUserWithEmailAndPassword, getAuth, GoogleAuthProvider, signInWithCredential, signInWithEmailAndPassword, signOut } from 'firebase/auth';
import { getFirestore, Timestamp } from '../functions/node_modules/firebase-admin/lib/firestore/index.js';
import { ensureProfile, finishStudySession, startStudySession, syncStudyCamera, updateAccount } from '../functions/index.js';
import { splitStudyInterval } from '../functions/domain.js';
import { spendFocusTime } from '../functions/focus-time.js';
import { generateForUser } from '../functions/ai-service.js';
import { allowance, MONTHLY_LIMIT, tokenCost } from '../functions/ai-budget.js';
import { schoolDates } from '../functions/integrations-domain.js';
import { chatWithStudy, getAiUsage, getSchoolOverview, searchSchools, saveSchool } from '../functions/integrations.js';
import { schoolAgent } from '../functions/school-agent.js';

const projectId = 'demo-study';
function mockProvider(context, generate) {
  const original=globalThis.fetch;
  globalThis.fetch=async(url,options)=>{
    if(String(url).includes('eurofxref'))return new Response("<Cube currency='USD' rate='1.2'/><Cube currency='KRW' rate='1800'/>");
    if(String(url).endsWith(':countTokens'))return Response.json({totalTokens:20});
    assert.ok(String(url).includes(':streamGenerateContent'));
    return generate(JSON.parse(options.body));
  };
  context.after(()=>{globalThis.fetch=original;});
}
function streamAnswer(body, finishReason='STOP') {
  return new Response(`data: ${JSON.stringify({candidates:[{content:{parts:[{text:'실제 스트림 부분 답변'}]},finishReason}],usageMetadata:{promptTokenCount:20,candidatesTokenCount:body.generationConfig.maxOutputTokens,thoughtsTokenCount:0}})}\n\n`,{headers:{'content-type':'text/event-stream'}});
}
let environment;
let clientApp;

test('integration callables require authentication and AI requires verified email',async()=>{
  for(const callable of [chatWithStudy,getAiUsage,getSchoolOverview,searchSchools,saveSchool])await assert.rejects(()=>callable.run({data:{}}),error=>error.code==='unauthenticated');
  await assert.rejects(()=>chatWithStudy.run({auth:{uid:'unverified',token:{email_verified:false}},data:{}}),error=>error.code==='failed-precondition');
});

test('Argon shares monthly ledger and rejects its third Korean-day generation',async context=>{
  let calls=0;mockProvider(context,body=>{calls++;return streamAnswer(body);});
  const args={user:'quota-argon',model:'gemini-4-argon',key:'test-only',contents:[{role:'user',parts:[{text:'질문'}]}],requested:128};
  await generateForUser(args);await generateForUser(args);
  await assert.rejects(()=>generateForUser(args),error=>error.code==='resource-exhausted'&&error.message.includes('하루 2회'));
  assert.equal(calls,2);
  const status=await getAiUsage.run({auth:{uid:args.user,token:{}},data:{}});
  assert.equal(status.argonRemaining,0);assert.ok(status.usedWon>0&&status.usedWon<=1000);
});

test('near monthly limit provider is capped mid-answer and tokens settle below 1000 won',async context=>{
  const user='quota-partial',model='gemini-4-argon',inputBound=278,rate=2640;
  const month=schoolDates().date.slice(0,7),ref=getFirestore('study-data').doc(`users/${user}/aiUsage/${month}`);
  await ref.set({spent:MONTHLY_LIMIT-tokenCost(model,inputBound,80,rate),reserved:0});
  let cap;mockProvider(context,body=>{cap=body.generationConfig.maxOutputTokens;return streamAnswer(body,'MAX_TOKENS');});
  const chunks=[];
  const result=await generateForUser({user,model,key:'test-only',contents:[{role:'user',parts:[{text:'질문'}]}],onChunk:text=>chunks.push(text)});
  assert.equal(cap,80);assert.equal(result.cutoff,true);assert.ok(chunks.length);assert.ok(result.text);
  const saved=(await ref.get()).data();assert.equal(saved.reserved,0);assert.ok(saved.spent<=MONTHLY_LIMIT);
});

test('streamed tool calls are metered, preserve signatures and do not consume an extra Argon daily use',async context=>{
  const user='quota-school-agent',model='gemini-4-argon';let calls=0;
  const args={start:'2026-11-02',end:'2026-11-02',types:['meals']};
  mockProvider(context,body=>{
    calls++;
    assert.ok(body.tools[0].functionDeclarations.length);
    if(calls===1){
      assert.equal(body.toolConfig.functionCallingConfig.mode,'AUTO');
      return new Response(`data: ${JSON.stringify({candidates:[{content:{parts:[{functionCall:{name:'get_school_data',args},thoughtSignature:'test-signature'}]},finishReason:'STOP'}],usageMetadata:{promptTokenCount:20,candidatesTokenCount:10}})}\n\n`);
    }
    assert.equal(body.toolConfig.functionCallingConfig.mode,'NONE');
    assert.equal(body.contents.at(-2).parts[0].thoughtSignature,'test-signature');
    assert.equal(body.contents.at(-1).parts[0].functionResponse.response.meals[0].name,'중식');
    return streamAnswer(body);
  });
  const result=await schoolAgent({school:{name:'테스트학교',kind:'중학교',officeCode:'B10',schoolCode:'7010057',grade:'2',className:'3'},
    contents:[{role:'user',parts:[{text:'11월 2일 급식 알려줘'}]}],
    lookup:async()=>[{MLSV_YMD:'20261102',MMEAL_SC_NM:'중식',DDISH_NM:'밥<br>국'}],
    generate:options=>generateForUser({...options,user,model,key:'test-only',requested:128})});
  assert.equal(calls,2);assert.ok(result.text);assert.equal(result.usage.argonRemaining,1);
  const monthly=(await getFirestore('study-data').doc(`users/${user}/aiUsage/${schoolDates().date.slice(0,7)}`).get()).data();
  assert.equal(monthly.reserved,0);assert.ok(monthly.spent>0);
});

test('simultaneous requests reserve balance atomically across models',async context=>{
  const user='quota-parallel',model='gemini-3.8-flash',rate=2640;
  const quote=allowance({model,inputTokens:20,exchangeRate:rate});
  const ref=getFirestore('study-data').doc(`users/${user}/aiUsage/${schoolDates().date.slice(0,7)}`);
  await ref.set({spent:MONTHLY_LIMIT-quote.amount,reserved:0});
  let enter,release;const entered=new Promise(resolve=>{enter=resolve}),waiting=new Promise(resolve=>{release=resolve});
  mockProvider(context,async body=>{enter();await waiting;return streamAnswer(body);});
  const args={user,model,key:'test-only',contents:[{role:'user',parts:[{text:'질문'}]}]};
  const first=generateForUser(args);await entered;
  try{await assert.rejects(()=>generateForUser({...args,model:'gemini-4-argon'}),error=>error.code==='resource-exhausted');}finally{release();}
  await first;const saved=(await ref.get()).data();assert.equal(saved.reserved,0);assert.ok(saved.spent<=MONTHLY_LIMIT);
});

test('ambiguous provider failures retain reserved cost and clients cannot alter usage',async context=>{
  mockProvider(context,()=>{throw new Error('provider contained test-private-key');});
  const user='quota-failure';
  await assert.rejects(()=>generateForUser({user,model:'gemini-3.8-flash',key:'test-only',contents:[{role:'user',parts:[{text:'질문'}]}]}),error=>error.code==='unavailable'&&!error.message.includes('private'));
  const path=`users/${user}/aiUsage/${schoolDates().date.slice(0,7)}`;
  const saved=(await getFirestore('study-data').doc(path).get()).data();assert.equal(saved.reserved,0);assert.ok(saved.spent>0);
  const client=environment.authenticatedContext(user).firestore();
  await assertFails(setDoc(doc(client,path),{spent:0,reserved:0}));
  await assertFails(setDoc(doc(client,`users/${user}/aiDaily/${schoolDates().date}`),{argonCalls:0}));
  await assertFails(getDoc(doc(client,'aiReservations/private')));
});

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
    ['users/alice/stats/focusTime', { balanceSeconds: 999999 }],
    ['users/alice/focusTimeTransactions/spend_fake', { type: 'spend', seconds: 1 }],
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
  const wallet = (await db.doc(`users/${auth.uid}/stats/focusTime`).get()).data();
  assert.equal(wallet.balanceSeconds, first.creditedSeconds);
  assert.equal(wallet.earnedSeconds, first.creditedSeconds);
  assert.equal((await db.doc(`users/${auth.uid}/focusTimeTransactions/earn_${sessionId}`).get()).data().seconds, first.creditedSeconds);
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

test('Focus Time spending is atomic, retryable and independent of study totals', async () => {
  const db = getFirestore(undefined, 'study-data');
  const uid = 'focus-buyer';
  const wallet = db.doc(`users/${uid}/stats/focusTime`);
  const summary = db.doc(`users/${uid}/stats/summary`);
  await wallet.set({ balanceSeconds: 100, earnedSeconds: 100 });
  await summary.set({ totalSeconds: 500 });
  const purchase = { uid, purchaseId: 'one', itemId: 'hat', costSeconds: 60 };
  const grant = transaction => transaction.set(db.doc(`users/${uid}/inventory/hat`), { owned: true });
  const results = await Promise.all([spendFocusTime(db, purchase, grant), spendFocusTime(db, purchase, grant)]);
  assert.equal(results.filter(result => !result.alreadySpent).length, 1);
  assert.equal((await wallet.get()).data().balanceSeconds, 40);
  assert.equal((await wallet.get()).data().spentSeconds, 60);
  assert.equal((await db.doc(`users/${uid}/inventory/hat`).get()).data().owned, true);
  await assert.rejects(() => spendFocusTime(db, { ...purchase, itemId: 'other' }), error => error.code === 'already-exists');
  await assert.rejects(() => spendFocusTime(db, { ...purchase, purchaseId: 'two' }), error => error.code === 'failed-precondition');
  for (const costSeconds of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(() => spendFocusTime(db, { ...purchase, costSeconds }), error => error.code === 'invalid-argument');
  }
  await assert.rejects(() => spendFocusTime(db, { ...purchase, purchaseId: 'failed-grant', costSeconds: 10 }, () => { throw new Error('grant failed'); }));
  assert.equal((await wallet.get()).data().balanceSeconds, 40);
  assert.equal((await summary.get()).data().totalSeconds, 500);
  assert.equal((await db.doc(`users/${uid}/focusTimeTransactions/spend_failed-grant`).get()).exists, false);
  await assert.rejects(() => spendFocusTime(db, { ...purchase, uid: 'no-wallet' }), error => error.code === 'failed-precondition');
  const competing = await Promise.allSettled(['a', 'b'].map(purchaseId => spendFocusTime(db, { ...purchase, purchaseId, costSeconds: 30 })));
  assert.equal(competing.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal((await wallet.get()).data().balanceSeconds, 10);
});

test('zero-credit camera completion creates no currency', async () => {
  const auth = { uid: 'focus-zero', token: { email_verified: true } };
  await ensureProfile.run({ auth, data: { displayName: '일시정지' } });
  const { sessionId } = await startStudySession.run({ auth, data: { subjectId: 'math', cameraMode: true, controllerId: '12345678-1234-1234-1234-123456789abc' } });
  const results = await Promise.all([finishStudySession.run({ auth, data: { sessionId } }), finishStudySession.run({ auth, data: { sessionId } })]);
  assert.ok(results.every(result => result.creditedSeconds === 0));
  assert.equal((await getFirestore(undefined, 'study-data').doc(`users/${auth.uid}/stats/focusTime`).get()).exists, false);
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

test('camera sessions enforce controller ownership, sequence and active-window credits', async () => {
  const auth = { uid: 'camera-owner', token: { email_verified: true } };
  const controllerId = '12345678-1234-1234-1234-123456789abc';
  const db = getFirestore(undefined, 'study-data');
  await ensureProfile.run({ auth, data: { displayName: '캠회원' } });
  const { sessionId } = await startStudySession.run({ auth, data: { subjectId: 'math', cameraMode: true, controllerId } });
  const request = { auth, data: { sessionId, controllerId, tracking: true, sequence: 1 } };
  await assert.rejects(() => syncStudyCamera.run({ ...request, auth: { uid: 'other', token: { email_verified: true } } }), error => error.code === 'failed-precondition');
  await assert.rejects(() => syncStudyCamera.run({ ...request, data: { ...request.data, controllerId: 'another' } }), error => error.code === 'permission-denied');
  await syncStudyCamera.run(request);
  const ref = db.doc(`users/${auth.uid}/sessions/${sessionId}`);
  const now = Math.floor(Date.now() / 1000) * 1000;
  await ref.update({ startedAt: Timestamp.fromMillis(now - 120000), activeSinceMs: now - 60000, leaseUntilMs: now - 30000 });
  await syncStudyCamera.run({ auth, data: { sessionId, controllerId, tracking: false, sequence: 2 } });
  assert.equal((await ref.get()).data().accumulatedSeconds, 30);
  assert.equal((await syncStudyCamera.run(request)).ignored, true);
  assert.equal((await ref.get()).data().activeSinceMs, null);
  const finished = await finishStudySession.run({ auth, data: { sessionId, durationSeconds: 999999 } });
  assert.equal(finished.creditedSeconds, 30);
  assert.equal((await db.doc(`users/${auth.uid}/stats/focusTime`).get()).data().balanceSeconds, 30);
  assert.equal((await db.doc(`users/${auth.uid}/stats/summary`).get()).data().totalSeconds, 30);
  assert.equal((await finishStudySession.run({ auth, data: { sessionId } })).creditedSeconds, 30);
  await assert.rejects(() => syncStudyCamera.run({ auth, data: { ...request.data, sequence: 3 } }), error => error.code === 'failed-precondition');
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
