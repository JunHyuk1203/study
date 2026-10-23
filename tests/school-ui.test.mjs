import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { chatHistory, completedAnswer } from '../chat-state.js';
import { briefingPeriod } from '../functions/briefing-period.js';

const cacheSource=(await readFile(new URL('../client-cache.js',import.meta.url),'utf8')).replace(/^export /gm,'');
const source=cacheSource+'\n'+(await readFile(new URL('../integrations.js',import.meta.url),'utf8')).replace(/^import .*;\r?\n/gm,'').replace(/^export /gm,'');
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function schoolUi() {
  const handlers={},requests=[];
  const context=vm.createContext({
    briefingPeriod,
    document:{querySelectorAll:()=>[],querySelector:selector=>selector==='[data-school-meals]'?{}:null,addEventListener:(name,handler)=>{handlers[name]=handler;}},
    window:{addEventListener(){}},
    getStudyData:()=>context.profileState,
    profileState:{ready:false,user:{uid:'ui-user'},profile:{school:{name:'학교',grade:'2',className:'3'}}},
    invoke:(name,data)=>new Promise((resolve,reject)=>requests.push({name,data,resolve,reject})),
  });
  vm.runInContext(`${source}\ncall=invoke;globalThis.ui={sync,setMonth:value=>{calendarMonth=value;},state:()=>({month:calendarMonth,school:schoolState,calendar:calendarState})};`,context);
  context.profileState.ready=true;
  return {context,requests,handlers,ui:context.ui};
}
const overview=month=>({calendarRange:{start:`${month}-01`},date:'2026-10-21',meals:[],timetable:[],events:[],errors:{}});

test('grade options shrink for middle/high schools and clear an invalid previous grade',()=>{
  const {context}=schoolUi();
  context.document.createElement=()=>({});
  const select={value:'6',replaceChildren(...options){this.options=options;}};
  context.registration={elements:{grade:select}};
  vm.runInContext("updateGradeOptions(registration,{kind:'중학교'})",context);
  assert.equal(select.options.length,4);assert.equal(select.value,'');
  select.value='3';vm.runInContext("updateGradeOptions(registration,{kind:'고등학교'})",context);
  assert.equal(select.options.length,4);assert.equal(select.value,'3');
  vm.runInContext("updateGradeOptions(registration,{kind:'초등학교'})",context);
  assert.equal(select.options.length,7);
  select.value='5';vm.runInContext("updateGradeOptions(registration,{name:'중앙고등학교'})",context);
  assert.equal(select.options.length,4);assert.equal(select.value,'');
});

test('calendar selection filters the schedule list, reset restores it, and cached Saturday closures stay hidden',async()=>{
  const {context,ui,requests,handlers}=schoolUi();
  const node=tag=>({tag,children:[],append(...children){this.children.push(...children);},replaceChildren(){this.children=[];},hasAttribute:name=>name==='data-school-events'});
  const list=node('div');context.document.createElement=node;
  context.document.querySelectorAll=selector=>['[data-school-meals], [data-school-timetable], [data-school-events]','[data-school-events]'].includes(selector)?[list]:[];
  ui.setMonth('2026-10');await ui.sync();
  requests[0].resolve({...overview('2026-10'),events:[{date:'2026-10-22',name:'중간고사'},{date:'2026-10-23',name:'체험학습'},{date:'2026-10-24',name:'토요휴업일'}]});await settle();
  assert.equal(list.children[0].children.length,2);
  handlers.click({target:{closest:selector=>selector==='[data-school-calendar-day]'?{disabled:false,dataset:{schoolCalendarDay:'2026-10-22'}}:null}});
  assert.equal(list.children[0].children.length,1);
  handlers.click({target:{closest:selector=>selector==='[data-school-calendar-all]'?{}:null}});
  assert.equal(list.children[0].children.length,2);assert.equal(requests.length,1);
});

