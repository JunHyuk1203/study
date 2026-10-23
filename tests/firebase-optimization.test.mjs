import test from 'node:test';
import assert from 'node:assert/strict';
import {roomDirectory} from '../functions/room-service.js';
import {socialSnapshot} from '../functions/social-service.js';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {createReadCache,statsRevision} from '../client-cache.js';
import {changePlan} from '../functions/plan-service.js';
import {allowance} from '../functions/ai-budget.js';

function directoryDatabase() {
  const now=Date.now(),reads=[];
  const records={
    'users/alice':{},
    ...Object.fromEntries(['a','b','c'].map(id=>[`studyRooms/${id}`,{title:id,status:'open',visibility:'private',createdAtMs:now,hostUid:'alice',memberIds:[],members:{},invitedUids:['alice']}]))
  };
  const snapshot=path=>({id:path.split('/').at(-1),data:()=>records[path],exists:Boolean(records[path])});
  const query=(path,filters=[])=>({
    where(field,op,value){return query(path,[...filters,[field,value]]);},orderBy(){return this;},limit(){return this;},
    async get(){
      const docs=path.endsWith('/roomInvites')?['a','b','c'].map(id=>({id,data:()=>({expiresAtMs:now+60000})})):['a','b'].map(id=>snapshot(`studyRooms/${id}`));
      reads.push(...docs.map(row=>`${path}/${row.id}`));return {docs};
    }
  });
  const doc=path=>({path,collection:name=>query(`${path}/${name}`),async get(){reads.push(path);return snapshot(path);}});
  return {reads,records,db:{doc,collection:query,getAll:async(...refs)=>Promise.all(refs.map(ref=>ref.get()))}};
}
test('directory reuses owned rooms while checking fresh invitations',async t=>{
  const {db,reads}=directoryDatabase();
  const rows=await roomDirectory(db,'alice',{});
  assert.deepEqual(rows.map(row=>row.id),['a','b','c']);
  t.diagnostic(`directory document accesses=${reads.length}`);
  assert.equal(reads.length,6);
});
test('social response shares invitation query with its room directory',async t=>{
  const {db,reads}=directoryDatabase();
  const result=await socialSnapshot(db,'alice',{includeSchoolRooms:true,includeLists:true,listScope:'invites'});
  assert.equal(result.roomInvites.length,3);assert.equal(result.schoolRooms.length,3);
  t.diagnostic(`social document accesses=${reads.length}`);
  assert.equal(reads.length,7);
});
test('directory still rejects revoked invitations and missing or inaccessible rooms',async()=>{
  const {db,records}=directoryDatabase();
  records['studyRooms/c'].invitedUids=[];
  records['studyRooms/b'].visibility='public';
  let rows=await roomDirectory(db,'alice',{});
  assert.deepEqual(rows.map(row=>row.id),['a']);
  delete records['studyRooms/c'];
  rows=await roomDirectory(db,'alice',{});
  assert.deepEqual(rows.map(row=>row.id),['a']);
});

test('checkpoint cache keeps period reads fresh and reuses finish-only records',async t=>{
  const file=await readFile(new URL('../data.js',import.meta.url),'utf8');
  const source=file.slice(file.indexOf('async function loadVisibleData()'),file.indexOf('async function connectUser()'));
  async function measure(policy){
    let reads=0;
    const profile={studyRevision:4,wordCheckpointRevision:0,schoolId:'school'};
    const context=vm.createContext({statsRevision:policy,state:{profile,pending:new Set(),failed:new Set()},
      sdk:{doc:()=>null,collection:()=>null,query:()=>null,orderBy(){},limit(){},async getDoc(){reads++;return {data:()=>({})};},async getDocs(){reads+=50;return {docs:Array.from({length:50},()=>({data:()=>({})}))};}},
      db:{},connectedUid:'alice',generation:1,document:{hidden:false},dateKey:()=> '2026-10-24',monday:()=> '2026-10-19',
      readCache:createReadCache({storage:null}),dataRequests:new Map(),visibleDataKeys:()=>new Set(['today','summary','focusTime','ranking','ownRanking','schoolRanking']),paint(){},notice(error){throw error;},errorText:x=>x});
    vm.runInContext(source,context);
    for(let i=0;i<6;i++){await context.loadVisibleData();profile.studyRevision++;profile.wordCheckpointRevision++;}
    const checkpointReads=reads;
    profile.studyRevision++;await context.loadVisibleData();
    return {checkpointReads,finishReads:reads-checkpointReads};
  }
  const before=await measure(p=>p.studyRevision),after=await measure(statsRevision);
  assert.equal(before.checkpointReads,624);assert.equal(after.checkpointReads,109);
  assert.equal(after.finishReads,104);
  assert.equal(statsRevision({studyRevision:10},'ranking'),10);
  t.diagnostic(`six refreshes: document accesses ${before.checkpointReads} -> ${after.checkpointReads}; finish refresh=${after.finishReads}`);
});

