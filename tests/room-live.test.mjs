import test,{before} from 'node:test';
import assert from 'node:assert/strict';
import {getFirestore} from '../functions/node_modules/firebase-admin/lib/firestore/index.js';
import {ensureProfile,startStudySession,syncStudyCamera,finishStudySession,getStudySocial,updateStudySocial,expireStudySessions,startWordStudy,syncWordStudy} from '../functions/index.js';
import {memberStatus} from '../room-time.js';

before(()=>{
  assert.ok(process.env.FIRESTORE_EMULATOR_HOST&&process.env.FIREBASE_AUTH_EMULATOR_HOST,'Room tests require local emulators');
  assert.equal(process.env.GCLOUD_PROJECT,'demo-study');
});
const db=()=>getFirestore('study-data');
const controllerId='12345678-1234-1234-1234-123456789abc';
const auth=uid=>({uid,token:{email_verified:true}});
const social=(uid,action,data={})=>updateStudySocial.run({auth:auth(uid),data:{action,...data}});
const snapshot=uid=>getStudySocial.run({auth:auth(uid),data:{}});
const user=uid=>ensureProfile.run({auth:auth(uid),data:{displayName:uid}});
const start=uid=>startStudySession.run({auth:auth(uid),data:{subjectId:'other',cameraMode:true,controllerId}});
const beat=(uid,id,sequence,tracking=true)=>syncStudyCamera.run({auth:auth(uid),data:{sessionId:id,controllerId,sequence,tracking}});
function clock(t) {
  const original=Date.now;let now=Date.parse('2026-10-23T12:00:00+09:00');
  Date.now=()=>now;t.after(()=>{Date.now=original;});
  return ms=>{now+=ms;return now;};
}
async function group(host,guest) {
  await user(host);await user(guest);
  const {roomId}=await social(host,'createRoom',{title:'회귀 테스트'});
  const {code}=await social(host,'roomCode',{roomId});
  await social(guest,'joinCode',{code});return {roomId,code};
}

test('camera checkpoints publish peer status immediately without owner polling',async t=>{
  const tick=clock(t),prefix=process.env.ROOM_TEST_PREFIX||'',owner=prefix+'live-owner',peer=prefix+'live-peer';
  const {roomId}=await group(owner,peer),session=await start(owner);
  await beat(owner,session.sessionId,1);
  const saved=(await db().doc(`studyRooms/${roomId}`).get()).data();
  assert.equal(saved.members[owner].status,'studying','Camera acknowledgement must publish studying before any owner room poll');
  assert.equal((await snapshot(peer)).room.members[owner].status,'studying');
  tick(3000);await beat(owner,session.sessionId,2,false);
  assert.equal((await snapshot(peer)).room.members[owner].status,'resting');
  tick(1000);const resumed=await beat(owner,session.sessionId,3,true);
  assert.equal(resumed.roomActivity.member.status,'studying');
  assert.equal((await snapshot(peer)).room.members[owner].status,'studying');
  for(let i=1;i<=36;i++) {
    tick(5000);
    // Poll before and after checkpoints, with no social request from the owner.
    assert.equal((await snapshot(peer)).room.members[owner].status,'studying');
    await beat(owner,session.sessionId,i+3);
    assert.equal((await snapshot(peer)).room.members[owner].status,'studying');
  }
  assert.equal((await snapshot(peer)).room.members[owner].seconds,183);
});

test('a delayed heartbeat preserves presence while credit stops at the 10 second lease',async t=>{
  const tick=clock(t),owner='delay-owner',peer='delay-peer';
  await group(owner,peer);const session=await start(owner);
  await beat(owner,session.sessionId,1);tick(15000);
  const response=await beat(owner,session.sessionId,2);
  assert.equal(response.session.accumulatedSeconds,10);
  const member=(await snapshot(peer)).room.members[owner];
  assert.equal(member.status,'studying');assert.equal(member.seconds,10);
  tick(46000);assert.equal(memberStatus(member,Date.now()),'offline');
  await expireStudySessions.run({auth:auth(owner),data:{}});
  assert.equal((await db().doc(`users/${owner}/sessions/${session.sessionId}`).get()).data().status,'finished');
});

