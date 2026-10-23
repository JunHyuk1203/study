import {authReady,getAuthUser} from './auth.js?v=20261022-1';
import {firebaseConfig} from './firebase-config.js';
let ready;
export async function studyCall(name,data={}) {
  ready ??= (async()=>{
    if(!await authReady)throw new Error('서비스를 불러오지 못했습니다. 새로고침해 주세요.');
    const [appSdk,sdk]=await Promise.all([
      import('https://www.gstatic.com/firebasejs/13.0.0/firebase-app.js'),
      import('https://www.gstatic.com/firebasejs/13.0.0/firebase-functions.js'),
    ]);
    const app=appSdk.getApps()[0]??appSdk.initializeApp(firebaseConfig);
    return {sdk,functions:sdk.getFunctions(app,'asia-northeast3')};
  })();
  const {sdk,functions}=await ready;
  if(!getAuthUser())throw new Error('로그인 후 이용해 주세요.');
  return (await sdk.httpsCallable(functions,name)(data)).data;
}
export function serviceError(error) {
  if(error?.code==='functions/unauthenticated')return '다시 로그인해 주세요.';
  if(error?.code==='functions/unavailable'||error?.code==='functions/internal')return '서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.';
  return error?.message||'요청을 처리하지 못했습니다.';
}
export function element(tag,className,text) {
  const node=document.createElement(tag);if(className)node.className=className;if(text!=null)node.textContent=text;return node;
}
export const duration = seconds => {
  const value=Math.max(0,Math.floor(seconds||0));
  return value<60?`${value}초`:`${Math.floor(value/3600)?`${Math.floor(value/3600)}시간 `:''}${Math.floor(value%3600/60)}분`;
};
