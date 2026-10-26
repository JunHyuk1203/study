import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes,createCipheriv,createDecipheriv} from 'node:crypto';
import {createFaceService,authorizeFaceStudy,envelopeHash,faceDayEnd,seoulDay} from '../functions/face-service.js';
import {FACE_MODEL,FACE_PREPROCESS,FACE_SCHEMA,FACE_ORIGIN,studyNonce} from '../functions/face-protocol.js';
import {createBrowserFaceKeys} from '../face-storage.js';
import {signFace,encryptFaceSamples,decryptFaceSamples} from '../face-crypto.js';
import {createIdentityMatcher,createEnrollmentCollector,faceDirection,faceImageQuality,faceFrameGeometry,createFacePoseCalibration,createLocalFaceGuard} from '../camera-identity.js';
import {checkpointCamera} from '../functions/domain.js';
import {createStudyRevocationCheck} from '../functions/study-auth.js';

function memoryStore(){
  const rows=new Map();let tail=Promise.resolve();
  const snapshot=ref=>({exists:rows.has(ref.path),data:()=>structuredClone(rows.get(ref.path))});
  return {rows,doc:path=>({path,get:async()=>snapshot({path})}),runTransaction:fn=>{
    const result=tail.then(async()=>{const writes=new Map();const value=await fn({get:async ref=>snapshot(ref),set:(ref,data)=>writes.set(ref.path,structuredClone(data))});for(const [key,value]of writes)rows.set(key,value);return value;});tail=result.catch(()=>{});return result;
  }};
}
function testKms(){const key=randomBytes(32);return {
  async seal(value,aad){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(Buffer.from(aad));return Buffer.concat([iv,cipher.update(value,'base64'),cipher.final(),cipher.getAuthTag()]).toString('base64');},
  async open(value,aad){const bytes=Buffer.from(value,'base64'),cipher=createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));cipher.setAAD(Buffer.from(aad));cipher.setAuthTag(bytes.subarray(-16));return Buffer.concat([cipher.update(bytes.subarray(12,-16)),cipher.final()]).toString('base64');},
};}
const owner=Array.from({length:1024},(_,i)=>i===0?1:0),other=Array.from({length:1024},(_,i)=>i===1?1:0);
async function harness(){
  const db=memoryStore(),keys=await createBrowserFaceKeys(),installationId=randomUUID(),uid='owner';let now=Date.parse('2026-10-26T10:00:00+09:00');
  const service=createFaceService({db,kms:testKms(),projectId:'demo-study',clock:()=>now});
  let authTime=Math.floor(now/1000),grant,ticket,sealed;
  const call=(action,data={},who=uid)=>service(action,{auth:{uid:who,token:{email_verified:true,auth_time:authTime,firebase:{sign_in_provider:'password'}}},data:{installationId,...data}});
  const sign=(purpose,nonce,k=keys)=>signFace(k,purpose,uid,installationId,nonce);
  async function daily(){const challenge=await call('beginDailyFaceAuth',{publicKey:keys.publicKey});authTime=Math.floor(now/1000);({grant}=await call('completeDailyFaceAuth',{challengeId:challenge.challengeId,signature:await sign('daily',challenge.challengeId)}));return challenge;}
  async function begin(){await daily();({ticket}=await call('beginFaceEnrollment',{idempotencyKey:randomUUID(),signature:await sign('enroll',grant.id)}));return ticket;}
  async function seal(){if(!ticket)await begin();const encrypted=await encryptFaceSamples(Array(12).fill(owner),keys,ticket.binding);sealed=await call('sealFaceKeyEnvelope',{ticketId:ticket.id,wrappedKey:encrypted.wrappedKey,signature:await sign('seal',`${ticket.id}:${envelopeHash(encrypted.wrappedKey)}`)});return {encrypted,...sealed};}
  async function commit(){if(!sealed)await seal();return call('commitFaceEnrollment',{ticketId:ticket.id,idempotencyKey:ticket.idempotencyKey,envelopeHash:sealed.envelopeHash,signature:await sign('commit',`${ticket.id}:${sealed.envelopeHash}`)});}
  return {db,keys,installationId,uid,call,sign,daily,begin,seal,commit,get ticket(){return ticket;},get grant(){return grant;},get sealed(){return sealed;},get now(){return now;},advance:ms=>{now+=ms;},setAuthTime:value=>{authTime=value;}};
}

