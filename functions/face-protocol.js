// Shared wire format. Never add mutable display names or client clocks to AAD.
export const FACE_POLICY = 'face-v1';
export const FACE_MODEL = 'human-faceres-3.3.6-1024';
export const FACE_PREPROCESS = 'eyes-aligned-rgb224-v1';
export const FACE_SCHEMA = 2;
export const FACE_ORIGIN = 'https://study.junhyuk.site';
export const encode64 = bytes => {const array=new Uint8Array(bytes);let value='';for(let i=0;i<array.length;i+=8192)value+=String.fromCharCode(...array.subarray(i,i+8192));return btoa(value);};
export const decode64 = value => Uint8Array.from(atob(value), c => c.charCodeAt(0));
export const faceAAD = binding => JSON.stringify(Object.fromEntries(
  ['projectId','appOrigin','uid','installationId','profileId','generation','modelVersion','preprocessVersion','schemaVersion','purpose'].map(key => [key,binding[key]])));
export const faceMessage = (purpose,uid,installationId,nonce) => JSON.stringify([FACE_POLICY,purpose,uid,installationId,nonce]);
export const studyNonce = data => JSON.stringify([data.controllerId,data.sessionId || '',data.sequence || 0,data.tracking === true,data.faceAuthorization?.profileId,data.faceAuthorization?.generation,data.faceAuthorization?.grantId,data.faceAuthorization?.issuedAt]);
