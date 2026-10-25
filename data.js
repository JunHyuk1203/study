import { authReady, getAuthUser } from './auth.js?v=20261022-1';
import {wordLiveSeconds} from './word-time.js?v=20261022-1';
import { readCache, statsRevision } from './client-cache.js?v=20261024-selfhost1';
import { showToast } from './notifications.js?v=20261022-18';
import { cameraController, cameraState, startCamera, stopCamera, openCameraFocus, closeCameraFocus, toggleCameraPause } from './camera.js?v=20261025-1';

const historicalSubjects = { korean: '국어', math: '수학', english: '영어', science: '과학', social: '사회' };
function studySubjects() { return {other:'기타',...Object.fromEntries((state.profile?.subjects || []).map(row => [row.id,row.name]))}; }
const KST = 9 * 3600000;
const dateKey = (now = Date.now()) => new Date(now + KST).toISOString().slice(0, 10);
function monday(date) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() - (value.getUTCDay() + 6) % 7);
  return value.toISOString().slice(0, 10);
}
function time(seconds = 0) {
  const value = Math.max(0, Number(seconds) || 0);
  if (value > 0 && value < 60) return `${Math.floor(value)}초`;
  return `${Math.floor(value / 3600)}시간 ${String(Math.floor(value % 3600 / 60)).padStart(2, '0')}분`;
}
function clock(seconds) {
  const value = Math.max(0, Math.floor(seconds));
  return [Math.floor(value / 3600), Math.floor(value % 3600 / 60), value % 60].map(number => String(number).padStart(2, '0')).join(':');
}
let sdk;
let functionsSdk;
let authServices;
let db;
let call;
let resolveDataReady;
const dataReady = new Promise(resolve => { resolveDataReady = resolve; });
let generation = 0;
let connectedUid = null;
let connectedDay = null;
let profileReady = Promise.resolve();
let subscriptions = [];
let activeUnsubscribe;
let activeId;
const dataRequests = new Map();
let busy = false;
let finishingSession = false;
let cameraSyncBusy = false, cameraLastSync = 0, cameraLastTracking = null, cameraSyncId = null, cameraSyncFailed = false;
let cameraSyncFailures = 0, cameraRetryAt = 0, cameraLastAttemptTracking = null;
let cameraPauseAt = null;
let cameraResumeSequence = null;
let cameraSyncSequence = 0;
let cameraSyncEpoch=0,cameraHandoffDisplay=null;
let cameraTransitions = [], cameraEventCounter = 0;
let cameraLastWordPaused=null;
let sessionClock = null;
let wordClock=null;
let cameraDisplay = null;
// Confirmed server credit plus a lease-bounded, monotonic local estimate.
function updateCameraDisplay() {
  if (!cameraDisplay && (!state.active?.cameraMode || state.active.controllerId !== cameraController)) return;
  const localMs = performance.now();
  if (cameraDisplay) {
    if (cameraDisplay.running) cameraDisplay.totalMs += Math.max(0, Math.min(localMs, cameraDisplay.untilMs) - cameraDisplay.localMs);
    cameraDisplay.localMs = localMs;
  }
  const session = state.active;
  if (!session?.cameraMode || session.controllerId !== cameraController) {cameraDisplay=null;return;}
  const now = sessionNow();
  const confirmedMs = (session.accumulatedSeconds || 0)*1000;
  if (!cameraDisplay || cameraDisplay.session !== session) {
    const provisionalMs = session.activeSinceMs != null ? Math.max(0, Math.min(now, session.leaseUntilMs) - session.activeSinceMs) : 0;
    cameraDisplay = {session, confirmedMs, provisionalMs, totalMs:confirmedMs + provisionalMs, localMs};
  }
  cameraDisplay.provisionalMs = Math.max(0, cameraDisplay.totalMs-cameraDisplay.confirmedMs);
  const camera = cameraState();
  cameraDisplay.running = session.activeSinceMs != null && camera.tracking && !camera.manuallyPaused && !cameraPageHidden() && !cameraSyncFailed && cameraResumeSequence == null && !wordAppInUse();
  cameraDisplay.untilMs = localMs + Math.max(0, (session.leaseUntilMs || 0) - now);
}
// Session timestamps come from the server; the device clock may be seconds ahead.
function stopReplacedCamera(previousId,nextId) {
  if(previousId && previousId!==nextId && state.active && !state.active.activityMode && !finishingSession)leaveEndedStudy();
}
function leaveEndedStudy() {
  resetCameraSync();cameraHandoffDisplay=null;observeSession(null);
  stopCamera('학습 세션이 종료되었습니다.');
  void closeCameraFocus().then(()=>{
    if(!/study\.html$/.test(window.location?.pathname||''))return;
    const home=document.querySelector?.('a[href="index.html"]');
    if(home?.click)home.click();else window.location?.assign?.('index.html');
  });
}
function resetCameraSync() {
  cameraSyncEpoch++;cameraSyncBusy=false;cameraSyncId=null;cameraSyncSequence=0;
  cameraLastSync=0;cameraLastTracking=null;cameraSyncFailed=false;cameraSyncFailures=0;
  cameraRetryAt=0;cameraLastAttemptTracking=null;cameraPauseAt=null;cameraResumeSequence=null;
  cameraLastWordPaused=null;
  cameraTransitions=[];
}
function observeActiveSnapshot(session,sessionId,watchGeneration=generation) {
  if(watchGeneration!==generation||activeId!==sessionId||state.profile?.activeSessionId!==sessionId)return;
  observeSession(session?{...session,id:sessionId}:null);
  paintTimer();
  void syncCamera();
}
function observeSession(session) {
  // Callable acknowledgements can arrive before an older listener snapshot.
  if (session?.cameraMode && state.active?.cameraMode && (session.id==null||state.active.id==null||session.id===state.active.id) && session.status!=='finished' && session.controllerId === state.active.controllerId && session.sequence <= state.active.sequence) return;
  updateCameraDisplay();
  const serverMs = (session?.updatedAt || session?.createdAt || session?.startedAt)?.toMillis?.();
  sessionClock = Number.isFinite(serverMs) ? {serverMs, localMs:performance.now()} : null;
  if (!session) {cameraPauseAt=null;cameraResumeSequence=null;}
  if (cameraResumeSequence != null && session?.sequence >= cameraResumeSequence && session.activeSinceMs != null) {
    cameraResumeSequence=null;cameraPauseAt=null;
  }
  state.active = session;
  updateCameraDisplay();
}
function sessionNow() {
  return sessionClock ? sessionClock.serverMs + Math.max(0, performance.now() - sessionClock.localMs) : Date.now();
}
function observeCameraReply(reply, sessionId) {
  if (!reply?.session || state.profile?.activeSessionId !== sessionId) return;
  const { serverNowMs, startedAtMs, ...session } = reply.session;
  observeSession({ ...state.active, ...session,id:sessionId,
    ...(startedAtMs != null ? { startedAt: { toMillis: () => startedAtMs } } : {}),
    updatedAt: { toMillis: () => serverNowMs } });
}
let previewSession = null;
let authResolved = false;
export function getStudyData() {
  const today = dateKey(), sunday = new Date(`${today}T00:00:00Z`);
  sunday.setUTCDate(sunday.getUTCDate() - sunday.getUTCDay());
  const start = sunday.toISOString().slice(0,10), week = {totalSeconds:0,subjectSeconds:{}};
  for (const row of state.days) if (row.date >= start && row.date <= today) {
    week.totalSeconds += row.totalSeconds || 0;
    for (const [id,seconds] of Object.entries(row.subjectSeconds || {})) week.subjectSeconds[id] = (week.subjectSeconds[id] || 0) + seconds;
  }
  const word=state.profile?.wordSnapshot;
  if(word){
    const saved=state.days.find(row=>row.date===today)||{},now=wordClock?wordClock.serverMs+Math.max(0,performance.now()-wordClock.localMs):word.serverNowMs;
    const pending=wordLiveSeconds(saved,word,'day',today,now);
    week.totalSeconds+=pending;week.subjectSeconds[word.subjectId]=(week.subjectSeconds[word.subjectId]||0)+pending;
  }
  return {profile:state.profile, ready:authResolved && !state.pending.has('profile'), user:getAuthUser(), stats:{day:liveStats('today'),week,month:liveStats('month')}, loading:new Set(state.pending), failed:new Set(state.failed)};
}
function updatePreviewTimer() {
  if (!previewSession) return;
  const active = cameraState().tracking && !cameraState().manuallyPaused && !document.hidden;
  if (active && previewSession.activeSince == null) previewSession.activeSince = performance.now();
  if (!active && previewSession.activeSince != null) {
    previewSession.totalMs += Math.max(0, performance.now() - previewSession.activeSince);
    previewSession.activeSince = null;
  }
}
let state = emptyState();

