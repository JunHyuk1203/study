// Face-only inactivity clock. Arms and wrists are optional study-motion evidence.
export function createIdleTracker(limitMs = 22500) {
  let anchor = null, smooth = null, lastTime = null, idleSince = null, motionSince = null, studySince = null;
  function reset() { anchor = smooth = lastTime = idleSince = motionSince = studySince = null; }
  function state(now) {
    return { elapsedMs: idleSince === null ? 0 : Math.max(0, now - idleSince),
      eligible: idleSince !== null, moving: motionSince !== null,
      confirmed: idleSince !== null && now - idleSince >= limitMs && motionSince === null && studySince === null };
  }
  function update(signals, now) {
    const vector = signals.activityVector;
    if (!Array.isArray(vector) || vector.length !== 9 || !vector.every(Number.isFinite)) { reset(); return state(now); }
    if (!anchor) { anchor = [...vector]; smooth = [...vector]; idleSince = now; }
    const alpha = lastTime === null ? 1 : 1 - Math.exp(-Math.max(0, now - lastTime) / 450);
    smooth = smooth.map((value, i) => value + alpha * (vector[i] - value));
    lastTime = now;
    // Head translation/direction or both eyes must move appreciably. Single-frame jitter is ignored.
    const moving = Math.hypot(smooth[0] - anchor[0], smooth[1] - anchor[1]) > .05 ||
      Math.hypot(smooth[4] - anchor[4], smooth[5] - anchor[5]) > .25 || Math.abs(smooth[6] - anchor[6]) > .18 ||
      (Math.abs(smooth[2] - anchor[2]) > .25 && Math.abs(smooth[3] - anchor[3]) > .25) ||
      (Math.abs(smooth[7] - anchor[7]) > .18 && Math.abs(smooth[8] - anchor[8]) > .18);
    motionSince = moving ? motionSince ?? now : null;
    studySince = signals.studyActivity ? studySince ?? now : null;
    if ((motionSince !== null && now - motionSince >= 500) || (studySince !== null && now - studySince >= 500)) {
      idleSince = now; anchor = [...smooth]; motionSince = null;
    }
    return state(now);
  }
  return { update, state, reset };
}
