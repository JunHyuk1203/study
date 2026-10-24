// Only descriptors are persisted in this browser. Images and descriptors never leave it.
const MODEL='https://cdn.jsdelivr.net/npm/@vladmandic/human@3.3.6/models/faceres.json';
function normalized(values){
  if(!Array.isArray(values)&&!ArrayBuffer.isView(values))return null;
  if(values.length!==1024||!Array.from(values).every(Number.isFinite))return null;
  const norm=Math.hypot(...values);
  return norm>0?Array.from(values,value=>value/norm):null;
}
const similarity=(a,b)=>a.reduce((total,value,i)=>total+value*b[i],0);
export function createIdentityMatcher(saved=[]){
  let samples=saved.map(normalized).filter(Boolean).slice(0,3);
  return {
    get enrolled(){return samples.length===3;},
    get samples(){return samples.map(sample=>[...sample]);},
    observe(values){
      const descriptor=normalized(values);
      if(!descriptor)return {matched:false,status:'checking'};
      if(samples.length<3){
        if(samples.length&&samples.some(sample=>similarity(sample,descriptor)<.85))samples=[];
        samples.push(descriptor);
        return {matched:samples.length===3,status:samples.length===3?'matched':'enrolling',progress:samples.length};
      }
      const score=Math.max(...samples.map(sample=>similarity(sample,descriptor)));
      return {matched:score>=.65,status:score>=.65?'matched':'mismatch',score};
    },
  };
}
async function profileStore(mode,record){
  return new Promise((resolve,reject)=>{
    const request=indexedDB.open('study-camera-identity',1);
    request.onupgradeneeded=()=>request.result.createObjectStore('profiles');
    request.onerror=()=>reject(request.error);
    request.onblocked=()=>reject(new Error('얼굴 정보 저장소가 사용 중입니다'));
    request.onsuccess=()=>{
      const db=request.result,tx=db.transaction('profiles',mode);
      const operation=mode==='readonly'?tx.objectStore('profiles').get('current'):tx.objectStore('profiles').put(record,'current');
      tx.oncomplete=()=>{db.close();resolve(operation.result);};
      tx.onabort=tx.onerror=()=>{db.close();reject(tx.error||new Error('얼굴 정보 저장 실패'));};
    };
  });
}
export async function createLocalFaceGuard(tf,session){
  const saved=await profileStore('readonly');
  const matcher=createIdentityMatcher(saved?.version===1&&saved.session===session?saved.samples:[]);
  const model=await tf.loadGraphModel(MODEL);
  const canvas=new OffscreenCanvas(224,224),context=canvas.getContext('2d',{willReadFrequently:true});
  let lastCheck=-Infinity,current={matched:false,status:matcher.enrolled?'checking':'enrolling'},persisted=matcher.enrolled;
  const state=()=>({...current,enrolled:matcher.enrolled});
  return {
    async check(source,result,time){
      const faces=result.faceLandmarks||[],face=faces[0];
      if(faces.length!==1||!face?.[473]){
        lastCheck=-Infinity;current={matched:false,status:faces.length>1?'multiple':'missing'};return state();
      }
      if(time-lastCheck<600)return state();
      lastCheck=time;
      const width=source.videoWidth||source.width,height=source.videoHeight||source.height;
      const eye=(a,b)=>({x:(face[a].x+face[b].x)*width/2,y:(face[a].y+face[b].y)*height/2});
      const left=eye(33,133),right=eye(362,263),dx=right.x-left.x,dy=right.y-left.y;
      const size=Math.hypot(dx,dy),angle=Math.atan2(dy,dx);
      if(size<14||!Number.isFinite(angle)||Math.abs(angle)>.55){current={matched:false,status:'checking'};return state();}
      const scale=224/(size*3),cos=Math.cos(angle)*scale,sin=Math.sin(angle)*scale;
      const midX=(left.x+right.x)/2,midY=(left.y+right.y)/2;
      context.setTransform(1,0,0,1,0,0);context.fillStyle='#808080';context.fillRect(0,0,224,224);
      context.setTransform(cos,-sin,sin,cos,112-cos*midX-sin*midY,85+sin*midX-cos*midY);
      context.drawImage(source,0,0);context.setTransform(1,0,0,1,0,0);
      const input=tf.tidy(()=>tf.browser.fromPixels(context.getImageData(0,0,224,224)).toFloat().expandDims(0));
      let descriptor;
      try{
        descriptor=model.execute(input,'global_pooling/Mean');
        current=matcher.observe(await descriptor.data());
        if(matcher.enrolled&&!persisted){
          await profileStore('readwrite',{version:1,session,samples:matcher.samples});persisted=true;
        }
        return state();
      }finally{input.dispose();descriptor?.dispose();}
    },
    close(){model.dispose();},
  };
}