function emptyState() {
  return { profile: null, today: {}, week: {}, month: {}, summary: {}, focusTime: {}, lastWeek: {}, days: [], ranking: [], schoolRanking: [], ownRanking: null, active: null, notice: '', error: false, pending:new Set(['profile','today','week','month','summary','focusTime','lastWeek','days','ranking','ownRanking']), failed:new Set() };
}
function notice(text, error = false, transient = !error) {
  state.notice = transient ? '' : text;state.noticePath = window.location?.pathname;state.error = error;
  if (transient && text) showToast(text);
  paint();
}
function errorText(error) {
  const messages = {
    'functions/unauthenticated': '다시 로그인해 주세요.',
    'functions/failed-precondition': '계정 화면에서 이메일 인증을 완료한 뒤 돌아와 주세요.',
    'functions/already-exists': '진행 중인 학습 기록이 있습니다. 먼저 종료해 주세요.',
    'functions/not-found': '학습 기록을 찾지 못했습니다. 새로고침해 주세요.',
    'functions/unavailable': '자체 서버에 연결하지 못했습니다. 서버 프로그램 실행 상태를 확인해 주세요.',
    'functions/internal': '저장 서비스 응답을 받지 못했습니다. 기록 상태를 확인하고 다시 시도해 주세요.',
    'permission-denied': '기록을 읽을 권한이 없습니다. 다시 로그인해 주세요.',
  };
  return messages[error?.code] || '데이터를 불러오거나 저장하지 못했습니다. 인터넷 연결을 확인해 주세요.';
}
function textAll(selector, value) { for (const element of document.querySelectorAll(selector)) element.textContent = value; }

function paintRanking(container, rows, school = false) {
  container.replaceChildren();
  const key = school ? 'schoolRanking' : 'ranking';
  if (!authResolved || getAuthUser() && (state.pending.has(key) || school && state.pending.has('profile'))) {
    container.textContent = '로딩 중…'; return;
  }
  if (state.failed.has(key)) { container.textContent = '랭킹을 불러오지 못했습니다. 새로고침해 주세요.'; return; }
  if (!getAuthUser() || !rows.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-data';
    empty.textContent = !getAuthUser() ? '로그인하면 랭킹을 볼 수 있습니다.' : school && !state.profile?.schoolId ? '학교 소속을 등록한 뒤 확인할 수 있습니다.' : '이번 주에 저장된 공부 기록이 없습니다.';
    container.append(empty);
    return;
  }
  rows.forEach((row, index) => {
    const item = document.createElement('div');
    item.className = `ranking-row${row.uid === connectedUid ? ' me' : ''}`;
    for (const [className, value] of [['rank', String(index + 1)], ['avatar-small sage', (row.displayName || '회').slice(0, 1)], ['ranking-name', row.displayName || '회원'], ['time', time(row.totalSeconds)]]) {
      const span = document.createElement('span');
      span.className = className;
      span.textContent = value;
      item.append(span);
    }
    container.append(item);
  });
}

