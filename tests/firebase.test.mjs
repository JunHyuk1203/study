import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { collection, doc, getDoc, getDocs, limit, orderBy, query, setDoc } from 'firebase/firestore';
import { initializeApp, deleteApp } from 'firebase/app';
import { connectAuthEmulator, createUserWithEmailAndPassword, getAuth, GoogleAuthProvider, signInWithCredential, signInWithEmailAndPassword, signOut } from 'firebase/auth';
import { getFirestore, Timestamp } from '../functions/node_modules/firebase-admin/lib/firestore/index.js';
import { ensureProfile, finishStudySession, startStudySession, syncStudyCamera, updateAccount, updateStudyPlan, startWordStudy, syncWordStudy, closeExpiredWordStudies, prepareWordStudy } from '../functions/index.js';
import { splitStudyInterval } from '../functions/domain.js';
import { spendFocusTime } from '../functions/focus-time.js';
import { generateForUser } from '../functions/ai-service.js';
import { allowance, MONTHLY_LIMIT, tokenCost } from '../functions/ai-budget.js';
import { schoolDates } from '../functions/integrations-domain.js';
import { chatWithStudy, getAiUsage, getSchoolOverview, searchSchools, saveSchool } from '../functions/integrations.js';
import { schoolAgent } from '../functions/school-agent.js';
import { cachedBriefing } from '../functions/briefing-cache.js';
import { createDailyNeis } from '../functions/neis-cache.js';

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
  const client=environment.authenticatedContext('alice').firestore();
  await assertFails(getDoc(doc(client,'wordAccountLinks/alice')));
  await assertFails(setDoc(doc(client,'wordAccountLinks/alice'),{wordUid:'alice',studyUid:'bob'}));
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

test('custom subjects and goals are saved per account and only registered subjects can start', async () => {
  const auth={uid:'plan-owner',token:{email_verified:true}},db=getFirestore(undefined,'study-data');
  await assert.rejects(()=>updateStudyPlan.run({data:{action:'addSubject',name:'물리'}}),error=>error.code==='unauthenticated');
  await ensureProfile.run({auth,data:{displayName:'목표회원'}});
  await assert.rejects(()=>startStudySession.run({auth,data:{subjectId:'math'}}),error=>error.code==='invalid-argument');
  const subject=(await updateStudyPlan.run({auth,data:{action:'addSubject',name:'물리',uid:'other'}})).subject;
  const requests=[1,2].map(()=>updateStudyPlan.run({auth,data:{action:'addGoal',period:'week',minutes:300,subjectId:subject.id,totalSeconds:99999}}));
  const goals=await Promise.all(requests);assert.equal(goals[0].goal.id,goals[1].goal.id);
  const profile=(await db.doc('users/plan-owner').get()).data();
  assert.equal(profile.goals.length,1);assert.equal(profile.subjects.length,1);assert.equal(profile.totalSeconds,undefined);
  const {sessionId}=await startStudySession.run({auth,data:{subjectId:subject.id}});
  await assert.rejects(()=>updateStudyPlan.run({auth,data:{action:'removeSubject',id:subject.id}}),error=>error.code==='invalid-argument');
  await finishStudySession.run({auth,data:{sessionId}});
  await assert.rejects(()=>updateStudyPlan.run({auth,data:{action:'removeSubject',id:subject.id}}),error=>error.code==='invalid-argument');
  await updateStudyPlan.run({auth,data:{action:'removeGoal',id:goals[0].goal.id}});
  await updateStudyPlan.run({auth,data:{action:'removeSubject',id:subject.id}});
  assert.equal((await db.doc('users/plan-owner').get()).data().subjects.length,0);
});

