import {randomUUID,createHash,createPublicKey,verify} from 'node:crypto';
import {HttpsError} from './platform-http.js';
import {FACE_POLICY,FACE_MODEL,FACE_PREPROCESS,FACE_SCHEMA,FACE_ORIGIN,faceAAD,faceMessage,studyNonce} from './face-protocol.js';

const fail=(code,message)=>{throw new HttpsError(code,message);};
const id=value=>typeof value==='string'&&/^[a-zA-Z0-9_-]{16,100}$/.test(value);
export const envelopeHash=value=>createHash('sha256').update(value).digest('hex');
export const seoulDay=now=>new Date(now+32400000).toISOString().slice(0,10);
export const faceDayEnd=now=>Date.parse(`${seoulDay(now)}T00:00:00+09:00`)+86400000;
const recent=(token,now,after=0)=>{
  const time=token.auth_time*1000;
  if(!Number.isFinite(time)||time>now+1000||now-time>300000||time<after-1000||seoulDay(time)!==seoulDay(now))fail('failed-precondition','계정을 다시 인증해 주세요.');
};
function publicKey(value) {
  if(value?.kty!=='EC'||value.crv!=='P-256'||value.d||!/^[-\w]{43}$/.test(value.x||'')||!/^[-\w]{43}$/.test(value.y||''))fail('invalid-argument','브라우저 공개키가 올바르지 않습니다.');
  const key={kty:'EC',crv:'P-256',x:value.x,y:value.y};
  try{createPublicKey({key,format:'jwk'});}catch{fail('invalid-argument','브라우저 공개키가 올바르지 않습니다.');}
  return key;
}
export function verifyFaceProof(key,purpose,uid,installationId,nonce,signature) {
  try {
    if(typeof signature!=='string'||signature.length!==88)return false;
    return verify('sha256',Buffer.from(faceMessage(purpose,uid,installationId,nonce)),{key:createPublicKey({key,format:'jwk'}),dsaEncoding:'ieee-p1363'},Buffer.from(signature,'base64'));
  }catch{return false;}
}
const requireProof=(key,purpose,uid,installationId,nonce,signature)=>{
  if(!verifyFaceProof(key,purpose,uid,installationId,nonce,signature))fail('permission-denied','등록한 브라우저에서 다시 시도해 주세요.');
};
const currentGrant=(state,installationId,now)=>state?.grant?.installationId===installationId&&state.grant.expiresAtMs>now&&state.grant.policyVersion===FACE_POLICY;
export async function authorizeFaceStudy(tx,db,uid,data,session=null,now=Date.now()) {
  const state=(await tx.get(db.doc(`faceSecurity/${uid}`))).data(),auth=data?.faceAuthorization,active=state?.active;
  if(!active||active.revoked||!auth||!currentGrant(state,active.installationId,now)||state.grant.generation!==active.generation||auth.grantId!==state.grant.id||auth.profileId!==active.profileId||auth.generation!==active.generation||auth.installationId!==active.installationId||!Number.isFinite(auth.issuedAt)||Math.abs(now-auth.issuedAt)>60000||session&&(session.faceProfileId!==active.profileId||session.faceGeneration!==active.generation))fail('failed-precondition','일일 인증과 등록한 얼굴 확인이 필요합니다.');
  requireProof(active.publicKey,'study',uid,active.installationId,studyNonce(data),auth.signature);
  return {faceProfileId:active.profileId,faceGeneration:active.generation,faceAuthUntilMs:state.grant.expiresAtMs,faceLeaseUntilMs:Math.min(now+60000,state.grant.expiresAtMs),verificationType:'face-browser'};
}