function subjectPeriod() {
  const selected = document.querySelector('[data-subject-period]')?.value;
  return ['today', 'week', 'month'].includes(selected) ? selected : 'week';
}

document.addEventListener('change', event => {
  if (!event.target.matches?.('[data-subject-period]')) return;
  paint();
  void loadVisibleData();
});

function liveStats(key) {
  const stats=state[key],word=state.profile?.wordSnapshot;
  if(!word || !['today','week','month'].includes(key))return stats;
  const today=dateKey(),period=key==='today'?'day':key,periodKey=key==='week'?monday(today):key==='month'?today.slice(0,7):today;
  const now=wordClock?wordClock.serverMs+Math.max(0,performance.now()-wordClock.localMs):word.serverNowMs;
  const pending=wordLiveSeconds(stats,word,period,periodKey,now);
  return {...stats,totalSeconds:(stats.totalSeconds||0)+pending,subjectSeconds:{...stats.subjectSeconds,[word.subjectId]:(stats.subjectSeconds?.[word.subjectId]||0)+pending}};
}
function paintChart(container) {
  const isSubjects = container.dataset.chart === 'subjects';
  const key = isSubjects ? subjectPeriod() : 'days';
  const details = isSubjects ? document.querySelector('[data-subject-times]') : null;
  if (isSubjects) {
    const periodLabel = {today:'오늘', week:'이번 주', month:'이번 달'}[key];
    textAll('[data-subject-period-label]', periodLabel);
    container.setAttribute('aria-label', `${periodLabel} 과목별 학습 시간`);
    details?.replaceChildren();
  }
  if (!authResolved || getAuthUser() && state.pending.has(key)) { container.textContent = '로딩 중…'; return; }
  if (!getAuthUser()) { container.textContent = '로그인하면 공부 기록을 볼 수 있습니다.'; return; }
  if (state.failed.has(key)) { container.textContent = '기록을 불러오지 못했습니다.'; return; }
  const subjectSeconds = isSubjects ? liveStats(key).subjectSeconds || {} : {};
  const labels = {...Object.fromEntries(Object.keys(subjectSeconds).map(id => [id, historicalSubjects[id] || '삭제된 과목'])),...studySubjects()};
  const rows = isSubjects ? Object.entries(labels).map(([id, label]) => ({ label, seconds: subjectSeconds[id] || 0 })) : Array.from({ length: 7 }, (_, index) => {
    const key = dateKey(Date.now() - (6 - index) * 86400000);
    const record = state.days.find(row => row.date === key);
    return { label: ['일', '월', '화', '수', '목', '금', '토'][new Date(`${key}T00:00:00Z`).getUTCDay()], seconds: record?.totalSeconds || 0 };
  });
  const maximum = Math.max(...rows.map(row => row.seconds), 1);
  container.replaceChildren();
  rows.forEach((row, index) => {
    const column = document.createElement('div');
    if ((isSubjects && row.seconds === maximum) || (!isSubjects && index === 6)) column.className = 'today';
    const bar = document.createElement('i');
    bar.style.setProperty('--bar', `${row.seconds / maximum * 80}%`);
    if (!row.seconds) bar.className = 'empty-bar';
    column.title = `${row.label}: ${time(row.seconds)}`;
    const label = document.createElement('span');
    label.textContent = row.label;
    column.append(bar, label);
    container.append(column);
    if (details) {
      const item = document.createElement('div');
      const name = document.createElement('dt');
      name.textContent = row.label;
      const duration = document.createElement('dd');
      duration.textContent = `${Math.floor(row.seconds / 3600)}시간 ${String(Math.floor(row.seconds % 3600 / 60)).padStart(2, '0')}분`;
      if (row.seconds > 0 && row.seconds < 60) duration.textContent += ' (1분 미만)';
      item.append(name, duration);
      details.append(item);
    }
  });
}

function paint() {
  const user = getAuthUser();
  const value = (key, result) => !authResolved || user && state.pending.has(key) ? '로딩 중…' : !user ? '로그인 필요' : state.failed.has(key) ? '불러오기 실패' : result;
  for (const key of ['today', 'week', 'month', 'summary']) textAll(`[data-time="${key}"]`, value(key, time(liveStats(key).totalSeconds)));
  textAll('[data-streak]', value('summary', `${state.summary.currentStreak || 0}일`));
  textAll('[data-focus-balance]', value('focusTime', clock(state.focusTime?.balanceSeconds ?? 0)));
  const rank = state.ranking.findIndex(row => row.uid === user?.uid);
  textAll('[data-my-rank]', value('ownRanking', value('ranking', rank >= 0 ? `${rank + 1}위` : state.ownRanking?.totalSeconds ? '50위 밖' : '—')));
  textAll('[data-data-badge]', value('today', '실시간 기록'));
  const previous = state.lastWeek.totalSeconds || 0;
  textAll('[data-week-comparison]', value('week', value('lastWeek', previous ? `지난주 대비 ${Math.round(((state.week.totalSeconds || 0) - previous) / previous * 100)}%` : '지난주 기록 없음')));
  textAll('[data-school-name]', value('profile', state.profile?.school?.name || '등록된 학교 없음'));
  textAll('[data-account-school]', value('profile', state.profile?.school?.name || '미등록'));
  textAll('[data-account-classroom]', value('profile', state.profile?.school ? `${state.profile.school.grade}학년 ${state.profile.school.className}반` : '미등록'));
  for (const element of document.querySelectorAll('[data-ranking]')) paintRanking(element, element.dataset.ranking === 'school' ? state.schoolRanking : state.ranking, element.dataset.ranking === 'school');
  for (const element of document.querySelectorAll('[data-chart]')) paintChart(element);
  for (const element of document.querySelectorAll('[data-sync-status]')) {
    const pageNotice = state.noticePath === window.location?.pathname ? state.notice : '';
    element.textContent = pageNotice || (!user ? '기록을 저장하려면 로그인해 주세요.' : '');
    element.hidden = !element.textContent;
    element.classList.toggle('is-error', Boolean(pageNotice && state.error));
  }
  for (const form of document.querySelectorAll('[data-profile-form]')) {
    form.hidden = !user;
    const input = form.elements.displayName;
    if (input && document.activeElement !== input) input.value = state.profile?.displayName || user?.displayName || '';
  }
  paintTimer();
  openLinkedSettings();
  window.dispatchEvent(new Event('study:data-changed'));
}

