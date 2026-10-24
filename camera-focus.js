// Temporal policy: no images, networking, storage, or user calibration.
import { createIdleTracker } from './camera-idle.js?v=20261024-10';
export const FOCUS_LIMITS = Object.freeze({ identity: 5000, sleep: 4500, phone: 750, away: 3000, idle: 15000, resume: 2000, gap: 3000 });
export const FOCUS_MESSAGES = Object.freeze({
  sleep: '수면·졸음 감지 · 눈을 뜨고 학습하면 자동 재개됩니다',
  phone: '휴대폰 사용 감지 · 휴대폰을 내려놓으면 자동 재개됩니다',
  away: '자리 이탈 감지 · 자리로 돌아오면 자동 재개됩니다',
  idle: '장시간 움직임·학습 행동 없음 · 학습 행동이 돌아오면 자동 재개됩니다',
  unknown: '얼굴을 확인할 수 없습니다 · 인식되면 자동 재개됩니다',
  identity: '시작한 얼굴을 확인하는 중 · 정면을 봐 주세요',
});
export function createFocusTracker() {
  let lastTime = null, candidate = null, since = null, healthySince = null, warning = null;
  const idle = createIdleTracker(FOCUS_LIMITS.idle);
  let trackingNow = false;
  let lastSignals = null;
  let missingSince = null;
  let phoneObservationId=null,phonePositives=0;
  let behaviorSince={sleep:null,phone:null,away:null},needsOwnerMotion=false,returnAnchor=null,returnMotionSince=null;
  let identityFailureSince=null;
  function reset(preserveOwner=false) {
    const keepLock=preserveOwner && (needsOwnerMotion || Boolean(lastSignals?.identity));
    lastTime = candidate = since = healthySince = warning = null;
    idle.reset();
    trackingNow = false;
    lastSignals = null;
    missingSince = null;
    phoneObservationId=null;phonePositives=0;
    behaviorSince={sleep:null,phone:null,away:null};needsOwnerMotion=keepLock;returnAnchor=returnMotionSince=null;
    identityFailureSince=null;
  }
  function update(signals, now) {
    if (!Number.isFinite(now)) throw new TypeError('A monotonic timestamp is required');
    if (lastTime !== null && (now <= lastTime || now - lastTime > FOCUS_LIMITS.gap)) reset(true);
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
    const identity=signals?.identity,ownerReady=!identity || identity.matched===true;
    const enrolling=identity && (identity.enrolled===false || identity.status==='enrolling');
    const wrongOwner=valid && identity && !enrolling && !ownerReady && ['mismatch','multiple'].includes(identity.status);
    identityFailureSince=wrongOwner?identityFailureSince??now:null;
    const identityWarning=identityFailureSince!==null && now-identityFailureSince>=FOCUS_LIMITS.identity;
    if(warning==='identity'&&!identityWarning)warning=null;
    const observations={sleep:visible&&signals.eyesClosed,phone:valid&&signals.phoneUse,away:valid&&!signals.face};
    for(const key of Object.keys(behaviorSince))behaviorSince[key]=observations[key]?behaviorSince[key]??now:null;
    missingSince = valid && !signals.face ? missingSince ?? now : null;
    if(identity && (identity.status==='mismatch' || identity.status==='multiple' || missingSince!==null&&now-missingSince>=FOCUS_LIMITS.away)){
      needsOwnerMotion=true;returnAnchor=returnMotionSince=null;
    }
    if(needsOwnerMotion && visible && ownerReady){
      const vector=signals.activityVector;
      if(Array.isArray(vector)&&vector.length===9&&vector.every(Number.isFinite)){
        returnAnchor??=[...vector];
        const moved=Math.hypot(vector[0]-returnAnchor[0],vector[1]-returnAnchor[1])>.02 ||
          Math.hypot(vector[4]-returnAnchor[4],vector[5]-returnAnchor[5])>.08 || Math.abs(vector[6]-returnAnchor[6])>.06 ||
          signals.gazeValid && Math.abs(vector[2]-returnAnchor[2])>.025 && Math.abs(vector[3]-returnAnchor[3])>.025;
        returnMotionSince=moved?returnMotionSince??now:null;
        if(returnMotionSince!==null&&now-returnMotionSince>=400)needsOwnerMotion=false;
      }
    }
    if (!valid || !ownerReady || missingSince !== null && now-missingSince >= FOCUS_LIMITS.away) idle.reset();
    const observeIdle=visible && ownerReady && !signals.eyesClosed;
    if(!observeIdle)idle.pauseGaze();
    const idleState = observeIdle ? idle.update(signals, now) : idle.state(now);
    if(valid && identity && !ownerReady){
      healthySince=null;trackingNow=false;warning=identityWarning?'identity':null;
      return {tracking:false,status:identityWarning?'paused':'scanning',reason:'identity',identityWarning,
        message:identityWarning?'등록한 얼굴과 다릅니다 · 본인이 돌아오면 자동 재개됩니다':'인식 중…'};
    }
    if(valid && identity && visible && needsOwnerMotion){
      healthySince=null;trackingNow=false;warning=null;
      return {tracking:false,status:'scanning',reason:'identity',identityWarning:false,message:'인식 중…'};
    }
    const elapsedFor=key=>behaviorSince[key]===null?0:now-behaviorSince[key];
    const phoneConfirmed=valid&&signals.phoneUse&&elapsedFor('phone')>=FOCUS_LIMITS.phone&&(!observation||phonePositives>=2);
    const sleepConfirmed=visible&&signals.eyesClosed&&elapsedFor('sleep')>=FOCUS_LIMITS.sleep;
    const awayConfirmed=valid&&!signals.face&&elapsedFor('away')>=FOCUS_LIMITS.away;
    const reason = !valid ? 'unknown' : visible&&!ownerReady ? 'identity' : phoneConfirmed ? 'phone' : sleepConfirmed ? 'sleep' : awayConfirmed ? 'away' : needsOwnerMotion&&visible ? 'away' : idleState.confirmed ? 'idle' : signals.phoneUse ? 'phone' : !signals.face ? 'away' :
      signals.eyesClosed && signals.face ? 'sleep' :
      !visible ? 'unknown' : null;
    if (reason) {
      if (candidate !== reason) { candidate = reason; since = now; }
      // Confirm the behavior first; the warning and pause must always happen together.
      const elapsed=behaviorSince[reason]!=null?now-behaviorSince[reason]:now-since;
      const confirmed = (reason === 'identity' || reason === 'idle' || reason === 'unknown' || reason==='away'&&needsOwnerMotion || elapsed >= FOCUS_LIMITS[reason]) && (reason!=='phone' || !observation || phonePositives>=2);
      if (!confirmed) {
        return { tracking: trackingNow && !warning, status: warning ? 'paused' : trackingNow ? 'tracking' : 'scanning',
          reason: warning, message: warning ? FOCUS_MESSAGES[warning] : trackingNow ? '학습 행동 인식 중 · 집중 시간 측정' : '학습 행동 확인 중 · 자동 시작 준비' };
      }
      healthySince = null; trackingNow = false;
      if (confirmed) warning = reason;
      return { tracking: false, status: warning ? 'paused' : 'scanning', reason: warning || reason,
        message: reason==='identity' ? identity.status==='mismatch' ? '등록한 얼굴과 다릅니다 · 본인이 돌아오면 자동 재개됩니다' : identity.status==='multiple' ? '여러 얼굴이 보입니다 · 등록한 사람만 화면에 있어야 합니다' : identity.status==='enrolling' ? `얼굴을 이 기기에 등록하는 중 (${identity.progress||0}/3) · 정면을 봐 주세요` : FOCUS_MESSAGES.identity : needsOwnerMotion&&visible ? '본인 확인 완료 · 고개나 시선을 움직여 주세요' : warning ? FOCUS_MESSAGES[warning] : '행동 확인 중 · 학습시간 일시정지' };
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
      !lastSignals.activityVector ? '얼굴 방향 확인 필요' : lastSignals.identity&&!lastSignals.identity.matched ? '본인 확인 필요' : null;
    const rows = ['sleep', 'phone', 'away', 'idle'].map(key => {
      const active = key === 'idle' ? Boolean(idleState.eligible && !idleBlocked) : behaviorSince[key]!==null;
      const elapsedMs = active ? key === 'idle' ? idleState.elapsedMs : Math.max(0, lastTime - behaviorSince[key]) : 0;
      const pauseAfterMs = FOCUS_LIMITS[key];
      return { key, active, elapsedMs, pauseAfterMs, pauseRemainingMs: Math.max(0, pauseAfterMs - elapsedMs),
        warningAfterMs: FOCUS_LIMITS[key], warningRemainingMs: Math.max(0, FOCUS_LIMITS[key] - elapsedMs),
        blocked: key === 'idle' ? idleBlocked : null };
    });
    return { rows, warning, phoneEvidence: lastSignals?.phoneEvidence, gaze: idleState.gaze, identity:lastSignals?.identity,
      resumeRemainingMs: healthySince === null ? null : Math.max(0, FOCUS_LIMITS.resume - (lastTime - healthySince)) };
  }
  return { update, reset, getDebug };
}
