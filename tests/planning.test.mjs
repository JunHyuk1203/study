import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {planPeriod,planSubjects,subjectName,goalInput,appendGoal} from '../functions/plan-domain.js';
import {changePlan} from '../functions/plan-service.js';
import {runPlanTool} from '../functions/plan-agent.js';
import {schoolAgent} from '../functions/school-agent.js';
import {goalProgress,goalSummary} from '../goal-state.js';

test('goals use Korean dates, Sunday through Saturday weeks and a fixed current month',()=>{
  const sunday=Date.parse('2026-11-01T14:59:59Z'),monday=sunday+1000;
  assert.equal(planPeriod('day',sunday),'2026-11-01');
  assert.equal(planPeriod('week',sunday),'2026-11-01');
  assert.equal(planPeriod('week',monday),'2026-11-01');
  assert.equal(planPeriod('week',Date.parse('2026-10-31T14:59:59Z')),'2026-10-25');
  assert.equal(planPeriod('month',Date.parse('2026-10-31T15:00:00Z')),'2026-11');
  assert.throws(()=>planPeriod('year'));
});

test('only other is a default subject; goal input rejects unknown subjects, invalid durations and periods',()=>{
  assert.deepEqual(planSubjects(null),[{id:'other',name:'기타'}]);
  assert.equal(subjectName('  물리  '),'물리');
  for(const name of ['', 'a'.repeat(21), '\u0000'])assert.throws(()=>subjectName(name));
  const profile={subjects:[{id:'s_physics',name:'물리'}]};
  const now=Date.parse('2026-10-22T00:00:00Z');
  assert.deepEqual(goalInput({period:'week',minutes:150,subjectId:'s_physics'},profile,now),{period:'week',periodKey:'2026-10-18',subjectId:'s_physics',targetSeconds:9000});
  for(const input of [{period:'day',minutes:0},{period:'day',minutes:1.5},{period:'day',minutes:1441},{period:'week',minutes:10081},{period:'month',minutes:44641},{period:'year',minutes:1},{period:'day',minutes:60,subjectId:'math'}])assert.throws(()=>goalInput(input,profile,now));
  const goal={...goalInput({period:'day',minutes:60},profile,now),id:'one'};
  assert.throws(()=>goalInput({period:'month',minutes:29*1440},profile,Date.parse('2026-02-01T00:00:00Z')));
  assert.equal(appendGoal([goal],{...goal,id:'two'}).alreadyExists,true);
});

test('goal counts use the matching subject and period and exclude expired goals',()=>{
  const now=Date.parse('2026-10-22T00:00:00Z');
  const day={id:'a',period:'day',periodKey:'2026-10-22',subjectId:'all',targetSeconds:3600};
  const week={id:'b',period:'week',periodKey:'2026-10-18',subjectId:'s_physics',targetSeconds:7200};
  const expired={...day,id:'c',periodKey:'2026-10-21'};
  const stats={day:{totalSeconds:3600},week:{totalSeconds:90000,subjectSeconds:{s_physics:1800}}};
  assert.deepEqual(goalSummary([day,week,expired],stats,now),{total:2,completed:1});
  assert.equal(goalProgress(week,stats,now).percent,25);
  assert.equal(goalProgress(expired,stats,now).current,false);
  assert.equal(goalProgress(day,{},now).complete,false);
});

function fakeDb() {
  const records=new Map([['users/owner',{uid:'owner',displayName:'사용자'}],['users/other',{uid:'other'}]]);
  const doc=path=>({path,get:async()=>({exists:records.has(path),data:()=>structuredClone(records.get(path))})});
  let queue=Promise.resolve();
  return {records,doc,runTransaction(action){const result=queue.then(()=>action({get:ref=>ref.get(),update:(ref,data)=>records.set(ref.path,{...records.get(ref.path),...data})}));queue=result.catch(()=>{});return result;}};
}

test('subject and goal writes are owner scoped, deduplicate retries and preserve server-only profile fields',async()=>{
  const db=fakeDb();
  const [a,b]=await Promise.all([changePlan(db,'owner','addSubject',{name:'물리'}),changePlan(db,'owner','addSubject',{name:'물리'})]);
  assert.equal(a.subject.id,b.subject.id);assert.equal(db.records.get('users/owner').subjects.length,1);
  const args={period:'week',minutes:300,subjectId:a.subject.id,uid:'other',totalSeconds:999999};
  const [first,second]=await Promise.all([changePlan(db,'owner','addGoal',args),changePlan(db,'owner','addGoal',args)]);
  assert.equal(first.goal.id,second.goal.id);assert.equal(db.records.get('users/owner').goals.length,1);
  assert.equal(db.records.get('users/owner').totalSeconds,undefined);assert.equal(db.records.get('users/other').goals,undefined);
  await assert.rejects(()=>changePlan(db,'owner','removeSubject',{id:'other'}));
  await assert.rejects(()=>changePlan(db,'owner','removeSubject',{id:a.subject.id}));
  await changePlan(db,'owner','removeGoal',{id:first.goal.id});
  await changePlan(db,'owner','removeSubject',{id:a.subject.id});
  assert.equal(db.records.get('users/owner').subjects.length,0);
});

