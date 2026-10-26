import {createFaceVault} from './face-vault.js';
const MODEL='https://cdn.jsdelivr.net/npm/@vladmandic/human@3.3.6/models/faceres.json';
export function normalized(values){
  if(!Array.isArray(values)&&!ArrayBuffer.isView(values))return null;
  if(values.length!==1024||!Array.from(values).every(Number.isFinite))return null;
  const norm=Math.hypot(...values);return norm>0?Array.from(values,value=>value/norm):null;
}
const similarity=(a,b)=>a.reduce((sum,value,i)=>sum+value*b[i],0);
export function createIdentityMatcher(saved=[]) {
  const samples=saved.map(normalized).filter(Boolean);let votes=[];
  return {
    get enrolled(){return samples.length===12;},
    get samples(){return samples.map(row=>[...row]);},
    reset(){votes=[];},
    observe(values){
      const descriptor=normalized(values);
      if(!descriptor||samples.length!==12){votes=[];return {matched:false,status:'locked'};}
      const scores=samples.map(sample=>similarity(sample,descriptor)).sort((a,b)=>b-a);
      const score=scores.slice(0,3).reduce((a,b)=>a+b,0)/3;
      votes.push(score>=.65);votes=votes.slice(-5);
      const matched=votes.length===5&&votes.filter(Boolean).length>=4&&score>=.65;
      return {matched,status:matched?'matched':score<.65?'mismatch':'checking',score};
    },
  };
}
export const FACE_DIRECTIONS=[{name:'front',count:4,label:'정면을 편하게 바라봐 주세요'},{name:'left',count:2,label:'고개를 조금만 왼쪽으로 돌려 주세요'},{name:'right',count:2,label:'고개를 조금만 오른쪽으로 돌려 주세요'},{name:'up',count:2,label:'턱을 조금만 올려 주세요'},{name:'down',count:2,label:'턱을 조금만 내려 주세요'}];
export function faceDirection(yaw,pitch) {
  if(Math.abs(yaw)<=8&&Math.abs(pitch)<=8)return 'front';
  if(Math.abs(pitch)<=12&&yaw>=12&&yaw<=22)return 'left';
  if(Math.abs(pitch)<=12&&yaw<=-12&&yaw>=-22)return 'right';
  if(Math.abs(yaw)<=10&&pitch<=-8&&pitch>=-15)return 'up';
  if(Math.abs(yaw)<=10&&pitch>=8&&pitch<=15)return 'down';
  return null;
}
// Align to the eyes, independent of where the face appears in the camera frame.
export function faceFrameGeometry(face,width,height){
  if(!face||!Number.isFinite(width)||!Number.isFinite(height)||width<=0||height<=0)return null;
  if([1,10,33,133,152,234,263,362,454].some(i=>!face[i]||!Number.isFinite(face[i].x)||!Number.isFinite(face[i].y)||face[i].x<.005||face[i].x>.995||face[i].y<.005||face[i].y>.995))return null;
  const eye=(a,b)=>({x:(face[a].x+face[b].x)*width/2,y:(face[a].y+face[b].y)*height/2});
  const left=eye(33,133),right=eye(362,263),dx=right.x-left.x,dy=right.y-left.y,size=Math.hypot(dx,dy),angle=Math.atan2(dy,dx);
  if(size<22||Math.abs(angle)>.4)return null;
  const scale=224/(size*3),cos=Math.cos(angle)*scale,sin=Math.sin(angle)*scale,midX=(left.x+right.x)/2,midY=(left.y+right.y)/2;
  const nx=face[1].x*width-midX,ny=face[1].y*height-midY;
  return {width,height,transform:[cos,-sin,sin,cos,112-cos*midX-sin*midY,85+sin*midX-cos*midY],yaw:(nx*Math.cos(angle)+ny*Math.sin(angle))/size*65,pitch:((-nx*Math.sin(angle)+ny*Math.cos(angle))/size-.48)*45};
}
export function createFacePoseCalibration(){
  let baseline=null,points=[];
  return {
    reset(){baseline=null;points=[];},
    observe({yaw,pitch},time){
      if(!Number.isFinite(yaw)||!Number.isFinite(pitch)||!Number.isFinite(time))return {ready:false};
      if(!baseline){
        if(Math.abs(yaw)>25||Math.abs(pitch)>30){points=[];return {ready:false,label:'고개를 정면으로 두고 카메라를 편하게 바라봐 주세요'};}
        if(points.length&&(time-points.at(-1).time>1800||Math.abs(yaw-points[0].yaw)>4||Math.abs(pitch-points[0].pitch)>4))points=[];
        points.push({yaw,pitch,time});
        if(points.length<3||time-points[0].time<1000)return {ready:false,label:'편한 정면 자세를 확인하고 있어요. 잠시 그대로 있어 주세요'};
        baseline={yaw:points.reduce((sum,p)=>sum+p.yaw,0)/points.length,pitch:points.reduce((sum,p)=>sum+p.pitch,0)/points.length};points=[];
      }
      return {ready:true,direction:faceDirection(yaw-baseline.yaw,pitch-baseline.pitch)};
    },
  };
}
export function createEnrollmentCollector() {
  let samples=[],counts=[0,0,0,0,0],last=-Infinity,stableSince=null,previous=-Infinity;
  const reset=()=>{samples=[];counts=[0,0,0,0,0];last=-Infinity;stableSince=null;};
  return {
    reset,
    observe(values,{time,direction,quality=true,multiple=false}={}) {
      if(multiple)reset();
      const descriptor=normalized(values),step=counts.findIndex((count,i)=>count<FACE_DIRECTIONS[i].count);
      const response=()=>{const next=counts.findIndex((count,i)=>count<FACE_DIRECTIONS[i].count);return {samples:samples.map(row=>[...row]),progress:samples.length,counts:[...counts],direction:next<0?'front':FACE_DIRECTIONS[next].name,label:next<0?'마지막으로 정면을 다시 봐 주세요':`${FACE_DIRECTIONS[next].label} · ${counts[next]}/${FACE_DIRECTIONS[next].count}`};};
      if(!quality||!descriptor||!Number.isFinite(time)||time-previous>1800){stableSince=null;previous=time;return {...response(),complete:false};}
      previous=time;stableSince??=time;
      if(time-stableSince<1000||time-last<400||direction!==(step<0?'front':FACE_DIRECTIONS[step].name))return {...response(),complete:false};
      last=time;
      if(step<0)return {...response(),complete:true};
      samples.push(descriptor);counts[step]++;
      return {...response(),complete:false};
    },
  };
}
export function faceImageQuality(image) {
  let sum=0,sum2=0,dark=0,bright=0,left=0,right=0,count=0;
  const {data,width,height}=image,gray=(x,y)=>{const i=(y*width+x)*4;return .2126*data[i]+.7152*data[i+1]+.0722*data[i+2];};
  for(let y=40;y<Math.min(height-1,180);y+=2)for(let x=48;x<Math.min(width-1,176);x+=2){const value=gray(x,y);sum+=value;sum2+=value*value;dark+=value<25;bright+=value>240;if(x<112)left+=value;else right+=value;count++;}
  if(!count)return '카메라 영상 품질을 확인할 수 없습니다';
  const mean=sum/count;
  if(mean<45||dark/count>.45)return '얼굴 앞쪽을 조금 더 밝게 해 주세요';
  if(mean>215||bright/count>.3)return '얼굴에 비치는 강한 빛이나 안경 반사를 줄여 주세요';
  if(Math.abs(left-right)/Math.max(1,sum)>.3)return '창문을 등지지 않도록 위치를 바꿔 주세요';
  // Smooth skin, webcam denoising and resampling reduce local edges without hiding a face.
  // Only a nearly uniform frame is rejected here. Do not infer occlusion from texture.
  if(sum2/count-mean*mean<16)return '얼굴의 윤곽을 구분하기 어렵습니다. 카메라 초점과 조명을 확인해 주세요';
  return null;
}
export async function createLocalFaceGuard(tf,security,rpc,notify=()=>{}) {
  if(!security?.uid)throw new Error('계정 인증과 암호화된 얼굴 등록이 필요합니다.');
  const vault=createFaceVault(security,rpc,notify);
  let matcher=createIdentityMatcher(await vault.load()||[]),collector=matcher.enrolled?null:createEnrollmentCollector();
  const model=await tf.loadGraphModel(MODEL);
  const canvas=new OffscreenCanvas(224,224),context=canvas.getContext('2d',{willReadFrequently:true});
  const poseCalibration=createFacePoseCalibration();
  let lastCheck=-Infinity,current={matched:false,status:matcher.enrolled?'checking':'enrolling'},closed=false;
  const state=()=>({...current,enrolled:matcher.enrolled});
  const hold=(label,multiple=false)=>{matcher.reset();collector?.observe(null,{time:lastCheck,quality:false,multiple});current={matched:false,status:'quality-hold',label};notify({type:'face-progress',state:'QUALITY_HOLD',label,...(multiple&&collector?{progress:0,counts:[0,0,0,0,0]}:{})});return state();};
  return {
    async check(source,result,time){
      if(closed)return {matched:false,status:'locked',enrolled:false};
      const faces=result.faceLandmarks||[],face=faces[0];
      if(faces.length!==1||!face?.[473]){if(faces.length>1)poseCalibration.reset();return hold(faces.length>1?'화면에 한 사람만 나오게 해 주세요':'얼굴 전체가 카메라에 나오게 해 주세요. 크기와 위치는 자동으로 맞춥니다',faces.length>1);}
      if(time-lastCheck<500)return state();
      const gap=time-lastCheck;lastCheck=time;
      const width=source.videoWidth||source.width,height=source.videoHeight||source.height;
      const framing=faceFrameGeometry(face,width,height);
      if(!framing)return hold('얼굴 전체가 보이게 하고 너무 멀리 앉지 말아 주세요. 크기와 위치는 자동으로 맞춥니다');
      notify({type:'face-framing',framing});
      if(gap>1800&&Number.isFinite(gap))return hold('인식 속도가 느립니다. 다른 앱을 닫고 잠시 기다려 주세요');
      context.setTransform(1,0,0,1,0,0);context.fillStyle='#808080';context.fillRect(0,0,224,224);
      context.setTransform(...framing.transform);context.drawImage(source,0,0);context.setTransform(1,0,0,1,0,0);
      const image=context.getImageData(0,0,224,224),quality=faceImageQuality(image);
      if(quality)return hold(quality);
      const pose=collector?poseCalibration.observe(framing,time):null;
      if(pose&&!pose.ready)return hold(pose.label||'정면 자세를 확인하고 있습니다');
      const input=tf.tidy(()=>tf.browser.fromPixels(image).toFloat().expandDims(0));let descriptor;
      try {
        descriptor=model.execute(input,'global_pooling/Mean');const values=await descriptor.data();
        if(collector){
          const observed=collector.observe(values,{time,direction:pose.direction});
          current={matched:false,status:'enrolling',progress:observed.progress};
          notify({type:'face-progress',state:'ENROLLING',progress:observed.progress,counts:observed.counts,direction:observed.direction,label:observed.progress===12?'정면을 다시 봐 주세요':observed.label});
          if(observed.complete){const restored=await vault.save(observed.samples);matcher=createIdentityMatcher(restored);collector.reset();collector=null;current={matched:false,status:'checking'};}
        }else current=matcher.observe(values);
        if(current.matched)notify({type:'face-verified'});
        return state();
      }finally{input.dispose();descriptor?.dispose();}
    },
    close(){closed=true;collector?.reset();matcher=createIdentityMatcher();vault.close();model.dispose();canvas.width=canvas.height=0;},
  };
}
