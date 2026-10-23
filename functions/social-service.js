import {createSocialCode,normalizeSocialCode,isShortSocialCode} from './social-code.js';
import {FieldValue} from 'firebase-admin/firestore';
import {HttpsError} from 'firebase-functions/v2/https';
import {schoolRoomInfo} from './integrations-domain.js';
import {changeRoom,roomDirectory,syncRoom} from './room-service.js';

export const ROOM_LIMIT = 12;
const fail = (code, message) => {throw new HttpsError(code,message);};
const validId = value => typeof value==='string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const userRef = (db,uid) => db.doc(`users/${uid}`);
const sub = (db,uid,collection,id) => userRef(db,uid).collection(collection).doc(id);
const bump = (tx,ref) => tx.update(ref,{socialRevision:FieldValue.increment(1)});
const name = profile => profile?.displayName || '공부 친구';

export async function changeSocial(db,uid,action,data={}) {
  if(['createRoom','createSchoolRoom','joinSchool','invite','join','joinCode','previewCode','previewRoom','roomCode','updateRoom','decline','leave','close'].includes(action))return changeRoom(db,uid,action,data);
  if (!['code','request','accept','reject','cancel','remove','createRoom','createSchoolRoom','joinSchool','invite','join','decline','leave','close'].includes(action)) fail('invalid-argument','지원하지 않는 요청입니다.');
  return db.runTransaction(async tx=>{
    const ref=userRef(db,uid),profile=(await tx.get(ref)).data(),now=Date.now();
    if(!profile)fail('failed-precondition','계정 설정을 먼저 완료해 주세요.');
    if(action==='code') {
      if(isShortSocialCode(profile.friendCode))return {code:profile.friendCode};
      let code,codeRef;
      for(let attempt=0;attempt<8;attempt++) {
        code=createSocialCode();codeRef=db.doc(`friendCodes/${code}`);
        if(!(await tx.get(codeRef)).exists)break;
        codeRef=null;
      }
      if(!codeRef)fail('aborted','코드를 다시 생성해 주세요.');
      if(profile.friendCode)tx.delete(db.doc(`friendCodes/${profile.friendCode}`));
      tx.create(codeRef,{uid});tx.update(ref,{friendCode:code,socialRevision:FieldValue.increment(1)});return {code};
    }
    if(['request','accept','reject','cancel','remove'].includes(action)) {
      let other=data.uid;
      if(action==='request') {
        const code=normalizeSocialCode(data.code);
        if(!isShortSocialCode(code))fail('invalid-argument','친구 코드 6자리를 확인해 주세요.');
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
  });
}

export async function socialSnapshot(db,uid,{revision=-1,includeLists=false,listScope,includeSchoolRooms=false}={}) {
  if(listScope!=null&&!['requests','invites'].includes(listScope))fail('invalid-argument','새로고침할 목록이 올바르지 않습니다.');
  const ref=userRef(db,uid),profile=(await ref.get()).data();
  if(!profile)fail('failed-precondition','계정 설정을 먼저 완료해 주세요.');
  const result={revision:profile.socialRevision||0,code:isShortSocialCode(profile.friendCode)?profile.friendCode:null,room:null,serverNowMs:Date.now()};
  result.schoolRoom=schoolRoomInfo(profile.school);
  if(includeSchoolRooms)result.schoolRooms=await roomDirectory(db,uid,profile);
  // Listeners are unnecessary: poll only while the Play page or a room is open,
  // and reuse lists until a server-owned revision changes.
  if(includeLists&&(listScope||revision!==result.revision)) {
    const collections=listScope==='requests'?['friendRequests','sentRequests']:listScope==='invites'?['roomInvites']:['friends','friendRequests','sentRequests','roomInvites'];
    for(const collection of collections) {
      const docs=await ref.collection(collection).limit(50).get();
      result[collection]=docs.docs.map(doc=>({...doc.data(),id:doc.id}));
    }
  }
  if(profile.activeRoomId)result.room=await syncRoom(db,uid,profile.activeRoomId);
  result.serverNowMs=Date.now();
  return result;
}
