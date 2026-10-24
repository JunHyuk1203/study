// Face-only inactivity clock. Arms and wrists are optional study-motion evidence.
export function createIdleTracker(limitMs = 15000) {
  let anchor = null, smooth = null, lastTime = null, idleSince = null, motionSince = null, studySince = null;
  let gazeAnchor=null,gazeSmooth=null,gazeLast=null,gazeSince=null,gazeSteps=[];
  function pauseGaze() { gazeAnchor=gazeSmooth=gazeLast=gazeSince=null;gazeSteps=[]; }
  function reset() { anchor = smooth = lastTime = idleSince = motionSince = studySince = null;pauseGaze(); }
  function state(now) {
    return { elapsedMs: idleSince === null ? 0 : Math.max(0, now - idleSince),
      eligible: idleSince !== null, moving: motionSince !== null || gazeSince !== null,
      gaze: { tracking: gazeAnchor !== null, moving: gazeSince !== null || gazeSteps.length > 0 },
      confirmed: idleSince !== null && now - idleSince >= limitMs && motionSince === null && gazeSince === null && studySince === null };
  }
  function update(signals, now) {
    const vector = signals.activityVector;
    if (!Array.isArray(vector) || vector.length !== 9 || !vector.every(Number.isFinite)) { reset(); return state(now); }
    if (!anchor) { anchor = [...vector]; smooth = [...vector]; idleSince = now; }
    const alpha = lastTime === null ? 1 : 1 - Math.exp(-Math.max(0, now - lastTime) / 450);
    smooth = smooth.map((value, i) => value + alpha * (vector[i] - value));
    const gazeAlpha=lastTime===null?1:1-Math.exp(-Math.max(0,now-lastTime)/120);
    lastTime = now;
    // Face translation and head direction release idle; mild gaze jitter is ignored.
    const moving = Math.hypot(smooth[0] - anchor[0], smooth[1] - anchor[1]) > .025 ||
      Math.hypot(smooth[4] - anchor[4], smooth[5] - anchor[5]) > .10 || Math.abs(smooth[6] - anchor[6]) > .08;
    let gazeActive=false;
    if(signals.gazeValid===false)pauseGaze();
    else {
      const gaze=[vector[2],vector[3],vector[7],vector[8]];
      gazeSmooth=gazeSmooth?gazeSmooth.map((value,i)=>value+gazeAlpha*(gaze[i]-value)):[...gaze];
      gazeAnchor??=[...gazeSmooth];gazeLast??=[...gazeSmooth];
      const coherent=(current,reference,horizontal,vertical)=>{
        const d=current.map((value,i)=>value-reference[i]);
        return d[0]*d[1]>0 && Math.min(Math.abs(d[0]),Math.abs(d[1]))>horizontal ||
          d[2]*d[3]>0 && Math.min(Math.abs(d[2]),Math.abs(d[3]))>vertical;
      };
      gazeSince=coherent(gazeSmooth,gazeAnchor,.025,.02) && coherent(gaze,gazeAnchor,.025,.02)?gazeSince??now:null;
      gazeSteps=gazeSteps.filter(time=>now-time<=1500);
      if(coherent(gaze,gazeLast,.02,.015)){gazeSteps.push(now);gazeLast=[...gaze];}
      // Reading has repeated short fixations; a sustained gaze shift also counts.
      gazeActive=gazeSteps.length>=3 || gazeSince!==null && now-gazeSince>=400;
    }
    motionSince = moving ? motionSince ?? now : null;
    studySince = signals.studyActivity ? studySince ?? now : null;
    if (gazeActive || (motionSince !== null && now - motionSince >= 400) || (studySince !== null && now - studySince >= 500)) {
      idleSince = now; anchor = [...smooth]; motionSince = null;
      gazeAnchor=gazeSmooth?[...gazeSmooth]:null;gazeLast=null;gazeSince=null;gazeSteps=[];
    }
    return state(now);
  }
  return { update, state, reset, pauseGaze };
}
