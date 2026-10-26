// Imported in the inference Worker. Plain descriptors never enter the UI thread.
import {faceStore,faceRecordKey} from './face-storage.js';
import {encryptFaceSamples,decryptFaceSamples,signFace,hashFace} from './face-crypto.js';
import {faceAAD} from './functions/face-protocol.js';

export function createFaceVault(context,rpc,notify=()=>{}) {
  let record=context.record,ticket=context.ticket,closed=false;
  const {uid,installationId,keys}=context;
  const call=async(action,data)=>{if(closed)throw new Error('얼굴 보안 세션이 종료되었습니다.');const result=await rpc(action,{installationId,...data});if(closed)throw new Error('얼굴 보안 세션이 종료되었습니다.');return result;};
  async function unlock() {
    if(!record)throw new Error('암호화된 얼굴 정보가 없습니다.');
    const challenge=await call('beginFaceUnlock',{profileId:record.binding.profileId});
    if(faceAAD(challenge.binding)!==faceAAD(record.binding))throw new Error('활성 얼굴 등록이 변경되었습니다.');
    const signature=await signFace(keys,'unlock',uid,installationId,`${challenge.nonce}:${await hashFace(record.envelope)}`);
    let response=await call('unlockFaceKeyEnvelope',{nonce:challenge.nonce,envelope:record.envelope,signature});
    try{
      const samples=await decryptFaceSamples(record,keys,response.wrappedKey,uid,installationId);
      record={...record,status:'active'};
      await faceStore('profiles','readwrite',faceRecordKey(uid,installationId,record.binding.profileId),record);
      notify({type:'face-unlocked',binding:record.binding,expiresAtMs:response.expiresAtMs,serverNowMs:response.serverNowMs});
      return samples;
    }finally{response.wrappedKey=null;response=null;}
  }
  return {
    async load(){return ticket?null:unlock();},
    async save(samples){
      if(!ticket)throw new Error('얼굴 등록 허가가 없습니다.');
      notify({type:'face-progress',state:'ENROLLMENT_COMMITTING',progress:12});
      let encrypted=await encryptFaceSamples(samples,keys,ticket.binding);
      try{
        const signature=await signFace(keys,'seal',uid,installationId,`${ticket.id}:${await hashFace(encrypted.wrappedKey)}`);
        const sealed=await call('sealFaceKeyEnvelope',{ticketId:ticket.id,wrappedKey:encrypted.wrappedKey,signature});
        encrypted.wrappedKey=null;
        record={ciphertext:encrypted.ciphertext,iv:encrypted.iv,binding:encrypted.binding,envelope:sealed.envelope,status:'pending',idempotencyKey:ticket.idempotencyKey,ticketId:ticket.id};
        await faceStore('profiles','readwrite',faceRecordKey(uid,installationId,record.binding.profileId),record);
        // Persist a pointer AFTER the pending ciphertext, before the server commit.
        await faceStore('settings','readwrite',`${uid}:${installationId}:pending`,record.binding.profileId);
        const commitSignature=await signFace(keys,'commit',uid,installationId,`${ticket.id}:${sealed.envelopeHash}`);
        const committed=await call('commitFaceEnrollment',{ticketId:ticket.id,idempotencyKey:ticket.idempotencyKey,envelopeHash:sealed.envelopeHash,signature:commitSignature});
        notify({type:'face-committed',grant:committed.grant,binding:committed.active});
        ticket=null;
        const restored=await unlock();
        await faceStore('settings','readwrite',`${uid}:${installationId}:pending`,undefined);
        return restored;
      }finally{if(encrypted)encrypted.wrappedKey=null;encrypted=null;}
    },
    close(){closed=true;record=null;ticket=null;context=null;},
  };
}
