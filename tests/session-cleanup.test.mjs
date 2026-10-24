import test from 'node:test';
import assert from 'node:assert/strict';
import {cleanupExpiredSessions} from '../functions/session-cleanup.js';

test('cleanup pages through 250 expirations, isolates failure and preserves renewed sessions',async()=>{
  const records=new Map(),sessions=new Map(),calls=[];
  for(let i=0;i<250;i++){const id=String(i).padStart(3,'0');records.set(id,{uid:'owner',sessionId:id,expiresAtMs:100});sessions.set(id,{status:'active',presenceUntilMs:100});}
  sessions.get('005').presenceUntilMs=2000;
  const doc=id=>({id,path:id});
  const snap=id=>({id,ref:doc(id),exists:records.has(id),data:()=>records.get(id)});
  const query=(after='')=>({where(){return this;},orderBy(){return this;},limit(n){this.n=n;return this;},startAfter(cursor){this.after=cursor.id;return this;},async get(){return {docs:[...records.keys()].filter(id=>id>(this.after||after)&&records.get(id).expiresAtMs<=1000).slice(0,this.n).map(snap)};}});
  const db={collection:()=>query(),doc:path=>({path}),runTransaction:fn=>fn({
    getAll:async(lease,session)=>[snap(lease.id),{exists:sessions.has(session.path.split('/').at(-1)),data:()=>sessions.get(session.path.split('/').at(-1))}],
    delete:ref=>records.delete(ref.id),update:(ref,patch)=>records.set(ref.id,{...records.get(ref.id),...patch})
  })};
  const result=await cleanupExpiredSessions(db,async(uid,id)=>{
    calls.push(id);
    if(id==='003')throw Object.assign(Error('injected'),{code:'unavailable'});
    if(id==='005')return {notExpired:true};
    if(id==='006'){sessions.delete(id);throw Object.assign(Error('missing'),{code:'not-found'});}
    sessions.get(id).status='finished';records.delete(id);
    return {};
  },{now:()=>1000});
  assert.equal(calls.length,250);assert.equal(result.failed,1);assert.equal(result.processed,248);assert.equal(result.renewed,1);
  assert.equal(sessions.get('005').status,'active');assert.equal(records.get('005').expiresAtMs,2000);
  assert.deepEqual([...records.keys()],['003','005']);assert.equal(result.oldestPendingMs,100);
});
