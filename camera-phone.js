// Pure local phone observation policy. Coordinates are normalized to the original image.
export const PHONE_LIMITS = Object.freeze({ seed: .15, context: .35, contextWindow:3500, create: .55, window: 2200, separation: 400, grace: 1000, maxAge: 1500, maxHold: 2500 });
export const FULL_FRAME = Object.freeze({ x: 0, y: 0, width: 1, height: 1, key: 'full' });
const area = b => b[2] * b[3];
const intersection = (a, b) => Math.max(0, Math.min(a[0]+a[2], b[0]+b[2])-Math.max(a[0],b[0])) *
  Math.max(0, Math.min(a[1]+a[3], b[1]+b[3])-Math.max(a[1],b[1]));
const validBox = b => Array.isArray(b) && b.length === 4 && b.every(Number.isFinite) && b[2] > 0 && b[3] > 0;
function match(a, b) {
  const shared = intersection(a,b), iou = shared / (area(a)+area(b)-shared);
  const size = Math.max(area(a),area(b))/Math.min(area(a),area(b));
  const movement = Math.hypot(a[0]+a[2]/2-b[0]-b[2]/2,a[1]+a[3]/2-b[1]-b[3]/2);
  return size <= 3 && (iou >= .15 || movement <= Math.min(Math.hypot(a[2],a[3]),Math.hypot(b[2],b[3]))*.6);
}
function covers(region, box) {
  return region && intersection([region.x,region.y,region.width,region.height],box)/area(box) >= .8;
}
function inspectable(observation,box) {
  const {resolution,region}=observation;
  if(!resolution)return true;
  const scale=resolution.inputSize/Math.max(region.width*resolution.width,region.height*resolution.height);
  return Math.max(box[2]*resolution.width,box[3]*resolution.height)*scale>=32;
}
export function createPhoneTracker() {
  let tracks=[], nextId=1, lastAt=-Infinity, lastValid=null, started=null, unavailable=false;
  const seen=new Set(), diagnostics={accepted:0,discarded:0,reasons:{},latencies:[]};
  function reject(reason) { diagnostics.discarded++; diagnostics.reasons[reason]=(diagnostics.reasons[reason]||0)+1; }
  function observe(observation, now) {
    started ??= now;
    if(!observation || seen.has(observation.id))return state(now);
    seen.add(observation.id); if(seen.size>128)seen.delete(seen.values().next().value);
    const {observedAt,completedAt,frameId,region}=observation;
    if(!Number.isFinite(observedAt)||!Number.isFinite(completedAt)||completedAt<observedAt||observedAt>now||frameId==null){reject('invalid');return state(now);}
    if(observedAt<lastAt){reject('out-of-order');return state(now);}
    lastAt=observedAt;
    diagnostics.latencies.push(completedAt-observedAt);if(diagnostics.latencies.length>120)diagnostics.latencies.shift();
    if(now-observedAt>PHONE_LIMITS.maxAge){reject('stale');unavailable=true;return state(now);}
    if(observation.status!=='ok'){reject('model-error');unavailable=true;return state(now);}
    // Capture time controls freshness and independent evidence. Receipt time controls
    // how long a newly accepted result may survive a brief gap on a slow device.
    lastValid=now;unavailable=false;diagnostics.accepted++;
    tracks=tracks.filter(t=>observedAt-t.lastSeen<=PHONE_LIMITS.window);
    const assigned=new Set();
    for(const candidate of [...(observation.candidates||[])].filter(c=>validBox(c.box)&&Number.isFinite(c.score)&&c.score>=PHONE_LIMITS.seed).sort((a,b)=>b.score-a.score)) {
      let track=tracks.find(t=>!assigned.has(t.id)&&match(t.box,candidate.box));
      // Overlapping detections from one pass are the same evidence, not new tracks.
      if(!track && tracks.some(t=>assigned.has(t.id)&&match(t.box,candidate.box)))continue;
      if(!track){
        if(tracks.length>=8){
          const weakest=tracks.filter(t=>!t.confirmed).sort((a,b)=>a.score-b.score)[0];
          if(!weakest||weakest.score>=candidate.score)continue;
          tracks=tracks.filter(t=>t!==weakest);
        }
        track={id:nextId++,box:candidate.box,history:[],lastSeen:observedAt,lastPositive:null,lastPositiveReceipt:null,contextAt:null,confirmed:false};tracks.push(track);
      }
      const positive=candidate.score>=PHONE_LIMITS.create;
      assigned.add(track.id);
      // An uncertain crop must not steer the next crop away from the original object.
      if(positive||track.score==null)track.box=candidate.box;
      track.score=candidate.score;track.lastSeen=observedAt;
      // Tight crops can amplify a hand-shaped false positive. Require classification
      // support from a full frame, tile or hand-context pass before confirming it.
      if(candidate.score>=PHONE_LIMITS.context && !region?.key?.startsWith('track-'))track.contextAt=observedAt;
      const old=track.history.find(e=>e.frameId===frameId);
      if(old)old.positive ||= positive;else if(positive)track.history.push({frameId,at:observedAt,positive:true});
      if(positive){track.lastPositive=observedAt;track.lastPositiveReceipt=now;track.released=false;}
      if(positive&&region?.key&&region.key!=='full'&&!region.key.startsWith('track-')&&candidate.score>(track.bestViewScore??0)){
        track.bestViewScore=candidate.score;track.bestView={width:region.width,height:region.height,
          offsetX:region.x-candidate.box[0]-candidate.box[2]/2,offsetY:region.y-candidate.box[1]-candidate.box[3]/2};
      }
    }
    for(const track of tracks){
      if(!assigned.has(track.id)&&covers(region,track.box)&&inspectable(observation,track.box)&&!track.history.some(e=>e.frameId===frameId))track.history.push({frameId,at:observedAt,positive:false});
      track.history=track.history.filter(e=>observedAt-e.at<=PHONE_LIMITS.window).slice(-3);
      const positives=track.history.filter(e=>e.positive);
      const contextFresh=track.contextAt!==null&&observedAt-track.contextAt<=PHONE_LIMITS.contextWindow;
      if(!contextFresh)track.confirmed=false;
      if(positives.length>=2 && positives.at(-1).at-positives[0].at>=PHONE_LIMITS.separation && contextFresh)track.confirmed=true;
    }
    return state(now);
  }
  function holdMs() {
    const sorted=[...diagnostics.latencies].sort((a,b)=>a-b);
    const p95=sorted[Math.min(sorted.length-1,Math.floor(sorted.length*.95))]??0;
    return Math.max(PHONE_LIMITS.grace,Math.min(PHONE_LIMITS.maxHold,p95*2));
  }
  function state(now) {
    started ??= now;
    let active=null, missing=null, lost=false;
    for(const track of tracks){
      const age=now-(track.lastPositiveReceipt??track.lastSeen);
      const captureAge=now-(track.lastPositive??track.lastSeen);
      const negatives=track.history.filter(e=>!e.positive&&e.at>(track.lastPositive??-Infinity)).length;
      if(track.confirmed&&negatives>=2&&age>=PHONE_LIMITS.grace){track.confirmed=false;track.released=true;}
      if(track.confirmed){if(age<=holdMs()&&captureAge<=PHONE_LIMITS.maxAge+PHONE_LIMITS.maxHold){if(!negatives)active=track;else missing=track;}else lost=true;}
    }
    const confirmed=active||missing;
    const candidate=tracks.filter(t=>!t.released&&now-t.lastSeen<=PHONE_LIMITS.window).sort((a,b)=>b.score-a.score)[0];
    const status=confirmed ? (active?'confirmed':'missing') : unavailable||lost||now-(lastValid??started)>Math.max(PHONE_LIMITS.maxAge,holdMs()) ? 'unavailable' : candidate ? 'candidate' : tracks.some(t=>t.released) ? 'released' : 'searching';
    const selected=confirmed||candidate;
    return {status,confirmed:Boolean(confirmed),trackId:selected?.id??null,box:selected?.box??null,score:selected?.score??0,positives:selected?.history.filter(e=>e.positive).length??0,
      contextVerified:selected?.contextAt!=null&&now-selected.contextAt<=PHONE_LIMITS.contextWindow+PHONE_LIMITS.maxAge};
  }
  return {observe,state,targets:now=>tracks.filter(t=>!t.released&&now-t.lastSeen<=PHONE_LIMITS.window).sort((a,b)=>Number(b.confirmed)-Number(a.confirmed)||b.score-a.score).slice(0,2).map(t=>({...t,trackId:t.id})),
    diagnostics(){const sorted=[...diagnostics.latencies].sort((a,b)=>a-b);return {...diagnostics,latencies:undefined,holdMs:holdMs(),p50:sorted[Math.floor(sorted.length*.5)]??0,p95:sorted[Math.min(sorted.length-1,Math.floor(sorted.length*.95))]??0};}};
}
export function createPhoneScheduler() {
  let turn=0, lastFull=-Infinity,jobsSinceFull=0,targetBurst=0;
  const visited=new Map(),views=new Map();
  return { next(width,height,now,targets=[],hands=[]) {
    const activeKeys=new Set(targets.map(t=>`track-${t.trackId}`));
    for(const key of visited.keys())if(key.startsWith('track-')&&!activeKeys.has(key)){visited.delete(key);views.delete(key);}
    const current=turn++;
    const full=()=>{lastFull=now;jobsSinceFull=0;targetBurst=0;return {...FULL_FRAME};};
    if(!Number.isFinite(lastFull))return full();
    // A newly found candidate gets the next job. Reset the full-frame budget on
    // actual execution, so a deadline scan cannot cause another adjacent full scan.
    if(targets.length && targetBurst<2 && jobsSinceFull<3){
      const target=[...targets].sort((a,b)=>(visited.get(`track-${a.trackId}`)??-Infinity)-(visited.get(`track-${b.trackId}`)??-Infinity))[0];
      const key=`track-${target.trackId}`,view=views.get(key)||0,context=Boolean(target.bestView)||view%2===1;
      const [x,y,w,h]=target.box,scale=context?3:1.6,minimum=context ? .36 : .16;
      const rw=target.bestView?Math.min(1,Math.max(target.bestView.width,w*1.2)):Math.min(1,Math.max(minimum,w*scale));
      const rh=target.bestView?Math.min(1,Math.max(target.bestView.height,h*1.2)):Math.min(1,Math.max(minimum,h*scale));
      const desiredX=target.bestView?x+w/2+target.bestView.offsetX:x+w/2-rw/2;
      const desiredY=target.bestView?y+h/2+target.bestView.offsetY:y+h/2-rh/2;
      visited.set(key,now);views.set(key,view+1);jobsSinceFull++;targetBurst++;
      return {x:Math.max(0,Math.min(1-rw,Math.max(x+w-rw,Math.min(x,desiredX)))),y:Math.max(0,Math.min(1-rh,Math.max(y+h-rh,Math.min(y,desiredY)))),width:rw,height:rh,key:context?`verify-${target.trackId}`:key};
    }
    if(now-lastFull>=2000||jobsSinceFull>=3)return full();
    // Square pixel tiles overlap by at least 20%, even on portrait cameras.
    const side=Math.min(width,height)*.65,tw=Math.min(1,side/width),th=Math.min(1,side/height);
    const cols=Math.ceil((1-tw)/(tw*.8))+1,rows=Math.ceil((1-th)/(th*.8))+1,tiles=[];
    for(let y=0;y<rows;y++)for(let x=0;x<cols;x++)tiles.push({x:x*(1-tw)/Math.max(1,cols-1),y:y*(1-th)/Math.max(1,rows-1),width:tw,height:th,key:`tile-${x}-${y}`});
    // Hands get occasional priority but cannot starve the tile sweep.
    const choices=!targets.length&&current%3===1&&hands.length?hands.map((r,i)=>({...r,key:`hand-${i}`})):tiles;
    const region=choices.sort((a,b)=>(visited.get(a.key)??-Infinity)-(visited.get(b.key)??-Infinity))[0];
    visited.set(region.key,now);jobsSinceFull++;targetBurst=0;return region;
  }, diagnostics:()=>({lastFull,regions:Object.fromEntries(visited)})};
}
