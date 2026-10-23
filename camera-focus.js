// Temporal policy: no images, networking, storage, or user calibration.
export const FOCUS_LIMITS = Object.freeze({ sleep: 1500, blinkGrace: 350, phone: 1500, away: 2000, idle: 45000, resume: 2000, gap: 3000 });
export const FOCUS_MESSAGES = Object.freeze({
  sleep: '수면·졸음 감지 · 눈을 뜨고 학습하면 자동 재개됩니다',
  phone: '휴대폰 사용 감지 · 휴대폰을 내려놓으면 자동 재개됩니다',
  away: '자리 이탈 감지 · 자리로 돌아오면 자동 재개됩니다',
  idle: '장시간 움직임·학습 행동 없음 · 학습 행동이 돌아오면 자동 재개됩니다',
  unknown: '얼굴·상체를 확인할 수 없습니다 · 인식되면 자동 재개됩니다',
});
export function createFocusTracker() {
  let lastTime = null, candidate = null, since = null, healthySince = null, warning = null, history = [];
  let trackingNow = false;
  let lastSignals = null;
  function reset() {
    lastTime = candidate = since = healthySince = warning = null;
    history = [];
    trackingNow = false;
    lastSignals = null;
  }
  function update(signals, now) {
    if (!Number.isFinite(now)) throw new TypeError('A monotonic timestamp is required');
    if (lastTime !== null && (now <= lastTime || now - lastTime > FOCUS_LIMITS.gap)) reset();
    lastTime = now;
    lastSignals = signals;
    const valid = signals?.reliable === true;
    const visible = valid && signals.face && signals.body;
    if (visible && !signals.eyesClosed && !signals.phoneUse && Array.isArray(signals.activityVector) &&
        signals.activityVector.length >= 8 && signals.activityVector.every(Number.isFinite)) {
      history.push({ time: now, vector: signals.activityVector });
      while (history.length > 1 && history[1].time <= now - FOCUS_LIMITS.idle) history.shift();
    } else if (!visible || signals.phoneUse || !signals.eyesClosed) history = [];
    // Full window of still head, gaze AND wrists. Reading/writing cues suppress this heuristic.
    const still = history.length > 1 && now - history[0].time >= FOCUS_LIMITS.idle &&
      history[0].vector.every((_, i) => {
        const values = history.map(row => row.vector[i]);
        return Math.max(...values) - Math.min(...values) < (i < 2 ? .025 : i < 4 ? .09 : i < 8 ? .035 : .12);
      });
    const reason = !valid ? 'unknown' : !signals.face && !signals.body ? 'away' :
      signals.eyesClosed && signals.face ? 'sleep' : signals.phoneUse ? 'phone' :
      !visible ? 'unknown' : still && !signals.studyActivity ? 'idle' : null;
    if (signals?.studyActivity) history = [];
    if (reason) {
      if (candidate !== reason) { candidate = reason; since = now; }
      // Ordinary blinks must not freeze the timer and trigger a two-second restart on every blink.
      if (reason === 'sleep' && now - since < FOCUS_LIMITS.blinkGrace) {
        return { tracking: trackingNow && !warning, status: warning ? 'paused' : trackingNow ? 'tracking' : 'scanning',
          reason: warning, message: warning ? FOCUS_MESSAGES[warning] : trackingNow ? '학습 행동 인식 중 · 집중 시간 측정' : '학습 행동 확인 중 · 자동 시작 준비' };
      }
      if (reason === 'sleep') history = [];
      healthySince = null; trackingNow = false;
      const confirmed = reason === 'idle' || reason === 'unknown' || now - since >= FOCUS_LIMITS[reason];
      if (confirmed) warning = reason;
      return { tracking: false, status: warning ? 'paused' : 'scanning', reason: warning || reason,
        message: warning ? FOCUS_MESSAGES[warning] : '행동 확인 중 · 학습시간 일시정지' };
    }
    candidate = since = null;
    healthySince ??= now;
    const tracking = now - healthySince >= FOCUS_LIMITS.resume;
    trackingNow = tracking;
    if (tracking) warning = null;
    return { tracking, status: tracking ? 'tracking' : warning ? 'paused' : 'scanning', reason: warning,
      message: tracking ? '학습 행동 인식 중 · 집중 시간 측정' : warning ? `${FOCUS_MESSAGES[warning]} · 복귀 확인 중` : '학습 행동 확인 중 · 자동 시작 준비' };
  }
  function getDebug() {
    if (lastTime === null) return null;
    const thresholds = i => i < 2 ? .025 : i < 4 ? .09 : i < 8 ? .035 : .12;
    let stillSince = lastTime;
    if (history.length) {
      const min = [...history.at(-1).vector], max = [...min];
      // Longest stationary suffix of the same observations used by the policy.
      for (let j = history.length - 1; j >= 0; j--) {
        const values = history[j].vector;
        if (values.some((value, i) => Math.max(max[i], value) - Math.min(min[i], value) >= thresholds(i))) break;
        values.forEach((value, i) => { min[i] = Math.min(min[i], value); max[i] = Math.max(max[i], value); });
        stillSince = history[j].time;
      }
    }
    const ready = lastSignals?.reliable && lastSignals.face && lastSignals.body;
    const idleBlocked = !ready ? '얼굴·상체 확인 필요' : lastSignals.studyActivity ? '학습 단서 감지' :
      !lastSignals.activityVector ? '양쪽 손목 확인 필요' : lastSignals.phoneUse || lastSignals.eyesClosed ? '다른 행동 판정 중' : null;
    const rows = ['sleep', 'phone', 'away', 'idle'].map(key => {
      const active = key === 'idle' ? Boolean(history.length && !idleBlocked) : candidate === key;
      const elapsedMs = active ? Math.max(0, lastTime - (key === 'idle' ? stillSince : since)) : 0;
      const pauseAfterMs = key === 'sleep' ? FOCUS_LIMITS.blinkGrace : key === 'idle' ? FOCUS_LIMITS.idle : 0;
      return { key, active, elapsedMs, pauseAfterMs, pauseRemainingMs: Math.max(0, pauseAfterMs - elapsedMs),
        warningAfterMs: FOCUS_LIMITS[key], warningRemainingMs: Math.max(0, FOCUS_LIMITS[key] - elapsedMs),
        blocked: key === 'idle' ? idleBlocked : null };
    });
    return { rows, warning, resumeRemainingMs: healthySince === null ? null : Math.max(0, FOCUS_LIMITS.resume - (lastTime - healthySince)) };
  }
  return { update, reset, getDebug };
}
