import {randomBytes} from 'node:crypto';
import {FieldValue} from 'firebase-admin/firestore';
import {HttpsError} from 'firebase-functions/v2/https';

export const ROOM_LIMIT = 12;
const ROOM_LIFE = 12 * 3600000;
const fail = (code, message) => {throw new HttpsError(code,message);};
const validId = value => typeof value==='string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const userRef = (db,uid) => db.doc(`users/${uid}`);
const sub = (db,uid,collection,id) => userRef(db,uid).collection(collection).doc(id);
const bump = (tx,ref) => tx.update(ref,{socialRevision:FieldValue.increment(1)});
const openRoom = (room,now) => room?.status==='open' && room.expiresAtMs>now;
const name = profile => profile?.displayName || '공부 친구';

export async function changeSocial(db,uid,action,data={}) {
  if (!['code','request','accept','reject','cancel','remove','createRoom','invite','join','decline','leave','close'].includes(action)) fail('invalid-argument','지원하지 않는 요청입니다.');
  return db.runTransaction(async tx=>{
    const ref=userRef(db,uid),profile=(await tx.get(ref)).data(),now=Date.now();
    if(!profile)fail('failed-precondition','계정 설정을 먼저 완료해 주세요.');
    if(action==='code') {
      if(profile.friendCode)return {code:profile.friendCode};
      const code=randomBytes(5).toString('hex').toUpperCase(),codeRef=db.doc(`friendCodes/${code}`);
      if((await tx.get(codeRef)).exists)fail('aborted','코드를 다시 생성해 주세요.');
      tx.create(codeRef,{uid});tx.update(ref,{friendCode:code,socialRevision:FieldValue.increment(1)});return {code};
    }
    if(['request','accept','reject','cancel','remove'].includes(action)) {
      let other=data.uid;
      if(action==='request') {
        const code=String(data.code||'').trim().toUpperCase();
        if(!/^[A-F0-9]{10}$/.test(code))fail('invalid-argument','친구 코드 10자리를 확인해 주세요.');
        other=(await tx.get(db.doc(`friendCodes/${code}`))).data()?.uid;
        if(!other)fail('not-found','친구 코드를 찾을 수 없습니다.');
      }
      if(!validId(other)||other===uid)fail('invalid-argument','상대방 친구 코드를 입력해 주세요.');
      const otherRef=userRef(db,other),otherProfile=(await tx.get(otherRef)).data();
      if(!otherProfile)fail('not-found','친구 계정을 찾을 수 없습니다.');
      const friend=sub(db,uid,'friends',other),reverseFriend=sub(db,other,'friends',uid);
      const incoming=sub(db,uid,'friendRequests',other),outgoing=sub(db,uid,'sentRequests',other);
      const otherIncoming=sub(db,other,'friendRequests',uid),otherOutgoing=sub(db,other,'sentRequests',uid);
      const docs=await tx.getAll(friend,reverseFriend,incoming,outgoing,otherIncoming,otherOutgoing);
      if(action==='remove') {if(!docs[0].exists)fail('not-found','이미 삭제된 친구입니다.');tx.delete(friend);tx.delete(reverseFriend);}
      else if(action==='reject'||action==='cancel') {
        if(action==='reject'){if(!docs[2].exists)fail('not-found','이미 처리된 친구 요청입니다.');tx.delete(incoming);tx.delete(otherOutgoing);}
        else {if(!docs[3].exists)fail('not-found','이미 처리된 친구 요청입니다.');tx.delete(outgoing);tx.delete(otherIncoming);}
      } else {
        if(docs[0].exists)fail('already-exists','이미 추가한 친구입니다.');
        if(action==='request') {
          if(docs[2].exists)fail('already-exists','상대방의 친구 요청이 있습니다. 받은 요청에서 수락해 주세요.');
          if(docs[3].exists)fail('already-exists','이미 친구 요청을 보냈습니다.');
          const pending=await tx.get(otherRef.collection('friendRequests').limit(50));
          const sent=await tx.get(ref.collection('sentRequests').limit(50));
          if(pending.size>=48||sent.size>=48)fail('resource-exhausted','대기 중인 요청이 많습니다. 먼저 정리해 주세요.');
          tx.set(otherIncoming,{uid,displayName:name(profile),createdAtMs:now});
          tx.set(outgoing,{uid:other,displayName:name(otherProfile),createdAtMs:now});
        } else {
          if(!docs[2].exists)fail('not-found','친구 요청이 취소되었거나 처리되었습니다.');
          const ownFriends=await tx.get(ref.collection('friends').limit(50));
          const theirFriends=await tx.get(otherRef.collection('friends').limit(50));
          if(ownFriends.size>=48||theirFriends.size>=48)fail('resource-exhausted','친구는 최대 48명까지 추가할 수 있습니다.');
          tx.set(friend,{uid:other,displayName:name(otherProfile),createdAtMs:now});
          tx.set(reverseFriend,{uid,displayName:name(profile),createdAtMs:now});
          for(const request of [incoming,outgoing,otherIncoming,otherOutgoing])tx.delete(request);
        }
      }
      bump(tx,ref);bump(tx,otherRef);return {updated:true};
    }
    if(action==='createRoom') {
      const title=typeof data.title==='string'?data.title.trim():'';
      if(!title||title.length>40||/[\p{Cc}\p{Cf}]/u.test(title))fail('invalid-argument','방 이름은 1~40자로 입력해 주세요.');
      if(profile.activeRoomId) {
        const previous=(await tx.get(db.doc(`studyRooms/${profile.activeRoomId}`))).data();
        if(openRoom(previous,now)&&previous.memberIds.includes(uid))fail('already-exists','참여 중인 방에서 먼저 나가 주세요.');
      }
      const roomRef=db.collection('studyRooms').doc();
      tx.create(roomRef,{title,hostUid:uid,status:'open',createdAtMs:now,expiresAtMs:now+ROOM_LIFE,memberIds:[uid],invitedUids:[],members:{[uid]:{uid,displayName:name(profile),joinedAtMs:now,lastSeenMs:now,status:'resting',seconds:0,subjectName:''}}});
      tx.update(ref,{activeRoomId:roomRef.id,socialRevision:FieldValue.increment(1)});return {roomId:roomRef.id};
    }
    const roomId=data.roomId;
    if(!validId(roomId))fail('invalid-argument','방 정보가 올바르지 않습니다.');
    const roomRef=db.doc(`studyRooms/${roomId}`),room=(await tx.get(roomRef)).data();
    if(!room)fail('not-found','방을 찾을 수 없습니다.');
    const member=room.memberIds.includes(uid),host=room.hostUid===uid;
    if(action==='decline') {
      tx.delete(sub(db,uid,'roomInvites',roomId));bump(tx,ref);return {updated:true};
    }
    if(!openRoom(room,now))fail('failed-precondition','이미 종료되었거나 만료된 일회성 방입니다.');
    if(action==='join') {
      if(member)return {roomId};
      const invitation=(await tx.get(sub(db,uid,'roomInvites',roomId))).data();
      if(!room.invitedUids.includes(uid)||!invitation||invitation.expiresAtMs<=now)fail('permission-denied','유효한 친구 초대가 필요합니다.');
      if(profile.activeRoomId&&profile.activeRoomId!==roomId) {
        const previous=(await tx.get(db.doc(`studyRooms/${profile.activeRoomId}`))).data();
        if(openRoom(previous,now)&&previous.memberIds.includes(uid))fail('already-exists','참여 중인 방에서 먼저 나가 주세요.');
      }
      if(room.memberIds.length>=ROOM_LIMIT)fail('resource-exhausted','방 인원이 가득 찼습니다. 최대 12명까지 참여할 수 있습니다.');
      tx.update(roomRef,{memberIds:[...room.memberIds,uid],invitedUids:room.invitedUids.filter(id=>id!==uid),members:{...room.members,[uid]:{uid,displayName:name(profile),joinedAtMs:now,lastSeenMs:now,status:'resting',seconds:0,subjectName:''}}});
      tx.delete(sub(db,uid,'roomInvites',roomId));tx.update(ref,{activeRoomId:roomId,socialRevision:FieldValue.increment(1)});return {roomId};
    }
    if(!member)fail('permission-denied','참여 중인 방에서만 사용할 수 있습니다.');
    if(action==='invite') {
      const ids=[...new Set(Array.isArray(data.uids)?data.uids:[])];
      if(!ids.length||ids.length>ROOM_LIMIT-1||ids.some(id=>!validId(id)||room.memberIds.includes(id)))fail('invalid-argument','초대할 친구를 선택해 주세요.');
      if(new Set([...room.invitedUids,...ids]).size>48)fail('resource-exhausted','대기 중인 방 초대가 너무 많습니다.');
      const friends=await tx.getAll(...ids.map(id=>sub(db,uid,'friends',id)));
      if(friends.some(doc=>!doc.exists))fail('permission-denied','추가한 친구에게만 초대할 수 있습니다.');
      // Serialize invitations on recipient profiles so inbox limits cannot race.
      const recipients=await tx.getAll(...ids.map(id=>userRef(db,id)));
      const inboxes=await Promise.all(ids.map(id=>tx.get(userRef(db,id).collection('roomInvites').limit(50))));
      if(inboxes.some(inbox=>inbox.size>=48))fail('resource-exhausted','친구의 초대함이 가득 찼습니다.');
      tx.update(roomRef,{invitedUids:[...new Set([...room.invitedUids,...ids])]});
      ids.forEach((id,index)=>{if(!recipients[index].exists)fail('not-found','친구 계정을 찾을 수 없습니다.');tx.set(sub(db,id,'roomInvites',roomId),{roomId,title:room.title,hostName:name(profile),createdAtMs:now,expiresAtMs:Math.min(room.expiresAtMs,now+30*60000)});bump(tx,userRef(db,id));});
      return {invited:ids.length};
    }
    if(action==='close'&&!host)fail('permission-denied','방장만 방을 종료할 수 있습니다.');
    if(host) {
      const members=await tx.getAll(...room.memberIds.map(id=>userRef(db,id)));
      const invited=room.invitedUids.length?await tx.getAll(...room.invitedUids.map(id=>userRef(db,id))):[];
      tx.update(roomRef,{status:'closed',closedAtMs:now});
      members.forEach(doc=>{if(doc.data()?.activeRoomId===roomId)tx.update(doc.ref,{activeRoomId:null,socialRevision:FieldValue.increment(1)});});
      invited.forEach(doc=>{tx.delete(sub(db,doc.id,'roomInvites',roomId));if(doc.exists)bump(tx,doc.ref);});
    } else {
      const members={...room.members};delete members[uid];
      tx.update(roomRef,{memberIds:room.memberIds.filter(id=>id!==uid),members});
      if(profile.activeRoomId===roomId)tx.update(ref,{activeRoomId:null,socialRevision:FieldValue.increment(1)});
    }
    return {closed:host};
  });
}

