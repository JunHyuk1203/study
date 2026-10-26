// Imported in the inference Worker. Plain descriptors never enter the UI thread.
import {faceStore,faceRecordKey} from './face-storage.js';
import {encryptFaceSamples,decryptFaceSamples,signFace,hashFace} from './face-crypto.js';
import {faceAAD} from './functions/face-protocol.js';

export function createFaceVault(context,rpc,notify=()=>{}) {
  let record=context.record,ticket=context.ticket,closed=false,candidate=null;
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
      const progress=label=>notify({type:'face-progress',state:'ENROLLMENT_COMMITTING',progress:12,manualCapture:false,label});
      if(!ticket){progress('저장된 얼굴 정보의 암호화를 확인하고 있습니다');const restored=await unlock();await faceStore('settings','readwrite',`${uid}:${installationId}:pending`,undefined);return restored;}
      if(record?.ticketId!==ticket.id){
        progress('얼굴 정보를 암호화하고 있습니다');
        candidate??=await encryptFaceSamples(samples,keys,ticket.binding);
        progress('서버 보안 키로 암호화 정보를 보호하고 있습니다');
        const signature=await signFace(keys,'seal',uid,installationId,`${ticket.id}:${await hashFace(candidate.wrappedKey)}`);
        const sealed=await call('sealFaceKeyEnvelope',{ticketId:ticket.id,wrappedKey:candidate.wrappedKey,signature});
        record={ciphertext:candidate.ciphertext,iv:candidate.iv,binding:candidate.binding,envelope:sealed.envelope,status:'pending',idempotencyKey:ticket.idempotencyKey,ticketId:ticket.id};
        candidate.wrappedKey=null;candidate=null;
      }
      {
        progress('브라우저에 암호화된 얼굴 정보를 저장하고 있습니다');
        await faceStore('profiles','readwrite',faceRecordKey(uid,installationId,record.binding.profileId),record);
        // Persist a pointer AFTER the pending ciphertext, before the server commit.
        await faceStore('settings','readwrite',`${uid}:${installationId}:pending`,record.binding.profileId);
        progress('서버에 얼굴 등록을 확정하고 있습니다');
        const envelopeHash=await hashFace(record.envelope);
        const commitSignature=await signFace(keys,'commit',uid,installationId,`${ticket.id}:${envelopeHash}`);
        const committed=await call('commitFaceEnrollment',{ticketId:ticket.id,idempotencyKey:ticket.idempotencyKey,envelopeHash,signature:commitSignature});
        notify({type:'face-committed',grant:committed.grant,binding:committed.active});
        ticket=null;
        progress('저장된 얼굴 정보를 열어 정상 저장 여부를 확인하고 있습니다');
        const restored=await unlock();
        await faceStore('settings','readwrite',`${uid}:${installationId}:pending`,undefined);
        return restored;
      }
    },
    close(){closed=true;record=null;ticket=null;if(candidate)candidate.wrappedKey=null;candidate=null;context=null;},
  };
}
