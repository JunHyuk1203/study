import test from 'node:test';
import assert from 'node:assert/strict';
import { createReadCache } from '../client-cache.js';
import { briefingPeriod } from '../functions/briefing-period.js';
import { cachedBriefing } from '../functions/briefing-cache.js';
import { createDailyNeis, neisRequestParts } from '../functions/neis-cache.js';
import { calendarCells, renderCalendar } from '../school-calendar.js';
import { schoolEvents } from '../functions/integrations-domain.js';

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

test('NEIS overlapping date ranges share full-month daily cache across instances and KST midnight',async()=>{
  const db=database();let now=at('23:59'),calls=0;
  const fetchRows=async(endpoint,params)=>{calls++;assert.equal(params.AA_FROM_YMD,'20261001');assert.equal(params.AA_TO_YMD,'20261031');return [{AA_YMD:'20261022',EVENT_NM:'중간고사'},{AA_YMD:'20261024',EVENT_NM:'토요휴업일'}];};
  const query=(from,to)=>({SD_SCHUL_CODE:'school',AA_FROM_YMD:from,AA_TO_YMD:to});
  const first=createDailyNeis({db,fetchRows,now:()=>now});
  assert.equal((await first('SchoolSchedule',query('20261022','20261022'))).length,1);
  const reopened=createDailyNeis({db,fetchRows,now:()=>now});
  assert.equal((await reopened('SchoolSchedule',query('20261001','20261031'))).length,2);assert.equal(calls,1);
  now=at('24:00');await reopened('SchoolSchedule',query('20261022','20261022'));assert.equal(calls,2);
});

test('NEIS reservations prevent parallel calls and repeated failures on the same day',async()=>{
  const db=database();let calls=0,resolve,entered;
  const started=new Promise(r=>{entered=r;});
  const first=createDailyNeis({db,fetchRows:()=>{calls++;entered();return new Promise(r=>{resolve=r;});}});
  const second=createDailyNeis({db,fetchRows:()=>{throw Error('duplicate');}});
  const pending=first('schoolInfo',{SCHUL_NM:'학교'});await started;
  await assert.rejects(second('schoolInfo',{SCHUL_NM:'학교'}),error=>error.code==='unavailable');
  resolve([]);await pending;assert.deepEqual(await second('schoolInfo',{SCHUL_NM:'학교'}),[]);assert.equal(calls,1);
  const failed=createDailyNeis({db,fetchRows:async()=>{calls++;throw Error('provider');}});
  await assert.rejects(failed('schoolInfo',{SCHUL_NM:'다른 학교'}),/provider/);
  const retry=createDailyNeis({db,fetchRows:()=>{throw Error('must not refetch');}});
  await assert.rejects(retry('schoolInfo',{SCHUL_NM:'다른 학교'}),error=>error.code==='unavailable');assert.equal(calls,2);
});

test('NEIS month boundaries handle leap years and preserve classroom separation',()=>{
  const parts=neisRequestParts('hisTimetable',{GRADE:'1',CLASS_NM:'2',TI_FROM_YMD:'20280228',TI_TO_YMD:'20280302'});
  assert.equal(parts.length,2);assert.equal(parts[0].params.TI_TO_YMD,'20280229');assert.equal(parts[1].params.TI_FROM_YMD,'20280301');assert.equal(parts[1].params.CLASS_NM,'2');
});

test('NEIS meals and calendar share a school cache while timetables separate grades and classes',async()=>{
  const db=database(),calls=[];
  const fetchRows=async(endpoint,params)=>{calls.push({endpoint,params});return [];};
  const school={ATPT_OFCDC_SC_CODE:'S10',SD_SCHUL_CODE:'school'};
  const first=createDailyNeis({db,fetchRows}),otherStudent=createDailyNeis({db,fetchRows});
  const meals={...school,MLSV_FROM_YMD:'20261022',MLSV_TO_YMD:'20261022'};
  const calendar={...school,AA_FROM_YMD:'20261001',AA_TO_YMD:'20261031'};
  for(const lookup of [first,otherStudent]){await lookup('mealServiceDietInfo',meals);await lookup('SchoolSchedule',calendar);}
  assert.equal(calls.length,2);
  const timetable={...school,GRADE:'1',CLASS_NM:'1',TI_FROM_YMD:'20261019',TI_TO_YMD:'20261023'};
  await first('hisTimetable',timetable);await otherStudent('hisTimetable',timetable);
  await otherStudent('hisTimetable',{...timetable,CLASS_NM:'2'});
  await otherStudent('hisTimetable',{...timetable,GRADE:'2'});
  assert.equal(calls.filter(call=>call.endpoint==='hisTimetable').length,3);
});

test('calendar aligns leap February, retains empty dates, and removes only Saturday closure events',()=>{
  const events=schoolEvents([{AA_YMD:'20280205',EVENT_NM:'토요휴업일'},{AA_YMD:'20280205',EVENT_NM:'토요 휴업일'},{AA_YMD:'20280205',EVENT_NM:'토요 체험학습'},{AA_YMD:'20280229',EVENT_NM:'졸업식'}]);
  assert.deepEqual(events.map(event=>event.name),['토요 체험학습','졸업식']);
  const cells=calendarCells('2028-02',events);
  assert.equal(cells.length%7,0);assert.equal(cells[0],null);assert.equal(cells[1],null);assert.equal(cells[2].day,1);
  assert.equal(cells.filter(Boolean).length,29);assert.equal(cells.find(cell=>cell?.day===29).events[0].name,'졸업식');
});

test('calendar renders accessible dates, today, event counts and a selected-day reset',()=>{
  const node=tag=>({tag,children:[],dataset:{},attributes:{},append(...children){this.children.push(...children);},replaceChildren(){this.children=[];},setAttribute(name,value){this.attributes[name]=value;}});
  const container=node('div'),document={createElement:node};
  renderCalendar(container,{month:'2026-10',status:'ready',today:'2026-10-22',selected:'2026-10-22',events:[{date:'2026-10-22',name:'시험'},{date:'2026-10-22',name:'상담'}]},document);
  const cells=container.children[1].children;
  const day=cells.find(cell=>cell.dataset.schoolCalendarDay==='2026-10-22');
  assert.equal(day.attributes['aria-current'],'date');assert.equal(day.attributes['aria-pressed'],'true');assert.match(day.attributes['aria-label'],/시험, 상담/);
  assert.equal(day.children[2].textContent,'+1');assert.equal(container.children[2].disabled,false);
});

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
