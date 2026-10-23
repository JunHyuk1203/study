import { authReady, getAuthUser } from './auth.js?v=20261022-1';
import { getStudyData } from './data.js?v=20261023-19';
import { firebaseConfig } from './firebase-config.js';
import { chatHistory, completedAnswer } from './chat-state.js?v=20261021-28';
import { readCache } from './client-cache.js?v=20261022-11';
import { briefingPeriod } from './functions/briefing-period.js?v=20261022-11';
import { renderCalendar } from './school-calendar.js?v=20261022-12';

let callable;
async function client(name) {
  if (!await authReady) throw new Error('로그인 서비스를 불러오지 못했습니다. 새로고침해 주세요.');
  if (!getAuthUser()) throw new Error('로그인 후 이용할 수 있습니다.');
  if (!callable) {
    const [appSdk, functionsSdk] = await Promise.all([import('https://www.gstatic.com/firebasejs/13.0.0/firebase-app.js'), import('https://www.gstatic.com/firebasejs/13.0.0/firebase-functions.js')]);
    const app = appSdk.getApps()[0] ?? appSdk.initializeApp(firebaseConfig);
    const functions = functionsSdk.getFunctions(app, 'asia-northeast3');
    callable = name => functionsSdk.httpsCallable(functions, name, {timeout:name==='chatWithStudy'?245000:85000});
  }
  return callable(name);
}
async function call(name, data = {}) { return (await (await client(name))(data)).data; }
export async function updatePlan(input) { return call('updateStudyPlan',input); }
async function cachedCall(name, data = {}, ttl = 30*60000, force = false) {
  const {user,profile}=getStudyData();
  const period=briefingPeriod();
  const key=`${user?.uid}:remote:${name}:${JSON.stringify([profile?.school||null,period.date,name==='getStudyBriefing'?period.id:null,data])}`;
  const saved=force?undefined:readCache.get(key);
  if(saved!==undefined)return saved;
  const result=await call(name,force&&name==='getStudyBriefing'?{...data,force:true}:data);
  if(['getSchoolOverview','getUpcomingExams'].includes(name))ttl=Date.parse(`${period.date}T00:00:00+09:00`)+86400000-Date.now();
  // Partial upstream failures must remain retryable instead of being cached.
  if(!Object.values(result.errors||{}).some(Boolean)) readCache.set(key,result,result.expiresAtMs?Math.max(0,result.expiresAtMs-Date.now()):ttl);
  return result;
}
function errorMessage(error) {
  if (error?.code === 'functions/unauthenticated') return '다시 로그인해 주세요.';
  if (error?.code === 'functions/failed-precondition') return error.message || '계정 화면에서 이메일을 인증해 주세요.';
  if (error?.code === 'functions/resource-exhausted') return error.message || '요청이 많습니다. 잠시 후 다시 시도해 주세요.';
  if (error?.code === 'functions/invalid-argument') return '입력 내용을 확인해 주세요.';
  return error?.code ? '불러오지 못했습니다. 잠시 후 다시 시도해 주세요.' : error.message;
}
const text = (selector, value) => { for (const element of document.querySelectorAll(selector)) element.textContent = value; };
let owner, generation = 0, schoolKey, schoolState = {status:'idle'}, briefing = {status:'idle'}, messages = [], chatting = false, chatError = '';
let schoolSelection = null, searching = false;
const currentSchoolMonth = () => new Date(Date.now()+9*3600000).toISOString().slice(0,7);
let calendarMonth = currentSchoolMonth();
let calendarKey, calendarState = {status:'idle'};
let selectedSchoolDate=null;
const schoolRendered = new WeakMap();
let aiUsage, usageLoading=false, usageError='';
let briefingKey;
let forceSchoolRefresh=false;
let examKey, examState={status:'idle'};
function renderExams() {
  const hint=schoolHint();
  const data=examState.data;
  const exams=data?.exams||[];
  const days=exams.length?Math.round((Date.parse(`${exams[0].date}T00:00:00Z`)-Date.parse(`${data.start}T00:00:00Z`))/86400000):0;
  const nextTypes=exams.filter((exam,index)=>exams.findIndex(other=>other.type===exam.type)===index);
  text('[data-upcoming-exam]',hint?'미등록':examState.status==='error'?'조회 실패':examState.status!=='ready'?'로딩 중…':data.errors?.events?'확인 필요':exams.length?`${exams[0].type} ${days===0?'D-day':`D-${days}`}`:'일정 없음');
  text('[data-upcoming-exam-details]',hint|| (examState.status==='error'?examState.error:examState.status!=='ready'?'학사일정을 확인하고 있습니다.':data.errors?.events?'학사일정 일부를 불러오지 못했습니다. 새로고침해 주세요.':exams.length?`${nextTypes.map(exam=>`${exam.date} ${exam.name}`).join(' · ')} · 나이스 학사일정`:'앞으로 180일 내 등록된 모의고사·중간·기말 일정이 없습니다.'));
}
function status(selector, message, failed = false) {
  for (const element of document.querySelectorAll(selector)) {element.textContent=message; element.classList.toggle('is-error', failed); element.hidden=!message;}
}
function schoolHint() {
  const {ready, user, profile} = getStudyData();
  return !ready ? '로딩 중…' : !user ? '로그인 후 학교를 등록해 주세요.' : !profile?.school ? '학교·학년·반을 등록해 주세요.' : null;
}
function updateGradeOptions(registration, school) {
  const select=registration.elements.grade, previous=select.value;
  const kind=school.kind||school.name||'', maximum=/(?:중학교|고등학교)$/.test(kind)?3:6;
  // Native select options; lightweight test fixtures may only provide a value.
  if(select.replaceChildren) {
    const options=Array.from({length:maximum+1},(_,grade)=>{
      const option=document.createElement('option');option.value=grade?String(grade):'';option.textContent=grade?`${grade}학년`:'선택';return option;
    });
    select.replaceChildren(...options);
  }
  select.value=Number(previous)>=1&&Number(previous)<=maximum?previous:'';
}
function renderSchool() {
  const {user, profile} = getStudyData(), hint = schoolHint();
  text('[data-school-details]', profile?.school ? `${profile.school.grade}학년 ${profile.school.className}반 · ${profile.school.address}` : hint || '');
  for (const form of document.querySelectorAll('[data-school-search]')) {
    for (const field of form.elements) field.disabled = !user || searching;
  }
  const registration = document.querySelector('[data-school-registration]');
  if (registration && !searching && !registration.dataset.initialized && profile?.school) {
    schoolSelection = profile.school;
    registration.hidden = false;
    registration.dataset.initialized = 'true';
    registration.querySelector('[data-selected-school]').textContent = profile.school.name;
    updateGradeOptions(registration, profile.school);
    registration.elements.grade.value = Number(profile.school.grade)<=((/(?:중학교|고등학교)$/.test(profile.school.kind||profile.school.name||''))?3:6)?profile.school.grade:'';
    registration.elements.className.value = profile.school.className;
  }
  for (const button of document.querySelectorAll('[data-school-refresh]')) button.disabled = !user || schoolState.status==='loading';
  for (const control of document.querySelectorAll('[data-school-month], [data-school-month-step], [data-school-month-today]')) {
    control.disabled = Boolean(hint) || calendarState.status==='loading';
    if (control.matches('[data-school-month]')) control.value=calendarMonth;
  }
  if(selectedSchoolDate&&!selectedSchoolDate.startsWith(calendarMonth))selectedSchoolDate=null;
  for(const calendar of document.querySelectorAll('[data-school-calendar]'))renderCalendar(calendar,{
    month:calendarMonth,events:calendarState.status==='ready'&&!calendarState.data.errors?.events?calendarState.data.events||[]:[],
    selected:selectedSchoolDate,today:new Date(Date.now()+9*3600000).toISOString().slice(0,10),status:calendarState.status,hint,
  });
  for (const container of document.querySelectorAll('[data-school-meals], [data-school-timetable], [data-school-events]')) {
    const sectionState=container.hasAttribute('data-school-events')?calendarState:schoolState;
    const previous=schoolRendered.get(container);
    if(previous?.state===sectionState&&previous.hint===hint)continue;
    schoolRendered.set(container,{state:sectionState,hint});
    if (hint) {container.textContent=hint; continue;}
    if (sectionState.status==='idle' || sectionState.status==='loading') {container.textContent='로딩 중…'; continue;}
    if (sectionState.status==='error') {container.textContent=sectionState.error; continue;}
    const data=sectionState.data;
    container.replaceChildren();
    if (container.hasAttribute('data-school-events')) {
      if (data.errors?.events) {container.textContent='학사일정을 불러오지 못했습니다. 새로고침해 주세요.';continue;}
      if (!Array.isArray(data.events)) {container.textContent='학사일정 서비스를 준비 중입니다.';continue;}
      const events=data.events.filter(event=>!/^토요\s*휴업일$/.test(event.name)&&(!selectedSchoolDate||event.date===selectedSchoolDate));
      if (!events.length) {container.textContent=selectedSchoolDate?'선택한 날짜에 등록된 학사일정이 없습니다.':'선택한 달에 등록된 학사일정이 없습니다.';continue;}
      const list=document.createElement('ul');list.className='school-events';
      for (const event of events) {
        const item=document.createElement('li');
        const date=document.createElement('time');date.dateTime=event.date;date.textContent=`${Number(event.date.slice(5,7))}/${Number(event.date.slice(8,10))}`;
        const content=document.createElement('div'),title=document.createElement('strong');title.textContent=event.name;content.append(title);
        if(event.description && event.description!==event.name) {const description=document.createElement('p');description.textContent=event.description;content.append(description);}
        item.append(date,content);list.append(item);
      }
      container.append(list);
    } else if (container.hasAttribute('data-school-meals')) {
      if (data.errors.meals) {container.textContent='급식을 불러오지 못했습니다. 새로고침해 주세요.';continue;}
      if (!data.meals.length) {container.textContent='오늘 등록된 급식 정보가 없습니다.';continue;}
      for (const meal of data.meals) {
        const title=document.createElement('h3'); title.textContent=meal.name;
        const list=document.createElement('ul'); list.className='meal-menu';
        for (const item of meal.items) {const li=document.createElement('li');li.textContent=item;list.append(li);}
        const calories=document.createElement('p');calories.className='meal-kcal';calories.textContent=meal.calories;
        container.append(title,list,calories);
      }
    } else {
      if (data.errors.timetable) {container.textContent='시간표를 불러오지 못했습니다. 새로고침해 주세요.';continue;}
      if (!data.timetable.length) {container.textContent='이번 주 등록된 시간표가 없습니다.';continue;}
      const table=document.createElement('table');table.className='school-schedule';
      const caption=document.createElement('caption');caption.textContent=`${data.school.grade}학년 ${data.school.className}반 · ${data.days[0]} ~ ${data.days[4]}`;table.append(caption);
      const header=document.createElement('tr');
      for (const day of ['교시','월','화','수','목','금']) {const th=document.createElement('th');th.textContent=day;header.append(th);}
      const head=document.createElement('thead');head.append(header);table.append(head);
      const body=document.createElement('tbody');
      const last=Math.max(...data.timetable.map(row=>row.period));
      for(let period=1;period<=last;period++) {
        const tr=document.createElement('tr'),th=document.createElement('th');th.textContent=String(period);tr.append(th);
        for(const day of data.days) {
          const cell=document.createElement('td');
          cell.textContent=[...new Set(data.timetable.filter(row=>row.date===day.replaceAll('-','')&&row.period===period).map(row=>row.subject))].join(' / ')||'—';tr.append(cell);
        }
        body.append(tr);
      }
      table.append(body);container.append(table);
    }
  }
  if (schoolState.data) text('[data-school-date]', schoolState.data.date);
  text('[data-school-calendar-month]', `${calendarMonth.slice(0,4)}년 ${Number(calendarMonth.slice(5,7))}월`);
}
function renderBriefing() {
  const {ready,user}=getStudyData();
  text('[data-ai-briefing]', !ready ? '로딩 중…' : !user ? '로그인하면 공부 기록에 맞는 제안을 받을 수 있습니다.' : !user.emailVerified ? '이메일 인증 후 이용할 수 있습니다.' : briefing.status==='ready' ? briefing.text : briefing.status==='error' ? briefing.error : '로딩 중…');
  for(const button of document.querySelectorAll('[data-briefing-retry]')) {
    button.hidden=!ready||!user?.emailVerified;
    button.disabled=briefing.status==='loading';
    button.textContent=briefing.status==='loading'?'브리핑 생성 중…':briefing.status==='error'?'다시 불러오기':'최신 기록으로 새로고침';
  }
}
function renderChat() {
  const {ready,user}=getStudyData();
  for(const form of document.querySelectorAll('[data-ai-form]')) {
    form.querySelector('button[type="submit"]').disabled=!ready||!user||!user.emailVerified||chatting||aiUsage?.usedWon>=1000;
    form.querySelector('textarea').disabled=!ready||!user||!user.emailVerified;
  }
  const container=document.querySelector('[data-ai-messages]');
  if(!container)return;
  const scroller=container.closest('.chat-card');
  const followLatest=scroller&&(scroller.scrollHeight-scroller.scrollTop-scroller.clientHeight<48||container.childElementCount<messages.length);
  container.replaceChildren();
  if(!messages.length) {
    const empty=document.createElement('p');empty.className='empty-data';
    empty.textContent=!ready?'로딩 중…':!user?'로그인 후 AI에게 질문해 보세요.':!user.emailVerified?'계정에서 이메일을 인증한 뒤 이용해 주세요.':'궁금한 문제나 공부 계획을 물어보세요.';container.append(empty);
  }
  for(const message of messages) {
    const row=document.createElement('div');row.className=`message${message.role==='user'?' user':''}`;
    const avatar=document.createElement('span');avatar.className='chat-avatar';avatar.textContent=message.role==='user'?'나':'S';
    const bubble=document.createElement('div');bubble.className='bubble';bubble.textContent=message.text;
    row.append(avatar,bubble);container.append(row);
  }
  if(chatting) {const loading=document.createElement('p');loading.className='empty-data';loading.textContent='로딩 중…';container.append(loading);}
  if(followLatest)scroller.scrollTop=scroller.scrollHeight;
  status('[data-ai-status]',chatError,Boolean(chatError));
  text('[data-ai-usage]', !ready?'로딩 중…':!user?'로그인 후 이용할 수 있습니다.':usageError||(!aiUsage?'로딩 중…':`이번 달 ${aiUsage.usedWon.toLocaleString()} / 1,000원 · 오늘 Argon ${aiUsage.argonRemaining}회 남음`));
  for(const select of document.querySelectorAll('[data-ai-model]'))select.disabled=chatting;
  for(const option of document.querySelectorAll('[data-ai-model] option[value="gemini-4-argon"]'))option.disabled=aiUsage?.argonRemaining===0;
  for(const select of document.querySelectorAll('[data-ai-model]'))if(aiUsage?.argonRemaining===0&&select.value==='gemini-4-argon'&&!chatting)select.value='gemini-3.8-flash';
}
async function sync() {
  const {ready,user,profile}=getStudyData();
  if(owner!==user?.uid) {owner=user?.uid;generation++;schoolKey=null;calendarKey=null;calendarMonth=currentSchoolMonth();schoolState={status:'idle'};calendarState={status:'idle'};briefing={status:'idle'};briefingKey=null;messages=[];chatting=false;chatError='';schoolSelection=null;aiUsage=null;usageLoading=false;usageError='';}
  const currentBriefingKey=briefingPeriod().id;
  if(briefingKey!==currentBriefingKey){briefingKey=currentBriefingKey;briefing={status:'idle'};}
  const token=generation;
  renderSchool();renderBriefing();renderChat();
  const examsKey=JSON.stringify([user?.uid,profile?.school||null,new Date(Date.now()+9*3600000).toISOString().slice(0,10)]);
  if(examKey!==examsKey){examKey=examsKey;examState={status:'idle'};}
  renderExams();
  if(!ready||!user)return;
  if(document.querySelector('[data-upcoming-exam]')&&profile?.school&&examState.status==='idle') {
    examState={status:'loading'};renderExams();
    void cachedCall('getUpcomingExams',{},6*3600000).then(data=>{if(token===generation&&examKey===examsKey){examState={status:'ready',data};renderExams();}}).catch(error=>{if(token===generation&&examKey===examsKey){examState={status:'error',error:errorMessage(error)};renderExams();}});
  }
  if(document.querySelector('[data-ai-usage]')&&!aiUsage&&!usageLoading&&!usageError){
    usageLoading=true;
    void cachedCall('getAiUsage',{},2*60000).then(data=>{if(token===generation){aiUsage=data;usageLoading=false;renderChat();}}).catch(error=>{if(token===generation){usageError=errorMessage(error);usageLoading=false;text('[data-ai-usage]',usageError);}});
  }
  const key=JSON.stringify([profile?.school||null,currentSchoolMonth(),new Date(Date.now()+9*3600000).toISOString().slice(0,10)]);
  const monthKey=JSON.stringify([key,calendarMonth]);
  if(document.querySelector('[data-school-meals]')&&schoolKey!==key) {
    schoolKey=key;
    if(profile?.school) {
      calendarKey=monthKey;calendarState={status:'loading'};
      schoolState={status:'loading'};renderSchool();
      const force=forceSchoolRefresh;forceSchoolRefresh=false;
      void cachedCall('getSchoolOverview',{month:calendarMonth},30*60000,force).then(data=>{if(token===generation&&schoolKey===key){schoolState={status:'ready',data};if(calendarKey===monthKey)calendarState={status:'ready',data};renderSchool();}}).catch(error=>{if(token===generation&&schoolKey===key){schoolState={status:'error',error:errorMessage(error)};if(calendarKey===monthKey)calendarState={status:'error',error:errorMessage(error)};renderSchool();}});
    }
  }
  if(document.querySelector('[data-school-meals]')&&profile?.school&&calendarKey!==monthKey) {
    calendarKey=monthKey;calendarState={status:'loading'};renderSchool();
    void cachedCall('getSchoolOverview',{month:calendarMonth,eventsOnly:true}).then(data=>{if(token===generation&&schoolKey===key&&calendarKey===monthKey){calendarState={status:'ready',data};renderSchool();}}).catch(error=>{if(token===generation&&schoolKey===key&&calendarKey===monthKey){calendarState={status:'error',error:errorMessage(error)};renderSchool();}});
  }
  if(document.querySelector('[data-ai-briefing]')&&user.emailVerified&&briefing.status==='idle') {
    const force=briefing.force===true,periodKey=briefingKey;
    briefing={status:'loading'};renderBriefing();
    void cachedCall('getStudyBriefing',{},3600000,force).then(data=>{if(token===generation&&periodKey===briefingKey){briefing={status:'ready',text:data.text};if(data.usage)aiUsage=data.usage;renderBriefing();}}).catch(error=>{if(token===generation&&periodKey===briefingKey){briefing={status:'error',error:errorMessage(error)};renderBriefing();}});
  }
}
document.addEventListener('submit',async event=>{
  const form=event.target;
  if(form.matches('[data-school-search]')) {
    event.preventDefault();if(searching||!form.reportValidity())return;
    searching=true;schoolSelection=null;renderSchool();const token=generation;
    const results=document.querySelector('[data-school-results]');results.textContent='로딩 중…';
    const registration=document.querySelector('[data-school-registration]');registration.hidden=true;
    try {
      const data=await call('searchSchools',{query:form.elements.query.value.trim()});
      if(token!==generation||!results.isConnected)return;
      results.replaceChildren();
      if(!data.schools.length)results.textContent='검색 결과가 없습니다. 학교 이름을 확인해 주세요.';
      for(const school of data.schools) {
        const button=document.createElement('button');button.type='button';button.className='school-result';
        const name=document.createElement('strong'),address=document.createElement('span');name.textContent=school.name;address.textContent=school.address;button.append(name,address);
        button.addEventListener('click',()=>{schoolSelection=school;updateGradeOptions(registration,school);registration.hidden=false;registration.dataset.initialized='true';registration.querySelector('[data-selected-school]').textContent=school.name;for(const item of results.children)item.setAttribute('aria-pressed',String(item===button));});results.append(button);
      }
    }catch(error){if(token===generation)results.textContent=errorMessage(error);}
    finally{searching=false;renderSchool();}
  }
  if(form.matches('[data-school-registration]')) {
    event.preventDefault();if(!schoolSelection||form.dataset.busy==='true'||!form.reportValidity())return;
    form.dataset.busy='true';
    const button=form.querySelector('[type="submit"]');button.disabled=true;status('[data-school-status]','로딩 중…');
    try {await call('saveSchool',{officeCode:schoolSelection.officeCode,schoolCode:schoolSelection.schoolCode,grade:form.elements.grade.value,className:form.elements.className.value});status('[data-school-status]','학교·학년·반을 저장했습니다.');}
    catch(error){status('[data-school-status]',errorMessage(error),true);}finally{button.disabled=false;form.dataset.busy='false';}
  }
  if(form.matches('[data-ai-form]')) {
    event.preventDefault();if(chatting||!form.reportValidity())return;
    const field=form.elements.message,value=field.value.trim();if(!value)return;
    const token=generation;
    const history=chatHistory(messages,value);
    messages.push({role:'user',text:value});field.value='';chatting=true;chatError='';renderChat();
    const model=document.querySelector('[data-ai-model]').value;
    const answer={role:'model',text:''};messages.push(answer);
    try {
      const request=await (await client('chatWithStudy')).stream({messages:history,model});
      for await(const chunk of request.stream){if(token!==generation)break;answer.text+=chunk.text||'';renderChat();}
      const data=await request.data;
      if(token===generation){answer.text=completedAnswer(data,answer.text);aiUsage=data.usage;chatError=data.cutoff?'월 이용 한도에 맞춰 답변 생성을 중단했습니다.':data.interrupted?'연결이 중단되어 여기까지의 답변을 표시합니다.':'';}
    }
    catch(error){if(token===generation){chatError=errorMessage(error);if(!answer.text.trim()){messages.splice(-2);field.value=value;}else answer.text+='\n\n(답변이 중단되었습니다.)';aiUsage=null;usageError='';}}
    finally{if(token===generation){chatting=false;renderChat();void sync();}}
  }
});
document.addEventListener('change',event=>{
  if(event.target.matches('[data-school-month]')&&event.target.validity.valid&&/^20\d{2}-(0[1-9]|1[0-2])$/.test(event.target.value)) {
    calendarMonth=event.target.value;void sync();
  }
});
document.addEventListener('click',event=>{
  const calendarDay=event.target.closest('[data-school-calendar-day]');
  if(calendarDay&&!calendarDay.disabled){selectedSchoolDate=calendarDay.dataset.schoolCalendarDay;for(const node of document.querySelectorAll('[data-school-events]'))schoolRendered.delete(node);renderSchool();}
  if(event.target.closest('[data-school-calendar-all]')){selectedSchoolDate=null;for(const node of document.querySelectorAll('[data-school-events]'))schoolRendered.delete(node);renderSchool();}
  const monthStep=event.target.closest('[data-school-month-step]');
  if(monthStep&&!monthStep.disabled){
    const date=new Date(`${calendarMonth}-01T00:00:00Z`);date.setUTCMonth(date.getUTCMonth()+Number(monthStep.dataset.schoolMonthStep));
    const next=date.toISOString().slice(0,7);
    if(/^20\d{2}-/.test(next)){calendarMonth=next;void sync();}
  }
  if(event.target.closest('[data-school-month-today]:not(:disabled)')){calendarMonth=currentSchoolMonth();void sync();}
  if(event.target.closest('[data-school-refresh]')){schoolKey=null;forceSchoolRefresh=true;void sync();}
  if(event.target.closest('[data-briefing-retry]')&&briefing.status!=='loading'){briefing={status:'idle',force:true};void sync();}
});
for(const event of ['study:navigated','study:auth-changed','study:data-changed'])window.addEventListener(event,()=>{void sync();});
// Only refresh at a slot transition while the home screen is visible.
window.setInterval?.(()=>{if(!document.hidden&&document.querySelector('[data-ai-briefing]')&&briefingKey!==briefingPeriod().id)void sync();},60000);
void sync();
