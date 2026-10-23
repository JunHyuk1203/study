// Face-only inactivity clock. Arms and wrists are optional study-motion evidence.
export function createIdleTracker(limitMs = 45000) {
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
    const alpha = lastTime === null ? 1 : 1 - Math.exp(-Math.max(0, now - lastTime) / 600);
    smooth = smooth.map((value, i) => value + alpha * (vector[i] - value));
    lastTime = now;
    // Head translation/direction or both eyes must move appreciably. Single-frame jitter is ignored.
    const moving = Math.hypot(smooth[0] - anchor[0], smooth[1] - anchor[1]) > .075 ||
      Math.hypot(smooth[4] - anchor[4], smooth[5] - anchor[5]) > .35 || Math.abs(smooth[6] - anchor[6]) > .24 ||
      (Math.abs(smooth[2] - anchor[2]) > .35 && Math.abs(smooth[3] - anchor[3]) > .35) ||
      (Math.abs(smooth[7] - anchor[7]) > .25 && Math.abs(smooth[8] - anchor[8]) > .25);
    motionSince = moving ? motionSince ?? now : null;
    studySince = signals.studyActivity ? studySince ?? now : null;
    if ((motionSince !== null && now - motionSince >= 800) || (studySince !== null && now - studySince >= 800)) {
      idleSince = now; anchor = [...smooth]; motionSince = null;
    }
    return state(now);
  }
  return { update, state, reset };
}