// One private UID record makes nonce consumption and generation changes atomic on both stores.
export function createFaceService({db,kms,projectId,configured=()=>true,clock=Date.now}) {
  return async function faceCall(action,request) {
    const uid=request.auth?.uid,token=request.auth?.token||{},data=request.data||{},now=clock();
    if(!uid||token.email_verified!==true||!['password','google.com'].includes(token.firebase?.sign_in_provider))fail('permission-denied','이메일 인증을 마친 이메일 또는 Google 계정으로 로그인해 주세요.');
    const ref=db.doc(`faceSecurity/${uid}`);
    if(action==='getFaceEnrollmentStatus') {
      const state=(await ref.get()).data();
      return {enabled:configured(),policyVersion:FACE_POLICY,serverNowMs:now,active:state?.active&&!state.active.revoked?{profileId:state.active.profileId,generation:state.active.generation,installationId:state.active.installationId}:null,pending:state?.ticket?.installationId===data.installationId&&state.ticket.expiresAtMs>now?{id:state.ticket.id,idempotencyKey:state.ticket.idempotencyKey,profileId:state.ticket.binding.profileId,envelopeHash:state.ticket.envelopeHash||null}:null,grant:currentGrant(state,data.installationId,now)?state.grant:null};
    }
    if(!configured())fail('failed-precondition','얼굴 보안 키 설정이 필요합니다. 관리자에게 문의해 주세요.');
    if(!id(data.installationId))fail('invalid-argument','브라우저 설치 정보가 올바르지 않습니다.');
    const rateRef=db.doc(`faceSecurityRates/${uid}`);
    await db.runTransaction(async tx=>{
      const saved=(await tx.get(rateRef)).data(),rate=saved?.until>now?saved:{until:now+60000,count:0};
      if(++rate.count>60)fail('resource-exhausted','요청이 많습니다. 잠시 후 다시 시도해 주세요.');
      tx.set(rateRef,rate);
    });
    return db.runTransaction(async tx=>{
      const state=(await tx.get(ref)).data()||{},active=state.active;
      // Metadata only; bounded retention, including abandoned tickets.
      state.audit=(state.audit||[]).filter(row=>now-row.at<90*86400000).slice(-1023);
      state.registrations=(state.registrations||[]).filter(at=>now-at<86400000);
      if(state.challenge?.expiresAtMs<=now)state.challenge=null;
      if(state.ticket?.expiresAtMs<=now)state.ticket=null;
      if(state.unlock?.expiresAtMs<=now)state.unlock=null;
      if(state.grant?.expiresAtMs<=now)state.grant=null;
      const grant=()=>{if(!currentGrant(state,data.installationId,now))fail('failed-precondition','오늘의 계정 인증을 완료해 주세요.');};
      const ticket=()=>{
        grant();
        if(!state.ticket||state.ticket.id!==data.ticketId||state.ticket.installationId!==data.installationId)fail('failed-precondition','얼굴 등록 허가가 만료되었습니다.');
        return state.ticket;
      };
      const save=result=>{state.cleanupAtMs=now+3600000;tx.set(ref,state);return result;};
      if(action==='beginDailyFaceAuth') {
        state.challenge={id:randomUUID(),installationId:data.installationId,publicKey:publicKey(data.publicKey),enrollmentOnly:data.enrollmentOnly===true,createdAtMs:now,expiresAtMs:now+300000};
        return save({challengeId:state.challenge.id,serverNowMs:now});
      }
      if(action==='completeDailyFaceAuth') {
        const challenge=state.challenge;
        if(!challenge||challenge.id!==data.challengeId||challenge.installationId!==data.installationId)fail('failed-precondition','계정 인증 요청이 만료되었습니다.');
        recent(token,now,challenge.createdAtMs);
        const key=active&&!active.revoked&&!challenge.enrollmentOnly&&active.installationId===data.installationId?active.publicKey:challenge.publicKey;
        requireProof(key,'daily',uid,data.installationId,challenge.id,data.signature);
        state.grant={id:randomUUID(),installationId:data.installationId,generation:active?.installationId===data.installationId&&!active.revoked&&!challenge.enrollmentOnly?active.generation:0,publicKey:challenge.publicKey,authTime:token.auth_time,policyVersion:FACE_POLICY,expiresAtMs:faceDayEnd(now)};
        state.challenge=null;
        return save({grant:state.grant,serverNowMs:now});
      }
      if(action==='beginFaceEnrollment') {
        grant();recent(token,now);
        if(state.registrations.length>=3)fail('resource-exhausted','24시간 내 얼굴 등록은 3회까지 가능합니다. 관리자에게 문의해 주세요.');
        requireProof(state.grant.publicKey,'enroll',uid,data.installationId,state.grant.id,data.signature);
        if(!id(data.idempotencyKey))fail('invalid-argument','등록 요청 식별자가 올바르지 않습니다.');
        if(state.ticket?.idempotencyKey===data.idempotencyKey)return save({ticket:state.ticket});
        if(state.ticket)fail('already-exists','다른 얼굴 등록이 진행 중입니다. 취소하거나 만료 후 다시 시도해 주세요.');
        const binding={projectId,appOrigin:FACE_ORIGIN,uid,installationId:data.installationId,profileId:randomUUID(),generation:(state.generation||0)+1,modelVersion:FACE_MODEL,preprocessVersion:FACE_PREPROCESS,schemaVersion:FACE_SCHEMA,purpose:'face-profile'};
        state.ticket={id:randomUUID(),installationId:data.installationId,idempotencyKey:data.idempotencyKey,publicKey:state.grant.publicKey,binding,expiresAtMs:now+300000};
        return save({ticket:state.ticket});
      }
      if(action==='sealFaceKeyEnvelope') {
        const pending=ticket();
        if(typeof data.wrappedKey!=='string'||!/^[A-Za-z0-9+/]{54}==$/.test(data.wrappedKey)||Buffer.from(data.wrappedKey,'base64').length!==40)fail('invalid-argument','키 봉투 형식이 올바르지 않습니다.');
        const hash=envelopeHash(data.wrappedKey);
        requireProof(pending.publicKey,'seal',uid,data.installationId,`${pending.id}:${hash}`,data.signature);
        if(pending.localHash&&pending.localHash!==hash)fail('already-exists','이미 다른 키가 등록 요청에 연결되어 있습니다.');
        if(!pending.envelope){pending.envelope=await kms.seal(data.wrappedKey,faceAAD(pending.binding));pending.localHash=hash;pending.envelopeHash=envelopeHash(pending.envelope);}
        return save({envelope:pending.envelope,envelopeHash:pending.envelopeHash});
      }
      if(action==='commitFaceEnrollment') {
        grant();
        if(state.lastCommit?.idempotencyKey===data.idempotencyKey&&active?.profileId===state.lastCommit.profileId){
          requireProof(active.publicKey,'commit',uid,data.installationId,`${data.ticketId}:${data.envelopeHash}`,data.signature);
          if(active.installationId!==data.installationId||active.envelopeHash!==data.envelopeHash)fail('permission-denied','등록 요청이 일치하지 않습니다.');
          return save({active:active.binding,grant:state.grant});
        }
        const pending=ticket();
        if(!pending.envelope||pending.envelopeHash!==data.envelopeHash||pending.idempotencyKey!==data.idempotencyKey)fail('failed-precondition','암호화 저장을 먼저 완료해 주세요.');
        requireProof(pending.publicKey,'commit',uid,data.installationId,`${pending.id}:${pending.envelopeHash}`,data.signature);
        state.active={...pending.binding,binding:pending.binding,publicKey:pending.publicKey,envelopeHash:pending.envelopeHash,createdAtMs:now,revoked:false};
        state.generation=pending.binding.generation;state.grant.generation=state.generation;
        state.lastCommit={idempotencyKey:data.idempotencyKey,profileId:pending.binding.profileId};
        state.registrations.push(now);state.audit.push({event:active?'replaced':'enrolled',at:now,generation:state.generation});state.ticket=null;state.unlock=null;
        return save({active:state.active.binding,grant:state.grant});
      }
      if(action==='beginFaceUnlock') {
        grant();
        if(!active||active.revoked||active.installationId!==data.installationId||active.generation!==state.grant.generation||active.profileId!==data.profileId)fail('failed-precondition','현재 브라우저의 활성 얼굴 등록이 없습니다.');
        state.unlock={id:randomUUID(),expiresAtMs:now+60000,envelopeHash:active.envelopeHash,generation:active.generation};
        return save({nonce:state.unlock.id,binding:active.binding,expiresAtMs:state.grant.expiresAtMs,serverNowMs:now});
      }
      if(action==='unlockFaceKeyEnvelope') {
        grant();const unlock=state.unlock;
        if(!active||active.revoked||active.installationId!==data.installationId||active.generation!==state.grant.generation||!unlock||unlock.id!==data.nonce||unlock.generation!==active.generation||typeof data.envelope!=='string'||data.envelope.length>8192||envelopeHash(data.envelope)!==active.envelopeHash)fail('permission-denied','키 해제 요청이 만료되었거나 등록이 변경되었습니다.');
        requireProof(active.publicKey,'unlock',uid,data.installationId,`${unlock.id}:${active.envelopeHash}`,data.signature);
        const wrappedKey=await kms.open(data.envelope,faceAAD(active.binding));state.unlock=null;
        return save({wrappedKey,expiresAtMs:state.grant.expiresAtMs,serverNowMs:now});
      }
      if(action==='cancelFaceEnrollment') {
        const pending=ticket();requireProof(pending.publicKey,'cancel',uid,data.installationId,pending.id,data.signature);state.ticket=null;return save({cancelled:true});
      }
      if(action==='lockFaceEnrollment') {
        grant();requireProof(state.grant.publicKey,'lock',uid,data.installationId,state.grant.id,data.signature);state.grant=null;state.unlock=null;return save({locked:true});
      }
      if(action==='revokeFaceEnrollment') {
        recent(token,now);if(active&&!active.revoked){state.active={...active,revoked:true,revokedAtMs:now};state.audit.push({event:'revoked',at:now});}
        state.grant=null;state.ticket=null;state.unlock=null;return save({revoked:true});
      }
      fail('not-found','지원하지 않는 얼굴 보안 요청입니다.');
    });
  };
}
