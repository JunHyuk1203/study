import {faceAAD,faceMessage,encode64,decode64,FACE_MODEL,FACE_PREPROCESS,FACE_SCHEMA} from './functions/face-protocol.js';
const utf8=new TextEncoder();
export const signFace=async(keys,purpose,uid,installationId,nonce)=>encode64(await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},keys.signingKey,utf8.encode(faceMessage(purpose,uid,installationId,nonce))));
export const hashFace=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',utf8.encode(value))),byte=>byte.toString(16).padStart(2,'0')).join('');
export function validateFaceSamples(samples) {
  if(!Array.isArray(samples)||samples.length!==12||samples.some(row=>!Array.isArray(row)||row.length!==1024||!row.every(Number.isFinite)||Math.abs(Math.hypot(...row)-1)>.01))throw new Error('얼굴 정보가 손상되었습니다. 계정 인증 후 다시 등록해 주세요.');
  return samples;
}
export function validateFaceBinding(binding,uid,installationId) {
  if(binding.uid!==uid||binding.installationId!==installationId||binding.modelVersion!==FACE_MODEL||binding.preprocessVersion!==FACE_PREPROCESS||binding.schemaVersion!==FACE_SCHEMA||binding.purpose!=='face-profile')throw new Error('얼굴 정보 버전 또는 계정이 다릅니다. 인증 후 다시 등록해 주세요.');
}
export async function encryptFaceSamples(samples,keys,binding) {
  validateFaceSamples(samples);validateFaceBinding(binding,binding.uid,binding.installationId);
  let dek=await crypto.subtle.generateKey({name:'AES-GCM',length:256},true,['encrypt','decrypt']);
  const iv=crypto.getRandomValues(new Uint8Array(12)),plain=new Uint8Array(new Float32Array(samples.flat()).buffer);
  try{
    const ciphertext=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:utf8.encode(faceAAD(binding)),tagLength:128},dek,plain);
    const wrappedKey=encode64(await crypto.subtle.wrapKey('raw',dek,keys.wrappingKey,'AES-KW'));
    return {ciphertext:encode64(ciphertext),iv:encode64(iv),binding,wrappedKey};
  }finally{plain.fill(0);dek=null;}
}
export async function decryptFaceSamples(record,keys,wrappedKey,uid,installationId) {
  validateFaceBinding(record.binding,uid,installationId);
  if(typeof record.ciphertext!=='string'||record.ciphertext.length>400000||decode64(record.iv).length!==12||decode64(wrappedKey).length!==40)throw new Error('얼굴 암호문 형식이 올바르지 않습니다.');
  let dek=await crypto.subtle.unwrapKey('raw',decode64(wrappedKey),keys.wrappingKey,'AES-KW',{name:'AES-GCM',length:256},false,['decrypt']);
  let plain;
  try{plain=new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:decode64(record.iv),additionalData:utf8.encode(faceAAD(record.binding)),tagLength:128},dek,decode64(record.ciphertext)));if(plain.byteLength!==12*1024*4)throw new Error('얼굴 정보 크기가 올바르지 않습니다.');const floats=new Float32Array(plain.buffer);return validateFaceSamples(Array.from({length:12},(_,i)=>Array.from(floats.subarray(i*1024,(i+1)*1024))));}
  finally{plain?.fill(0);dek=null;wrappedKey=null;}
}