test('envelope round trip binds account, browser, profile, versions and ciphertext',async()=>{
  const h=await harness(),{encrypted,envelope}=await h.seal();await h.commit();
  const nonce=await h.call('beginFaceUnlock',{profileId:h.ticket.binding.profileId});
  const request={nonce:nonce.nonce,envelope,signature:await h.sign('unlock',`${nonce.nonce}:${envelopeHash(envelope)}`)};
  const opened=await h.call('unlockFaceKeyEnvelope',request);
  assert.deepEqual(await decryptFaceSamples(encrypted,h.keys,opened.wrappedKey,h.uid,h.installationId),Array(12).fill(owner));
  await assert.rejects(h.call('unlockFaceKeyEnvelope',request),{code:'permission-denied'});
  await assert.rejects(decryptFaceSamples(encrypted,await createBrowserFaceKeys(),opened.wrappedKey,h.uid,h.installationId));
  for(const field of ['uid','installationId','profileId','generation','modelVersion','preprocessVersion','schemaVersion','appOrigin','projectId']){
    const corrupted={...encrypted,binding:{...encrypted.binding,[field]:`${encrypted.binding[field]}-tampered`}};
    await assert.rejects(decryptFaceSamples(corrupted,h.keys,opened.wrappedKey,h.uid,h.installationId),field);
  }
  await assert.rejects(decryptFaceSamples({...encrypted,ciphertext:'A'+encrypted.ciphertext.slice(1)},h.keys,opened.wrappedKey,h.uid,h.installationId));
  const stored=JSON.stringify([...h.db.rows.values()]);assert.ok(!stored.includes('samples'));assert.ok(!stored.includes(encrypted.wrappedKey));
});
test('browser keys stay nonextractable after structured cloning and use AES-KW',async()=>{
  const keys=structuredClone(await createBrowserFaceKeys());
  await assert.rejects(crypto.subtle.exportKey('raw',keys.wrappingKey));
  await assert.rejects(crypto.subtle.exportKey('jwk',keys.signingKey));
  assert.equal(keys.wrappingKey.algorithm.name,'AES-KW');
  assert.ok(await signFace(keys,'daily','u',randomUUID(),randomUUID()));
});
test('refresh-only, old, future, previous-day and pre-challenge auth_time fail',async()=>{
  for(const offset of [-301000,2000,-3600000]){const h=await harness(),challenge=await h.call('beginDailyFaceAuth',{publicKey:h.keys.publicKey});h.setAuthTime(Math.floor((h.now+offset)/1000));await assert.rejects(h.call('completeDailyFaceAuth',{challengeId:challenge.challengeId,signature:await h.sign('daily',challenge.challengeId)}),{code:'failed-precondition'});}
  const h=await harness(),challenge=await h.call('beginDailyFaceAuth',{publicKey:h.keys.publicKey});h.advance(10000);h.setAuthTime(Math.floor((h.now-20000)/1000));await assert.rejects(h.call('completeDailyFaceAuth',{challengeId:challenge.challengeId,signature:await h.sign('daily',challenge.challengeId)}));
});
test('daily challenge is one-use and requires the pinned browser key',async()=>{
  const h=await harness(),challenge=await h.call('beginDailyFaceAuth',{publicKey:h.keys.publicKey});
  await assert.rejects(h.call('completeDailyFaceAuth',{challengeId:challenge.challengeId,signature:await h.sign('daily',challenge.challengeId,await createBrowserFaceKeys())}),{code:'permission-denied'});
  const data={challengeId:challenge.challengeId,signature:await h.sign('daily',challenge.challengeId)};await h.call('completeDailyFaceAuth',data);await assert.rejects(h.call('completeDailyFaceAuth',data));
});
test('cross-account, cross-installation, wrong hash and expired unlock are rejected',async()=>{
  const h=await harness();await h.commit();const nonce=await h.call('beginFaceUnlock',{profileId:h.ticket.binding.profileId});
  const data={nonce:nonce.nonce,envelope:h.sealed.envelope,signature:await h.sign('unlock',`${nonce.nonce}:${h.sealed.envelopeHash}`)};
  await assert.rejects(h.call('unlockFaceKeyEnvelope',data,'another-user'));
  await assert.rejects(h.call('unlockFaceKeyEnvelope',{...data,installationId:randomUUID()}));
  await assert.rejects(h.call('unlockFaceKeyEnvelope',{...data,envelope:'bad'}));
  h.advance(60001);await assert.rejects(h.call('unlockFaceKeyEnvelope',data));
});
test('concurrent commits consume one ticket; response-loss retry returns same generation',async()=>{
  const h=await harness();await h.seal();const results=await Promise.all([h.commit(),h.commit()]);assert.equal(results[0].active.profileId,results[1].active.profileId);
  const state=h.db.rows.get(`faceSecurity/${h.uid}`);assert.equal(state.registrations.length,1);assert.equal(state.audit.length,1);assert.equal(state.generation,1);
  const again=await h.commit();assert.equal(again.active.generation,1);
});
test('failed or cancelled replacement preserves old active profile and replacement limits survive browser changes',async()=>{
  const h=await harness();await h.commit();const original=h.ticket.binding.profileId;
  for(let i=0;i<2;i++){await h.begin();await h.seal();await h.commit();}
  const active=h.db.rows.get(`faceSecurity/${h.uid}`).active;assert.notEqual(active.profileId,original);
  await h.daily();await assert.rejects(h.call('beginFaceEnrollment',{idempotencyKey:randomUUID(),signature:await h.sign('enroll',h.grant.id)}),{code:'resource-exhausted'});
  assert.equal(h.db.rows.get(`faceSecurity/${h.uid}`).active.profileId,active.profileId);
});
test('study authorization binds signature to sequence, tracking and active generation',async()=>{
  const h=await harness();const committed=await h.commit();
  const data={controllerId:randomUUID(),sessionId:randomUUID(),sequence:1,tracking:true,faceAuthorization:{installationId:h.installationId,profileId:committed.active.profileId,generation:1,grantId:committed.grant.id,issuedAt:h.now}};
  data.faceAuthorization.signature=await h.sign('study',studyNonce(data));
  const authorized=await h.db.runTransaction(tx=>authorizeFaceStudy(tx,h.db,h.uid,data,null,h.now));assert.equal(authorized.faceLeaseUntilMs,h.now+60000);
  for(const modified of [{...data,sequence:2},{...data,tracking:false},{...data,faceAuthorization:{...data.faceAuthorization,generation:2}}])await assert.rejects(h.db.runTransaction(tx=>authorizeFaceStudy(tx,h.db,h.uid,modified,null,h.now)));
  await h.call('revokeFaceEnrollment');await assert.rejects(h.db.runTransaction(tx=>authorizeFaceStudy(tx,h.db,h.uid,data,null,h.now)));
});
test('server Seoul date and midnight clip credit even after delayed sync and finalization',()=>{
  const midnight=Date.parse('2026-10-27T00:00:00+09:00');assert.equal(faceDayEnd(midnight-1),midnight);assert.equal(seoulDay(midnight),'2026-10-27');
  const session={startedAtMs:midnight-20000,activeSinceMs:midnight-5000,leaseUntilMs:midnight+20000,faceAuthUntilMs:midnight,faceLeaseUntilMs:midnight+60000};
  for(const now of [midnight,midnight+60000,midnight+86400000]){const result=checkpointCamera(session,now,true);assert.equal(result.accumulatedSeconds,5);assert.equal(result.activeSinceMs,null);assert.equal(result.canResume,false);}
});
test('collector requires all five directions, stable quality and an independent final frame',()=>{
  const collector=createEnrollmentCollector();let time=0,result,target=0;
  for(const [direction,count]of [['front',4],['left',2],['right',2],['up',2],['down',2]]){
    target+=count;for(let i=0;i<15;i++){result=collector.observe(owner,{time:time+=500,direction});if(result.progress>=target)break;}
    assert.equal(result.direction,{4:'left',6:'right',8:'up',10:'down',12:'front'}[target]);
  }
  assert.equal(result.progress,12);assert.equal(result.complete,false);
  assert.equal(collector.observe(owner,{time:time+=500,direction:'left'}).complete,false);
  assert.equal(collector.observe(owner,{time:time+=500,direction:'front',quality:false}).complete,false);
  collector.observe(owner,{time:time+=500,direction:'front'});collector.observe(owner,{time:time+=500,direction:'front'});
  assert.equal(collector.observe(owner,{time:time+=500,direction:'front'}).complete,true);
  assert.equal(collector.observe(other,{time:time+=500,direction:'front'}).reset,true);
});