function wordAppInUse() {
  return Boolean(state.active?.cameraMode && state.profile?.wordCameraSessionId===state.profile?.activeSessionId && state.profile?.wordPresenceUntilMs>sessionNow());
}
function cameraPageHidden(){return document.hidden;}
function cameraTimerMessage(camera) {
  if (finishingSession) return '서버에 저장 중…';
  if(camera.enabled&&camera.identityPhase==='enrolling'&&!camera.manuallyPaused)return '얼굴 등록 중…';
  if (wordAppInUse()) return 'SP word 사용 중 · 얼굴인식 학습시간 일시정지';
  if (camera.manuallyPaused) return '사용자가 수동으로 일시정지했습니다 · 재개 버튼을 눌러 주세요';
  if (cameraSyncFailed) return '서버 연결을 확인하는 중 · 학습 시간 적립 일시정지';
  if (camera.status === 'error') return camera.message || '카메라 인식 오류 · 종료 후 다시 시작해 주세요';
  if (cameraPageHidden()) return '화면을 벗어나 일시정지했습니다 · 돌아오면 얼굴을 다시 확인합니다';
  if (camera.status === 'opening') return '최초 얼굴 인식을 준비하는 중 · 카메라 연결 확인';
  if (camera.status === 'scanning' && !camera.tracking) return camera.message || '최초 얼굴 인식을 준비하는 중 · 카메라를 바라봐 주세요';
  if (camera.status === 'paused') return camera.message || '얼굴 인식에 실패했습니다 · 얼굴이 인식되면 자동 재개';
  if (!camera.enabled) return '카메라가 종료되어 일시정지했습니다 · 얼굴 인식을 다시 시작해 주세요';
  return '얼굴 인식 완료 · 학습 시작을 서버와 동기화하는 중';
}

function cameraTimerPending(camera) {
  if(camera.enabled&&camera.identityPhase==='enrolling'&&!camera.manuallyPaused)return true;
  return finishingSession || !wordAppInUse() && !camera.manuallyPaused && !cameraSyncFailed && camera.status !== 'error' && !cameraPageHidden() &&
    (['opening', 'scanning'].includes(camera.status) || camera.enabled && camera.status === 'tracking');
}

function paintTimer() {
  updateCameraDisplay();
  const started = state.active?.startedAt?.toMillis?.();
  const session = state.active;
  const camera = cameraState();
  const isCamera = session?.cameraMode || session?.activityMode;
  const now = isCamera ? sessionNow() : Date.now();
  const expired = isCamera && (session.activeSinceMs == null || now >= session.leaseUntilMs);
  const locallyPaused = session?.cameraMode && (wordAppInUse() || session.controllerId === cameraController && (!camera.tracking || camera.manuallyPaused || cameraPageHidden() || cameraSyncFailed || cameraResumeSequence != null));
  const running = isCamera && !expired && !locallyPaused;
  const pausedAt = cameraPauseAt == null ? now : now - Math.max(0, performance.now() - cameraPauseAt);
  const windowEnd = Math.min(now, session?.leaseUntilMs || 0, locallyPaused ? pausedAt : Infinity);
  const elapsed = previewSession ? (previewSession.totalMs + (previewSession.activeSince != null ? performance.now() - previewSession.activeSince : 0)) / 1000 : cameraDisplay ? cameraDisplay.totalMs / 1000 : isCamera ? (session.accumulatedSeconds || 0) + (session.activeSinceMs != null ? Math.max(0, (windowEnd - session.activeSinceMs) / 1000) : 0) : started ? Math.min(43200, Math.max(0, (Date.now() - started) / 1000)) : 0;
  textAll('[data-active-timer]', clock(elapsed));
  for (const button of document.querySelectorAll('[data-camera-pause]')) {
    button.disabled = busy || !camera.enabled || ['opening', 'error', 'off'].includes(camera.status);
    button.setAttribute('aria-pressed', String(camera.manuallyPaused));
    button.setAttribute('aria-label', camera.manuallyPaused ? '학습 재개' : '학습 수동 일시정지');
    button.title = camera.manuallyPaused ? '학습 재개' : '학습 수동 일시정지';
  }
  for (const button of document.querySelectorAll('[data-study-action]')) button.disabled = busy || (button.dataset.studyAction === 'start' ? Boolean(state.profile?.activeSessionId || previewSession || camera.enabled) : !(state.profile?.activeSessionId || previewSession || camera.enabled));
  // The focus window must remain dismissible even after camera startup fails.
  if (!busy || camera.status === 'opening' && !state.profile?.activeSessionId) for (const button of document.querySelectorAll('.camera-focus [data-study-action="stop"]')) button.disabled = false;
  for (const button of document.querySelectorAll('[data-existing-session]')) button.hidden = !state.profile?.activeSessionId;
  for (const selector of document.querySelectorAll('[data-study-subject]')) {
    const choices = Object.fromEntries(Object.entries(studySubjects()).filter(([,name])=>name!=='영단어')), signature = JSON.stringify(choices);
    if (selector.dataset?.subjects !== signature) {
      const previous = selector.value;
      selector.replaceChildren(...Object.entries(choices).map(([id,name]) => {const option = document.createElement('option');option.value=id;option.textContent=name;return option;}));
      selector.value = Object.hasOwn(choices,previous) ? previous : 'other';
      if (selector.dataset) selector.dataset.subjects = signature;
    }
    selector.disabled = busy || Boolean(state.profile?.activeSessionId || previewSession || camera.enabled);
    if (state.active?.subjectId && Object.hasOwn(choices,state.active.subjectId)) selector.value = state.active.subjectId;
  }
  textAll('[data-timer-state]', state.profile?.activeSessionId ? isCamera ? running ? '스터디캠 학습 중 · 자동 저장' : cameraTimerMessage(camera) : '학습 중 · 종료 시 자동 저장' : camera.enabled || camera.status === 'error' ? cameraTimerMessage(camera) : '학습 시작 대기');
  if (session?.activityMode) textAll('[data-timer-state]', running ? '단어앱에서 영단어 학습 중' : '단어앱 영단어 학습 일시정지');
  if (previewSession) textAll('[data-timer-state]', camera.tracking ? '체험 학습 중 · 계정 기록 저장 안 됨' : cameraTimerMessage(camera));
  if (camera.manuallyPaused&&!session?.activityMode) textAll('[data-timer-state]', cameraTimerMessage(camera));
  if (finishingSession) textAll('[data-timer-state]', '서버에 저장 중…');
  if(cameraHandoffDisplay){
    for(const button of document.querySelectorAll('.camera-focus [data-study-action="stop"]')){button.disabled=false;button.textContent='닫기';}
    textAll('.camera-focus [data-active-timer]',clock(cameraHandoffDisplay.seconds));
    textAll('.camera-focus [data-timer-state]','얼굴인식 종료 완료 · 단어앱으로 전환');
  }
  const pending = !cameraHandoffDisplay&&!session?.activityMode&&cameraTimerPending(camera) && !running;
  for (const panel of document.querySelectorAll('.timer-panel')) {
    panel.classList.toggle('camera-pending', pending);
    panel.classList.toggle('camera-paused', !pending && Boolean(previewSession ? !camera.tracking : isCamera && !running));
  }
}

