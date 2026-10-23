const LABELS = { sleep: '수면·졸음', phone: '휴대폰', away: '자리 이탈', idle: '멍때림 추정' };
const seconds = ms => `${(Math.max(0, ms) / 1000).toFixed(1)}초`;

export function focusDebugRows(debug) {
  return Object.entries(LABELS).map(([key, label]) => {
    const row = debug?.rows.find(row => row.key === key);
    if (!row) return { key, label, text: '분석 대기', active: false };
    if (row.blocked) return { key, label, text: row.blocked, active: false };
    const evidence = key === 'phone' ? debug?.phoneEvidence : null;
    const score = evidence ? `객체 ${Math.round(evidence.score * 100)}%` : '';
    if (!row.active) {
      const text = evidence?.stage === 'using' ? `${score} · 사용 조건 충족` : evidence?.stage === 'not-found' ? '객체 미검출 · 25% 이상 후보 없음' : evidence?.stage === 'weak' ?
        `${score} · 신뢰도 부족` : evidence?.stage === 'desk' ? `${score} · 손 접촉/든 위치 미확인` : '미감지';
      return { key, label, text, active: false };
    }
    const pause = row.pauseAfterMs === 0 ? '즉시 정지' : row.pauseRemainingMs > 0 ? `정지까지 ${seconds(row.pauseRemainingMs)}` : '정지 기준 도달';
    const warning = row.warningRemainingMs > 0 ? `경고까지 ${seconds(row.warningRemainingMs)}` : '경고 기준 도달';
    return { key, label, text: `${seconds(row.elapsedMs)} 감지 · ${pause} · ${warning}${evidence ? ` · ${score}` : ''}`, active: true };
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
      '</dl><p class="cam-debug-note">분석 프레임 기준 · 정지와 경고 시점은 다릅니다.</p>';
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
    `${runtime.mode === 'light' ? '경량' : '표준'} Worker · ${runtime.backend.toUpperCase()}${Number.isFinite(runtime.inferenceMs) ? ` · 추론 ${Math.round(runtime.inferenceMs)}ms` : ''} · 200/800ms 요청` :
    '분석 프레임 기준 · 정지와 경고 시점은 다릅니다.';
  for (const row of focusDebugRows(snapshot)) {
    const element = panel.querySelector(`[data-debug-row="${row.key}"]`);
    element.dataset.active = String(row.active);
    element.querySelector('dd').textContent = row.text;
  }
}