test('automatic face framing aligns translated, resized and tilted faces without asking for a fixed outline',()=>{
  const makeFace=(cx,cy,size,angle)=>{
    const face=Array.from({length:478},()=>({x:cx/1280,y:cy/720}));
    const point=(x,y)=>({x:(cx+size*(x*Math.cos(angle)-y*Math.sin(angle)))/1280,y:(cy+size*(x*Math.sin(angle)+y*Math.cos(angle)))/720});
    for(const i of [33,133])face[i]=point(-.5,0);
    for(const i of [362,263])face[i]=point(.5,0);
    face[1]=point(0,.48);face[10]=point(0,-.8);face[152]=point(0,1.3);face[234]=point(-1,.4);face[454]=point(1,.4);
    return face;
  };
  for(const [x,y,size,angle]of [[640,240,130,0],[340,200,65,.2],[850,250,150,-.2]]){
    const face=makeFace(x,y,size,angle),framing=faceFrameGeometry(face,1280,720);assert.ok(framing);
    const [a,b,c,d,e,f]=framing.transform;
    assert.ok(Math.abs(a*x+c*y+e-112)<1e-8);assert.ok(Math.abs(b*x+d*y+f-85)<1e-8);
    assert.ok(Math.abs(framing.yaw)<1e-8);assert.ok(Math.abs(framing.pitch)<1e-8);
  }
  assert.equal(faceFrameGeometry(makeFace(640,240,15,0),1280,720),null);
  assert.equal(faceFrameGeometry(makeFace(15,200,100,0),1280,720),null);
});