const integrationFile=await readFile(new URL('../integrations.js',import.meta.url),'utf8');
const cachedSource=integrationFile.slice(integrationFile.indexOf('const remoteRequests='),integrationFile.indexOf('function errorMessage'));
function cachedContext(call){
  return vm.createContext({call,readCache:createReadCache({storage:null}),getStudyData:()=>({user:{uid:'alice'},profile:{school:{id:'school'}}}),briefingPeriod:()=>({date:'2099-10-24',id:'morning'})});
}
test('school requests coalesce, reuse full calendars and isolate forced refreshes',async()=>{
  const resolves=[];let calls=0;
  const context=cachedContext(()=>{calls++;return new Promise(resolve=>resolves.push(resolve));});
  vm.runInContext(cachedSource,context);
  const a=context.cachedCall('getSchoolOverview',{month:'2099-10'}),b=context.cachedCall('getSchoolOverview',{month:'2099-10'});
  assert.equal(calls,1);resolves.shift()({events:['old']});await Promise.all([a,b]);
  assert.deepEqual((await context.cachedCall('getSchoolOverview',{month:'2099-10',eventsOnly:true})).events,['old']);assert.equal(calls,1);
  const automatic=context.cachedCall('getSchoolOverview',{month:'2099-11'});
  const forced=context.cachedCall('getSchoolOverview',{month:'2099-11'},1000,true);
  assert.equal(calls,3);
  resolves[1]({events:['fresh']});await forced;resolves[0]({events:['stale']});await automatic;
  assert.deepEqual((await context.cachedCall('getSchoolOverview',{month:'2099-11'})).events,['fresh']);
});
test('failed/partial school responses remain retryable',async()=>{
  let calls=0;const context=cachedContext(async()=>{if(++calls===1)throw Error('offline');return calls===2?{errors:{events:'failed'}}:{events:[]};});
  vm.runInContext(cachedSource,context);
  await assert.rejects(context.cachedCall('getSchoolOverview',{}));
  await context.cachedCall('getSchoolOverview',{});await context.cachedCall('getSchoolOverview',{});assert.equal(calls,3);
});
test('missing plan removals do not write, and existing removals still write',async()=>{
  let writes=0;const profile={subjects:[{id:'math'}],goals:[{id:'goal'}]};
  const db={doc:()=>({}),runTransaction:fn=>fn({get:async()=>({exists:true,data:()=>profile}),update(){writes++;}})};
  await changePlan(db,'alice','removeGoal',{id:'missing'});await changePlan(db,'alice','removeSubject',{id:'missing'});assert.equal(writes,0);
  await changePlan(db,'alice','removeGoal',{id:'goal'});await changePlan(db,'alice','removeSubject',{id:'math'});assert.equal(writes,2);
  profile.activeSessionId='active';await assert.rejects(changePlan(db,'alice','removeSubject',{id:'missing'}));
});
test('AI reservation skips daily reads only when no daily limit applies',async t=>{
  const text=await readFile(new URL('../functions/ai-service.js',import.meta.url),'utf8');
  const source=text.slice(text.indexOf('async function reserve('),text.indexOf('async function settle('));
  let reads=0,dailyCalls=0;
  const db={doc:path=>({path}),runTransaction:fn=>fn({getAll:async(...refs)=>{reads+=refs.length;return refs.map(ref=>({data:()=>ref.path.includes('aiDaily')?{argonCalls:dailyCalls}:{spent:0,reserved:0}}));},set(){},create(){}})};
  const context=vm.createContext({db,schoolDates:()=>({date:'2026-10-24'}),randomUUID:()=> 'reservation',Timestamp:{now:()=>0},allowance,HttpsError:Error});
  vm.runInContext(source,context);
  await context.reserve('alice','gemini-3.8-flash',20,2000,1024);assert.equal(reads,1);
  await context.reserve('alice','gemini-4-argon',20,2000,1024);assert.equal(reads,3);
  await context.reserve('alice','gemini-4-argon',20,2000,1024,false);assert.equal(reads,4);
  dailyCalls=2;await assert.rejects(context.reserve('alice','gemini-4-argon',20,2000,1024));
  t.diagnostic('reservation document reads: Flash 2 -> 1; Argon first 2 -> 2; continuation 2 -> 1');
});
