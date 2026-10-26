import {getApp} from 'firebase-admin/app';
import {HttpsError} from './platform-http.js';

export const faceKmsConfigured = () => /^projects\/[^/]+\/locations\/[^/]+\/keyRings\/[^/]+\/cryptoKeys\/[^/]+$/.test(process.env.FACE_KMS_KEY || '');
// Uses the existing ADC/service-account credential. No local KEK fallback exists.
export function createFaceKms() {
  async function call(method,input,aad) {
    if(!faceKmsConfigured())throw new HttpsError('failed-precondition','얼굴 보안 키 설정이 필요합니다. 관리자에게 문의해 주세요.');
    const credential=getApp().options.credential;
    const {access_token}=await credential.getAccessToken();
    let response;
    try {
      response=await fetch(`https://cloudkms.googleapis.com/v1/${process.env.FACE_KMS_KEY}:${method}`,{
        method:'POST',headers:{Authorization:`Bearer ${access_token}`,'Content-Type':'application/json'},
        body:JSON.stringify({[method==='encrypt'?'plaintext':'ciphertext']:input,additionalAuthenticatedData:Buffer.from(aad).toString('base64')}),
        signal:AbortSignal.timeout(15000),cache:'no-store',
      });
      if(!response.ok)throw new Error('kms');
      const result=await response.json();
      const output=result[method==='encrypt'?'ciphertext':'plaintext'];
      if(typeof output!=='string'||output.length>8192)throw new Error('kms');
      return output;
    }catch {throw new HttpsError('unavailable','얼굴 보안 키를 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.');}
  }
  return {seal:(value,aad)=>call('encrypt',value,aad),open:(value,aad)=>call('decrypt',value,aad)};
}