test('registration calibrates a steady comfortable front pose once and keeps directional movement relative to it',()=>{
  const calibration=createFacePoseCalibration();
  assert.equal(calibration.observe({yaw:5,pitch:14},0).ready,false);
  assert.equal(calibration.observe({yaw:5,pitch:14},500).ready,false);
  assert.equal(calibration.observe({yaw:5,pitch:14},1000).direction,'front');
  assert.equal(calibration.observe({yaw:21,pitch:14},1500).direction,'left');
  assert.equal(calibration.observe({yaw:-11,pitch:14},2000).direction,'right');
  assert.equal(calibration.observe({yaw:5,pitch:3},2500).direction,'up');
  assert.equal(calibration.observe({yaw:5,pitch:25},3000).direction,'down');
  calibration.reset();assert.equal(calibration.observe({yaw:35,pitch:14},4000).ready,false);
  assert.equal(calibration.observe({yaw:5,pitch:14},4500).ready,false);
  assert.equal(calibration.observe({yaw:15,pitch:14},5000).ready,false);
});
function smoothFaceImage(){
  const data=new Uint8ClampedArray(224*224*4);
  const spot=(x,y,cx,cy,sx,sy)=>Math.exp(-.5*((x-cx)**2/sx**2+(y-cy)**2/sy**2));
  for(let y=0;y<224;y++)for(let x=0;x<224;x++){
    const value=135-45*spot(x,y,76,85,12,5)-45*spot(x,y,148,85,12,5)-28*spot(x,y,112,150,25,6)+15*spot(x,y,112,119,10,17),index=(y*224+x)*4;
    data[index]=data[index+1]=data[index+2]=value;data[index+3]=255;
  }
  return {data,width:224,height:224};
}

