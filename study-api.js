import {authReady,getAuthUser} from './auth.js?v=20261022-1';
import {serverCallable} from './server-client.js?v=20261024-selfhost1';
export async function studyCall(name,data={}) {
  if(!await authReady)throw new Error('서비스를 불러오지 못했습니다. 새로고침해 주세요.');
  if(!getAuthUser())throw new Error('로그인 후 이용해 주세요.');
  return (await serverCallable(name)(data)).data;
}
export function serviceError(error) {
  if(error?.code==='functions/unauthenticated')return '다시 로그인해 주세요.';
  if(error?.code==='functions/unavailable')return '자체 서버에 연결하지 못했습니다. 서버 프로그램 실행 상태를 확인해 주세요.';
  if(error?.code==='functions/internal')return '요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.';
  return error?.message||'요청을 처리하지 못했습니다.';
}
export function element(tag,className,text) {
  const node=document.createElement(tag);if(className)node.className=className;if(text!=null)node.textContent=text;return node;
}
export const duration = seconds => {
  const value=Math.max(0,Math.floor(seconds||0));
  return value<60?`${value}초`:`${Math.floor(value/3600)?`${Math.floor(value/3600)}시간 `:''}${Math.floor(value%3600/60)}분`;
};
