import {authReady,getAuthUser} from './auth.js?v=20261022-1';
import {backendConfig} from './backend-config.js?v=20261024-selfhost1';

function error(value,status) {
  const result=new Error(value?.message||'자체 서버에 연결하지 못했습니다. 서버 실행 상태를 확인해 주세요.');
  result.code=`functions/${value?.code||(status===401?'unauthenticated':'unavailable')}`;
  if(value?.details)result.details=value.details;
  return result;
}
export function revive(value) {
  if(Array.isArray(value))return value.map(revive);
  if(value&&typeof value==='object') {
    if(Object.keys(value).length===1&&Array.isArray(value.$studyTimestamp)) {
      const [seconds,nanoseconds]=value.$studyTimestamp;
      return {seconds,nanoseconds,toMillis:()=>seconds*1000+nanoseconds/1e6,toDate:()=>new Date(seconds*1000+nanoseconds/1e6)};
    }
    return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,revive(item)]));
  }
  return value;
}
async function request(path,data,{signal,refresh=false}={}) {
  if(!await authReady)throw error({code:'unavailable',message:'로그인 서비스를 불러오지 못했습니다.'});
  const user=getAuthUser();if(!user)throw error({code:'unauthenticated',message:'로그인 후 이용해 주세요.'});
  const base=new URL(backendConfig.apiBaseUrl);
  if(base.protocol!=='https:'&&!['localhost','127.0.0.1','[::1]'].includes(base.hostname))throw error({code:'failed-precondition',message:'서버 주소는 HTTPS를 사용해야 합니다.'});
  let response;
  try {
    const token=await user.getIdToken(refresh);
    response=await fetch(new URL(path,base),{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify(data),signal,credentials:'omit',cache:'no-store'});
  } catch(cause) {if(signal?.aborted)throw cause;throw error();}
  if(response.status===401&&!refresh) {await response.body?.cancel();return request(path,data,{signal,refresh:true});}
  if(!response.ok) {
    let details;try{details=await response.json();}catch{}
    throw error(details?.error,response.status);
  }
  return response;
}
export async function* readLines(response,signal) {
  const reader=response.body.getReader(),decoder=new TextDecoder();let pending='';
  try {
    while(!signal?.aborted) {
      const {value,done}=await reader.read();if(done)break;
      pending+=decoder.decode(value,{stream:true});
      if(pending.length>2*1024*1024)throw error({code:'resource-exhausted',message:'서버 응답이 너무 큽니다.'});
      let index;while((index=pending.indexOf('\n'))>=0){const line=pending.slice(0,index);pending=pending.slice(index+1);if(line.trim())yield revive(JSON.parse(line));}
    }
    if(pending.trim())yield revive(JSON.parse(pending));
  } finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}
export function serverCallable(name,options={}) {
  const invoke=async(data={})=>{
    const signal=AbortSignal.timeout(options.timeout||35000);
    return revive(await(await request(`/api/v1/rpc/${encodeURIComponent(name)}`,{data},{signal})).json());
  };
  invoke.stream=async(data={})=>{
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),options.timeout||245000);
    let response;
    try{response=await request(`/api/v1/rpc/${encodeURIComponent(name)}`,{data,stream:true},{signal:controller.signal});}
    catch(cause){clearTimeout(timer);throw cause;}
    let resolve,reject;const result=new Promise((yes,no)=>{resolve=yes;reject=no;});result.catch(()=>{});
    const stream=(async function*(){let finished=false;
      try {
        for await(const item of readLines(response,controller.signal)) {
          if(item.type==='chunk')yield item.data;
          else if(item.type==='result'){finished=true;resolve(item.data);}
          else if(item.type==='error')throw error(item.error);
        }
        if(!finished)throw error();
      } catch(cause){reject(cause);throw cause;}
      finally{if(!finished)reject(error());controller.abort();clearTimeout(timer);}
    })();
    return {stream,data:result};
  };
  return invoke;
}
const snapshot=value=>({id:value.id,exists:()=>value.exists,data:()=>value.exists===false?undefined:value.data});
export const doc=(_,...parts)=>({kind:'doc',path:parts.join('/')});
export const collection=(_,...parts)=>({kind:'query',path:parts.join('/')});
export const documentId=()=>'__name__';
export const orderBy=(field,direction='asc')=>({kind:'order',field,direction});
export const startAt=value=>({kind:'startAt',value});
export const endAt=value=>({kind:'endAt',value});
export const limit=value=>({kind:'limit',value});
export function query(ref,...constraints) {
  const result={...ref,orders:[]};
  for(const item of constraints)if(item.kind==='order')result.orders.push({field:item.field,direction:item.direction});else result[item.kind]=item.value;
  return result;
}
export async function getDoc(ref) {return snapshot(revive(await(await request('/api/v1/read',ref,{signal:AbortSignal.timeout(20000)})).json()));}
export async function getDocs(ref) {
  const result=revive(await(await request('/api/v1/read',ref,{signal:AbortSignal.timeout(20000)})).json());
  return {docs:result.docs.map(snapshot)};
}
export function onSnapshot(ref,callback,onError=()=>{}) {
  const controller=new AbortController();let cancelled=false,retry=1000,timer;
  const connect=async()=>{
    try {
      const response=await request('/api/v1/watch',ref,{signal:controller.signal});
      retry=1000;
      for await(const item of readLines(response,controller.signal))if(item.type==='snapshot'&&!cancelled)callback(snapshot(item));
    } catch(cause){if(!cancelled)onError(cause);retry=Math.min(retry*2,30000);}
    if(!cancelled)timer=setTimeout(connect,retry);
  };
  void connect();return()=>{cancelled=true;clearTimeout(timer);controller.abort();};
}
