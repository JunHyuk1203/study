// Temporal policy: no images, networking, storage, or user calibration.
import { createIdleTracker } from './camera-idle.js?v=20261024-10';
import { createPhoneTracker } from './camera-phone.js?v=20261025-6';
export const FOCUS_LIMITS = Object.freeze({ identity: 8000, faceGrace: 5000, sleep: 4500, phone: 750, away: 5000, idle: 15000, resume: 2000, gap: 3000 });
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
  let phoneTracker=createPhoneTracker(),phoneState=null;
  let behaviorSince={sleep:null,phone:null,away:null};
  let identityFailureSince=null;
  let identityKnown=false,resumeOnFace=false;
  function reset(preserveOwner=false) {
    const keepIdentity=preserveOwner&&identityKnown;
    lastTime = candidate = since = healthySince = warning = null;
    idle.reset();
    trackingNow = false;
    lastSignals = null;
    missingSince = null;
    phoneObservationId=null;phonePositives=0;
    phoneTracker=createPhoneTracker();phoneState=null;
    behaviorSince={sleep:null,phone:null,away:null};
    identityFailureSince=null;
    identityKnown=keepIdentity;resumeOnFace=false;
  }
  function update(signals, now) {
    if (!Number.isFinite(now)) throw new TypeError('A monotonic timestamp is required');
    if (lastTime !== null && (now < lastTime || now - lastTime > (trackingNow?FOCUS_LIMITS.faceGrace:FOCUS_LIMITS.gap))) reset(true);
    lastTime = now;
    lastSignals = signals;
    const observation=signals?.phoneObservation;
    const tracked=signals?.phonePolicy==='tracked'||observation?.version>=2;
    phoneState=tracked?phoneTracker.observe(observation,now):null;
    if(!tracked && observation && observation.id!==phoneObservationId) {
      phoneObservationId=observation.id;
      phonePositives=observation.positive && observation.ageMs<=1500 ? phonePositives+1 : 0;
    }
    if(!tracked && observation && observation.ageMs>1500)phonePositives=0;
    const valid = signals?.reliable === true;
    const phoneUnavailable=phoneState?.status==='unavailable';
    const phoneActive=tracked?phoneState.confirmed:signals?.phoneUse;
    const visible = valid && signals.face;
    const identity=signals?.identity,ownerReady=!identity || identity.matched===true;
    identityKnown ||= Boolean(identity);
    const enrolling=identity && (identity.enrolled===false || identity.status==='enrolling');
    const observations={sleep:visible&&signals.eyesClosed,phone:valid&&phoneActive,away:valid&&!signals.face};
    for(const key of Object.keys(behaviorSince))behaviorSince[key]=observations[key]?behaviorSince[key]??now:null;
    const faceReturned=visible&&missingSince!==null&&resumeOnFace;
    missingSince = !visible ? missingSince ?? now : null;
    if(identity?.matched)identityFailureSince=null;
    if(faceReturned){
      resumeOnFace=false;identityFailureSince=null;
      healthySince=now-FOCUS_LIMITS.resume;
      if(warning==='away')warning=null;
    }
    const identityWarning=Boolean(visible&&!enrolling&&!ownerReady&&identityFailureSince!==null&&now-identityFailureSince>=FOCUS_LIMITS.identity);
    if(warning==='identity'&&!identityWarning)warning=null;
    if (!valid || !ownerReady || missingSince !== null && now-missingSince >= FOCUS_LIMITS.away) idle.reset();
    const observeIdle=visible && ownerReady && !signals.eyesClosed;
    if(!observeIdle)idle.pauseGaze();
    const idleState = observeIdle ? idle.update(signals, now) : idle.state(now);
    const elapsedFor=key=>behaviorSince[key]===null?0:now-behaviorSince[key];
    const phoneConfirmed=valid&&phoneActive&&(tracked||elapsedFor('phone')>=FOCUS_LIMITS.phone&&(!observation||phonePositives>=2));
    // Expired evidence is an observation failure, never a fresh negative or an old phone claim.
    if(tracked&&phoneState.status==='unavailable'&&warning==='phone')warning=null;
    if(!visible&&(trackingNow||resumeOnFace||valid&&identity)&&!enrolling&&!phoneConfirmed){
      resumeOnFace ||= trackingNow;
      const expired=now-missingSince>=FOCUS_LIMITS.faceGrace;
      if(expired){healthySince=null;trackingNow=false;warning='away';identityFailureSince=null;}
      return {tracking:trackingNow&&!warning,status:expired?'paused':trackingNow?'tracking':'scanning',reason:expired?'away':null,
        identityWarning:false,message:expired?FOCUS_MESSAGES.away:'얼굴 인식 유예 중 · 5초 안에 얼굴을 보여 주세요'};
    }
    if(!valid && identityKnown){
      healthySince=null;trackingNow=false;warning=null;
      return {tracking:false,status:'scanning',reason:'identity',identityWarning:false,message:'인식 중…'};
    }
    if(valid && identity && (enrolling || identityWarning)){
      healthySince=null;trackingNow=false;warning=identityWarning?'identity':null;
      return {tracking:false,status:identityWarning?'paused':'scanning',reason:'identity',identityWarning,
        message:identityWarning?'등록한 얼굴과 다릅니다 · 본인이 돌아오면 자동 재개됩니다':'인식 중…'};
    }
    const sleepConfirmed=visible&&signals.eyesClosed&&elapsedFor('sleep')>=FOCUS_LIMITS.sleep;
    const awayConfirmed=valid&&!signals.face&&elapsedFor('away')>=FOCUS_LIMITS.away;
    const reason = !valid || phoneUnavailable ? 'unknown' : phoneConfirmed ? 'phone' : sleepConfirmed ? 'sleep' : awayConfirmed ? 'away' : idleState.confirmed ? 'idle' : phoneActive ? 'phone' : !signals.face ? 'away' :
      signals.eyesClosed && signals.face ? 'sleep' :
      !visible ? 'unknown' : null;
    if (reason) {
      if (candidate !== reason) { candidate = reason; since = now; }
      // Confirm the behavior first; the warning and pause must always happen together.
      const elapsed=behaviorSince[reason]!=null?now-behaviorSince[reason]:now-since;
      const confirmed = reason==='phone'&&tracked ? phoneConfirmed : (reason === 'idle' || reason === 'unknown' || elapsed >= FOCUS_LIMITS[reason]) && (reason!=='phone' || !observation || phonePositives>=2);
      if (!confirmed) {
        return { tracking: trackingNow && !warning, status: warning ? 'paused' : trackingNow ? 'tracking' : 'scanning',
          reason: warning, message: warning ? FOCUS_MESSAGES[warning] : trackingNow ? '학습 행동 인식 중 · 집중 시간 측정' : '학습 행동 확인 중 · 자동 시작 준비' };
      }
      healthySince = null; trackingNow = false;
      if (confirmed) warning = reason;
      return { tracking: false, status: warning ? 'paused' : 'scanning', reason: warning || reason,
        message: reason==='unknown'&&phoneUnavailable&&valid ? '휴대폰 인식 응답을 확인할 수 없습니다 · 인식되면 자동 재개됩니다' : warning ? FOCUS_MESSAGES[warning] : '행동 확인 중 · 학습시간 일시정지' };
    }
    candidate = since = null;
    healthySince ??= now;
    const tracking = now - healthySince >= FOCUS_LIMITS.resume;
    trackingNow = tracking;
    if(tracking&&identity&&!ownerReady)identityFailureSince??=now;
    if (tracking) warning = null;
    return { tracking, status: tracking ? 'tracking' : warning ? 'paused' : 'scanning', reason: warning,
      message: tracking ? identity&&!ownerReady?'본인 확인 중 · 집중 시간 측정':'학습 행동 인식 중 · 집중 시간 측정' : warning ? `${FOCUS_MESSAGES[warning]} · 복귀 확인 중` : '학습 행동 확인 중 · 자동 시작 준비' };
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
    return { rows, warning, phoneEvidence: lastSignals?.phoneEvidence, phoneObservation:lastSignals?.phoneObservation, phoneState, phoneDiagnostics:phoneTracker.diagnostics(), gaze: idleState.gaze, identity:lastSignals?.identity,
      resumeRemainingMs: healthySince === null ? null : Math.max(0, FOCUS_LIMITS.resume - (lastTime - healthySince)) };
  }
  return { update, reset, getDebug };
}
