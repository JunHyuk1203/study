// Test-only provisioning bypasses KMS/provider UX, but exercises real device signatures
// and server study authorization against the emulator or dedicated PostgreSQL DB.
import {randomUUID} from 'node:crypto';
import {createBrowserFaceKeys} from '../face-storage.js';
import {signFace} from '../face-crypto.js';
import {FACE_POLICY,studyNonce} from '../functions/face-protocol.js';
import {faceDayEnd} from '../functions/face-service.js';
const devices=new Map();
export async function signedFaceRequest(db,request){
  if(!request.auth||request.auth.token?.email_verified!==true)return request;
  const uid=request.auth.uid;
  let device=devices.get(uid);
  if(!device){device={keys:await createBrowserFaceKeys(),installationId:randomUUID(),profileId:randomUUID(),grantId:randomUUID()};devices.set(uid,device);}
  const now=Date.now(),ref=db.doc(`faceSecurity/${uid}`),stored=(await ref.get()).data();
  if(stored?.active?.profileId!==device.profileId||stored.grant?.expiresAtMs<=now||!stored.grant){
    await ref.set({active:{profileId:device.profileId,generation:1,installationId:device.installationId,publicKey:device.keys.publicKey,revoked:false},grant:{id:device.grantId,installationId:device.installationId,generation:1,policyVersion:FACE_POLICY,expiresAtMs:faceDayEnd(now)}});
  }
  const faceAuthorization={installationId:device.installationId,profileId:device.profileId,generation:1,grantId:device.grantId,issuedAt:now};
  const data={...request.data,faceAuthorization};
  faceAuthorization.signature=await signFace(device.keys,'study',uid,device.installationId,studyNonce(data));
  return {...request,data};
}
export const faceCallable=(callable,db)=>({run:async request=>callable.run(await signedFaceRequest(db(),request))});