export async function socialSnapshot(db,uid,{revision=-1,includeLists=false}={}) {
  const ref=userRef(db,uid),profile=(await ref.get()).data();
  if(!profile)fail('failed-precondition','계정 설정을 먼저 완료해 주세요.');
  const result={revision:profile.socialRevision||0,code:profile.friendCode||null,room:null,serverNowMs:Date.now()};
  // Listeners are unnecessary: poll only while the Play page or a room is open,
  // and reuse lists until a server-owned revision changes.
  if(includeLists&&revision!==result.revision) {
    for(const collection of ['friends','friendRequests','sentRequests','roomInvites']) {
      const docs=await ref.collection(collection).limit(50).get();
      result[collection]=docs.docs.map(doc=>({...doc.data(),id:doc.id}));
    }
  }
  if(profile.activeRoomId) {
    const roomRef=db.doc(`studyRooms/${profile.activeRoomId}`);
    result.room=await db.runTransaction(async tx=>{
      const currentProfile=(await tx.get(ref)).data();
      if(currentProfile?.activeRoomId!==profile.activeRoomId)return null;
      const room=(await tx.get(roomRef)).data(),now=Date.now();
      if(!openRoom(room,now)||!room.memberIds.includes(uid)) {
        tx.update(ref,{activeRoomId:null,socialRevision:FieldValue.increment(1)});return null;
      }
      const sessionId=currentProfile.activeSessionId;
      const session=sessionId?(await tx.get(sub(db,uid,'sessions',sessionId))).data():null;
      const live=session?.status==='active'&&session.presenceUntilMs>now;
      const tracked=live&&(!(session.cameraMode||session.activityMode)||session.activeSinceMs!=null&&session.leaseUntilMs>now);
      const seconds=live?(session.cameraMode||session.activityMode?(session.accumulatedSeconds||0)+(tracked?Math.max(0,Math.floor((Math.min(now,session.leaseUntilMs)-session.activeSinceMs)/1000)):0):Math.max(0,Math.floor((now-session.startedAt.toMillis())/1000))):0;
      const subjectName=session?(currentProfile.subjects||[]).find(row=>row.id===session.subjectId)?.name||'기타':'';
      const members={...room.members,[uid]:{...room.members[uid],displayName:name(currentProfile),lastSeenMs:now,status:tracked?'studying':'resting',seconds,subjectName}};
      tx.update(roomRef,{members});
      return {...room,id:roomRef.id,members};
    });
  }
  return result;
}
