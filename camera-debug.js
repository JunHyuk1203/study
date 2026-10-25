const LABELS = { sleep: '수면·졸음', phone: '휴대폰', away: '자리 이탈', idle: '멍때림 추정', identity: '본인 얼굴 유사도' };
const seconds = ms => `${(Math.max(0, ms) / 1000).toFixed(ms > 0 && ms < 1000 ? 2 : 1)}초`;

export function focusDebugRows(debug) {
  return Object.entries(LABELS).map(([key, label]) => {
    if(key==='identity'){
      const identity=debug?.identity;
      const text=Number.isFinite(identity?.score)?`${(identity.score*100).toFixed(1)}% · 본인 기준 65.0% · ${identity.matched?'일치':'확인 중'}`:
        !identity?'분석 대기':identity.enrolled===false||identity.status==='enrolling'?'얼굴 등록 중 · 점수 대기':
        identity.status==='missing'?'얼굴 미감지 · 점수 없음':identity.status==='multiple'?'여러 얼굴 감지 · 점수 없음':'얼굴 비교 중 · 점수 대기';
      return {key,label,text,active:Number.isFinite(identity?.score)};
    }
    const row = debug?.rows.find(row => row.key === key);
    if (!row) return { key, label, text: '분석 대기', active: false };
    if(key==='phone'&&debug?.phoneState){
      const state=debug.phoneState;
      const labels={searching:'전체 화면 탐색 중',candidate:'휴대폰 후보 재확인 중',confirmed:'반복 검출 · 경고·정지',missing:'일시 누락 · 재확인 중',released:'휴대폰 해제 · 복귀 확인',unavailable:'휴대폰 관측 불가'};
      return {key,label,text:labels[state.status]||'분석 대기',active:state.confirmed};
    }
    if (row.blocked) return { key, label, text: row.blocked, active: false };
    const evidence = key === 'phone' ? debug?.phoneEvidence : null;
    const gazeNote=key==='idle' && debug?.gaze ? ` · ${!debug.gaze.tracking?'시선 확인 불가':debug.gaze.moving?'시선 변화 감지':'시선 추적 중'}` : '';
    const score = evidence ? `휴대폰 ${(evidence.score * 100).toFixed(1)}%` : '';
    if (!row.active) {
      const text = evidence?.stage === 'using' ? `${score} · 20% 기준 충족` : evidence?.stage === 'not-found' ? '휴대폰 후보 미검출 · 점수 없음' : evidence?.stage === 'weak' ?
        `${score} · 20% 미만` : '미감지';
      return { key, label, text: text+gazeNote, active: false };
    }
    const action = row.pauseRemainingMs > 0 ? `경고·정지까지 ${seconds(row.pauseRemainingMs)}` : '경고·정지 기준 도달';
    return { key, label, text: `${seconds(row.elapsedMs)} 감지 · ${action}${evidence ? ` · ${score}` : ''}${gazeNote}`, active: true };
  });
}

export function paintCameraDebug(root, debug, state) {
  let panel = root.querySelector('[data-camera-debug]');
  if (!panel) {
    panel = document.createElement('aside');
    panel.className = 'cam-debug'; panel.dataset.cameraDebug = '';
    panel.setAttribute('aria-label', '개발 테스트용 행동 감지 타이머');
    panel.innerHTML = '<div class="cam-debug-heading"><strong>감지 타이머</strong><span>개발 테스트</span></div>' +
      '<p class="cam-debug-summary" data-debug-summary></p><dl>' + Object.entries(LABELS).map(([key, label]) =>
        `<div data-debug-row="${key}"><dt>${label}</dt><dd></dd></div>`).join('') +
      '</dl><p class="cam-debug-note">분석 프레임 기준 · 경고와 시간 정지는 동시에 적용됩니다.</p>';
    root.querySelector('.cam-caption')?.after(panel);
    if (!panel.isConnected) root.append(panel);
  }
  const waiting = state.manuallyPaused || ['off', 'opening', 'error'].includes(state.status);
  const snapshot = waiting ? null : debug;
  const summary = state.manuallyPaused ? '수동 정지 · 분석 대기' : state.status === 'error' ? '인식 오류 · 시간 정지' :
    !snapshot ? '인식 준비 중 · 시간 정지' : state.tracking ? '학습 시간 측정 중' : snapshot.resumeRemainingMs > 0 ?
      `정상 행동 확인 · 재개까지 ${seconds(snapshot.resumeRemainingMs)}` : '학습 시간 정지 중';
  panel.querySelector('[data-debug-summary]').textContent = summary;
  const runtime = snapshot?.runtime;
  panel.querySelector('.cam-debug-note').textContent = runtime?.backend ?
    `${runtime.mode === 'light' ? '경량' : '표준'} Worker · ${runtime.backend.toUpperCase()}${Number.isFinite(runtime.inferenceMs) ? ` · 추론 ${Math.round(runtime.inferenceMs)}ms` : ''}${snapshot.phoneState ? ` · 휴대폰 지연 p50/p95 ${Math.round(snapshot.phoneDiagnostics.p50)}/${Math.round(snapshot.phoneDiagnostics.p95)}ms · 폐기 ${snapshot.phoneDiagnostics.discarded}회` : ' · 200/800ms 요청'}` :
    '분석 프레임 기준 · 경고와 시간 정지는 동시에 적용됩니다.';
  for (const row of focusDebugRows(snapshot)) {
    const element = panel.querySelector(`[data-debug-row="${row.key}"]`);
    element.dataset.active = String(row.active);
    element.querySelector('dd').textContent = row.text;
  }
}