test('session finish is idempotent and atomically updates statistics and ranking', async () => {
  const auth = { uid: 'study-owner', token: { email_verified: true } };
  const db = getFirestore(undefined, 'study-data');
  await ensureProfile.run({ auth, data: { displayName: '공부회원' } });
  const { sessionId } = await startStudySession.run({ auth, data: { subjectId: 'other', durationSeconds: 999999 } });
  await assert.rejects(() => startStudySession.run({ auth, data: { subjectId: 'other' } }), error => error.code === 'already-exists');
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
    if (!path.startsWith('leaderboards/')) assert.equal(row.subjectSeconds.other, seconds, path);
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
  const { sessionId } = await startStudySession.run({ auth, data: { subjectId: 'other', cameraMode: true, controllerId: '12345678-1234-1234-1234-123456789abc' } });
  const results = await Promise.all([finishStudySession.run({ auth, data: { sessionId } }), finishStudySession.run({ auth, data: { sessionId } })]);
  assert.ok(results.every(result => result.creditedSeconds === 0));
  assert.equal((await getFirestore(undefined, 'study-data').doc(`users/${auth.uid}/stats/focusTime`).get()).exists, false);
});

test('concurrent starts permit exactly one active session', async () => {
  const auth = { uid: 'concurrent-owner', token: { email_verified: true } };
  await ensureProfile.run({ auth, data: { displayName: '동시회원' } });
  const results = await Promise.allSettled([
    startStudySession.run({ auth, data: { subjectId: 'other' } }),
    startStudySession.run({ auth, data: { subjectId: 'other' } }),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected' && result.reason.code === 'already-exists').length, 1);
});

test('camera sessions enforce controller ownership, sequence and active-window credits', async () => {
  const auth = { uid: 'camera-owner', token: { email_verified: true } };
  const controllerId = '12345678-1234-1234-1234-123456789abc';
  const db = getFirestore(undefined, 'study-data');
  await ensureProfile.run({ auth, data: { displayName: '캠회원' } });
  const { sessionId, session: started } = await startStudySession.run({ auth, data: { subjectId: 'other', cameraMode: true, controllerId } });
  assert.equal(started.controllerId, controllerId);
  assert.equal(started.sequence, 0);
  assert.equal(started.activeSinceMs, null);
  assert.ok(Number.isFinite(started.startedAtMs));
  const request = { auth, data: { sessionId, controllerId, tracking: true, sequence: 1 } };
  await assert.rejects(() => syncStudyCamera.run({ ...request, auth: { uid: 'other', token: { email_verified: true } } }), error => error.code === 'failed-precondition');
  await assert.rejects(() => syncStudyCamera.run({ ...request, data: { ...request.data, controllerId: 'another' } }), error => error.code === 'permission-denied');
  const { session: synced } = await syncStudyCamera.run(request);
  const ref = db.doc(`users/${auth.uid}/sessions/${sessionId}`);
  const saved = (await ref.get()).data();
  assert.equal(synced.sequence, saved.sequence);
  assert.equal(synced.activeSinceMs, saved.activeSinceMs);
  assert.equal(synced.leaseUntilMs, saved.leaseUntilMs);
  assert.equal(synced.serverNowMs, saved.updatedAt.toMillis());
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
  assert.equal((await db.doc(`users/${auth.uid}`).get()).data().studyRevision,1);
  await assert.rejects(() => syncStudyCamera.run({ auth, data: { ...request.data, sequence: 3 } }), error => error.code === 'failed-precondition');
});

test('word auto sessions enforce ownership and reuse 영단어, then credit once with lease-capped time',async()=>{
  const db=getFirestore(undefined,'study-data'),auth={uid:'word-owner',token:{email_verified:true}};
  const controllerId='12345678-1234-1234-1234-123456789abc';
  await ensureProfile.run({auth,data:{displayName:'단어학습'}});
  await db.doc(`users/${auth.uid}`).update({subjects:[{id:'my_vocab',name:'영단어'}]});
  const started=await startWordStudy.run({auth,data:{controllerId}});
  assert.equal(started.session.subjectId,'my_vocab');
  assert.equal((await startWordStudy.run({auth,data:{controllerId}})).sessionId,started.sessionId);
  await assert.rejects(()=>startWordStudy.run({auth,data:{controllerId:'22345678-1234-1234-1234-123456789abc'}}),e=>e.code==='already-exists');
  const input={sessionId:started.sessionId,controllerId,sequence:1,tracking:true};
  await assert.rejects(()=>syncWordStudy.run({auth:{uid:'attacker',token:{email_verified:true}},data:input}),e=>e.code==='failed-precondition');
  await assert.rejects(()=>syncWordStudy.run({auth,data:{...input,controllerId:'22345678-1234-1234-1234-123456789abc'}}),e=>e.code==='permission-denied');
  await syncWordStudy.run({auth,data:input});
  assert.equal((await syncWordStudy.run({auth,data:input})).ignored,true);
  const time=Math.floor(Date.now()/1000)*1000;
  await db.doc(`users/${auth.uid}/sessions/${started.sessionId}`).update({startedAt:Timestamp.fromMillis(time-120000),activeSinceMs:time-60000,leaseUntilMs:time-30000});
  const finished=await finishStudySession.run({auth,data:{sessionId:started.sessionId}});
  assert.equal(finished.creditedSeconds,30);
  assert.equal((await finishStudySession.run({auth,data:{sessionId:started.sessionId}})).alreadyFinished,true);
  assert.equal((await db.doc(`users/${auth.uid}/stats/summary`).get()).data().totalSeconds,30);
  assert.equal((await db.doc(`wordStudyLeases/${started.sessionId}`).get()).exists,false);
  // Avoid a midnight boundary assumption: credited seconds may belong to yesterday.
  const stats=await db.collection(`users/${auth.uid}/dailyStats`).get();
  assert.equal(stats.docs.reduce((sum,row)=>sum+(row.data().subjectSeconds.my_vocab||0),0),30);
});

test('word cleanup closes expired leases and leaves renewed sessions active',async()=>{
  const db=getFirestore(undefined,'study-data'),auth={uid:'word-cleanup',token:{email_verified:true}},controllerId='12345678-1234-1234-1234-123456789abc';
  await ensureProfile.run({auth,data:{displayName:'단어정리'}});
  const started=await startWordStudy.run({auth,data:{controllerId}});
  assert.equal((await db.doc(`users/${auth.uid}`).get()).data().subjects[0].name,'영단어');
  await syncWordStudy.run({auth,data:{sessionId:started.sessionId,controllerId,sequence:1,tracking:true}});
  await db.doc(`wordStudyLeases/${started.sessionId}`).update({expiresAtMs:Date.now()-1000});
  await closeExpiredWordStudies.run({});
  assert.equal((await db.doc(`users/${auth.uid}/sessions/${started.sessionId}`).get()).data().status,'active');
  await db.doc(`users/${auth.uid}/sessions/${started.sessionId}`).update({leaseUntilMs:Date.now()-1000,presenceUntilMs:Date.now()-1000});
  await closeExpiredWordStudies.run({});
  assert.equal((await db.doc(`users/${auth.uid}/sessions/${started.sessionId}`).get()).data().status,'finished');
  assert.equal((await db.doc(`users/${auth.uid}`).get()).data().activeSessionId,null);
});

test('word handoff finishes camera before creating word session and blocks a concurrent camera restart',async()=>{
  const db=getFirestore(undefined,'study-data'),auth={uid:'word-camera-stop-ack',token:{email_verified:true}};
  const controllerId='12345678-1234-1234-1234-123456789abc',start=()=>startStudySession.run({auth,data:{subjectId:'other',cameraMode:true,controllerId}});
  await ensureProfile.run({auth,data:{displayName:'종료확인'}});
  const camera=await start(),now=Math.floor(Date.now()/1000)*1000,ref=db.doc(`users/${auth.uid}/sessions/${camera.sessionId}`);
  await ref.update({startedAt:Timestamp.fromMillis(now-10000),activeSinceMs:now-5000,leaseUntilMs:now+30000});
  await assert.rejects(()=>startWordStudy.run({auth,data:{controllerId}}),e=>e.code==='failed-precondition');
  assert.equal((await db.doc(`users/${auth.uid}`).get()).data().wordStudySessionId,undefined);
  const acks=await Promise.all([prepareWordStudy.run({auth,data:{}}),prepareWordStudy.run({auth,data:{}})]);
  assert.ok(acks.every(row=>row.cameraStopped));
  const stopped=(await ref.get()).data();assert.equal(stopped.status,'finished');assert.ok(stopped.creditedSeconds>=5);
  assert.equal((await db.doc(`users/${auth.uid}/stats/summary`).get()).data().sessionCount,1);
  await assert.rejects(start,e=>e.code==='failed-precondition');
  const word=await startWordStudy.run({auth,data:{controllerId}});
  assert.equal(word.session.cameraSessionId,null);
  assert.equal((await db.doc(`users/${auth.uid}`).get()).data().activeSessionId,word.sessionId);
  await assert.rejects(()=>syncStudyCamera.run({auth,data:{sessionId:camera.sessionId,controllerId,sequence:100,tracking:true}}),e=>e.code==='failed-precondition');
  assert.ok((await syncWordStudy.run({auth,data:{sessionId:word.sessionId,controllerId,sequence:1,tracking:true,present:true}})).session.activeSinceMs!=null);
  await finishStudySession.run({auth,data:{sessionId:word.sessionId}});
  assert.ok((await start()).sessionId);
  await assert.rejects(()=>prepareWordStudy.run({data:{}}),e=>e.code==='unauthenticated');
});

test('legacy overlapping sessions cannot credit word time until the active camera is finished',async()=>{
  const db=getFirestore(undefined,'study-data'),auth={uid:'word-camera-legacy',token:{email_verified:true}};
  const controllerId='12345678-1234-1234-1234-123456789abc';
  await ensureProfile.run({auth,data:{displayName:'기존기록전환'}});
  const camera=await startStudySession.run({auth,data:{subjectId:'other',cameraMode:true,controllerId}});
  const wordRef=db.collection(`users/${auth.uid}/sessions`).doc(),now=Timestamp.now();
  await wordRef.set({uid:auth.uid,subjectId:'other',source:'superword',activityMode:true,status:'active',controllerId,sequence:0,startedAt:now,createdAt:now,segments:[],accumulatedSeconds:0,activeSinceMs:null,leaseUntilMs:null,cameraSessionId:camera.sessionId});
  await db.doc(`users/${auth.uid}`).update({wordStudySessionId:wordRef.id,wordCameraSessionId:camera.sessionId});
  const input={sessionId:wordRef.id,controllerId,sequence:1,tracking:true,present:true};
  await assert.rejects(()=>syncWordStudy.run({auth,data:input}),e=>e.code==='failed-precondition');
  assert.equal((await wordRef.get()).data().activeSinceMs,null);
  await prepareWordStudy.run({auth,data:{}});
  assert.equal((await db.doc(`users/${auth.uid}/sessions/${camera.sessionId}`).get()).data().status,'finished');
  assert.ok((await syncWordStudy.run({auth,data:input})).session.activeSinceMs!=null);
  await finishStudySession.run({auth,data:{sessionId:wordRef.id}});
  assert.equal((await db.doc(`users/${auth.uid}`).get()).data().activeSessionId,null);
});

test('abandoned handoff reservations expire instead of permanently blocking study',async()=>{
  const db=getFirestore(undefined,'study-data'),auth={uid:'word-handoff-expiry',token:{email_verified:true}};
  const controllerId='12345678-1234-1234-1234-123456789abc',start=()=>startStudySession.run({auth,data:{subjectId:'other',cameraMode:true,controllerId}});
  await ensureProfile.run({auth,data:{displayName:'전환만료'}});
  await prepareWordStudy.run({auth,data:{}});
  await assert.rejects(start,e=>e.code==='failed-precondition');
  await db.doc(`users/${auth.uid}`).update({wordHandoffUntilMs:Date.now()-1});
  assert.ok((await start()).sessionId);
});

test('word heartbeat publishes canonical stats before finish and finish credits only the remaining delta',async()=>{
  const db=getFirestore(undefined,'study-data'),auth={uid:'word-live-ledger',token:{email_verified:true}},controllerId='12345678-1234-1234-1234-123456789abc';
  await ensureProfile.run({auth,data:{displayName:'실시간집계'}});
  const word=await startWordStudy.run({auth,data:{controllerId}}),ref=db.doc(`users/${auth.uid}/sessions/${word.sessionId}`),now=Math.floor(Date.now()/1000)*1000;
  await ref.update({startedAt:Timestamp.fromMillis(now-120000),activeSinceMs:now-10000,leaseUntilMs:now+30000});
  const input={sessionId:word.sessionId,controllerId,sequence:1,tracking:false,present:true};
  const synced=await syncWordStudy.run({auth,data:input}),settled=synced.session.accumulatedSeconds;
  let days=await db.collection(`users/${auth.uid}/dailyStats`).get();
  assert.ok(settled>=10);assert.equal(days.docs.reduce((sum,row)=>sum+row.data().totalSeconds,0),settled);
  assert.equal((await db.doc(`users/${auth.uid}`).get()).data().wordSnapshot.sessionId,word.sessionId);
  await syncWordStudy.run({auth,data:input});
  await ref.update({activeSinceMs:Math.floor(Date.now()/1000)*1000-5000,leaseUntilMs:Date.now()+30000});
  const finished=await finishStudySession.run({auth,data:{sessionId:word.sessionId}});
  await finishStudySession.run({auth,data:{sessionId:word.sessionId}});
  days=await db.collection(`users/${auth.uid}/dailyStats`).get();
  assert.equal(days.docs.reduce((sum,row)=>sum+row.data().totalSeconds,0),finished.creditedSeconds);
  assert.ok(finished.creditedSeconds>=settled+5);
  assert.equal((await db.doc(`users/${auth.uid}/stats/summary`).get()).data().totalSeconds,finished.creditedSeconds);
});

test('Firestore briefing cache serves a slot once and rejects simultaneous duplicate generation',async()=>{
  const db=getFirestore(undefined,'study-data'),user='briefing-cache-owner';
  let generated=0;
  const generate=async()=>({text:`브리핑 ${++generated}`});
  const first=await cachedBriefing({db,user,generate});
  assert.equal((await cachedBriefing({db,user,generate})).text,first.text);assert.equal(generated,1);
  assert.equal((await cachedBriefing({db,user,force:true,generate})).text,'브리핑 2');
  let resolve,entered;
  const started=new Promise(r=>{entered=r;});
  const pending=cachedBriefing({db,user,force:true,generate:()=>{entered();return new Promise(r=>{resolve=r;});}});
  await started;
  await assert.rejects(cachedBriefing({db,user,force:true,generate}),error=>error.code==='aborted');
  resolve({text:'새 브리핑'});await pending;
  assert.equal((await cachedBriefing({db,user,generate})).text,'새 브리핑');
});

test('NEIS daily cache survives function instance changes and remains server-only',async()=>{
  const db=getFirestore(undefined,'study-data');let calls=0;
  const fetchRows=async()=>{calls++;return [{AA_YMD:'20261022',EVENT_NM:'중간고사'}];};
  const params={SD_SCHUL_CODE:'qa-cache-school',AA_FROM_YMD:'20261001',AA_TO_YMD:'20261031'};
  const first=createDailyNeis({db,fetchRows}),second=createDailyNeis({db,fetchRows});
  assert.equal((await first('SchoolSchedule',params)).length,1);
  assert.equal((await second('SchoolSchedule',{...params,AA_FROM_YMD:'20261022',AA_TO_YMD:'20261022'})).length,1);
  assert.equal(calls,1);
  const rows=await db.collection('neisDailyCache').get();assert.equal(rows.size,1);
  const client=environment.authenticatedContext('alice').firestore();
  await assertFails(getDoc(doc(client,'neisDailyCache',rows.docs[0].id)));
  await assertFails(setDoc(doc(client,'neisDailyCache',rows.docs[0].id),{rows:[]}));
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
