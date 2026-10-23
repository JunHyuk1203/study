import {createSocialCode,normalizeSocialCode,isShortSocialCode} from './social-code.js';
import {FieldValue} from 'firebase-admin/firestore';
import {HttpsError} from 'firebase-functions/v2/https';
import {schoolRoomInfo} from './integrations-domain.js';

export const ROOM_OFFLINE_MS=45000;
export const ROOM_IDLE_MS=3*3600000;
const fail=(code,message)=>{throw new HttpsError(code,message);};
const validId=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(value);
const userRef=(db,uid)=>db.doc(`users/${uid}`);
const inbox=(db,uid,id)=>db.doc(`users/${uid}/roomInvites/${id}`);
const bump={socialRevision:FieldValue.increment(1)};
export const isGeneralRoom=(room,id)=>room?.permanent===true||/^school_[A-Z]\d{2}_\d{7}_[1-6]$/.test(id);
const visibility=room=>room.visibility||(room.type==='school'?'public':'private');
export function roomDeadline(room) {
  const members=Object.values(room.members||{});
  return members.length?Math.max(...members.map(member=>Number(member.lastSeenMs)||room.createdAtMs))+ROOM_IDLE_MS:(room.emptySinceMs??room.createdAtMs)+ROOM_IDLE_MS;
}
export const roomAvailable=(room,id,now=Date.now())=>Boolean(room&&room.status==='open'&&(isGeneralRoom(room,id)||roomDeadline(room)>now));
export const canAccessPublicRoom=(room,id,profile)=>{const info=schoolRoomInfo(profile.school);return Boolean(info&&room.schoolId===info.schoolId&&(room.grade===info.grade||!isGeneralRoom(room,id)&&room.allowOtherGrades===true));};
const memberRecord=(uid,profile,now)=>({uid,displayName:profile.displayName||'공부 친구',joinedAtMs:now,lastSeenMs:now,status:'resting',seconds:0,subjectName:''});
export function roomPreview(room,id,now=Date.now()) {
  const members=Object.entries(room.members||{}).sort(([a],[b])=>Number(b===room.hostUid)-Number(a===room.hostUid)).map(([uid,member])=>({displayName:member.displayName||'공부 친구',isHost:uid===room.hostUid,online:now-member.lastSeenMs<ROOM_OFFLINE_MS,status:now-member.lastSeenMs>=ROOM_OFFLINE_MS?'offline':member.status==='studying'?'studying':'resting',participating:true}));
  const memberCount=members.length;
  if(room.hostUid&&!members.some(member=>member.isHost))members.unshift({displayName:room.hostName||'방장',isHost:true,online:false,status:'offline',participating:false});
  return {id,title:room.title,visibility:visibility(room),allowOtherGrades:!isGeneralRoom(room,id)&&room.allowOtherGrades===true,permanent:isGeneralRoom(room,id),memberCount,members};
}
// Reads all participants before any writes; deletion and membership changes are atomic.
async function deleteRoom(tx,db,ref,room) {
  const ids=[...new Set([...(room.memberIds||[]),...(room.invitedUids||[])])];
  const profiles=ids.length?await tx.getAll(...ids.map(uid=>userRef(db,uid))):[];
  for(const profile of profiles) {
    if(profile.data()?.activeRoomId===ref.id)tx.update(profile.ref,{activeRoomId:null,...bump});
    else if(profile.exists)tx.update(profile.ref,bump);
    tx.delete(inbox(db,profile.id,ref.id));
  }
  if(room.joinCode)tx.delete(db.doc(`roomCodes/${room.joinCode}`));
  tx.delete(ref);
}
async function resolveCode(tx,db,value) {
  const code=normalizeSocialCode(value);
  if(!isShortSocialCode(code))fail('invalid-argument','방 코드 6자리를 확인해 주세요.');
  const mapping=(await tx.get(db.doc(`roomCodes/${code}`))).data();
  if(!mapping||!validId(mapping.roomId))fail('not-found','유효한 방 코드를 찾을 수 없습니다.');
  return {code,roomId:mapping.roomId};
}
export async function changeRoom(db,uid,action,data={}) {
  return db.runTransaction(async tx=>{
    const ref=userRef(db,uid),profile=(await tx.get(ref)).data(),now=Date.now();
    if(!profile)fail('failed-precondition','계정 설정을 먼저 완료해 주세요.');
    const info=schoolRoomInfo(profile.school);
    if(action==='joinSchool'&&!info)fail('failed-precondition','계정에 올바른 학교·학년을 등록해 주세요.');
    if(action==='createRoom'||action==='createSchoolRoom') {
      const access=data.visibility??(action==='createSchoolRoom'?'public':'private');
      if(!['public','private'].includes(access))fail('invalid-argument','공개 여부를 선택해 주세요.');
      if(access==='public'&&!info)fail('failed-precondition','공개방을 만들려면 올바른 학교·학년을 등록해 주세요.');
      const title=validateTitle(data.title);
      if(profile.activeRoomId) {
        const previous=(await tx.get(db.doc(`studyRooms/${profile.activeRoomId}`))).data();
        if(roomAvailable(previous,profile.activeRoomId,now)&&previous.memberIds.includes(uid))fail('already-exists','참여 중인 방에서 먼저 나가 주세요.');
      }
      const roomRef=db.collection('studyRooms').doc(),room={type:'custom',visibility:access,title,hostUid:uid,hostName:profile.displayName||'공부 친구',status:'open',createdAtMs:now,deleteAfterMs:now+ROOM_IDLE_MS,memberIds:[uid],invitedUids:[],members:{[uid]:memberRecord(uid,profile,now)},...(info?{schoolId:info.schoolId,grade:info.grade,schoolRoomKey:info.id}:{})};
      room.allowOtherGrades=data.allowOtherGrades===true;
      tx.create(roomRef,room);tx.update(ref,{activeRoomId:roomRef.id,...bump});return {roomId:roomRef.id};
    }
    let roomId=data.roomId,code;
    if(action==='previewCode'||action==='joinCode'){const resolved=await resolveCode(tx,db,data.code);roomId=resolved.roomId;code=resolved.code;}
    if(action==='joinSchool'&&!roomId)roomId=info?.id;
    if(!validId(roomId))fail('invalid-argument','방 정보가 올바르지 않습니다.');
    const roomRef=db.doc(`studyRooms/${roomId}`),stored=(await tx.get(roomRef)).data();
    if(action==='decline'){tx.delete(inbox(db,uid,roomId));tx.update(ref,bump);return {updated:true};}
    const room=stored||((action==='joinSchool'&&roomId===info?.id)?{type:'school',permanent:true,visibility:'public',title:info.title,schoolId:info.schoolId,grade:info.grade,hostUid:null,status:'open',createdAtMs:now,memberIds:[],invitedUids:[],members:{}}:null);
    if(!roomAvailable(room,roomId,now))fail('not-found','방이 삭제되었거나 더 이상 입장할 수 없습니다.');
    const general=isGeneralRoom(room,roomId),member=room.memberIds.includes(uid),host=room.hostUid===uid,access=visibility(room);
    if(code&&room.joinCode!==code)fail('permission-denied','만료된 방 코드입니다.');
    if(access==='public'&&!canAccessPublicRoom(room,roomId,profile)&&action!=='leave'&&action!=='close')fail('permission-denied','이 방에 허용된 학교·학년만 이용할 수 있습니다.');
    const invitation=access==='private'&&!member&&['join','previewRoom'].includes(action)?(await tx.get(inbox(db,uid,roomId))).data():null;
    const invited=room.invitedUids.includes(uid)&&invitation?.expiresAtMs>now;
    if(action==='previewCode'||action==='previewRoom') {
      if(access==='private'&&!member&&!host&&!code&&!invited)fail('permission-denied','친구 초대나 방 코드가 필요합니다.');
      return {preview:roomPreview(room,roomId,now),...(code?{code}:{})};
    }
    if(['join','joinSchool','joinCode'].includes(action)) {
      if(access==='private'&&!member&&!host&&!invited&&!code)fail('permission-denied','친구 초대나 방 코드가 필요합니다.');
      if(member)return {roomId};
      if(profile.activeRoomId&&profile.activeRoomId!==roomId) {
        const previous=(await tx.get(db.doc(`studyRooms/${profile.activeRoomId}`))).data();
        if(roomAvailable(previous,profile.activeRoomId,now)&&previous.memberIds.includes(uid))fail('already-exists','참여 중인 방에서 먼저 나가 주세요.');
      }
      const members=general?Object.fromEntries(Object.entries(room.members).filter(([,value])=>now-value.lastSeenMs<ROOM_OFFLINE_MS)):room.members;
      if(Object.keys(members).length>=(general?500:12))fail('resource-exhausted','방 인원이 가득 찼습니다.');
      const updated={...room,members:{...members,[uid]:memberRecord(uid,profile,now)},memberIds:[...Object.keys(members),uid],invitedUids:room.invitedUids.filter(id=>id!==uid),...(!general?{deleteAfterMs:now+ROOM_IDLE_MS}:{})};
      tx.set(roomRef,updated);tx.delete(inbox(db,uid,roomId));tx.update(ref,{activeRoomId:roomId,...bump});return {roomId};
    }
    if(!member)fail('permission-denied','참여 중인 방에서만 사용할 수 있습니다.');
    if(action==='updateRoom') {
      if(!host||general)fail('permission-denied','방장만 방 설정을 바꿀 수 있습니다.');
      const title=validateTitle(data.title),access=data.visibility;
      if(!['public','private'].includes(access))fail('invalid-argument','공개 여부를 선택해 주세요.');
      const participants=await tx.getAll(...room.memberIds.map(id=>userRef(db,id)));
      const invitees=room.invitedUids.length?await tx.getAll(...room.invitedUids.map(id=>userRef(db,id))):[];
      const allowOtherGrades=data.allowOtherGrades===true;
      const patch={title,visibility:access,allowOtherGrades,type:'custom',...(info?{schoolId:info.schoolId,grade:info.grade,schoolRoomKey:info.id}:{})};
      if(access==='public'&&(!info||participants.some(doc=>!canAccessPublicRoom({...room,...patch},roomId,doc.data()||{}))))fail('failed-precondition','허용된 학교·학년의 참여자만 남은 상태에서 공개 범위를 변경해 주세요.');
      if(room.joinCode&&access==='public'){tx.delete(db.doc(`roomCodes/${room.joinCode}`));patch.joinCode=FieldValue.delete();}
      if(access==='public'){patch.invitedUids=[];for(const invitee of invitees){tx.delete(inbox(db,invitee.id,roomId));if(invitee.exists)tx.update(invitee.ref,bump);}}
      tx.update(roomRef,patch);tx.update(ref,bump);return {updated:true};
    }
    if(action==='roomCode') {
      if(!host||access!=='private')fail('permission-denied','비공개방 방장만 코드를 만들 수 있습니다.');
      let value,codeRef;
      for(let attempt=0;attempt<8;attempt++) {
        value=createSocialCode();codeRef=db.doc(`roomCodes/${value}`);
        if(!(await tx.get(codeRef)).exists)break;
        codeRef=null;
      }
      if(!codeRef)fail('aborted','다시 시도해 주세요.');
      if(room.joinCode)tx.delete(db.doc(`roomCodes/${room.joinCode}`));
      tx.create(codeRef,{roomId});tx.update(roomRef,{joinCode:value});return {code:value};
    }
    if(action==='invite') {
      if(access!=='private')fail('permission-denied','비공개방에서 친구를 초대할 수 있습니다.');
      const ids=[...new Set(Array.isArray(data.uids)?data.uids:[])];
      if(!ids.length||ids.length>11||ids.some(id=>!validId(id)||room.memberIds.includes(id)))fail('invalid-argument','초대할 친구를 선택해 주세요.');
      if(new Set([...room.invitedUids,...ids]).size>48)fail('resource-exhausted','대기 중인 초대가 너무 많습니다.');
      const friends=await tx.getAll(...ids.map(id=>db.doc(`users/${uid}/friends/${id}`)));
      if(friends.some(doc=>!doc.exists))fail('permission-denied','추가한 친구에게만 초대할 수 있습니다.');
      const recipients=await tx.getAll(...ids.map(id=>userRef(db,id)));
      const boxes=await Promise.all(ids.map(id=>tx.get(userRef(db,id).collection('roomInvites').limit(50))));
      if(recipients.some(doc=>!doc.exists)||boxes.some(box=>box.size>=48))fail('resource-exhausted','친구의 초대함을 확인해 주세요.');
      tx.update(roomRef,{invitedUids:[...new Set([...room.invitedUids,...ids])]});
      ids.forEach(id=>{tx.set(inbox(db,id,roomId),{roomId,title:room.title,hostName:profile.displayName||'공부 친구',createdAtMs:now,expiresAtMs:now+30*60000});tx.update(userRef(db,id),bump);});
      return {invited:ids.length};
    }
    if(action==='close') {
      if(!host||general)fail('permission-denied','방장만 방을 삭제할 수 있습니다.');
      await deleteRoom(tx,db,roomRef,room);return {closed:true};
    }
    if(action!=='leave')fail('invalid-argument','지원하지 않는 요청입니다.');
    const members={...room.members};delete members[uid];const ids=room.memberIds.filter(id=>id!==uid);
    if(!general&&!ids.length){await deleteRoom(tx,db,roomRef,room);return {closed:true};}
    const next={...room,members,memberIds:ids,hostName:room.hostName||room.members[room.hostUid]?.displayName||'방장',emptySinceMs:ids.length?null:now};
    if(!general)next.deleteAfterMs=roomDeadline(next);
    tx.set(roomRef,next);tx.update(ref,{activeRoomId:null,...bump});return {closed:false};
  });
}
function validateTitle(title) {
  if(typeof title!=='string'||!title.trim()||title.trim().length>40||/[\p{Cc}\p{Cf}]/u.test(title))fail('invalid-argument','방 이름은 1~40자로 입력해 주세요.');
  return title.trim();
}
export async function roomDirectory(db,uid,profile) {
  const info=schoolRoomInfo(profile.school),now=Date.now(),rows=[];
  if(info) {
    const general=(await db.doc(`studyRooms/${info.id}`).get()).data();
    rows.push(roomPreview(general||{title:info.title,permanent:true,visibility:'public',members:{}},info.id,now));
    const docs=await db.collection('studyRooms').where('schoolId','==',info.schoolId).where('status','==','open').orderBy('createdAtMs','desc').limit(50).get();
    for(const doc of docs.docs)if(visibility(doc.data())==='public'&&canAccessPublicRoom(doc.data(),doc.id,profile)&&roomAvailable(doc.data(),doc.id,now)&&!rows.some(row=>row.id===doc.id))rows.push(roomPreview(doc.data(),doc.id,now));
  }
  const invites=await userRef(db,uid).collection('roomInvites').limit(50).get();
  const owned=await db.collection('studyRooms').where('hostUid','==',uid).limit(50).get();
  for(const doc of owned.docs)if(roomAvailable(doc.data(),doc.id,now)&&(visibility(doc.data())==='private'||canAccessPublicRoom(doc.data(),doc.id,profile))&&!rows.some(row=>row.id===doc.id))rows.push(roomPreview(doc.data(),doc.id,now));
  for(const invite of invites.docs) {
    if(invite.data().expiresAtMs<=now)continue;
    const doc=await db.doc(`studyRooms/${invite.id}`).get(),room=doc.data();
    if(roomAvailable(room,doc.id,now)&&room.invitedUids.includes(uid)&&(visibility(room)==='private'||canAccessPublicRoom(room,doc.id,profile))&&!rows.some(row=>row.id===doc.id))rows.push(roomPreview(room,doc.id,now));
  }
  return rows;
}
export async function syncRoom(db,uid,expectedId) {
  const ref=userRef(db,uid),roomRef=db.doc(`studyRooms/${expectedId}`);
  return db.runTransaction(async tx=>{
    const profile=(await tx.get(ref)).data();if(profile?.activeRoomId!==expectedId)return null;
    const room=(await tx.get(roomRef)).data(),now=Date.now();
    if(!roomAvailable(room,expectedId,now)) {
      if(room&&!isGeneralRoom(room,expectedId))await deleteRoom(tx,db,roomRef,room);
      else tx.update(ref,{activeRoomId:null,...bump});return null;
    }
    if(!room.memberIds.includes(uid)){tx.update(ref,{activeRoomId:null,...bump});return null;}
    if(visibility(room)==='public'&&!canAccessPublicRoom(room,expectedId,profile)) {
      const members={...room.members};delete members[uid];const ids=room.memberIds.filter(id=>id!==uid);
      if(!isGeneralRoom(room,expectedId)&&!ids.length){await deleteRoom(tx,db,roomRef,room);return null;}
      const next={...room,members,memberIds:ids,emptySinceMs:ids.length?null:now};
      if(!isGeneralRoom(room,expectedId))next.deleteAfterMs=roomDeadline(next);
      tx.set(roomRef,next);tx.update(ref,{activeRoomId:null,...bump});return null;
    }
    const camera=profile.activeSessionId?(await tx.get(db.doc(`users/${uid}/sessions/${profile.activeSessionId}`))).data():null;
    const word=profile.wordStudySessionId&&profile.wordStudySessionId!==profile.activeSessionId?(await tx.get(db.doc(`users/${uid}/sessions/${profile.wordStudySessionId}`))).data():null;
    const useWord=word?.status==='active'&&word.presenceUntilMs>now&&word.activeSinceMs!=null&&word.leaseUntilMs>now;
    const session=useWord?word:camera;
    const live=session?.status==='active'&&session.presenceUntilMs>now;
    const tracked=live&&(!(session.cameraMode||session.activityMode)||session.activeSinceMs!=null&&session.leaseUntilMs>now);
    const seconds=(useWord&&camera?.cameraMode?camera.accumulatedSeconds||0:0)+(live?(session.cameraMode||session.activityMode?(session.accumulatedSeconds||0)+(tracked?Math.max(0,Math.floor((Math.min(now,session.leaseUntilMs)-session.activeSinceMs)/1000)):0):Math.max(0,Math.floor((now-session.startedAt.toMillis())/1000))):0);
    const subjectName=session?(profile.subjects||[]).find(row=>row.id===session.subjectId)?.name||'기타':'';
    const countUntilMs=tracked?Math.min(session.presenceUntilMs,session.startedAt.toMillis()+12*3600000,session.cameraMode||session.activityMode?session.leaseUntilMs:Infinity):now;
    const studying=live&&(!(session.cameraMode||session.activityMode)||session.activeSinceMs!=null);
    const members={...room.members,[uid]:{...room.members[uid],displayName:profile.displayName||'공부 친구',lastSeenMs:now,sampledAtMs:now,countUntilMs,status:studying?'studying':'resting',seconds,subjectName}};
    const patch={members,...(!isGeneralRoom(room,expectedId)?{deleteAfterMs:now+ROOM_IDLE_MS}:{})};
    tx.update(roomRef,patch);return {...room,...patch,id:expectedId};
  });
}
export async function readActivityRoom(tx,db,uid,profile) {
  if(!profile?.activeRoomId)return null;
  const ref=db.doc(`studyRooms/${profile.activeRoomId}`),room=(await tx.get(ref)).data();
  return roomAvailable(room,ref.id)&&room.memberIds.includes(uid)&&(visibility(room)==='private'||canAccessPublicRoom(room,ref.id,profile))?{ref,room}:null;
}
// Word-app heartbeats also count as service visits, even when STUDY is closed.
export function publishWordRoom(tx,activity,uid,profile,session,now,present,camera) {
  if(!activity||!present)return;
  const {ref,room}=activity,tracked=session.activeSinceMs!=null&&session.leaseUntilMs>now&&session.presenceUntilMs>now;
  const cameraSeconds=(camera?.accumulatedSeconds||0)+(camera?.activeSinceMs!=null?Math.max(0,Math.floor((Math.min(now,camera.leaseUntilMs)-camera.activeSinceMs)/1000)):0);
  const seconds=cameraSeconds+(session.accumulatedSeconds||0)+(tracked?Math.max(0,Math.floor((Math.min(now,session.leaseUntilMs)-session.activeSinceMs)/1000)):0);
  const member={...room.members[uid],displayName:profile.displayName||'공부 친구',lastSeenMs:now,sampledAtMs:now,countUntilMs:tracked?Math.min(session.presenceUntilMs,session.leaseUntilMs):now,status:tracked?'studying':'resting',seconds,subjectName:'영단어'};
  tx.update(ref,{members:{...room.members,[uid]:member},...(!isGeneralRoom(room,ref.id)?{deleteAfterMs:now+ROOM_IDLE_MS}:{})});
}
export async function purgeIdleRooms(db,now=Date.now()) {
  // Priority queue handles current rooms; a rolling audit also migrates legacy rooms.
  const due=await db.collection('studyRooms').where('deleteAfterMs','<=',now).limit(30).get();
  const cursorRef=db.doc('systemJobs/studyRoomCleanup'),cursor=(await cursorRef.get()).data()?.cursor;
  let query=db.collection('studyRooms').orderBy('__name__').limit(50);if(cursor)query=query.startAfter(cursor);
  const audit=await query.get(),unique=new Map([...due.docs,...audit.docs].map(doc=>[doc.id,doc]));
  let deleted=0;
  for(const doc of unique.values())deleted+=await db.runTransaction(async tx=>{
    const room=(await tx.get(doc.ref)).data();if(!room||isGeneralRoom(room,doc.id))return 0;
    if(room.status!=='open'||roomDeadline(room)<=now){await deleteRoom(tx,db,doc.ref,room);return 1;}
    if(room.deleteAfterMs!==roomDeadline(room))tx.update(doc.ref,{deleteAfterMs:roomDeadline(room)});return 0;
  });
  await cursorRef.set({cursor:audit.size===50?audit.docs.at(-1).id:null});return {deleted};
}
