import { authReady, getAuthUser } from './auth.js?v=20261022-1';
import { firebaseConfig } from './firebase-config.js';
import { cameraController, cameraState, startCamera, stopCamera, openCameraFocus, closeCameraFocus, toggleCameraPause } from './camera.js?v=20261021-26';

const subjects = { korean: '국어', math: '수학', english: '영어', science: '과학', social: '사회', other: '기타' };
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
let generation = 0;
let connectedUid = null;
let connectedDay = null;
let profileReady = Promise.resolve();
let subscriptions = [];
let activeUnsubscribe;
let schoolUnsubscribe;
let activeId;
let schoolId;
let busy = false;
let cameraSyncBusy = false, cameraLastSync = 0, cameraLastTracking = null, cameraSyncId = null, cameraSyncFailed = false;
let cameraPauseAt = null;
let cameraResumeSequence = null;
let sessionClock = null;
// Session timestamps come from the server; the device clock may be seconds ahead.
function observeSession(session) {
  const serverMs = (session?.updatedAt || session?.createdAt || session?.startedAt)?.toMillis?.();
  sessionClock = Number.isFinite(serverMs) ? {serverMs, localMs:performance.now()} : null;
  if (!session) {cameraPauseAt=null;cameraResumeSequence=null;}
  if (cameraResumeSequence != null && session?.sequence >= cameraResumeSequence && session.activeSinceMs != null) {
    cameraResumeSequence=null;cameraPauseAt=null;
  }
  state.active = session;
}
function sessionNow() {
  return sessionClock ? sessionClock.serverMs + Math.max(0, performance.now() - sessionClock.localMs) : Date.now();
}
let previewSession = null;
let authResolved = false;
export function getStudyData() { return {profile:state.profile, ready:authResolved && !state.pending.has('profile'), user:getAuthUser()}; }
function updatePreviewTimer() {
  if (!previewSession) return;
  const active = cameraState().tracking && !document.hidden;
  if (active && previewSession.activeSince == null) previewSession.activeSince = Date.now();
  if (!active && previewSession.activeSince != null) {
    previewSession.totalMs += Math.max(0, Date.now() - previewSession.activeSince);
    previewSession.activeSince = null;
  }
}
let state = emptyState();