async function syncCamera(force = false, wordChanged = false) {
  const session = state.active;
  if (!session || session.activityMode || session.controllerId !== cameraController || !call || busy) return;
  if(session.cameraMode&&!cameraState().enabled)return;
  const sessionId = state.profile?.activeSessionId;
  if (!sessionId) return;
  if (cameraSyncId !== sessionId) { cameraSyncId = sessionId; cameraSyncSequence = 0; cameraLastSync = 0; cameraLastTracking = null; cameraSyncFailed = false;cameraSyncFailures=0;cameraRetryAt=0;cameraLastAttemptTracking=null;cameraTransitions=[]; }
  const wordPaused=wordAppInUse();
  wordChanged ||= wordPaused!==cameraLastWordPaused;
  const desired = !session.cameraMode || cameraState().tracking && !cameraState().manuallyPaused && !cameraPageHidden();
  const tail=cameraTransitions.at(-1);
  if (tail ? tail.tracking!==desired || tail.wordPaused!==wordPaused : desired!==cameraLastTracking || wordChanged) {
    cameraTransitions.push({sessionId,controllerId:cameraController,clientEpoch:cameraSyncEpoch,eventId:`${cameraSyncEpoch}:${++cameraEventCounter}`,tracking:desired,wordPaused});
  }
  if (cameraSyncBusy) return;
  if (cameraSyncFailed && Date.now() < cameraRetryAt) return;
  // Status/pose changes with the same presence must not trigger extra writes.
  if (!cameraTransitions.length && !wordChanged && desired === cameraLastTracking && !cameraSyncFailed && cameraResumeSequence == null && Date.now() - cameraLastSync < 5000) return;
  if(!cameraTransitions.length)cameraTransitions.push({sessionId,controllerId:cameraController,clientEpoch:cameraSyncEpoch,eventId:`${cameraSyncEpoch}:${++cameraEventCounter}`,tracking:desired,wordPaused});
  const transition=cameraTransitions[0],tracking=transition.tracking;
  cameraSyncBusy = true;
  const requestEpoch=cameraSyncEpoch;
  cameraLastAttemptTracking=tracking;
  // Detection can change before Firestore delivers the previous sync.
  const sequence = transition.sequence ??= Math.max(cameraSyncSequence, session.sequence || 0) + 1;
  cameraSyncSequence=Math.max(cameraSyncSequence,sequence);
  try {
    const result = await call(session.cameraMode?'syncStudyCamera':'heartbeatStudySession')({ ...transition, sequence, contractVersion:'2026-10-24' });
    if(requestEpoch!==cameraSyncEpoch||state.profile?.activeSessionId!==sessionId)return;
    observeCameraReply(result?.data, sessionId);
    if(result?.data?.session?.canResume===false){await call('finishStudySession')({sessionId});if(requestEpoch===cameraSyncEpoch)leaveEndedStudy();return;}
    if(result?.data?.roomActivity)window.dispatchEvent(new CustomEvent('study:room-activity',{detail:result.data.roomActivity}));
    if(result?.data?.ignored && result?.data?.session?.lastEventId!==transition.eventId) {
      // Word ownership changes also advance the server sequence. Keep the boundary.
      transition.sequence=Math.max(sequence,state.active?.sequence||0)+1;
      if((transition.rejections=(transition.rejections||0)+1)>1){cameraSyncFailed=true;cameraRetryAt=Date.now()+5000;}
    } else {
      cameraTransitions.shift();
      cameraLastTracking = tracking;
      cameraLastWordPaused = transition.wordPaused;
    }
    if(!cameraSyncFailed || !result?.data?.ignored){cameraSyncFailed = false;cameraSyncFailures=0;cameraRetryAt=0;}
  } catch (error) {
    if(requestEpoch!==cameraSyncEpoch||state.profile?.activeSessionId!==sessionId)return;
    if(error?.code==='functions/failed-precondition'||error?.code==='functions/not-found'){leaveEndedStudy();return;}
    cameraSyncFailed = true; cameraPauseAt ??= performance.now();
    cameraRetryAt=Date.now()+Math.min(60000,5000*2**Math.min(cameraSyncFailures++,4));
  }
  finally {
    if(requestEpoch!==cameraSyncEpoch)return;
    cameraLastSync = Date.now(); cameraSyncBusy = false; paintTimer();
    const currentTracking = !session.cameraMode || cameraState().tracking && !cameraState().manuallyPaused && !cameraPageHidden();
    if (!cameraSyncFailed && (cameraTransitions.length || tracking !== currentTracking || wordPaused!==wordAppInUse() || cameraResumeSequence != null && cameraSyncSequence < cameraResumeSequence)) void syncCamera(true);
  }
}

