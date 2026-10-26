import {getAuth} from 'firebase-admin/auth';
import {HttpsError} from './platform-http.js';

// 45s revocation cache + the existing 10s credit lease stays below 60s.
export function createStudyRevocationCheck({lookup,clock=Date.now}){
  const cache=new Map();
  return async request=>{
    const uid=request.auth?.uid,authTime=request.auth?.token?.auth_time;
    if(!uid||!Number.isFinite(authTime))throw new HttpsError('unauthenticated','계정을 다시 인증해 주세요.');
    let state=cache.get(uid);
    if(!state||state.until<=clock()){
      let user;try{user=await lookup(uid);}catch{throw new HttpsError('unauthenticated','계정을 다시 인증해 주세요.');}
      state={disabled:user.disabled,validSince:Date.parse(user.tokensValidAfterTime||'1970-01-01')/1000,until:clock()+45000};
      cache.set(uid,state);if(cache.size>10000)cache.delete(cache.keys().next().value);
    }
    if(state.disabled||!Number.isFinite(state.validSince)||authTime<state.validSince)throw new HttpsError('unauthenticated','계정의 학습 허가가 취소되었습니다. 다시 인증해 주세요.');
  };
}
const check=createStudyRevocationCheck({lookup:uid=>getAuth().getUser(uid)});
export async function assertStudyAccount(request){
  // Selfhost transport already checks this; emulator tests use synthetic account fixtures.
  if(process.env.STUDY_BACKEND==='selfhost'||process.env.FIREBASE_AUTH_EMULATOR_HOST)return;
  await check(request);
}