test('soft webcam texture can pass quality while blank, dark and overexposed frames are held',()=>{
  assert.equal(faceImageQuality(smoothFaceImage()),null);
  const solid=value=>({data:new Uint8ClampedArray(224*224*4).fill(value),width:224,height:224});
  assert.match(faceImageQuality(solid(128)),/윤곽/);
  assert.match(faceImageQuality(solid(20)),/밝게/);
  assert.match(faceImageQuality(solid(245)),/강한 빛/);
});

test('soft webcam frames progress through real guard calibration and frontal enrollment',async()=>{
  const previous=Object.getOwnPropertyDescriptor(globalThis,'OffscreenCanvas'),events=[],image=smoothFaceImage();
  const context={setTransform(){},fillRect(){},drawImage(){},getImageData:()=>image};
  globalThis.OffscreenCanvas=class{getContext(){return context;}};
  let guard;
  try{
    const input={toFloat(){return this;},expandDims(){return this;},dispose(){}};
    const tf={loadGraphModel:async()=>({execute:()=>({data:async()=>owner,dispose(){}}),dispose(){}}),tidy:fn=>fn(),browser:{fromPixels:()=>input}};
    guard=await createLocalFaceGuard(tf,{uid:'owner',ticket:{id:'enrollment-test'}},()=>{throw Error('No server call should be made before all directions are collected');},event=>events.push(event));
    const face=Array.from({length:478},()=>({x:.5,y:160/480}));
    for(const i of [33,133])face[i]={x:280/640,y:160/480};
    for(const i of [362,263])face[i]={x:360/640,y:160/480};
    face[1]={x:.5,y:198.4/480};
    let state;
    for(let time=0;time<=4500;time+=500)state=await guard.check({width:640,height:480},{faceLandmarks:[face]},time);
    assert.equal(state.progress,4);assert.equal(state.enrolled,false);
    assert.equal(events.filter(event=>event.type==='face-progress').at(-1).direction,'left');
    assert.ok(!events.some(event=>event.label?.includes('가리는 물체')));
  }finally{
    guard?.close();if(previous)Object.defineProperty(globalThis,'OffscreenCanvas',previous);else delete globalThis.OffscreenCanvas;
  }
});