function watch(reference, callback, token, key, onError = () => {}) {
  const unsubscribe = sdk.onSnapshot(reference, snapshot => {
    if (token !== generation) return;
    callback(snapshot);
    state.pending.delete(key);
    state.failed.delete(key);
    paint();
  }, error => { if (token === generation) { onError(error); state.pending.delete(key); state.failed.add(key); notice(errorText(error), true); } });
  subscriptions.push(unsubscribe);
}

function visibleDataKeys() {
  const keys = new Set();
  for (const element of document.querySelectorAll('[data-time]')) keys.add(element.dataset.time);
  if (document.querySelector('[data-streak]')) keys.add('summary');
  if (document.querySelector('[data-focus-balance]')) keys.add('focusTime');
  if (document.querySelector('[data-week-goal], [data-week-progress], [data-week-remaining], [data-week-comparison]')) keys.add('week');
  if (document.querySelector('[data-week-comparison]')) keys.add('lastWeek');
  if (document.querySelector('[data-chart="days"]')) keys.add('days');
  if (document.querySelector('[data-chart="subjects"]')) keys.add(subjectPeriod());
  if (document.querySelector('[data-goal-summary], [data-goal-list]')) for (const key of ['today','days','month']) keys.add(key);
  if (document.querySelector('[data-ranking="global"], [data-my-rank]')) keys.add('ranking');
  if (document.querySelector('[data-my-rank]')) keys.add('ownRanking');
  if (document.querySelector('[data-ranking="school"]') && state.profile?.schoolId) keys.add('schoolRanking');
  return keys;
}

async function loadVisibleData() {
  if (!sdk || !connectedUid || state.pending.has('profile') || document.hidden) return;
  const token = generation, uid = connectedUid, today = dateKey(), week = monday(today);
  const currentSchoolId=state.profile?.schoolId || '';
  const paths = {today:['dailyStats',today],week:['weeklyStats',week],month:['monthlyStats',today.slice(0,7)],summary:['stats','summary'],focusTime:['stats','focusTime'],lastWeek:['weeklyStats',monday(dateKey(Date.now()-7*86400000))]};
  const keys=visibleDataKeys();
  const apply=(key,result)=>{
    state[key]=result;state.pending.delete(key);state.failed.delete(key);
    if(key==='days'&&keys.has('today')){
      state.today=result.find(row=>row.date===today)||{};state.pending.delete('today');state.failed.delete('today');
    }
  };
  await Promise.all([...keys].filter(key=>key!=='today'||!keys.has('days')).map(async key => {
    const keyRevision=statsRevision(state.profile,key);
    const cacheKey = `${uid}:stats:v2:${today}:${keyRevision}:${currentSchoolId}:${key}`;
    const cached = readCache.get(cacheKey);
    if (cached !== undefined) {apply(key,cached);return;}
    if (dataRequests.has(cacheKey)) return;
    const request = (async () => {
      try {
        let result;
        if (paths[key]) result = (await sdk.getDoc(sdk.doc(db,'users',uid,...paths[key]))).data() || {};
        else if (key === 'ownRanking') result = (await sdk.getDoc(sdk.doc(db,'leaderboards',week,'entries',uid))).data() || null;
        else if (key === 'days') {
          const rows = await sdk.getDocs(sdk.query(sdk.collection(db,'users',uid,'dailyStats'),sdk.orderBy(sdk.documentId()),sdk.startAt(dateKey(Date.now()-6*86400000)),sdk.endAt(today),sdk.limit(7)));
          result = rows.docs.map(row => ({...row.data(),date:row.id}));
        } else {
          const path = key === 'schoolRanking' ? ['schoolLeaderboards',state.profile.schoolId,'weeks',week,'entries'] : ['leaderboards',week,'entries'];
          const rows = await sdk.getDocs(sdk.query(sdk.collection(db,...path),sdk.orderBy('totalSeconds','desc'),sdk.orderBy('uid'),sdk.limit(50)));
          result = rows.docs.map(row => row.data());
        }
        if (token !== generation || keyRevision !== statsRevision(state.profile,key) || currentSchoolId !== (state.profile?.schoolId || '')) return;
        readCache.set(cacheKey,result,key.includes('Ranking') || key === 'ranking' ? 5*60000 : 15*60000);
        apply(key,result);
      } catch (error) {
        if (token === generation) {state.pending.delete(key);state.failed.add(key);notice(errorText(error),true);}
      } finally {dataRequests.delete(cacheKey);}
    })();
    dataRequests.set(cacheKey,request);
    await request;
  }));
  if (token === generation) paint();
}