function emptyState() {
  return { profile: null, today: {}, week: {}, month: {}, summary: {}, focusTime: {}, lastWeek: {}, days: [], ranking: [], schoolRanking: [], ownRanking: null, active: null, notice: '', error: false, pending:new Set(['profile','today','week','month','summary','focusTime','lastWeek','days','ranking','ownRanking']), failed:new Set() };
}
function notice(text, error = false) { state.notice = text; state.error = error; paint(); }
function errorText(error) {
  const messages = {
    'functions/unauthenticated': '다시 로그인해 주세요.',
    'functions/failed-precondition': '계정 화면에서 이메일 인증을 완료한 뒤 돌아와 주세요.',
    'functions/already-exists': '진행 중인 학습 기록이 있습니다. 먼저 종료해 주세요.',
    'functions/not-found': '학습 기록을 찾지 못했습니다. 새로고침해 주세요.',
    'functions/unavailable': '저장 서비스에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.',
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

function paintChart(container) {
  const isSubjects = container.dataset.chart === 'subjects';
  const key = isSubjects ? 'week' : 'days';
  if (!authResolved || getAuthUser() && state.pending.has(key)) { container.textContent = '로딩 중…'; return; }
  if (!getAuthUser()) { container.textContent = '로그인하면 공부 기록을 볼 수 있습니다.'; return; }
  if (state.failed.has(key)) { container.textContent = '기록을 불러오지 못했습니다.'; return; }
  const rows = isSubjects ? Object.entries(subjects).map(([id, label]) => ({ label, seconds: state.week.subjectSeconds?.[id] || 0 })) : Array.from({ length: 7 }, (_, index) => {
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
  });
}

function paint() {
  const user = getAuthUser();
  const value = (key, result) => !authResolved || user && state.pending.has(key) ? '로딩 중…' : !user ? '로그인 필요' : state.failed.has(key) ? '불러오기 실패' : result;
  for (const key of ['today', 'week', 'month', 'summary']) textAll(`[data-time="${key}"]`, value(key, time(state[key].totalSeconds)));
  textAll('[data-streak]', value('summary', `${state.summary.currentStreak || 0}일`));
  textAll('[data-focus-balance]', value('focusTime', clock(state.focusTime?.balanceSeconds ?? 0)));
  const rank = state.ranking.findIndex(row => row.uid === user?.uid);
  textAll('[data-my-rank]', value('ownRanking', value('ranking', rank >= 0 ? `${rank + 1}위` : state.ownRanking?.totalSeconds ? '50위 밖' : '—')));
  textAll('[data-data-badge]', value('today', '실시간 기록'));
  const goal = state.profile?.weeklyGoalSeconds || 0;
  textAll('[data-week-goal]', value('profile', goal ? `${Math.floor((state.week.totalSeconds || 0) / 3600)} / ${goal/3600}시간` : '미설정'));
  textAll('[data-week-remaining]', value('profile', goal ? `목표까지 ${time(Math.max(0, goal - (state.week.totalSeconds || 0)))}` : '등록된 학습 목표가 없습니다.'));
  for (const bar of document.querySelectorAll('[data-week-progress]')) bar.style.width = `${goal ? Math.min(100, (state.week.totalSeconds || 0) / goal * 100) : 0}%`;
  const previous = state.lastWeek.totalSeconds || 0;
  textAll('[data-week-comparison]', value('week', value('lastWeek', previous ? `지난주 대비 ${Math.round(((state.week.totalSeconds || 0) - previous) / previous * 100)}%` : '지난주 기록 없음')));
  textAll('[data-school-name]', value('profile', state.profile?.school?.name || '등록된 학교 없음'));
  textAll('[data-account-school]', value('profile', state.profile?.school?.name || '미등록'));
  textAll('[data-account-classroom]', value('profile', state.profile?.school ? `${state.profile.school.grade}학년 ${state.profile.school.className}반` : '미등록'));
  for (const element of document.querySelectorAll('[data-ranking]')) paintRanking(element, element.dataset.ranking === 'school' ? state.schoolRanking : state.ranking, element.dataset.ranking === 'school');
  for (const element of document.querySelectorAll('[data-chart]')) paintChart(element);
  for (const element of document.querySelectorAll('[data-sync-status]')) {
    element.textContent = state.notice || (!user ? '기록을 저장하려면 로그인해 주세요.' : '');
    element.hidden = !element.textContent;
    element.classList.toggle('is-error', state.error);
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

function paintTimer() {
  const started = state.active?.startedAt?.toMillis?.();
  const session = state.active;
  const camera = cameraState();
  const isCamera = session?.cameraMode;
  const now = isCamera ? sessionNow() : Date.now();
  const expired = isCamera && (session.activeSinceMs == null || now >= session.leaseUntilMs);
  const locallyPaused = isCamera && session.controllerId === cameraController && (!camera.tracking || cameraSyncFailed || cameraResumeSequence != null);
  const running = isCamera && !expired && !locallyPaused;
  const pausedAt = cameraPauseAt == null ? now : now - Math.max(0, Date.now() - cameraPauseAt);
  const windowEnd = Math.min(now, session?.leaseUntilMs || 0, locallyPaused ? pausedAt : Infinity);
  const elapsed = previewSession ? (previewSession.totalMs + (previewSession.activeSince != null ? Date.now() - previewSession.activeSince : 0)) / 1000 : isCamera ? (session.accumulatedSeconds || 0) + (session.activeSinceMs != null ? Math.max(0, (windowEnd - session.activeSinceMs) / 1000) : 0) : started ? Math.min(43200, Math.max(0, (Date.now() - started) / 1000)) : 0;
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
    selector.disabled = busy || Boolean(state.profile?.activeSessionId || previewSession || camera.enabled);
    if (state.active?.subjectId) selector.value = state.active.subjectId;
  }
  textAll('[data-timer-state]', state.profile?.activeSessionId ? isCamera ? running ? '스터디캠 학습 중 · 자동 저장' : cameraSyncFailed ? '연결 확인 중 · 일시정지' : '스터디캠 일시정지 · 얼굴 인식 시 재개' : '학습 중 · 종료 시 자동 저장' : '학습 시작 대기');
  if (previewSession) textAll('[data-timer-state]', camera.tracking ? '체험 학습 중 · 계정 기록 저장 안 됨' : '얼굴 인식 대기 · 일시정지');
  if (camera.manuallyPaused) textAll('[data-timer-state]', '수동 일시정지 · 재개 버튼을 눌러 주세요');
  for (const panel of document.querySelectorAll('.timer-panel')) panel.classList.toggle('camera-paused', Boolean(previewSession ? !camera.tracking : isCamera && !running));
}

async function syncCamera(force = false) {
  const session = state.active;
  if (!session?.cameraMode || session.controllerId !== cameraController || !call || cameraSyncBusy || busy) return;
  const sessionId = state.profile?.activeSessionId;
  if (cameraSyncId !== sessionId) { cameraSyncId = sessionId; cameraLastSync = 0; cameraLastTracking = null; cameraSyncFailed = false; }
  const tracking = cameraState().tracking && !document.hidden;
  if (!tracking && cameraLastTracking === false && !cameraSyncFailed) return;
  if (!force && tracking === cameraLastTracking && Date.now() - cameraLastSync < 10000) return;
  cameraSyncBusy = true;
  const sequence = (session.sequence || 0) + 1;
  try {
    await call('syncStudyCamera')({ sessionId, controllerId: cameraController, tracking, sequence });
    cameraLastTracking = tracking;
    cameraSyncFailed = false;
  } catch { cameraSyncFailed = true; cameraPauseAt ??= Date.now(); }
  finally {
    cameraLastSync = Date.now(); cameraSyncBusy = false; paintTimer();
    if (tracking !== (cameraState().tracking && !document.hidden)) void syncCamera(true);
  }
}

function watch(reference, callback, token, key) {
  const unsubscribe = sdk.onSnapshot(reference, snapshot => {
    if (token !== generation) return;
    callback(snapshot);
    state.pending.delete(key);
    state.failed.delete(key);
    paint();
  }, error => { if (token === generation) { state.pending.delete(key); state.failed.add(key); notice(errorText(error), true); } });
  subscriptions.push(unsubscribe);
}

async function connectUser() {
  if (!sdk) return;
  const user = getAuthUser();
  const today = dateKey();
  if (user?.uid === connectedUid && today === connectedDay) { paint(); return; }
  const token = ++generation;
  for (const stop of subscriptions) stop();
  subscriptions = [];
  activeUnsubscribe?.(); schoolUnsubscribe?.();
  activeId = schoolId = undefined;
  state = emptyState();
  authResolved = true;
  if (!user) state.pending.clear();
  connectedUid = user?.uid || null;
  connectedDay = today;
  paint();
  if (!user) return;
  const uid = user.uid;
  const week = monday(today);
  const previousWeek = monday(dateKey(Date.now() - 7 * 86400000));
  watch(sdk.doc(db, 'users', uid), snapshot => {
    state.profile = snapshot.data() || null;
    const newActive = state.profile?.activeSessionId || null;
    if (newActive !== activeId) {
      activeUnsubscribe?.();
      activeId = newActive;
      observeSession(null);
      if (newActive) activeUnsubscribe = sdk.onSnapshot(sdk.doc(db, 'users', uid, 'sessions', newActive), record => {
        if (token !== generation) return;
        observeSession(record.data() || null);
        paintTimer();
      }, error => { if (token === generation) notice(errorText(error), true); });
    }
    const newSchool = state.profile?.schoolId || null;
    if (newSchool !== schoolId) {
      schoolUnsubscribe?.();
      schoolId = newSchool;
      state.schoolRanking = [];
      if (newSchool) state.pending.add('schoolRanking');
      if (newSchool) schoolUnsubscribe = sdk.onSnapshot(sdk.query(sdk.collection(db, 'schoolLeaderboards', newSchool, 'weeks', week, 'entries'), sdk.orderBy('totalSeconds', 'desc'), sdk.orderBy('uid'), sdk.limit(50)), rows => {
        if (token !== generation) return;
        state.pending.delete('schoolRanking'); state.failed.delete('schoolRanking');
        state.schoolRanking = rows.docs.map(row => row.data()); paint();
      }, error => { if (token === generation) { state.pending.delete('schoolRanking'); state.failed.add('schoolRanking'); notice(errorText(error), true); } });
    }
  }, token, 'profile');
  for (const [key, path] of [['today', ['dailyStats', today]], ['week', ['weeklyStats', week]], ['month', ['monthlyStats', today.slice(0, 7)]], ['summary', ['stats', 'summary']], ['focusTime', ['stats', 'focusTime']], ['lastWeek', ['weeklyStats', previousWeek]]]) {
    watch(sdk.doc(db, 'users', uid, ...path), snapshot => { state[key] = snapshot.data() || {}; }, token, key);
  }
  watch(sdk.query(sdk.collection(db, 'users', uid, 'dailyStats'), sdk.orderBy(sdk.documentId()), sdk.startAt(dateKey(Date.now() - 6 * 86400000)), sdk.endAt(today), sdk.limit(7)), rows => { state.days = rows.docs.map(row => ({ ...row.data(), date: row.id })); }, token, 'days');
  watch(sdk.query(sdk.collection(db, 'leaderboards', week, 'entries'), sdk.orderBy('totalSeconds', 'desc'), sdk.orderBy('uid'), sdk.limit(50)), rows => { state.ranking = rows.docs.map(row => row.data()); }, token, 'ranking');
  watch(sdk.doc(db, 'leaderboards', week, 'entries', uid), snapshot => { state.ownRanking = snapshot.data() || null; }, token, 'ownRanking');
  const displayName = (user.displayName || '회원').replace(/[\p{Cc}\p{Cf}]/gu, '').trim().slice(0, 20);
  profileReady = call('ensureProfile')({ displayName: displayName.length >= 2 ? displayName : '회원' });
  try { await profileReady; } catch (error) { if (token === generation) notice(errorText(error), true); }
}

document.addEventListener('click', async event => {
  const pauseButton = event.target.closest('[data-camera-pause]');
  if (pauseButton) {
    if (!pauseButton.disabled && !busy) toggleCameraPause();
    return;
  }
  const button = event.target.closest('[data-study-action]');
  if (button?.dataset.studyAction === 'stop' && busy && cameraState().status === 'opening' && !state.profile?.activeSessionId) {
    stopCamera(); previewSession = null; busy = false; await closeCameraFocus(); paintTimer(); return;
  }
  if (!button || button.disabled || busy) return;
  const starting = button.dataset.studyAction === 'start';
  const cameraStart = starting && button.hasAttribute('data-camera-toggle');
  if (!starting && (previewSession || !state.profile?.activeSessionId)) {
    stopCamera(); previewSession = null; await closeCameraFocus(); paintTimer(); return;
  }
  if (!cameraStart && !getAuthUser()) { window.location.assign('login.html'); return; }
  if (!cameraStart && !getAuthUser().emailVerified) { notice('계정 화면에서 이메일 인증을 완료해 주세요.', true); return; }
  if (!cameraStart && !call) { notice('저장 서비스를 연결 중입니다. 잠시 후 다시 시도해 주세요.', true); return; }
  busy = true;
  paintTimer();
  try {
    if (cameraStart) {
      openCameraFocus(button);
      if (!await startCamera()) return;
      if (!getAuthUser()?.emailVerified || !call) {
        previewSession = { totalMs: 0, activeSince: null };
        updatePreviewTimer();
        notice('체험 모드입니다. 로그인과 이메일 인증 후 시작한 학습부터 계정에 저장됩니다.');
        return;
      }
    }
    await profileReady;
    // Email verification can change before the cached ID token is refreshed.
    await authServices.auth.currentUser.getIdToken(true);
    if (starting) {
      const subjectId = document.querySelector('[data-study-subject]')?.value || 'other';
      const cameraMode = cameraState().enabled;
      await call('startStudySession')({ subjectId, cameraMode, ...(cameraMode ? { controllerId: cameraController } : {}) });
      notice(cameraMode ? '스터디캠 학습을 시작했습니다. 얼굴이 인식될 때만 시간이 적립됩니다.' : '학습을 시작했습니다. 종료를 누르면 기록이 저장됩니다.');
    } else {
      stopCamera();
      const result = await call('finishStudySession')({ sessionId: state.profile?.activeSessionId });
      notice(`${Math.floor(result.data.creditedSeconds / 60)}분 ${result.data.creditedSeconds % 60}초를 저장했습니다.`);
      await closeCameraFocus();
    }
  } catch (error) { notice(errorText(error), true); }
  finally { busy = false; paintTimer(); void syncCamera(); }
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
    await authServices.updateProfile(authServices.auth.currentUser, { displayName });
    window.dispatchEvent(new Event('study:navigated'));
    notice('닉네임을 저장했습니다.');
  } catch (error) { notice(errorText(error), true); }
  finally { busy = false; button.disabled = false; }
});

window.addEventListener('study:auth-changed', () => { void connectUser(); });
window.addEventListener('study:navigated', paint);
window.addEventListener('study:page-prepared', paint);
window.addEventListener('study:camera-changed', () => {
  updatePreviewTimer();
  if (!cameraState().tracking) {cameraPauseAt ??= Date.now();cameraResumeSequence=null;}
  else if (cameraPauseAt != null) cameraResumeSequence=(state.active?.sequence || 0)+1;
  paintTimer();void syncCamera(true);
});
window.setInterval(() => {
  if (connectedDay && connectedDay !== dateKey()) void connectUser();
  paintTimer();
  void syncCamera();
}, 1000);

try {
  authServices = await authReady;
  if (!authServices) { authResolved = true; state.pending.clear(); notice('서비스를 불러오지 못했습니다. 새로고침해 주세요.', true); }
  if (authServices) {
    const [appSdk, firestoreSdk, callableSdk] = await Promise.all([
      import('https://www.gstatic.com/firebasejs/13.0.0/firebase-app.js'),
      import('https://www.gstatic.com/firebasejs/13.0.0/firebase-firestore.js'),
      import('https://www.gstatic.com/firebasejs/13.0.0/firebase-functions.js'),
    ]);
    sdk = firestoreSdk;
    functionsSdk = callableSdk;
    const app = appSdk.getApps()[0] ?? appSdk.initializeApp(firebaseConfig);
    db = sdk.getFirestore(app, 'study-data');
    const functions = functionsSdk.getFunctions(app, 'asia-northeast3');
    call = name => functionsSdk.httpsCallable(functions, name);
    await connectUser();
  }
} catch (error) { notice(errorText(error), true); }