test('AI can inspect, add a subject and register its goal in one bounded model turn',async()=>{
  const db=fakeDb(),calls=[];
  const turns=[{name:'get_study_plan',args:{}},{name:'add_study_subject',args:{name:'물리'}},{name:'add_study_goal',args:{subjectName:'물리',period:'week',minutes:300}}];
  const contents=[{role:'user',parts:[{text:'물리 과목을 추가하고 이번 주 5시간 목표로 등록해 줘'}]}];
  const result=await schoolAgent({contents,managePlan:(name,args)=>runPlanTool(db,'owner',name,args),lookup:()=>{throw Error('unnecessary school lookup');},generate:async options=>{
    calls.push(options);
    const call=turns.shift();
    return call ? {text:'',functionCalls:[call],modelContent:{role:'model',parts:[{functionCall:call,thoughtSignature:`signature-${calls.length}`}]}} : {text:'물리 과목과 이번 주 5시간 목표를 등록했습니다.'};
  }});
  assert.match(result.text,/등록했습니다/);assert.equal(calls.length,4);
  assert.ok(calls.slice(1).every(row=>row.countDaily===false));
  assert.equal(calls.at(-1).toolConfig.functionCallingConfig.mode,'NONE');
  assert.equal(calls.at(-1).contents.filter(row=>row.role==='model').length,3);
  assert.equal(db.records.get('users/owner').goals[0].subjectId,db.records.get('users/owner').subjects[0].id);
});

test('AI receives a failed goal write as an error rather than a success',async()=>{
  const db=fakeDb();
  await assert.rejects(()=>runPlanTool(db,'owner','add_study_goal',{subjectName:'미등록',period:'day',minutes:60}));
  assert.equal(db.records.get('users/owner').goals,undefined);
});

test('goal popup expands from its card, closes back to it and supports reduced motion',async()=>{
  const source=(await readFile(new URL('../planning.js',import.meta.url),'utf8')).replace(/^import .*;\r?\n/gm,'');
  for(const reduced of [false,true]) {
    const animations=[],attrs={},listeners={};let focused=0;
    const trigger={isConnected:true,getBoundingClientRect:()=>({left:20,top:100,width:150,height:140}),getAttribute:()=> 'goal-panel',setAttribute:(name,value)=>attrs[name]=value,focus:()=>focused++};
    const form={hidden:false,querySelector:()=>({focus(){}})},createButton={hidden:false,setAttribute:(name,value)=>attrs[`create-${name}`]=value,focus(){}};
    const dialog={open:false,querySelector:selector=>selector==='[data-goal-form]'?form:createButton,getBoundingClientRect:()=>({left:200,top:60,width:600,height:500}),showModal(){this.open=true;},close(){this.open=false;},animate(frames,options){animations.push({frames,options});return {finished:Promise.resolve(),cancel(){}};}};
    const context=vm.createContext({getStudyData:()=>({ready:true,user:null,stats:{},loading:new Set(),failed:new Set()}),planSubjects:()=>[],goalSummary:()=>({total:0,completed:0}),
      document:{querySelectorAll:()=>[],addEventListener:(name,fn)=>listeners[name]=fn,getElementById:()=>dialog},window:{addEventListener(){},matchMedia:()=>({matches:reduced})}});
    vm.runInContext(`${source}\nglobalThis.ui={openGoals,closeGoals,showGoalForm};`,context);
    context.ui.openGoals(trigger);assert.equal(dialog.open,true);assert.equal(attrs['aria-expanded'],'true');
    assert.equal(form.hidden,true);assert.equal(createButton.hidden,false);
    context.ui.showGoalForm(dialog,true);assert.equal(form.hidden,false);assert.equal(createButton.hidden,true);
    context.ui.showGoalForm(dialog,false);assert.equal(form.hidden,true);assert.equal(attrs['create-aria-expanded'],'false');
    await context.ui.closeGoals(dialog);assert.equal(dialog.open,false);assert.equal(attrs['aria-expanded'],'false');assert.equal(focused,1);
    assert.equal(animations.length,reduced?0:2);
    if(!reduced){assert.match(animations[0].frames[0].transform,/translate.*scale/);assert.equal(animations[1].frames[0].transform,'none');}
  }
});

test('success notifications use one screen toast and only the latest timer can dismiss it',async()=>{
  const source=(await readFile(new URL('../notifications.js',import.meta.url),'utf8')).replace(/^export /gm,'');
  const timers=new Map();let next=0,toast,appended=0;
  const context=vm.createContext({
    document:{body:{append:element=>{toast=element;appended++;}},querySelector:()=>toast,createElement:()=>({dataset:{},setAttribute(){},matches:()=>false,showPopover(){this.shown=true;},hidePopover(){this.shown=false;}})},
    window:{setTimeout:(fn,delay)=>{assert.equal(delay,4000);timers.set(++next,fn);return next;},clearTimeout:id=>timers.delete(id)},
  });
  vm.runInContext(`${source}\nshowToast('닉네임을 저장했습니다.');`,context);
  assert.equal(toast.textContent,'닉네임을 저장했습니다.');assert.equal(toast.hidden,false);assert.equal(toast.className,'status-toast');
  vm.runInContext("showToast('계정에 저장했습니다.');",context);
  assert.equal(appended,1);assert.equal(timers.size,1);assert.equal(toast.textContent,'계정에 저장했습니다.');
  [...timers.values()][0]();assert.equal(toast.hidden,true);assert.equal(toast.shown,false);
});