async function connectUser() {
  if (!sdk) return;
  const user = getAuthUser();
  const today = dateKey();
  if (user?.uid === connectedUid && today === connectedDay) { paint(); return; }
  const token = ++generation;
  for (const stop of subscriptions) stop();
  subscriptions = [];
  activeUnsubscribe?.();
  activeId = undefined;
  state = emptyState();
  authResolved = true;
  if (!user) state.pending.clear();
  connectedUid = user?.uid || null;
  connectedDay = today;
  paint();
  if (!user) return;
  const uid = user.uid;
  let resolveProfile, rejectProfile, creatingProfile = false;
  profileReady = new Promise((resolve,reject) => {resolveProfile=resolve;rejectProfile=reject;});
  // Attach the rejection handler before an asynchronous listener can fail.
  void profileReady.catch(() => {});
  watch(sdk.doc(db, 'users', uid), snapshot => {
    const previousSessionId = state.profile?.activeSessionId;
    const previousRevision = state.profile?.studyRevision || 0;
    const previousSchoolId = state.profile?.schoolId;
    const previousWordPresence = state.profile?.wordPresenceUntilMs;
    const previousWordClock=state.profile?.wordSnapshot?.serverNowMs;
    const profile = snapshot.data() || null;
    if (profile && (profile.studyRevision || 0) < previousRevision) return;
    state.profile = profile;
    if(previousWordClock!==profile?.wordSnapshot?.serverNowMs)wordClock=profile?.wordSnapshot?{serverMs:profile.wordSnapshot.serverNowMs,localMs:performance.now()}:null;
  if(Boolean(previousWordPresence>Date.now())!==Boolean(profile?.wordPresenceUntilMs>Date.now()))queueMicrotask(()=>{if(token===generation)void syncCamera();});
    if (state.profile) resolveProfile();
    else if (!creatingProfile) {
      creatingProfile=true;
      const displayName=(user.displayName || '회원').replace(/[\p{Cc}\p{Cf}]/gu,'').trim().slice(0,20);
      void call('ensureProfile')({displayName:displayName.length>=2?displayName:'회원'}).then(resolveProfile,rejectProfile);
    }
    const newActive = state.profile?.activeSessionId || null;
    stopReplacedCamera(previousSessionId,newActive);
    if (newActive !== activeId) {
      resetCameraSync();
      activeUnsubscribe?.();
      activeId = newActive;
      if (newActive !== previousSessionId) observeSession(null);
      // This tab receives authoritative camera state in callable replies; only
      // another tab's active session needs a realtime session listener.
      if (newActive && state.active?.controllerId !== cameraController) activeUnsubscribe = sdk.onSnapshot(sdk.doc(db, 'users', uid, 'sessions', newActive), record => {
        observeActiveSnapshot(record.data()||null,newActive,token);
      }, error => { if (token === generation) notice(errorText(error), true); });
    }
    if (previousRevision !== (state.profile?.studyRevision || 0)) for (const key of visibleDataKeys()) state.pending.add(key);
    if (previousSchoolId !== state.profile?.schoolId) {
      state.schoolRanking=[];state.failed.delete('schoolRanking');
      if(state.profile?.schoolId)state.pending.add('schoolRanking');else state.pending.delete('schoolRanking');
    }
    // The watch wrapper marks profile ready after this callback.
    queueMicrotask(() => { if (token === generation) void loadVisibleData(); });
  }, token, 'profile', rejectProfile);
  try { await profileReady; } catch (error) { if (token === generation) notice(errorText(error), true); }
}

document.addEventListener('click', async event => {
  const pauseButton = event.target.closest('[data-camera-pause]');
  if (pauseButton) {
    if (!pauseButton.disabled && !busy) toggleCameraPause();
    return;
  }
  const button = event.target.closest('[data-study-action]');
  if(button?.dataset.studyAction==='stop'&&cameraHandoffDisplay&&button.closest?.('.camera-focus')){
    cameraHandoffDisplay=null;await closeCameraFocus();paintTimer();return;
  }
  if (button?.dataset.studyAction === 'stop' && busy && cameraState().status === 'opening' && !state.profile?.activeSessionId) {
    stopCamera(); previewSession = null; busy = false; await closeCameraFocus(); paintTimer(); return;
  }
  if (!button || button.disabled || busy) return;
  const starting = button.dataset.studyAction === 'start';
  const cameraStart = starting && button.hasAttribute('data-camera-toggle');
  if (!starting && (previewSession || !state.profile?.activeSessionId)) {
    stopCamera(); previewSession = null; await closeCameraFocus(); paintTimer(); return;
  }
  busy = true;
  paintTimer();
  try {
    if (cameraStart) {
      cameraHandoffDisplay=null;
      openCameraFocus(button);
      if (!await startCamera()) return;
    }
    // A missing user/callable during startup is still loading, not guest mode.
    if (starting && !await authReady) throw { code: 'functions/unavailable' };
    const user = getAuthUser();
    if (cameraStart) {
      if (!user?.emailVerified) {
        previewSession = { totalMs: 0, activeSince: null };
        updatePreviewTimer();
        notice('체험 모드입니다. 로그인과 이메일 인증 후 시작한 학습부터 계정에 저장됩니다.',false,false);
        return;
      }
    }
    if (!user) { window.location.assign('login.html'); return; }
    if (!user.emailVerified) { notice('계정 화면에서 이메일 인증을 완료해 주세요.', true); return; }
    if (!call) await dataReady;
    if (!call) throw { code: 'functions/unavailable' };
    await connectUser();
    await profileReady;
    // Email verification can change before the cached ID token is refreshed.
    await authServices.auth.currentUser.getIdToken(true);
    if (starting) {
      const subjectId = document.querySelector('[data-study-subject]')?.value || 'other';
      const cameraMode = cameraState().enabled;
      const result = await call('startStudySession')({ subjectId, cameraMode, controllerId: cameraController });
      if (result.data?.session) {
        state.profile = { ...state.profile, activeSessionId: result.data.sessionId };
        observeCameraReply(result.data, result.data.sessionId);
        if (cameraMode) {activeUnsubscribe?.();activeUnsubscribe=undefined;}
      }
      notice(cameraMode ? '' : '학습을 시작했습니다. 종료를 누르면 기록이 저장됩니다.');
    } else {
      finishingSession = true;
      notice('서버에 저장 중…',false,false);
      stopCamera('서버에 저장 중…');
      const result = await call('finishStudySession')({ sessionId: state.profile?.activeSessionId });
      finishingSession = false;
      stopCamera();
      if (result.data.studyRevision != null) {
        state.profile={...state.profile,activeSessionId:null,studyRevision:result.data.studyRevision};
        observeSession(null);
        void loadVisibleData();
      }
      notice(`${Math.floor(result.data.creditedSeconds / 60)}분 ${result.data.creditedSeconds % 60}초를 저장했습니다.`);
      await closeCameraFocus();
    }
  } catch (error) {
    if (cameraStart || !starting) stopCamera(errorText(error), true);
    notice(errorText(error), true);
  }
  finally { finishingSession = false; busy = false; paintTimer(); void syncCamera(); }
});