test('briefing reuses its slot cache on reopening and only manual refresh forces live generation',async()=>{
  const {context,ui,requests,handlers}=schoolUi();
  context.profileState.user.emailVerified=true;
  context.document.querySelector=selector=>selector==='[data-ai-briefing]'?{}:null;
  await ui.sync();assert.equal(requests.length,1);assert.equal(requests[0].name,'getStudyBriefing');
  requests[0].resolve({text:'저장된 아침 브리핑',expiresAtMs:Date.now()+3600000});await settle();
  vm.runInContext("briefing={status:'idle'};",context);
  await ui.sync();await settle();assert.equal(requests.length,1);
  handlers.click({target:{closest:selector=>selector==='[data-briefing-retry]'?{}:null}});
  assert.equal(requests.length,2);assert.equal(requests[1].data.force,true);
  requests[1].resolve({text:'최신 학습 기록 브리핑',expiresAtMs:Date.now()+3600000});await settle();
  const current=briefingPeriod();context.briefingPeriod=()=>({...current,id:'next-slot'});
  await ui.sync();assert.equal(requests.length,3);assert.equal(requests[2].data.force,undefined);
  requests[2].resolve({text:'다음 시간대 브리핑',expiresAtMs:Date.now()+3600000});await settle();
});

test('account school and classroom follow profile loading, saved changes and missing registration',async()=>{
  const dataSource=cacheSource+'\n'+(await readFile(new URL('../data.js',import.meta.url),'utf8'))
    .replace(/^import .*;\r?\n/gm,'').replace('export function getStudyData','function getStudyData').split(/\r?\ntry \{\r?\n  authServices/)[0];
  const school={textContent:''},classroom={textContent:''};
  const context=vm.createContext({
    getAuthUser:()=>({uid:'account-user'}),cameraState:()=>({}),
    document:{querySelectorAll:selector=>selector==='[data-account-school]'?[school]:selector==='[data-account-classroom]'?[classroom]:[],addEventListener(){}},
    window:{addEventListener(){},dispatchEvent(){},setInterval(){}},Event:class{},
  });
  vm.runInContext(`${dataSource}\nglobalThis.accountUi={paint,loaded:()=>{authResolved=true;state.pending.clear();},setSchool:school=>{state.profile={school};paint();}};`,context);
  context.accountUi.paint();assert.equal(school.textContent,'로딩 중…');
  context.accountUi.loaded();context.accountUi.setSchool({name:'중앙고등학교',grade:'2',className:'3'});
  assert.equal(school.textContent,'중앙고등학교');assert.equal(classroom.textContent,'2학년 3반');
  context.accountUi.setSchool({name:'새 학교',grade:'1',className:'5'});
  assert.equal(school.textContent,'새 학교');assert.equal(classroom.textContent,'1학년 5반');
  context.accountUi.setSchool(null);assert.equal(school.textContent,'미등록');assert.equal(classroom.textContent,'미등록');
});

test('account settings prefill the saved school and let classroom changes save without another search',async()=>{
  const {context,handlers,requests,ui}=schoolUi();
  const selected={textContent:''},button={disabled:false};
  const form={hidden:true,dataset:{},elements:{grade:{value:''},className:{value:''}},
    matches:selector=>selector==='[data-school-registration]',reportValidity:()=>true,
    querySelector:selector=>selector==='[data-selected-school]'?selected:button};
  const saved={name:'중앙고등학교',officeCode:'S10',schoolCode:'9010178',grade:'2',className:'3'};
  context.profileState.profile.school=saved;
  context.document.querySelector=selector=>selector==='[data-school-registration]'?form:null;
  await ui.sync();
  assert.equal(form.hidden,false);assert.equal(selected.textContent,saved.name);
  assert.equal(form.elements.grade.value,'2');assert.equal(form.elements.className.value,'3');
  form.elements.className.value='5';await ui.sync();assert.equal(form.elements.className.value,'5');
  const saving=handlers.submit({target:form,preventDefault(){}});
  assert.equal(requests[0].name,'saveSchool');assert.equal(requests[0].data.className,'5');
  assert.equal(requests[0].data.schoolCode,saved.schoolCode);
  requests[0].resolve({school:{...saved,className:'5'}});await saving;
  assert.equal(button.disabled,false);
});

test('calendar-only overview skips meal and timetable provider requests',async()=>{
  const backend=await readFile(new URL('../functions/integrations.js',import.meta.url),'utf8');
  const handler=backend.slice(backend.indexOf('export const getSchoolOverview'),backend.indexOf('export const getAiUsage')).replace('export const','globalThis.');
  const calls=[];
  const context=vm.createContext({
    onCall:(_,fn)=>fn,options:{},neisKey:{},neis:()=>{},uid:()=> 'user',rateLimit:async()=>{},
    db:{doc:()=>({get:async()=>({data:()=>({school:{name:'학교'}})})})},
    schoolDates:()=>({date:'2026-10-21',days:['2026-10-19','2026-10-20','2026-10-21','2026-10-22','2026-10-23']}),
    input:fn=>fn(),schoolMonth:value=>value,schoolCalendarRange:start=>({start,end:'2026-11-30'}),
    loadSchoolData:async(_,query)=>{calls.push(query);return {events:[],errors:{}};},
  });
  vm.runInContext(handler,context);
  const result=await context.getSchoolOverview({data:{month:'2026-11',eventsOnly:true}});
  assert.equal(calls.length,1);assert.deepEqual(Array.from(calls[0].types),['events']);
  assert.equal(calls[0].start,'2026-11-01');assert.equal(calls[0].end,'2026-11-30');
  assert.equal(result.meals,undefined);assert.equal(result.timetable,undefined);
});
test('calendar navigation crosses years, accepts leap February and returns to current Korean month',async()=>{
  const {ui,requests,handlers}=schoolUi();
  ui.setMonth('2026-12');await ui.sync();requests.at(-1).resolve(overview('2026-12'));await settle();
  handlers.click({target:{closest:selector=>selector==='[data-school-month-step]'?{disabled:false,dataset:{schoolMonthStep:'1'}}:null}});
  assert.equal(ui.state().month,'2027-01');assert.equal(requests.at(-1).data.month,'2027-01');
  requests.at(-1).resolve(overview('2027-01'));await settle();
  handlers.click({target:{closest:selector=>selector==='[data-school-month-step]'?{disabled:false,dataset:{schoolMonthStep:'-1'}}:null}});
  assert.equal(ui.state().month,'2026-12');requests.at(-1).resolve(overview('2026-12'));await settle();
  handlers.change({target:{matches:()=>true,validity:{valid:true},value:'2028-02'}});
  assert.equal(requests.at(-1).data.month,'2028-02');requests.at(-1).resolve(overview('2028-02'));await settle();
  handlers.click({target:{closest:selector=>selector==='[data-school-month-today]:not(:disabled)'?{}:null}});
  assert.equal(ui.state().month,new Date(Date.now()+9*3600000).toISOString().slice(0,7));
});
test('a late previous-school response cannot replace the newly selected school and month',async()=>{
  const {ui,requests,context}=schoolUi();
  ui.setMonth('2026-11');await ui.sync();
  const old=requests[0];
  context.profileState.profile.school={name:'새 학교',grade:'1',className:'5'};
  ui.setMonth('2026-12');await ui.sync();
  const current=overview('2026-12');requests[1].resolve(current);await settle();
  old.resolve(overview('2026-11'));await settle();
  assert.equal(ui.state().school.data,current);
});

test('changing months preserves meals and timetable DOM through calendar loading and errors',async()=>{
  const {ui,requests,context}=schoolUi();
  const containers=['meals','timetable','events'].map(type=>({
    textContent:'',replacements:0,hasAttribute:name=>name===`data-school-${type}`,
    replaceChildren(){this.replacements++;},
  }));
  context.document.querySelectorAll=selector=>selector==='[data-school-meals], [data-school-timetable], [data-school-events]'?containers:[];
  ui.setMonth('2026-10');await ui.sync();requests[0].resolve(overview('2026-10'));await settle();
  const base=ui.state().school;
  const replacements=containers.slice(0,2).map(container=>container.replacements);
  ui.setMonth('2026-11');await ui.sync();
  assert.equal(requests[1].data.eventsOnly,true);
  assert.equal(ui.state().school,base);
  assert.equal(containers[2].textContent,'로딩 중…');
  assert.deepEqual(containers.slice(0,2).map(container=>container.replacements),replacements);
  requests[1].reject(new Error('calendar failed'));await settle();
  assert.equal(containers[2].textContent,'calendar failed');
  assert.equal(ui.state().school,base);
  ui.setMonth('2026-12');await ui.sync();
  ui.setMonth('2027-01');await ui.sync();
  const current=overview('2027-01');requests[3].resolve(current);await settle();
  requests[2].resolve(overview('2026-12'));await settle();
  assert.equal(ui.state().calendar.data,current);
  assert.deepEqual(containers.slice(0,2).map(container=>container.replacements),replacements);
});

test('empty chat completion rolls back the failed turn and the next question succeeds',async()=>{
  const {context,handlers}=schoolUi();
  const requests=[],answers=[{text:'   '},{text:'5',usage:{usedWon:1}}];
  context.chatHistory=chatHistory;context.completedAnswer=completedAnswer;
  context.document.querySelector=()=>({value:'gemini-3.8-flash'});
  context.makeRequest=async data=>{requests.push(data);return {stream:(async function*(){})(),data:Promise.resolve(answers.shift())};};
  vm.runInContext("renderChat=()=>{};sync=async()=>{};client=async()=>({stream:makeRequest});globalThis.chatState=()=>({messages,chatting,chatError});",context);
  const field={value:'다음 시험이 언제야?'};
  const form={matches:selector=>selector==='[data-ai-form]',reportValidity:()=>true,elements:{message:field}};
  const event={target:form,preventDefault(){}};
  await handlers.submit(event);
  assert.equal(field.value,'다음 시험이 언제야?');assert.equal(context.chatState().messages.length,0);
  assert.equal(context.chatState().chatting,false);assert.match(context.chatState().chatError,/답변을 만들지/);
  field.value='2+3?';await handlers.submit(event);
  assert.equal(requests[1].messages.length,1);assert.equal(requests[1].messages[0].text,'2+3?');
  assert.equal(context.chatState().messages[1].text,'5');assert.equal(context.chatState().chatError,'');
});

test('home exams show loading then real dates and discard responses from a previous school',async()=>{
  const {context,requests,ui}=schoolUi();
  const metric={textContent:''},details={textContent:''};
  context.document.querySelector=selector=>selector==='[data-upcoming-exam]'?metric:null;
  context.document.querySelectorAll=selector=>selector==='[data-upcoming-exam]'?[metric]:selector==='[data-upcoming-exam-details]'?[details]:[];
  await ui.sync();assert.equal(requests[0].name,'getUpcomingExams');assert.match(metric.textContent,/로딩/);
  const old=requests[0];
  context.profileState.profile.school={name:'새 학교',grade:'1',className:'5'};await ui.sync();
  requests[1].resolve({start:'2026-10-21',exams:[{date:'2026-10-22',type:'모의고사',name:'전국연합학력평가'}],errors:{events:false}});await settle();
  assert.equal(metric.textContent,'모의고사 D-1');assert.match(details.textContent,/2026-10-22 전국연합학력평가/);
  old.resolve({start:'2026-10-21',exams:[],errors:{events:false}});await settle();
  assert.equal(metric.textContent,'모의고사 D-1');
});
