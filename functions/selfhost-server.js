import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {getAuth} from 'firebase-admin/auth';
import {getApps, initializeApp} from 'firebase-admin/app';
import {getFirestore} from './platform-store.js';
import {encode} from './local-store.js';
import * as handlers from './index.js';
import {FACE_ORIGIN} from './face-protocol.js';

const statusCodes = {'invalid-argument':400,'unauthenticated':401,'permission-denied':403,'not-found':404,'already-exists':409,'failed-precondition':412,'resource-exhausted':429,'aborted':409,'unavailable':503,'deadline-exceeded':504};
function fail(code,message) {throw Object.assign(new Error(message),{code});}
function publicError(error) {
  const known=Object.hasOwn(statusCodes,error?.code);
  return {code:known?error.code:'internal',message:known?error.message:'서버 요청을 처리하지 못했습니다.',...(known&&error.details?{details:error.details}:{})};
}
const serialized = value => JSON.stringify(encode(value));
function send(res,status,value) {
  if(res.destroyed||res.writableEnded)return;
  res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(serialized(value));
}
async function body(req) {
  if(!String(req.headers['content-type']||'').startsWith('application/json'))fail('invalid-argument','JSON 요청이 필요합니다.');
  let size=0;const chunks=[];
  for await(const chunk of req){size+=chunk.length;if(size>1024*1024)fail('resource-exhausted','요청이 너무 큽니다.');chunks.push(chunk);}
  try {return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch {fail('invalid-argument','요청 형식이 올바르지 않습니다.');}
}
const ownCollections=new Set(['sessions','dailyStats','weeklyStats','monthlyStats','stats']);
export async function authorizeRead(db,uid,input) {
  const path=input?.path;
  if(typeof path!=='string'||path.length>500)fail('invalid-argument','조회 경로가 올바르지 않습니다.');
  const parts=path.split('/');
  if(parts.some(p=>!p||p==='.'||p==='..'))fail('invalid-argument','조회 경로가 올바르지 않습니다.');
  let allowed=false;
  if(parts[0]==='users'&&parts[1]===uid) {
    allowed=input.kind==='doc'&&parts.length===2 || ownCollections.has(parts[2])&&(input.kind==='doc'&&parts.length===4||input.kind==='query'&&parts.length===3);
  } else if(parts[0]==='leaderboards'&&parts[2]==='entries') {
    allowed=input.kind==='doc'&&parts.length===4||input.kind==='query'&&parts.length===3;
  } else if(parts[0]==='schoolLeaderboards'&&parts[2]==='weeks'&&parts[4]==='entries') {
    allowed=(input.kind==='doc'&&parts.length===6||input.kind==='query'&&parts.length===5)&&(await db.doc(`users/${uid}`).get()).data()?.schoolId===parts[1];
  }
  if(!allowed)fail('permission-denied','이 기록에 접근할 수 없습니다.');
  if(input.kind==='doc')return db.doc(path);
  if(!Number.isInteger(input.limit)||input.limit<1||input.limit>50)fail('invalid-argument','한 번에 최대 50개까지 조회할 수 있습니다.');
  let query=db.collection(path).limit(input.limit);
  if(input.orders!==undefined&&!Array.isArray(input.orders))fail('invalid-argument','정렬 조건이 올바르지 않습니다.');
  if((input.orders||[]).length>2)fail('invalid-argument','정렬 조건이 너무 많습니다.');
  for(const order of input.orders||[]) {
    if(!['__name__','totalSeconds','uid'].includes(order.field)||!['asc','desc'].includes(order.direction))fail('invalid-argument','정렬 조건이 올바르지 않습니다.');
    query=query.orderBy(order.field,order.direction);
  }
  for(const key of ['startAt','endAt'])if(input[key]!==undefined) {
    if(typeof input[key]!=='string'||input[key].length>128)fail('invalid-argument','조회 범위가 올바르지 않습니다.');
    query=query[key](input[key]);
  }
  return query;
}
function record(snapshot) {return {id:snapshot.id,exists:snapshot.exists,data:snapshot.data()??null};}

export function createApi({db,verifyToken,allowedOrigins,callables=handlers,log=()=>{}}) {
  const instanceId=randomUUID();
  const origins=new Set(allowedOrigins),rates=new Map(),subscribers=new Map(),sockets=new Set(),active=new Set();
  let stopping=false;
  const server=http.createServer(async(req,res)=>{
    const abort=new AbortController();
    active.add(abort);res.on('close',()=>{abort.abort();active.delete(abort);});
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
    const origin=req.headers.origin;
    try {
      if(origin&&!origins.has(origin))fail('permission-denied','허용되지 않은 사이트입니다.');
      if(origin){res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Vary','Origin');}
      if(req.method==='OPTIONS') {
        res.writeHead(204,{'Access-Control-Allow-Methods':'GET, POST, OPTIONS','Access-Control-Allow-Headers':'Authorization, Content-Type','Access-Control-Max-Age':'600'});res.end();return;
      }
      const url=new URL(req.url,'http://127.0.0.1');
      const faceRequest=/^\/api\/v1\/rpc\/(?:getFaceEnrollmentStatus|beginDailyFaceAuth|completeDailyFaceAuth|beginFaceEnrollment|sealFaceKeyEnvelope|commitFaceEnrollment|beginFaceUnlock|unlockFaceKeyEnvelope|revokeFaceEnrollment|cancelFaceEnrollment|lockFaceEnrollment)$/.test(url.pathname);
      if(faceRequest&&origin!==FACE_ORIGIN)fail('permission-denied','정식 학습 사이트에서만 얼굴 등록을 사용할 수 있습니다.');
      if(req.method==='GET'&&url.pathname==='/health') {
        await db.pool.query('SELECT 1');send(res,stopping?503:200,{ok:!stopping,backend:'selfhost',instanceId,contractVersion:'2026-10-24'});return;
      }
      if(stopping)fail('unavailable','서버를 종료하고 있습니다.');
      // Restoration authenticates the Word token inside the handler; no Study login exists yet.
      const restoring=req.method==='POST'&&url.pathname==='/api/v1/rpc/restoreWordStudyLink';
      const authorization=req.headers.authorization;
      let token;
      if(!restoring) {
        if(typeof authorization!=='string'||!authorization.startsWith('Bearer ')||authorization.length>16384)fail('unauthenticated','로그인이 필요합니다.');
        try{token=await verifyToken(authorization.slice(7),{checkRevoked:faceRequest});}catch{fail('unauthenticated','로그인을 다시 확인해 주세요.');}
        if(!token?.uid||typeof token.uid!=='string'||token.uid.includes('/')||token.exp*1000<=Date.now())fail('unauthenticated','로그인 정보가 만료되었습니다.');
      }
      const rateKey=restoring?`restore:${req.socket.remoteAddress}`:`user:${token.uid}`;
      const now=Date.now(),rate=rates.get(rateKey);
      if(!rate||now-rate.start>=60000)rates.set(rateKey,{start:now,count:1});
      else if(++rate.count>300)fail('resource-exhausted','요청이 많습니다. 잠시 후 다시 시도해 주세요.');
      if(req.method==='POST'&&url.pathname==='/api/v1/read') {
        const input=await body(req),ref=await authorizeRead(db,token.uid,input),snapshot=await ref.get();
        send(res,200,input.kind==='doc'?record(snapshot):{docs:snapshot.docs.map(record)});return;
      }
      if(req.method==='POST'&&url.pathname==='/api/v1/watch') {
        const input=await body(req);
        if(input.kind!=='doc'||!input.path?.startsWith(`users/${token.uid}`))fail('permission-denied','본인의 상태만 구독할 수 있습니다.');
        const ref=await authorizeRead(db,token.uid,input);
        if(!new RegExp(`^users/[^/]+(?:/sessions/[^/]+)?$`).test(ref.path))fail('permission-denied','이 기록은 구독할 수 없습니다.');
        const count=subscribers.get(token.uid)||0;
        if(count>=8)fail('resource-exhausted','열린 상태 연결이 너무 많습니다.');
        subscribers.set(token.uid,count+1);
        res.writeHead(200,{'Content-Type':'application/x-ndjson; charset=utf-8','X-Accel-Buffering':'no'});
        res.flushHeaders();
        let dirty=false,reading=false,closed=false,last;
        const publish=async()=>{
          if(closed)return;dirty=true;if(reading)return;reading=true;
          try {while(dirty&&!closed){dirty=false;const value=serialized({type:'snapshot',...record(await ref.get())});if(value!==last&&!closed){last=value;res.write(value+'\n');}}}
          catch{if(!closed)res.end();}finally{reading=false;}
        };
        const changed=paths=>{if(paths.has(ref.path))void publish();};
        db.on('change',changed);
        const timer=setInterval(()=>{if(!closed)res.write('{"type":"ping"}\n');},15000);
        const expiry=setTimeout(()=>res.end(),Math.max(1,Math.min(token.exp*1000-Date.now(),60000)));
        res.once('close',()=>{closed=true;clearInterval(timer);clearTimeout(expiry);db.off('change',changed);const n=(subscribers.get(token.uid)||1)-1;if(n)subscribers.set(token.uid,n);else subscribers.delete(token.uid);});
        void publish();return;
      }
      const match=/^\/api\/v1\/rpc\/([A-Za-z][A-Za-z0-9]+)$/.exec(url.pathname);
      const handler=match&&Object.hasOwn(callables,match[1])?callables[match[1]]:null;
      if(req.method!=='POST'||handler?.studyKind!=='callable')fail('not-found','요청 경로를 찾을 수 없습니다.');
      const input=await body(req);
      if(!input||typeof input!=='object'||Array.isArray(input))fail('invalid-argument','요청 형식이 올바르지 않습니다.');
      const streaming=input.stream===true;
      if(streaming&&match[1]!=='chatWithStudy')fail('invalid-argument','스트리밍을 지원하지 않는 요청입니다.');
      const request={data:input.data??{},auth:restoring?null:{uid:token.uid,token},acceptsStreaming:streaming,...(faceRequest?{faceTokenFresh:true,faceOrigin:origin}:{})};
      if(!streaming){send(res,200,{data:await handler(request,{signal:abort.signal})});return;}
      res.writeHead(200,{'Content-Type':'application/x-ndjson; charset=utf-8','X-Accel-Buffering':'no'});res.flushHeaders();
      const ping=setInterval(()=>{if(!res.destroyed)res.write('{"type":"ping"}\n');},15000);
      const deadline=setTimeout(()=>abort.abort(),240000);
      try {
        const data=await handler(request,{signal:abort.signal,sendChunk:chunk=>{if(!res.destroyed)res.write(serialized({type:'chunk',data:chunk})+'\n');}});
        if(!res.destroyed)res.end(serialized({type:'result',data})+'\n');
      } catch(error){if(!res.destroyed)res.end(serialized({type:'error',error:publicError(error)})+'\n');}
      finally{clearInterval(ping);clearTimeout(deadline);}
    } catch(error) {
      if(!statusCodes[error?.code])log('api-error',{code:error?.code||'internal'});
      if(res.headersSent){res.end();return;}
      send(res,statusCodes[error?.code]||500,{error:publicError(error)});
    }
  });
  server.requestTimeout=250000;server.headersTimeout=15000;
  server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
  const sweep=setInterval(()=>{for(const [key,value]of rates)if(Date.now()-value.start>60000)rates.delete(key);},60000);sweep.unref();
  db.setMaxListeners(0);
  return {server,async close(){stopping=true;clearInterval(sweep);for(const controller of active)controller.abort();const closed=new Promise(resolve=>server.close(resolve));server.closeIdleConnections?.();const deadline=setTimeout(()=>{for(const socket of sockets)socket.destroy();},5000);await closed;clearTimeout(deadline);}};
}

export async function startSelfHost() {
  if(process.env.STUDY_BACKEND!=='selfhost')throw new Error('STUDY_BACKEND=selfhost required');
  const db=getFirestore();await db.ready;
  const app=getApps().find(a=>a.name==='[DEFAULT]')??initializeApp({projectId:process.env.GCLOUD_PROJECT});
  const auth=getAuth(app),cache=new Map();
  async function verifyToken(value,{checkRevoked=false}={}) {
    if(checkRevoked)return auth.verifyIdToken(value,true);
    const decoded=await auth.verifyIdToken(value);
    const cached=cache.get(decoded.uid);
    if(!cached||cached.expires<Date.now()) {
      const user=await auth.getUser(decoded.uid);
      const state={disabled:user.disabled,validSince:Date.parse(user.tokensValidAfterTime||'1970-01-01')/1000,expires:Date.now()+45000};
      cache.set(decoded.uid,state);if(cache.size>10000)cache.delete(cache.keys().next().value);
    }
    const user=cache.get(decoded.uid);
    if(user.disabled||decoded.auth_time<user.validSince)throw new Error('revoked');
    return decoded;
  }
  const allowedOrigins=JSON.parse(process.env.STUDY_ALLOWED_ORIGINS||'["https://study.junhyuk.site","https://word.junhyuk.site","https://junhyuk1203.github.io"]');
  const api=createApi({db,verifyToken,allowedOrigins,log:(name,fields)=>console.log(JSON.stringify({event:name,...fields}))});
  const host='127.0.0.1',port=Number(process.env.STUDY_PORT||18081);
  await new Promise((resolve,reject)=>{api.server.once('error',reject);api.server.listen(port,host,resolve);});
  const jobs=Object.entries(handlers).filter(([,fn])=>fn.studyKind==='schedule');
  let closing=false;
  const jobPromises=new Map();
  const tick=()=>{if(closing)return;for(const[name,job]of jobs)if(!jobPromises.has(name)){const work=Promise.resolve().then(()=>job({})).catch(error=>console.error(JSON.stringify({event:'job-error',name,code:error.code||'internal'}))).finally(()=>jobPromises.delete(name));jobPromises.set(name,work);}};
  const timer=setInterval(tick,60000);tick();
  console.log(JSON.stringify({event:'ready',host,port,backend:'postgresql',callables:Object.values(handlers).filter(fn=>fn.studyKind==='callable').length}));
  const close=async()=>{if(closing)return;closing=true;clearInterval(timer);await api.close();await Promise.allSettled([...jobPromises.values()]);await db.close();process.exit(0);};
  process.once('SIGINT',close);process.once('SIGTERM',close);
  process.stdin.setEncoding('utf8');process.stdin.on('data',value=>{if(value.trim()==='shutdown')void close();});
  return {api,db,close};
}