test('idle word heartbeats cannot turn a resumed camera participant into resting',async t=>{
  const tick=clock(t),prefix=process.env.ROOM_TEST_PREFIX||'',owner=prefix+'idle-word-owner',peer=prefix+'idle-word-peer';
  const {roomId}=await group(owner,peer),camera=await start(owner);
  await beat(owner,camera.sessionId,1);tick(5000);
  const word=await startWordStudy.run({auth:auth(owner),data:{controllerId,tracking:true}});
  const wordBeat=(sequence,tracking)=>syncWordStudy.run({auth:auth(owner),data:{sessionId:word.sessionId,controllerId,sequence,tracking,present:true}});
  tick(5000);await wordBeat(1,false);
  assert.equal((await snapshot(peer)).room.members[owner].status,'resting');
  tick(1000);
  const ref=db().doc(`users/${owner}/sessions/${camera.sessionId}`);
  await beat(owner,camera.sessionId,(await ref.get()).data().sequence+1);
  assert.equal((await snapshot(peer)).room.members[owner].status,'studying');
  for(let i=2;i<=8;i++) {
    tick(4000);await beat(owner,camera.sessionId,(await ref.get()).data().sequence+1);
    await wordBeat(i,false);
    const member=(await db().doc(`studyRooms/${roomId}`).get()).data().members[owner];
    assert.equal(member.status,'studying','An open but idle word window must not overwrite active camera status');
    assert.equal(member.activitySource,'camera');
    assert.equal((await snapshot(peer)).room.members[owner].status,'studying');
  }
});

test('room-only daily time survives finish, session restart and same-room reentry, while another room starts at zero',async t=>{
  const tick=clock(t),host='total-host',guest='total-guest',otherHost='other-host';
  await user(guest);const first=await start(guest);
  await beat(guest,first.sessionId,1);tick(5000);await beat(guest,first.sessionId,2);tick(5000);await beat(guest,first.sessionId,3);
  await user(host);const {roomId}=await social(host,'createRoom',{title:'누적 시간 A'}),{code}=await social(host,'roomCode',{roomId});
  await social(guest,'joinCode',{code});await beat(guest,first.sessionId,4);
  assert.equal((await snapshot(guest)).room.members[guest].seconds,0);
  tick(5000);await beat(guest,first.sessionId,5);tick(5000);
  const finished=await finishStudySession.run({auth:auth(guest),data:{sessionId:first.sessionId}});
  assert.equal(finished.creditedSeconds,20);
  assert.equal((await snapshot(host)).room.members[guest].seconds,10);
  await social(guest,'leave',{roomId});tick(20000);
  await social(guest,'joinCode',{code});
  assert.equal((await snapshot(guest)).room.members[guest].seconds,10);
  const next=await start(guest);await beat(guest,next.sessionId,1);tick(5000);await beat(guest,next.sessionId,2);
  assert.equal((await snapshot(guest)).room.members[guest].seconds,15);
  await social(guest,'leave',{roomId});await user(otherHost);
  const other=await social(otherHost,'createRoom',{title:'누적 시간 B'}),otherCode=await social(otherHost,'roomCode',{roomId:other.roomId});
  await social(guest,'joinCode',{code:otherCode.code});
  assert.equal((await snapshot(guest)).room.members[guest].seconds,0);
  await social(guest,'leave',{roomId:other.roomId});await social(guest,'joinCode',{code});
  const restored=(await snapshot(guest)).room;
  assert.equal(restored.members[guest].seconds,15);
  assert.equal(restored.rankings.today.winners[0].uid,guest);
  assert.equal(restored.rankings.week.seconds,15);assert.equal(restored.rankings.month.seconds,15);
  // A departed participant's earned time remains eligible for room statistics.
  await social(guest,'leave',{roomId});assert.equal((await snapshot(host)).room.rankings.today.winners[0].uid,guest);
});

test('concurrent camera checkpoints preserve both participants and tied room leaders',async t=>{
  const tick=clock(t),owner='parallel-owner',peer='parallel-peer';
  const {roomId}=await group(owner,peer),a=await start(owner),b=await start(peer);
  await Promise.all([beat(owner,a.sessionId,1),beat(peer,b.sessionId,1)]);
  for(let sequence=2;sequence<=7;sequence++) {
    tick(5000);await Promise.all([beat(owner,a.sessionId,sequence),beat(peer,b.sessionId,sequence)]);
  }
  const room=(await snapshot(peer)).room,saved=(await db().doc(`studyRooms/${roomId}`).get()).data();
  for(const uid of [owner,peer]) {
    assert.equal(room.members[uid].status,'studying');assert.equal(room.members[uid].seconds,30);
    assert.equal(saved.studyTotals[uid].today.ms,30000);
  }
  assert.deepEqual(new Set(room.rankings.today.winners.map(row=>row.uid)),new Set([owner,peer]));
});