async function closeAccountSettings() {
  const settings = document.querySelector('#account-settings');
  if (!settings?.open || settings.classList.contains('is-closing')) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    settings.close();
    return;
  }
  settings.classList.add('is-closing');
  const animation = settings.animate([
    { transform: 'translateY(0)', opacity: 1 },
    { transform: 'translateY(48px)', opacity: 0 },
  ], { duration: 240, easing: 'cubic-bezier(.4,0,1,1)', fill: 'both' });
  try {
    await animation.finished;
  } catch {
    // Closing still completes if navigation cancels the animation.
  } finally {
    settings.close();
    animation.cancel();
    settings.classList.remove('is-closing');
  }
}
document.addEventListener('cancel', event => {
  if (event.target.id !== 'account-settings') return;
  event.preventDefault();
  void closeAccountSettings();
}, true);
document.addEventListener('click', event => {
  if (event.target.closest('[data-account-settings-close]')) {
    void closeAccountSettings();
    return;
  }
  if (!event.target.closest('[data-account-settings-toggle]')) return;
  const settings = document.querySelector('#account-settings');
  if (!settings || !getAuthUser() || settings.open) return;
  settings.showModal();
});
document.addEventListener('toggle', event => {
  if (event.target.id !== 'account-settings') return;
  document.querySelector('[data-account-settings-toggle]')?.setAttribute('aria-expanded', String(event.target.open));
}, true);
function openLinkedSettings() {
  if (window.location?.hash !== '#account-settings' || !getAuthUser()) return;
  const settings = document.querySelector('#account-settings');
  if (settings && !settings.open && !settings.dataset.linkOpened) {
    settings.dataset.linkOpened = 'true';
    settings.showModal();
  }
}
window.addEventListener('hashchange', openLinkedSettings);
window.addEventListener('study:navigated', openLinkedSettings);
document.addEventListener('DOMContentLoaded', openLinkedSettings);

document.addEventListener('submit', async event => {
  const form = event.target.closest('[data-profile-form]');
  if (!form) return;
  event.preventDefault();
  if (busy || !getAuthUser() || !call || !form.reportValidity()) return;
  busy = true;
  const button = form.querySelector('[type="submit"]');
  button.disabled = true;
  try {
    const displayName = form.elements.displayName.value.trim();
    await profileReady;
    await call('updateAccount')({ displayName });
    if(authServices.auth.currentUser.displayName!==displayName)await authServices.updateProfile(authServices.auth.currentUser, { displayName });
    window.dispatchEvent(new Event('study:navigated'));
    notice('닉네임을 저장했습니다.');
  } catch (error) { notice(errorText(error), true); }
  finally { busy = false; button.disabled = false; }
});

window.addEventListener('study:auth-changed', () => { void connectUser(); });
window.addEventListener('study:navigated', () => {paint();void loadVisibleData();});
window.addEventListener('study:page-prepared', paint);
document.addEventListener('visibilitychange', () => {if (!document.hidden) void loadVisibleData();});
window.addEventListener('study:camera-changed', () => {
  updatePreviewTimer();
  if (state.active?.cameraMode && state.active.controllerId === cameraController) {
    if (!cameraState().tracking || cameraState().manuallyPaused || cameraPageHidden()) {cameraPauseAt ??= performance.now();cameraResumeSequence=null;}
    else if (cameraPauseAt != null && cameraResumeSequence == null) cameraResumeSequence=Math.max(cameraSyncSequence,state.active.sequence || 0)+1;
  }
  paintTimer();void syncCamera(true);
});
let expiryCheckBusy=false,expiryCheckAt=0;
window.setInterval(() => {
  if (connectedDay && connectedDay !== dateKey()) void connectUser();
  paintTimer();
  void syncCamera();
  const wordExpired=state.profile?.wordStudySessionId&&state.profile?.wordAppUntilMs<=Date.now();
  const deadline=state.active?(state.active.presenceUntilMs??state.active.leaseUntilMs??(state.active.startedAt?.toMillis?.()+10000)):null;
  const sessionExpired=deadline!=null&&deadline<=sessionNow();
  if(call&&!expiryCheckBusy&&Date.now()>=expiryCheckAt&&(wordExpired||sessionExpired)){
    expiryCheckBusy=true;expiryCheckAt=Date.now()+5000;
    void call('expireStudySessions')({}).catch(()=>{}).finally(()=>{expiryCheckBusy=false;});
  }
  if(state.profile?.wordSnapshot?.activeSinceMs!=null&&!document.hidden)paint();
}, 1000);

try {
  authServices = await authReady;
  if (!authServices) { authResolved = true; state.pending.clear(); notice('서비스를 불러오지 못했습니다. 새로고침해 주세요.', true); }
  if (authServices) {
    sdk = await import('./server-client.js?v=20261024-selfhost1');
    db = null;
    call = name => sdk.serverCallable(name);
    await connectUser();
  }
} catch (error) { notice(errorText(error), true); }
finally { resolveDataReady(); }
