import {test,after,before} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {signedFaceRequest} from './face-fixtures.mjs';

const connection=process.env.STUDY_TEST_DATABASE_URL;
if(!connection||!new URL(connection).pathname.startsWith('/study_selfhost_test'))throw new Error('Run server/test-selfhost.ps1 with a dedicated test DB');
process.env.STUDY_BACKEND='selfhost';process.env.DATABASE_URL=connection;
process.env.GCLOUD_PROJECT='demo-study';
const {getFirestore,Timestamp,FieldValue}=await import('../functions/platform-store.js');
const {createApi,authorizeRead}=await import('../functions/selfhost-server.js');
const handlers=await import('../functions/index.js');
const {createWordLinkService}=await import('../functions/word-link-service.js');
const {creditFocusTime,spendFocusTime}=await import('../functions/focus-time.js');
const db=getFirestore();let api,base;
const identity=uid=>({uid,exp:Math.floor(Date.now()/1000)+3600,email_verified:uid!=='unverified'});
const req=(uid,data)=>({auth:{uid,token:identity(uid)},data});
const rpc=async(name,uid,data={})=>handlers[name](name==='syncStudyCamera'||name==='startStudySession'&&data.cameraMode?await signedFaceRequest(db,req(uid,data)):req(uid,data));
before(async()=>{
  await db.ready;await db.pool.query('TRUNCATE study_documents');
  api=createApi({db,allowedOrigins:['https://study.junhyuk.site','https://word.junhyuk.site'],verifyToken:async token=>{
    if(!['alice','bob','unverified'].includes(token))throw new Error('invalid');return identity(token);
  }});
  await new Promise(resolve=>api.server.listen(0,'127.0.0.1',resolve));base=`http://127.0.0.1:${api.server.address().port}`;
});
after(async()=>{await api?.close();await db.close();});
test('face RPC requires the canonical origin and fresh revocation checks with no-store responses',async()=>{
  const checks=[];
  const endpoint=Object.assign(request=>({fresh:request.faceTokenFresh,origin:request.faceOrigin}),{studyKind:'callable'});
  const isolated=createApi({db,allowedOrigins:['https://study.junhyuk.site','https://word.junhyuk.site'],callables:{getFaceEnrollmentStatus:endpoint},verifyToken:async(_,options)=>{checks.push(options);return identity('alice');}});
  await new Promise(resolve=>isolated.server.listen(0,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${isolated.server.address().port}/api/v1/rpc/getFaceEnrollmentStatus`;
  try{
    for(const origin of [null,'https://word.junhyuk.site'])assert.equal((await fetch(url,{method:'POST',headers:{Authorization:'Bearer alice','Content-Type':'application/json',...(origin?{Origin:origin}:{})},body:'{"data":{}}'})).status,403);
    const response=await fetch(url,{method:'POST',headers:{Authorization:'Bearer alice','Content-Type':'application/json',Origin:'https://study.junhyuk.site'},body:'{"data":{}}'});
    assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(response.status,200);assert.equal((await response.json()).data.fresh,true);assert.deepEqual(checks,[{checkRevoked:true}]);
  }finally{await isolated.close();}
});
test('legacy camera clients cannot create a verified study session without a device proof',async()=>{
  await assert.rejects(handlers.startStudySession(req('alice',{cameraMode:true,controllerId:randomUUID(),subjectId:'other'})),{code:'failed-precondition'});
  for(const path of ['faceSecurity/alice','faceSecurityRates/alice'])await assert.rejects(authorizeRead(db,'alice',{kind:'doc',path}),{code:'permission-denied'});
});
const post=(path,token,data,origin='https://study.junhyuk.site')=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`,Origin:origin},body:JSON.stringify(data)});
async function browserTransport(refresh=false) {
  let source=await readFile(new URL('../server-client.js',import.meta.url),'utf8');
  source=source.replace(/^import .*from '\.\/auth\.js[^']*';\r?\n/m,`const authReady=Promise.resolve(true);const getAuthUser=()=>({getIdToken:async force=>${refresh?"force?'alice':'bad'":"'alice'"}});\n`);
  source=source.replace(/^import .*from '\.\/backend-config\.js[^']*';\r?\n/m,`const backendConfig={apiBaseUrl:${JSON.stringify(base)}};\n`);
  return import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
}

test('PostgreSQL store preserves deep merge, shallow update, delete and timestamp precision',async()=>{
  const ref=db.doc('adapter/value'),stamp=new Timestamp(1792800000,123456789);
  await ref.set({nested:{a:1,b:2},total:1,stamp});
  await ref.set({nested:{a:FieldValue.increment(2)}},{merge:true});
  assert.deepEqual((await ref.get()).data().nested,{a:3,b:2});
  await ref.update({nested:{c:3},'extra.count':FieldValue.increment(4)});
  assert.deepEqual((await ref.get()).data().nested,{c:3});
  await ref.update({'nested.c':FieldValue.delete()});
  const value=(await ref.get()).data();assert.deepEqual(value.nested,{});assert.equal(value.extra.count,4);assert.ok(value.stamp.isEqual(stamp));
  await assert.rejects(db.doc('adapter/missing').update({a:1}),{code:'not-found'});
  await assert.rejects(ref.create({a:1}),{code:'already-exists'});
});
test('concurrent cross-document transactions have no lost updates and failed writes roll back',async()=>{
  const a=db.doc('atomic/a'),b=db.doc('atomic/b');await a.set({n:0});await b.set({n:0});
  await Promise.all(Array.from({length:24},()=>db.runTransaction(async tx=>{
    const one=(await tx.get(a)).data();tx.update(a,{n:one.n+1});tx.set(b,{n:FieldValue.increment(1)},{merge:true});
  })));
  assert.equal((await a.get()).data().n,24);assert.equal((await b.get()).data().n,24);
  await assert.rejects(db.runTransaction(async tx=>{tx.update(a,{n:99});tx.update(db.doc('atomic/missing'),{n:1});}));
  assert.equal((await a.get()).data().n,24);
});
test('queries preserve tie ordering, missing-field filtering, ranges and deleted snapshot cursors',async()=>{
  const collection=db.collection('queryRows');
  for(const [id,data] of [['a',{n:1}],['b',{n:1}],['c',{n:2}],['d',{}]])await collection.doc(id).set(data);
  const first=await collection.orderBy('n').limit(1).get();await first.docs[0].ref.delete();
  const rest=await collection.orderBy('n').startAfter(first.docs[0]).get();assert.deepEqual(rest.docs.map(row=>row.id),['b','c']);
  assert.deepEqual((await collection.orderBy('__name__').startAt('b').endAt('c').get()).docs.map(row=>row.id),['b','c']);
  const timestamps=db.collection('stampRows');await timestamps.doc('a').set({at:new Timestamp(100,1)});await timestamps.doc('b').set({at:new Timestamp(100,2)});
  assert.deepEqual((await timestamps.where('at','>=',new Timestamp(100,2)).get()).docs.map(row=>row.id),['b']);
});
test('HTTP rejects unauthenticated, foreign-origin and cross-user private reads',async()=>{
  assert.equal((await post('/api/v1/read','bad',{kind:'doc',path:'users/alice'})).status,401);
  assert.equal((await post('/api/v1/read','alice',{kind:'doc',path:'users/alice'},'https://evil.example')).status,403);
  assert.equal((await post('/api/v1/read','alice',{kind:'doc',path:'users/bob'})).status,403);
  assert.equal((await post('/api/v1/read','alice',{kind:'query',path:'users/alice/sessions',limit:51})).status,400);
  assert.equal((await post('/api/v1/rpc/cleanupIdleStudyRooms','alice',{data:{}})).status,404);
  assert.equal((await post('/api/v1/read','alice',{kind:'doc',path:'wordAccountLinks/secret'})).status,403);
});
test('SP word custom domain passes browser preflight while foreign origins remain blocked',async()=>{
  const preflight=origin=>fetch(base+'/api/v1/rpc/startWordStudy',{method:'OPTIONS',headers:{Origin:origin,'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'authorization,content-type'}});
  const response=await preflight('https://word.junhyuk.site');
  assert.equal(response.status,204);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'),'https://word.junhyuk.site');
  assert.match(response.headers.get('Access-Control-Allow-Headers'),/Authorization/);
  assert.equal((await preflight('https://word.junhyuk.site.evil.example')).status,403);
  const launcher=await readFile(new URL('../server/launcher/Program.cs',import.meta.url),'utf8');
  assert.match(launcher,/settings\.AllowedOrigins\.Split[\s\S]*?Contains\("https:\/\/word\.junhyuk\.site", StringComparer\.OrdinalIgnoreCase\)/);
});

test('Word restoration verifies its own token without requiring a Study session',async()=>{
  const wordToken='verified-word-token'.repeat(3);
  const service=createWordLinkService({db,now:()=>Timestamp.now(),verifyWordToken:async token=>{
    if(token!==wordToken)throw new Error('invalid signature');return {uid:'word-restore',email_verified:true};
  },getStudyUser:async uid=>({uid,emailVerified:true}),mintToken:async uid=>`custom:${uid}`});
  await db.doc('wordAccountLinks/word-restore').set({studyUid:'alice'});
  const restore=Object.assign(request=>service.restore(request),{studyKind:'callable'});
  const local=createApi({db,allowedOrigins:['https://junhyuk1203.github.io'],verifyToken:async()=>{throw new Error('no Study login');},callables:{...handlers,restoreWordStudyLink:restore}});
  await new Promise(resolve=>local.server.listen(0,'127.0.0.1',resolve));
  const send=async(name,data)=>fetch(`http://127.0.0.1:${local.server.address().port}/api/v1/rpc/${name}`,{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://junhyuk1203.github.io'},body:JSON.stringify({data})});
  try {
    const result=await send('restoreWordStudyLink',{wordIdToken:wordToken});
    assert.equal(result.status,200);assert.deepEqual(await result.json(),{data:{linked:true,token:'custom:alice'}});
    assert.equal((await send('restoreWordStudyLink',{wordIdToken:'invalid'.repeat(8)})).status,401);
    assert.equal((await send('saveWordStudyLink',{wordIdToken:wordToken})).status,401);
    assert.equal((await send('startWordStudy',{})).status,401);
  }finally{await local.close();}
});

test('existing Firebase UIDs create fresh local profiles and plans',async()=>{
  for(const uid of ['alice','bob','unverified'])await rpc('ensureProfile',uid,{displayName:uid==='alice'?'앨리스':'스터디'});
  const response=await post('/api/v1/read','alice',{kind:'doc',path:'users/alice'});assert.equal(response.status,200);
  assert.equal((await response.json()).data.uid,'alice');
  await rpc('updateStudyPlan','alice',{action:'addSubject',name:'자체 과목'}).catch(async error=>{
    // Use the production action names, with failure evidence rather than accepting a no-op.
    throw error;
  });
  assert.ok((await db.doc('users/alice').get()).data().subjects.length);
});
test('school ranking permission checks the authenticated profile school',async()=>{
  await db.doc('users/alice').update({schoolId:'school-A'});
  await assert.rejects(authorizeRead(db,'alice',{kind:'query',path:'schoolLeaderboards/school-B/weeks/2026-10-19/entries',limit:50}),{code:'permission-denied'});
  await authorizeRead(db,'alice',{kind:'query',path:'schoolLeaderboards/school-A/weeks/2026-10-19/entries',limit:50});
});
test('manual study start is exclusive and concurrent finish saves once without face rewards',async()=>{
  const subject=(await db.doc('users/alice').get()).data().subjects[0];
  const outcomes=await Promise.allSettled([rpc('startStudySession','alice',{subjectId:subject.id,controllerId:'controller'}),rpc('startStudySession','alice',{subjectId:subject.id,controllerId:'controller'})]);
  assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);
  const id=outcomes.find(x=>x.status==='fulfilled').value.sessionId;
  await db.doc(`users/alice/sessions/${id}`).update({startedAt:Timestamp.fromMillis(Date.now()-5000),presenceUntilMs:Date.now()+10000});
  const finished=await Promise.all(Array.from({length:8},()=>rpc('finishStudySession','alice',{sessionId:id})));
  assert.equal(finished.filter(row=>!row.alreadyFinished).length,1);
  const wallet=(await db.doc('users/alice/stats/focusTime').get()).data();
  assert.equal(wallet?.earnedSeconds||0,0);assert.ok(finished[0].creditedSeconds>=4);
});
test('unverified accounts cannot start study or use social APIs',async()=>{
  await assert.rejects(rpc('startStudySession','unverified',{subjectId:'english'}),{code:'failed-precondition'});
  await assert.rejects(rpc('getStudySocial','unverified',{}),{code:'failed-precondition'});
});
test('friend code and request acceptance update both sides atomically',async()=>{
  const {code}=await rpc('updateStudySocial','bob',{action:'code'});
  await rpc('updateStudySocial','alice',{action:'request',code});await rpc('updateStudySocial','bob',{action:'accept',uid:'alice'});
  assert.equal((await db.doc('users/alice/friends/bob').get()).data().uid,'bob');
  assert.equal((await db.doc('users/bob/friends/alice').get()).data().uid,'alice');
  assert.equal((await db.doc('users/alice/sentRequests/bob').get()).exists,false);
});
test('HTTP watch sends initial state and committed changes only',async()=>{
  const controller=new AbortController();
  const response=await fetch(base+'/api/v1/watch',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer alice'},body:JSON.stringify({kind:'doc',path:'users/alice'}),signal:controller.signal});
  const reader=response.body.getReader(),decoder=new TextDecoder();let pending='';
  async function line(){while(!pending.includes('\n')){const {value,done}=await reader.read();if(done)throw new Error('Watch closed');pending+=decoder.decode(value);}const index=pending.indexOf('\n'),value=JSON.parse(pending.slice(0,index));pending=pending.slice(index+1);return value;}
  try {assert.equal((await line()).data.uid,'alice');await db.doc('users/alice').update({displayName:'변경된 이름'});assert.equal((await line()).data.displayName,'변경된 이름');}
  finally{controller.abort();await reader.cancel().catch(()=>{});}
});
test('RPC errors remain structured and internal details are not returned',async()=>{
  const response=await post('/api/v1/rpc/updateAccount','alice',{data:{displayName:'x'}});const result=await response.json();
  assert.equal(response.status,400);assert.equal(result.error.code,'invalid-argument');
  assert.equal((await post('/api/v1/rpc/constructor','alice',{data:{}})).status,404);
});
test('camera and word handoff preserves mutual exclusion and duplicate event boundaries',async()=>{
  const uid='camera-word',cameraId=randomUUID(),wordController=randomUUID();
  await rpc('ensureProfile',uid,{displayName:'카메라 단어'});
  const camera=await rpc('startStudySession',uid,{subjectId:'other',cameraMode:true,controllerId:cameraId});
  const event={sessionId:camera.sessionId,controllerId:cameraId,sequence:1,tracking:true,eventId:'initial-event',clientEpoch:1};
  await rpc('syncStudyCamera',uid,event);assert.equal((await rpc('syncStudyCamera',uid,event)).ignored,true);
  const word=await rpc('startWordStudy',uid,{controllerId:wordController,tracking:true});
  const ref=db.doc(`users/${uid}/sessions/${camera.sessionId}`);
  let current=(await ref.get()).data();assert.equal(current.wordPaused,true);assert.equal(current.activeSinceMs,null);
  await rpc('syncWordStudy',uid,{sessionId:word.sessionId,controllerId:wordController,sequence:1,tracking:false,present:false});
  current=(await ref.get()).data();assert.equal(current.wordPaused,false);
  await rpc('syncStudyCamera',uid,{...event,sequence:current.sequence+1,eventId:'resume-event'});
  assert.notEqual((await ref.get()).data().activeSinceMs,null);
  await ref.update({presenceUntilMs:Date.now()-1});await rpc('expireStudySessions',uid,{});
  assert.equal((await ref.get()).data().status,'finished');
  await rpc('finishStudySession',uid,{sessionId:word.sessionId});
});
test('word takeover atomically settles the old device and prevents stale heartbeats and finishes from touching the new device',async()=>{
  const uid='word-device-owner',firstController=randomUUID(),secondController=randomUUID();
  await rpc('ensureProfile',uid,{displayName:'단일 기기'});
  const old=await rpc('startWordStudy',uid,{controllerId:firstController,tracking:true});
  const now=Math.floor(Date.now()/1000)*1000;
  const oldRef=db.doc(`users/${uid}/sessions/${old.sessionId}`);
  await oldRef.update({startedAt:Timestamp.fromMillis(now-10000),activeSinceMs:now-5000,leaseUntilMs:now+10000});
  await assert.rejects(rpc('startWordStudy',uid,{controllerId:secondController,tracking:true}),{code:'already-exists'});
  const next=await rpc('startWordStudy',uid,{controllerId:secondController,tracking:true,takeover:true});
  assert.notEqual(next.sessionId,old.sessionId);
  const settled=(await oldRef.get()).data();
  assert.equal(settled.status,'finished');assert.equal(settled.terminalReason,'session-replaced');assert.equal(settled.replacedBySessionId,next.sessionId);
  assert.ok(settled.creditedSeconds>=5);assert.ok(settled.endedAt.toMillis()<=next.session.activeSinceMs);
  await assert.rejects(rpc('syncWordStudy',uid,{sessionId:old.sessionId,controllerId:firstController,sequence:999,tracking:true,present:true}),error=>error.details?.terminalReason==='session-replaced');
  await assert.rejects(rpc('startWordStudy',uid,{controllerId:firstController,tracking:true,takeover:true}),error=>error.details?.terminalReason==='session-replaced');
  const total=(await db.doc(`users/${uid}/stats/summary`).get()).data().totalSeconds;
  await rpc('finishStudySession',uid,{sessionId:old.sessionId});
  assert.equal((await db.doc(`users/${uid}`).get()).data().wordStudySessionId,next.sessionId);
  assert.equal((await db.doc(`users/${uid}/stats/summary`).get()).data().totalSeconds,total);
  assert.equal((await db.doc(`wordStudyLeases/${old.sessionId}`).get()).exists,false);
  await assert.rejects(rpc('syncWordStudy',uid,{sessionId:next.sessionId,controllerId:firstController,sequence:1,tracking:true,present:true}),{code:'permission-denied'});
  await rpc('finishStudySession',uid,{sessionId:next.sessionId});
});

test('simultaneous word takeovers leave exactly one active server session',async()=>{
  const uid='word-device-race';await rpc('ensureProfile',uid,{displayName:'기기 경합'});
  const starts=await Promise.all(Array.from({length:4},()=>rpc('startWordStudy',uid,{controllerId:randomUUID(),tracking:true,takeover:true})));
  const profile=(await db.doc(`users/${uid}`).get()).data();
  const sessions=await Promise.all(starts.map(row=>db.doc(`users/${uid}/sessions/${row.sessionId}`).get()));
  assert.equal(sessions.filter(row=>row.data().status==='active').length,1);
  assert.equal(sessions.find(row=>row.data().status==='active').id,profile.wordStudySessionId);
  await rpc('finishStudySession',uid,{sessionId:profile.wordStudySessionId});
});

test('word device takeover keeps camera handoff exclusive and clears the old lease',async()=>{
  const uid='word-device-camera';await rpc('ensureProfile',uid,{displayName:'카메라 기기'});
  const camera=await rpc('startStudySession',uid,{controllerId:randomUUID(),subjectId:'other',cameraMode:true});
  const first=await rpc('startWordStudy',uid,{controllerId:randomUUID(),tracking:true});
  const next=await rpc('startWordStudy',uid,{controllerId:randomUUID(),tracking:true,takeover:true});
  const saved=(await db.doc(`users/${uid}/sessions/${camera.sessionId}`).get()).data();
  assert.equal(saved.wordSessionId,next.sessionId);assert.equal(saved.wordPaused,true);assert.equal(saved.activeSinceMs,null);
  assert.equal((await db.doc(`wordStudyLeases/${first.sessionId}`).get()).exists,false);
  await rpc('finishStudySession',uid,{sessionId:next.sessionId});await rpc('finishStudySession',uid,{sessionId:camera.sessionId});
});

test('private room code joins and final departure remove room and code mappings',async()=>{
  const {roomId}=await rpc('updateStudySocial','alice',{action:'createRoom',title:'시험 스터디',visibility:'private'});
  const {code}=await rpc('updateStudySocial','alice',{action:'roomCode',roomId});
  await rpc('updateStudySocial','bob',{action:'joinCode',code});
  assert.equal((await db.doc(`studyRooms/${roomId}`).get()).data().memberIds.length,2);
  await rpc('updateStudySocial','bob',{action:'leave',roomId});await rpc('updateStudySocial','alice',{action:'leave',roomId});
  assert.equal((await db.doc(`studyRooms/${roomId}`).get()).exists,false);
  assert.equal((await db.doc(`roomCodes/${code}`).get()).exists,false);
});
test('NEIS requests share a persisted daily result without repeating upstream work',async()=>{
  const {createDailyNeis}=await import('../functions/neis-cache.js');let calls=0;
  const settings={db,fetchRows:async()=>{calls++;return [{name:'테스트 학교'}];}};
  const first=createDailyNeis(settings);
  const results=await Promise.all(Array.from({length:8},()=>first('schoolInfo',{SCHUL_NM:'테스트'})));
  assert.equal(calls,1);assert.equal(results[0][0].name,'테스트 학교');
  const another=createDailyNeis(settings);await another('schoolInfo',{SCHUL_NM:'테스트'});assert.equal(calls,1);
});
test('AI reservations enforce daily concurrency limits and HTTP streaming settles local usage',async()=>{
  const {generateForUser,usageFor}=await import('../functions/ai-service.js');
  const original=globalThis.fetch;process.env.GOOGLE_AI_API_KEY='test-only';
  globalThis.fetch=async(url,options)=>{
    const value=String(url);if(value.startsWith(base))return original(url,options);
    if(value.includes('ecb.europa.eu'))return new Response('<Cube currency="USD" rate="1.1"/><Cube currency="KRW" rate="1500"/>');
    if(value.endsWith(':countTokens'))return Response.json({totalTokens:50});
    if(value.includes(':streamGenerateContent'))return new Response('data: '+JSON.stringify({candidates:[{content:{parts:[{text:'검증 답변'}]},finishReason:'STOP'}],usageMetadata:{promptTokenCount:50,candidatesTokenCount:5,thoughtsTokenCount:0}})+'\n\n');
    throw new Error('Unexpected external request in test');
  };
  try {
    const outcomes=await Promise.allSettled(Array.from({length:3},()=>generateForUser({user:'ai-concurrent',model:'gemini-4-argon',contents:[{role:'user',parts:[{text:'테스트'}]}],key:'test-only'})));
    assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,2);assert.equal(outcomes.filter(x=>x.status==='rejected'&&x.reason.code==='resource-exhausted').length,1);
    assert.equal((await usageFor('ai-concurrent')).argonRemaining,0);
    const rows=await db.collection('aiReservations').where('user','==','ai-concurrent').get();assert.equal(rows.size,2);assert.ok(rows.docs.every(row=>row.data().status==='settled'));
    const response=await post('/api/v1/rpc/chatWithStudy','alice',{data:{messages:[{role:'user',text:'학습 테스트'}],model:'gemini-3.8-flash'},stream:true});
    assert.equal(response.status,200);const lines=(await response.text()).trim().split('\n').map(JSON.parse);
    assert.ok(lines.some(row=>row.type==='chunk'&&row.data.text==='검증 답변'));assert.ok(lines.some(row=>row.type==='result'&&row.data.text==='검증 답변'));
    const browser=await browserTransport();const stream=await browser.serverCallable('chatWithStudy').stream({messages:[{role:'user',text:'클라이언트 테스트'}],model:'gemini-3.8-flash'});
    let text='';for await(const chunk of stream.stream)text+=chunk.text;
    assert.equal(text,'검증 답변');assert.equal((await stream.data).text,'검증 답변');
    const month=new Date(Date.now()+9*3600000).toISOString().slice(0,7);
    assert.equal((await db.doc(`users/alice/aiUsage/${month}`).get()).data().reserved,0);
  } finally{globalThis.fetch=original;delete process.env.GOOGLE_AI_API_KEY;}
});
test('GitHub Pages transport refreshes a rejected token and revives timestamp snapshots',async()=>{
  const browser=await browserTransport(true);
  const result=await browser.serverCallable('updateAccount')({displayName:'브라우저 연결'});assert.equal(result.data.updated,true);
  const profile=await browser.getDoc(browser.doc(null,'users','alice'));assert.equal(profile.data().displayName,'브라우저 연결');assert.ok(Number.isFinite(profile.data().createdAt.toMillis()));
  await assert.rejects(browser.serverCallable('updateAccount')({displayName:'x'}),{code:'functions/invalid-argument'});
});

test('server outages reject browser reads and writes without falling back to Firebase data services',async()=>{
  const browser=await browserTransport(),original=globalThis.fetch,requests=[];
  globalThis.fetch=async url=>{requests.push(new URL(url));throw new TypeError('Server offline');};
  try {
    await assert.rejects(browser.serverCallable('updateAccount')({displayName:'offline'}),{code:'functions/unavailable'});
    await assert.rejects(browser.getDoc(browser.doc(null,'users','alice')),{code:'functions/unavailable'});
    assert.deepEqual(requests.map(url=>url.origin),[base,base]);
    assert.deepEqual(requests.map(url=>url.pathname),['/api/v1/rpc/updateAccount','/api/v1/read']);
  } finally{globalThis.fetch=original;}
});
