import test from 'node:test';
import assert from 'node:assert/strict';
import { createReadCache } from '../client-cache.js';
import { briefingPeriod } from '../functions/briefing-period.js';
import { cachedBriefing } from '../functions/briefing-cache.js';

const at=time=>Date.parse(`2026-10-22T${time}:00+09:00`);
test('KST briefing slots expire exactly at each boundary and the next date',()=>{
  for(const [time,label,end] of [['00:00','새벽','06:00'],['05:59','새벽','06:00'],['06:00','아침','11:00'],['10:59','아침','11:00'],['11:00','점심','17:00'],['17:00','저녁','22:00'],['22:00','심야','24:00']]){
    const p=briefingPeriod(at(time));assert.equal(p.label,label);assert.equal(p.expiresAtMs,at(end));
  }
  assert.notEqual(briefingPeriod(at('23:59')).id,briefingPeriod(at('24:00')).id);
});

test('response caches survive reopening, expire, isolate accounts and tolerate blocked storage',()=>{
  let time=0;
  const values={};
  const storage={getItem:key=>values[key]||null,setItem:(key,value)=>{values[key]=value;},removeItem:key=>{delete values[key];}};
  const first=createReadCache({storage,now:()=>time});
  first.set('alice:stats:1',{totalSeconds:60},100);
  const reopened=createReadCache({storage,now:()=>time});
  assert.deepEqual(reopened.get('alice:stats:1'),{totalSeconds:60});
  assert.equal(reopened.get('bob:stats:1'),undefined);
  assert.equal(reopened.get('alice:stats:2'),undefined);
  time=100;assert.equal(reopened.get('alice:stats:1'),undefined);
  const blocked=createReadCache({storage:{getItem(){throw Error();},setItem(){throw Error();}},now:()=>time});
  blocked.set('key',42,100);assert.equal(blocked.get('key'),42);
});

function database() {
  const records=new Map();let queue=Promise.resolve();
  const doc=path=>({path,async set(value,options){records.set(path,options?.merge?{...records.get(path),...value}:value);}});
  return {records,doc,runTransaction(fn){
    const task=queue.then(()=>fn({get:async ref=>({data:()=>records.get(ref.path)}),set:(ref,value,options)=>ref.set(value,options)}));
    queue=task.catch(()=>{});return task;
  }};
}

test('briefing is generated once per slot, stored across requests, and manual refresh uses fresh records',async()=>{
  const db=database();let now=at('06:00'),generated=0,seconds=60;
  const generate=async()=>({text:`${seconds}초`,model:'gemini-3.8-flash',generation:++generated});
  const request=force=>cachedBriefing({db,user:'owner',force,now:()=>now,generate});
  assert.equal((await request()).text,'60초');seconds=120;
  assert.equal((await request()).text,'60초');assert.equal(generated,1);
  assert.equal((await request(true)).text,'120초');assert.equal(generated,2);
  assert.equal((await request()).cached,true);
  now=at('11:00');assert.equal((await request()).cached,false);assert.equal(generated,3);
  await cachedBriefing({db,user:'other',now:()=>now,generate});assert.equal(generated,4);
});

test('parallel automatic requests cannot duplicate AI generation; failed generation releases the lease',async()=>{
  const db=database();let resolve,started;
  const entered=new Promise(r=>{started=r;});
  const pending=cachedBriefing({db,user:'owner',now:()=>at('06:00'),generate:()=>{started();return new Promise(r=>{resolve=r;});}});
  await entered;
  await assert.rejects(cachedBriefing({db,user:'owner',now:()=>at('06:00'),generate:()=>{throw Error('duplicate');}}),error=>error.code==='aborted');
  resolve({text:'저장된 브리핑'});await pending;
  await assert.rejects(cachedBriefing({db,user:'owner',force:true,now:()=>at('06:00'),generate:()=>{throw Error('provider');}}),/provider/);
  assert.equal((await cachedBriefing({db,user:'owner',force:true,now:()=>at('06:00'),generate:async()=>({text:'재시도 성공'})})).text,'재시도 성공');
});
