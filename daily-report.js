import {authReady,getAuthUser} from './auth.js?v=20261022-1';
import {getStudyData} from './data.js?v=20261023-7';
import {studyCall,serviceError,element as el,duration} from './study-api.js';
import {studyDate} from './functions/report-math.js';
let cached=null,cacheKey='',pending=false,epoch=0;
const colors=['#647e58','#8fa77e','#b1bd88','#b79473','#8b9fa2','#b899a8'];
const localTime=ms=>new Date(ms).toLocaleTimeString('ko-KR',{timeZone:'Asia/Seoul',hour:'2-digit',minute:'2-digit',hour12:false});
function metric(label,value) {const node=el('div','report-metric');node.append(el('dt','',label),el('dd','',value));return node;}
function section(title,description) {const node=el('section','report-section');node.append(el('h3','',title));if(description)node.append(el('p','tiny muted',description));return node;}
function bars(rows,{hourly=false}={}) {
  const node=el('div',hourly?'report-bars report-hours':'report-bars');
  const max=Math.max(1,...rows.map(row=>row.seconds));
  rows.forEach((row,index)=>{
    const column=el('div','report-column');
    const label=`${row.label}: ${duration(row.seconds)}`;
    column.title=label;column.setAttribute('aria-label',label);
    const track=el('div','report-bar-track'),bar=el('div','report-bar');
    bar.style.height=`${row.seconds/max*100}%`;bar.style.background=colors[index%colors.length];track.append(bar);
    column.append(track,el('span','report-axis',hourly&&index%3!==0?'':row.label));
    if(!hourly){const hours=Math.floor(row.seconds/3600),minutes=Math.floor(row.seconds%3600/60);column.append(el('span','report-bar-value',hours?`${hours}시간${minutes?`\n${minutes}분`:''}`:duration(row.seconds)));}
    node.append(column);
  });
  return node;
}
function breakdown(values,total,names={}) {
  const list=el('div','report-breakdown');
  Object.entries(values).sort((a,b)=>b[1]-a[1]).forEach(([key,seconds],index)=>{
    const row=el('div','report-breakdown-row'),head=el('div','report-row-heading');
    head.append(el('span','',names[key]||key),el('span','',`${duration(seconds)} · ${total?Math.round(seconds/total*100):0}%`));
    const track=el('div','report-horizontal-track'),bar=el('span');bar.style.width=`${total?seconds/total*100:0}%`;bar.style.background=colors[index%colors.length];track.append(bar);row.append(head,track);list.append(row);
  });return list;
}
function paint(report) {
  for(const root of document.querySelectorAll('[data-daily-report]')) {
    root.replaceChildren();
    const headline=el('p','report-date',`${report.date.replaceAll('-','.')} · 한국 시간 기준`);
    const metrics=el('dl','report-metrics');
    metrics.append(metric('공부한 시간',duration(report.totalSeconds)),metric('학습 세션',`${report.sessionCount}회`),metric('최장 세션',duration(report.longestSeconds)),metric('평균 세션',duration(report.averageSeconds)),metric('세션 내 일시정지',duration(report.pauseSeconds)),metric('세션 내 학습 비율',`${report.studyRatio}%`));
    root.append(headline,metrics);
    if(report.hasActiveSession)root.append(el('p','report-note','진행 중인 학습은 종료·저장 후 반영됩니다.'));
    if(!report.sessionCount)root.append(el('p','empty-data','오늘 저장된 공부 기록이 없습니다. 학습을 완료하면 리포트가 채워져요.'));
    const subjects=section('어떤 과목을 공부했나요?','과목별 공부시간과 비중');subjects.append(breakdown(report.subjectSeconds,report.totalSeconds,report.subjects));
    const hours=section('언제 공부가 잘 이어졌나요?','시간대별 실제 기록 시간 · 막대에 마우스를 올리면 시간을 확인할 수 있어요.');
    hours.append(bars(report.hourly.map((seconds,hour)=>({label:`${hour}시`,seconds})),{hourly:true}));
    // A textual equivalent also makes the dense chart usable with touch/readers.
    const detail=el('details','report-hour-details'),summary=el('summary','','시간대별 수치 보기');detail.append(summary);
    const hourList=el('dl','report-hour-values');report.hourly.forEach((seconds,hour)=>{if(seconds)hourList.append(metric(`${hour}–${hour+1}시`,duration(seconds)));});
    if(!hourList.childElementCount)detail.append(el('p','tiny muted','시간대별 기록이 없습니다.'));else detail.append(hourList);hours.append(detail);
    if(report.unallocatedSeconds)hours.append(el('p','report-note',`이전 기록 ${duration(report.unallocatedSeconds)}은 시간대 정보가 없어 그래프에서 제외했습니다. 총 공부시간에는 포함됩니다.`));
    const week=section('최근 7일의 흐름','완료·저장된 일별 공부시간 · 오늘은 완료한 세션 기준');week.append(bars(report.days.map(day=>({label:day.date.slice(5).replace('-','/'),seconds:day.seconds}))));
    const methods=section('어떻게 공부했나요?');methods.append(breakdown(report.sourceSeconds,report.totalSeconds));
    const timeline=section('오늘의 학습 기록','세션별 시작·종료와 실제 공부시간 · 최장 세션은 연속 집중시간을 의미하지 않습니다.');
    const list=el('ol','report-session-list');for(const row of report.sessions) {
      const item=el('li'),head=el('div','report-row-heading');head.append(el('strong','',report.subjects[row.subjectId]||'이전 과목'),el('span','',duration(row.seconds)));
      item.append(head,el('p','tiny muted',`${localTime(row.from)}–${localTime(row.until)} · ${row.source}${row.pauseSeconds?` · 일시정지 ${duration(row.pauseSeconds)}`:''}`));list.append(item);
    }timeline.append(list);
    const insights=section('오늘의 발견');
    const top=Object.entries(report.subjectSeconds).sort((a,b)=>b[1]-a[1])[0];
    const peak=report.hourly.indexOf(Math.max(...report.hourly));
    const yesterday=report.days.at(-2)?.seconds||0,diff=report.totalSeconds-yesterday;
    const notes=[];
    if(top)notes.push(`${report.subjects[top[0]]||'이전 과목'}에 가장 많은 시간(${duration(top[1])})을 썼어요.`);
    if(report.hourly[peak])notes.push(`${peak}–${peak+1}시에 가장 오래 공부했어요.`);
    if(report.totalSeconds&&yesterday)notes.push(`어제보다 ${duration(Math.abs(diff))} ${diff>=0?'더':'덜'} 공부했어요. 오늘 기록은 아직 늘어날 수 있어요.`);
    if(!notes.length)notes.push('공부를 마치면 오늘의 패턴을 확인할 수 있어요.');
    for(const note of notes)insights.append(el('p','report-insight',note));
    root.append(subjects,hours,week,methods,timeline,insights,el('p','tiny muted','스터디캠 기록은 얼굴 감지로 측정한 착석 시간입니다. 실제 집중 여부는 판단하지 않습니다.'));
  }
}
async function load(force=false) {
  const root=document.querySelector('[data-daily-report]');
  if(!root||document.hidden||root.closest?.('dialog')&&!root.closest('dialog').open)return;
  const user=getAuthUser(),data=getStudyData();
  if(!user){for(const node of document.querySelectorAll('[data-daily-report]'))node.textContent='로그인하면 오늘의 리포트를 볼 수 있어요.';return;}
  if(!data.ready)return;
  const key=`${user.uid}:${studyDate()}:${data.profile?.studyRevision||0}`;
  if(!force&&key===cacheKey&&cached){paint(cached);return;}
  if(pending)return;
  pending=true;const token=epoch;
  for(const node of document.querySelectorAll('[data-report-refresh]'))node.disabled=true;
  try {
    const report=await studyCall('getDailyReport');
    if(token!==epoch||getAuthUser()?.uid!==user.uid)return;
    cached=report;cacheKey=key;paint(report);
  }catch(error){if(token===epoch)for(const node of document.querySelectorAll('[data-daily-report]')){node.replaceChildren(el('p','auth-status is-error',serviceError(error)));}}
  finally{pending=false;for(const node of document.querySelectorAll('[data-report-refresh]'))node.disabled=false;if(token!==epoch)void load();}
}
document.addEventListener('click',event=>{if(event.target.closest('[data-report-refresh]'))void load(true);});
for(const event of ['study:navigated','study:data-changed'])window.addEventListener(event,()=>void load());
window.addEventListener('study:panel-opened',event=>{if(event.detail?.kind==='report')void load();});
window.addEventListener('study:auth-changed',()=>{epoch++;cached=null;cacheKey='';for(const node of document.querySelectorAll('[data-daily-report]'))node.textContent='리포트를 불러오는 중…';void load();});
document.addEventListener('visibilitychange',()=>{if(!document.hidden)void load();});
void authReady.then(()=>load());
