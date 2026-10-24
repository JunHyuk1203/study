// Temporal policy: no images, networking, storage, or user calibration.
import { createIdleTracker } from './camera-idle.js?v=20261024-8';
export const FOCUS_LIMITS = Object.freeze({ sleep: 4500, phone: 750, away: 3000, idle: 22500, resume: 2000, gap: 3000 });
export const FOCUS_MESSAGES = Object.freeze({
  sleep: '수면·졸음 감지 · 눈을 뜨고 학습하면 자동 재개됩니다',
  phone: '휴대폰 사용 감지 · 휴대폰을 내려놓으면 자동 재개됩니다',
  away: '자리 이탈 감지 · 자리로 돌아오면 자동 재개됩니다',
  idle: '장시간 움직임·학습 행동 없음 · 학습 행동이 돌아오면 자동 재개됩니다',
  unknown: '얼굴을 확인할 수 없습니다 · 인식되면 자동 재개됩니다',
});
export function createFocusTracker() {
  let lastTime = null, candidate = null, since = null, healthySince = null, warning = null;
  const idle = createIdleTracker(FOCUS_LIMITS.idle);
  let trackingNow = false;
  let lastSignals = null;
  let missingSince = null;
  let phoneObservationId=null,phonePositives=0;
  function reset() {
    lastTime = candidate = since = healthySince = warning = null;
    idle.reset();
    trackingNow = false;
    lastSignals = null;
    missingSince = null;
    phoneObservationId=null;phonePositives=0;
  }
  function update(signals, now) {
    if (!Number.isFinite(now)) throw new TypeError('A monotonic timestamp is required');
    if (lastTime !== null && (now <= lastTime || now - lastTime > FOCUS_LIMITS.gap)) reset();
    lastTime = now;
    lastSignals = signals;
    const observation=signals?.phoneObservation;
    if(observation && observation.id!==phoneObservationId) {
      phoneObservationId=observation.id;
      phonePositives=observation.positive && observation.ageMs<=1500 ? phonePositives+1 : 0;
    }
    if(observation && observation.ageMs>1500)phonePositives=0;
    const valid = signals?.reliable === true;
    const visible = valid && signals.face;
    missingSince = valid && !signals.face ? missingSince ?? now : null;
    if (!valid || signals.phoneUse || missingSince !== null && now-missingSince >= FOCUS_LIMITS.away) idle.reset();
    const observeIdle=visible && !signals.eyesClosed && !signals.phoneUse;
    if(!observeIdle)idle.pauseGaze();
    const idleState = observeIdle ? idle.update(signals, now) : idle.state(now);
    const reason = !valid ? 'unknown' : signals.phoneUse ? 'phone' : !signals.face ? 'away' :
      signals.eyesClosed && signals.face ? 'sleep' :
      !visible ? 'unknown' : idleState.confirmed ? 'idle' : null;
    if (reason) {
      if (candidate !== reason) { candidate = reason; since = now; }
      // Confirm the behavior first; the warning and pause must always happen together.
      const confirmed = (reason === 'idle' || reason === 'unknown' || now - since >= FOCUS_LIMITS[reason]) && (reason!=='phone' || !observation || phonePositives>=2);
      if (!confirmed) {
        return { tracking: trackingNow && !warning, status: warning ? 'paused' : trackingNow ? 'tracking' : 'scanning',
          reason: warning, message: warning ? FOCUS_MESSAGES[warning] : trackingNow ? '학습 행동 인식 중 · 집중 시간 측정' : '학습 행동 확인 중 · 자동 시작 준비' };
      }
      if (reason === 'sleep') idle.reset();
      healthySince = null; trackingNow = false;
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
    const idleState = idle.state(lastTime);
    const ready = lastSignals?.reliable && lastSignals.face;
    const idleBlocked = !ready ? '얼굴 확인 필요' : lastSignals.studyActivity ? '학습 동작 감지' :
      !lastSignals.activityVector ? '얼굴 방향 확인 필요' : lastSignals.phoneUse || lastSignals.eyesClosed ? '다른 행동 판정 중' : null;
    const rows = ['sleep', 'phone', 'away', 'idle'].map(key => {
      const active = key === 'idle' ? Boolean(idleState.eligible && !idleBlocked) : candidate === key;
      const elapsedMs = active ? key === 'idle' ? idleState.elapsedMs : Math.max(0, lastTime - since) : 0;
      const pauseAfterMs = FOCUS_LIMITS[key];
      return { key, active, elapsedMs, pauseAfterMs, pauseRemainingMs: Math.max(0, pauseAfterMs - elapsedMs),
        warningAfterMs: FOCUS_LIMITS[key], warningRemainingMs: Math.max(0, FOCUS_LIMITS[key] - elapsedMs),
        blocked: key === 'idle' ? idleBlocked : null };
    });
    return { rows, warning, phoneEvidence: lastSignals?.phoneEvidence, gaze: idleState.gaze,
      resumeRemainingMs: healthySince === null ? null : Math.max(0, FOCUS_LIMITS.resume - (lastTime - healthySince)) };
  }
  return { update, reset, getDebug };
}