test('quality, multi-face and repeated-frame holds cannot add enrollment samples',()=>{
  const c=createEnrollmentCollector();for(let time=0;time<2000;time+=500)c.observe(owner,{time,direction:'front'});
  const before=c.observe(owner,{time:2000,direction:'front'}).progress;
  assert.equal(c.observe(owner,{time:2000,direction:'front'}).progress,before);
  assert.equal(c.observe(owner,{time:2500,direction:'front',quality:false}).progress,before);
  assert.equal(c.observe(owner,{time:3000,direction:'front',multiple:true}).progress,0);
  assert.equal(faceDirection(16,0),'left');assert.equal(faceDirection(-16,0),'right');assert.equal(faceDirection(0,-11),'up');assert.equal(faceDirection(0,11),'down');
  assert.match(faceImageQuality({data:new Uint8ClampedArray(224*224*4),width:224,height:224}),/밝게/);
});
test('matcher never auto-enrolls, requires 4/5 votes, rejects one lucky maximum and keeps templates',()=>{
  assert.equal(createIdentityMatcher().observe(owner).matched,false);
  const matcher=createIdentityMatcher(Array(12).fill(owner));for(let i=0;i<4;i++)assert.equal(matcher.observe(owner).matched,false);assert.equal(matcher.observe(owner).matched,true);
  assert.equal(matcher.observe(other).matched,false);assert.deepEqual(matcher.samples,Array(12).fill(owner));
  matcher.reset();assert.equal(matcher.observe(owner).matched,false);
  const mixed=createIdentityMatcher([owner,...Array(11).fill(other)]);for(let i=0;i<8;i++)assert.equal(mixed.observe(owner).matched,false);
});
test('missing KMS cannot silently select a local encryption fallback',async()=>{
  const db=memoryStore(),service=createFaceService({db,kms:testKms(),configured:()=>false,projectId:'demo'});
  const request={auth:{uid:'a',token:{email_verified:true,firebase:{sign_in_provider:'google.com'}}},data:{installationId:randomUUID()}};
  assert.equal((await service('getFaceEnrollmentStatus',request)).enabled,false);await assert.rejects(service('beginDailyFaceAuth',request),{code:'failed-precondition'});
});
test('cancelled candidates keep the previous generation and are unusable afterwards',async()=>{
  const h=await harness();await h.commit();const original=h.db.rows.get(`faceSecurity/${h.uid}`).active;
  const ticket=await h.begin();
  await h.call('cancelFaceEnrollment',{ticketId:ticket.id,signature:await h.sign('cancel',ticket.id)});
  assert.deepEqual(h.db.rows.get(`faceSecurity/${h.uid}`).active,original);
  await assert.rejects(h.seal(),{code:'failed-precondition'});
});
test('lost local keys allow recent-auth enrollment recovery but cannot unlock the old generation',async()=>{
  const h=await harness();await h.commit();const replacement=await createBrowserFaceKeys();
  const challenge=await h.call('beginDailyFaceAuth',{publicKey:replacement.publicKey,enrollmentOnly:true});
  const signature=await h.sign('daily',challenge.challengeId,replacement);
  const {grant}=await h.call('completeDailyFaceAuth',{challengeId:challenge.challengeId,signature});assert.equal(grant.generation,0);
  await assert.rejects(h.call('beginFaceUnlock',{profileId:h.ticket.binding.profileId}));
  const pending=await h.call('beginFaceEnrollment',{idempotencyKey:randomUUID(),signature:await h.sign('enroll',grant.id,replacement)});assert.equal(pending.ticket.binding.generation,2);
});
test('failed signature attempts count against the UID rate limit',async()=>{
  const h=await harness(),challenge=await h.call('beginDailyFaceAuth',{publicKey:h.keys.publicKey});
  for(let i=0;i<59;i++)await assert.rejects(h.call('completeDailyFaceAuth',{challengeId:challenge.challengeId,signature:'invalid'}),{code:'permission-denied'});
  await assert.rejects(h.call('completeDailyFaceAuth',{challengeId:challenge.challengeId,signature:await h.sign('daily',challenge.challengeId)}),{code:'resource-exhausted'});
});
test('disabled and reset accounts lose future study leases within the revocation cache bound',async()=>{
  let now=100000,disabled=false,validSince=0,lookups=0;
  const check=createStudyRevocationCheck({clock:()=>now,lookup:async()=>{lookups++;return {disabled,tokensValidAfterTime:new Date(validSince).toISOString()};}});
  const request={auth:{uid:'owner',token:{auth_time:100}}};
  await check(request);disabled=true;now+=44000;await check(request);assert.equal(lookups,1);
  now+=1000;await assert.rejects(check(request),{code:'unauthenticated'});
  disabled=false;validSince=200000;now+=45000;await assert.rejects(check(request),{code:'unauthenticated'});
});
