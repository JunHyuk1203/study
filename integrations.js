import { authReady, getAuthUser } from './auth.js?v=20261021-25';
import { getStudyData } from './data.js?v=20261021-25';
import { firebaseConfig } from './firebase-config.js';

let callable;
async function client(name) {
  if (!await authReady) throw new Error('로그인 서비스를 불러오지 못했습니다. 새로고침해 주세요.');
  if (!getAuthUser()) throw new Error('로그인 후 이용할 수 있습니다.');
  if (!callable) {
    const [appSdk, functionsSdk] = await Promise.all([import('https://www.gstatic.com/firebasejs/13.0.0/firebase-app.js'), import('https://www.gstatic.com/firebasejs/13.0.0/firebase-functions.js')]);
    const app = appSdk.getApps()[0] ?? appSdk.initializeApp(firebaseConfig);
    const functions = functionsSdk.getFunctions(app, 'asia-northeast3');
    callable = name => functionsSdk.httpsCallable(functions, name, {timeout:85000});
  }
  return callable(name);
}
async function call(name, data = {}) { return (await (await client(name))(data)).data; }
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
let aiUsage, usageLoading=false, usageError='';
function status(selector, message, failed = false) {
  for (const element of document.querySelectorAll(selector)) {element.textContent=message; element.classList.toggle('is-error', failed); element.hidden=!message;}
}
function schoolHint() {
  const {ready, user, profile} = getStudyData();
  return !ready ? '로딩 중…' : !user ? '로그인 후 학교를 등록해 주세요.' : !profile?.school ? '학교·학년·반을 등록해 주세요.' : null;
}
function renderSchool() {
  const {user, profile} = getStudyData(), hint = schoolHint();
  text('[data-school-details]', profile?.school ? `${profile.school.grade}학년 ${profile.school.className}반 · ${profile.school.address}` : hint || '');
  for (const form of document.querySelectorAll('[data-school-search]')) {
    for (const field of form.elements) field.disabled = !user || searching;
  }
  for (const button of document.querySelectorAll('[data-school-refresh]')) button.disabled = !user || schoolState.status==='loading';
  for (const container of document.querySelectorAll('[data-school-meals], [data-school-timetable]')) {
    if (hint) {container.textContent=hint; continue;}
    if (schoolState.status==='idle' || schoolState.status==='loading') {container.textContent='로딩 중…'; continue;}
    if (schoolState.status==='error') {container.textContent=schoolState.error; continue;}
    const data=schoolState.data;
    container.replaceChildren();
    if (container.hasAttribute('data-school-meals')) {
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
}
function renderBriefing() {
  const {ready,user}=getStudyData();
  text('[data-ai-briefing]', !ready ? '로딩 중…' : !user ? '로그인하면 공부 기록에 맞는 제안을 받을 수 있습니다.' : !user.emailVerified ? '이메일 인증 후 이용할 수 있습니다.' : briefing.status==='ready' ? briefing.text : briefing.status==='error' ? briefing.error : '로딩 중…');
  for(const button of document.querySelectorAll('[data-briefing-retry]')) button.hidden=briefing.status!=='error';
}
function renderChat() {
  const {ready,user}=getStudyData();
  for(const form of document.querySelectorAll('[data-ai-form]')) {
    form.querySelector('button[type="submit"]').disabled=!ready||!user||!user.emailVerified||chatting||aiUsage?.usedWon>=1000;
    form.querySelector('textarea').disabled=!ready||!user||!user.emailVerified;
  }
  const container=document.querySelector('[data-ai-messages]');
  if(!container)return;
  container.replaceChildren();
  if(!messages.length) {
    const empty=document.createElement('p');empty.className='empty-data';
    empty.textContent=!ready?'로딩 중…':!user?'로그인 후 AI에게 질문해 보세요.':!user.emailVerified?'계정에서 이메일을 인증한 뒤 이용해 주세요.':'궁금한 문제나 공부 계획을 물어보세요.';container.append(empty);
  }
  for(const message of messages) {
    const row=document.createElement('div');row.className=`message${message.role==='user'?' user':''}`;
    const avatar=document.createElement('span');avatar.className='chat-avatar';avatar.textContent=message.role==='user'?'나':'✳';
    const bubble=document.createElement('div');bubble.className='bubble';bubble.textContent=message.text;
    row.append(avatar,bubble);container.append(row);
  }
  if(chatting) {const loading=document.createElement('p');loading.className='empty-data';loading.textContent='로딩 중…';container.append(loading);}
  status('[data-ai-status]',chatError,Boolean(chatError));
  text('[data-ai-usage]', !ready?'로딩 중…':!user?'로그인 후 이용할 수 있습니다.':usageError||(!aiUsage?'로딩 중…':`이번 달 ${aiUsage.usedWon.toLocaleString()} / 1,000원 · 오늘 Argon ${aiUsage.argonRemaining}회 남음`));
  for(const select of document.querySelectorAll('[data-ai-model]'))select.disabled=chatting;
  for(const option of document.querySelectorAll('[data-ai-model] option[value="gemini-4-argon"]'))option.disabled=aiUsage?.argonRemaining===0;
  for(const select of document.querySelectorAll('[data-ai-model]'))if(aiUsage?.argonRemaining===0&&select.value==='gemini-4-argon'&&!chatting)select.value='gemini-3.8-flash';
}
async function sync() {
  const {ready,user,profile}=getStudyData();
  if(owner!==user?.uid) {owner=user?.uid;generation++;schoolKey=null;schoolState={status:'idle'};briefing={status:'idle'};messages=[];chatting=false;chatError='';schoolSelection=null;aiUsage=null;usageLoading=false;usageError='';}
  const token=generation;
  renderSchool();renderBriefing();renderChat();
  if(!ready||!user)return;
  if(document.querySelector('[data-ai-usage]')&&!aiUsage&&!usageLoading&&!usageError){
    usageLoading=true;
    void call('getAiUsage').then(data=>{if(token===generation){aiUsage=data;usageLoading=false;renderChat();}}).catch(error=>{if(token===generation){usageError=errorMessage(error);usageLoading=false;text('[data-ai-usage]',usageError);}});
  }
  const key=JSON.stringify(profile?.school||null);
  if(document.querySelector('[data-school-meals]')&&schoolKey!==key) {
    schoolKey=key;
    if(profile?.school) {
      schoolState={status:'loading'};renderSchool();
      void call('getSchoolOverview').then(data=>{if(token===generation&&schoolKey===key){schoolState={status:'ready',data};renderSchool();}}).catch(error=>{if(token===generation&&schoolKey===key){schoolState={status:'error',error:errorMessage(error)};renderSchool();}});
    }
  }
  if(document.querySelector('[data-ai-briefing]')&&user.emailVerified&&briefing.status==='idle') {
    briefing={status:'loading'};renderBriefing();
    void call('getStudyBriefing').then(data=>{if(token===generation){briefing={status:'ready',text:data.text};renderBriefing();}}).catch(error=>{if(token===generation){briefing={status:'error',error:errorMessage(error)};renderBriefing();}});
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
        button.addEventListener('click',()=>{schoolSelection=school;registration.hidden=false;registration.querySelector('[data-selected-school]').textContent=school.name;for(const item of results.children)item.setAttribute('aria-pressed',String(item===button));});results.append(button);
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
    const history=messages.slice(-12).map(item=>({role:item.role,text:item.text.slice(0,4000)}));
    while(history.reduce((sum,item)=>sum+item.text.length,0)+value.length>24000)history.splice(0,2);
    history.push({role:'user',text:value});messages.push({role:'user',text:value});field.value='';chatting=true;chatError='';renderChat();
    const model=document.querySelector('[data-ai-model]').value;
    const answer={role:'model',text:''};messages.push(answer);
    try {
      const request=await (await client('chatWithStudy')).stream({messages:history,model});
      for await(const chunk of request.stream){if(token!==generation)break;answer.text+=chunk.text||'';renderChat();}
      const data=await request.data;
      if(token===generation){answer.text=data.text;aiUsage=data.usage;chatError=data.cutoff?'월 이용 한도에 맞춰 답변 생성을 중단했습니다.':data.interrupted?'연결이 중단되어 여기까지의 답변을 표시합니다.':'';}
    }
    catch(error){if(token===generation){chatError=errorMessage(error);if(!answer.text){messages.splice(-2);field.value=value;}else answer.text+='\n\n(답변이 중단되었습니다.)';aiUsage=null;usageError='';}}
    finally{if(token===generation){chatting=false;renderChat();void sync();}}
  }
});
document.addEventListener('click',event=>{
  if(event.target.closest('[data-school-refresh]')){schoolKey=null;void sync();}
  if(event.target.closest('[data-briefing-retry]')){briefing={status:'idle'};void sync();}
  const suggestion=event.target.closest('[data-ai-suggestion]');
  if(suggestion){const field=document.querySelector('[data-ai-form] textarea');field.value=suggestion.dataset.aiSuggestion;field.focus();}
});
for(const event of ['study:navigated','study:auth-changed','study:data-changed'])window.addEventListener(event,()=>{void sync();});
void sync();
