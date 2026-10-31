import {faceAAD,faceMessage,encode64,decode64,FACE_MODEL,FACE_PREPROCESS,FACE_SCHEMA} from './functions/face-protocol.js';
const utf8=new TextEncoder();
export const signFace=async(keys,purpose,uid,installationId,nonce)=>encode64(await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},keys.signingKey,utf8.encode(faceMessage(purpose,uid,installationId,nonce))));
export const hashFace=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',utf8.encode(value))),byte=>byte.toString(16).padStart(2,'0')).join('');
export function validateFaceSamples(samples) {
  if(!Array.isArray(samples)||samples.length!==12||samples.some(row=>!Array.isArray(row)||![1024,2048].includes(row.length)||row.length!==samples[0].length||!row.every(Number.isFinite)||Math.abs(Math.hypot(...row)-1)>.01||row.length===2048&&[row.slice(0,1024),row.slice(1024)].some(part=>Math.hypot(...part)<.01)))throw new Error('얼굴 정보가 손상되었습니다. 계정 인증 후 다시 등록해 주세요.');
  return samples;
}
export function validateFaceBinding(binding,uid,installationId) {
  const supported=binding.preprocessVersion===FACE_PREPROCESS&&binding.schemaVersion===FACE_SCHEMA||binding.preprocessVersion==='eyes-aligned-rgb224-periocular-v2'&&binding.schemaVersion===3||binding.preprocessVersion==='eyes-aligned-rgb224-v1'&&binding.schemaVersion===2;
  if(binding.uid!==uid||binding.installationId!==installationId||binding.modelVersion!==FACE_MODEL||!supported||binding.purpose!=='face-profile')throw new Error('얼굴 정보 버전 또는 계정이 다릅니다. 인증 후 다시 등록해 주세요.');
}
export async function encryptFaceSamples(samples,keys,binding) {
  validateFaceSamples(samples);validateFaceBinding(binding,binding.uid,binding.installationId);
  if(binding.schemaVersion===2&&samples[0].length!==1024)throw new Error('눈 중심 얼굴 등록에는 새 등록 요청이 필요합니다.');
  if(binding.schemaVersion===4&&samples[0].length!==2048)throw new Error('조명 보정 얼굴 등록에는 두 전체 얼굴 특징이 필요합니다.');
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
  try{plain=new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:decode64(record.iv),additionalData:utf8.encode(faceAAD(record.binding)),tagLength:128},dek,decode64(record.ciphertext)));const size=plain.byteLength/(12*4);if(![1024,2048].includes(size)||record.binding.schemaVersion===2&&size!==1024||record.binding.schemaVersion===4&&size!==2048)throw new Error('얼굴 정보 크기가 올바르지 않습니다.');const floats=new Float32Array(plain.buffer);return validateFaceSamples(Array.from({length:12},(_,i)=>Array.from(floats.subarray(i*size,(i+1)*size))));}
  finally{plain?.fill(0);dek=null;wrappedKey=null;}
}
