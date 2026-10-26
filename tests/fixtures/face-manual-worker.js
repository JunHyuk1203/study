// Test-only synthetic camera/model. Storage, crypto and RPC use production modules.
import {createLocalFaceGuard} from '/camera-identity.js';
let guard,source,face,sequence=0;
const requests=new Map();
const rpc=(action,data)=>new Promise((resolve,reject)=>{const id=++sequence;requests.set(id,{resolve,reject});postMessage({type:'rpc',id,action,data});});
self.onmessage=async({data})=>{
  if(data.type==='reply'){const item=requests.get(data.id);requests.delete(data.id);if(data.error)item.reject(Error(data.error));else item.resolve(data.result);return;}
  try{
    if(data.type==='init'){
      source=new OffscreenCanvas(640,480);const context=source.getContext('2d');context.fillStyle='#998877';context.fillRect(0,0,640,480);context.fillStyle='#302820';context.fillRect(270,150,25,15);context.fillRect(345,150,25,15);context.fillRect(290,220,60,15);
      face=Array.from({length:478},()=>({x:.5,y:160/480}));
      for(const i of [33,133])face[i]={x:280/640,y:160/480};
      for(const i of [362,263])face[i]={x:360/640,y:160/480};
      face[1]={x:.5,y:198.4/480};
      const vector=Array.from({length:1024},(_,i)=>i===0?1:0),tensor={toFloat(){return this;},expandDims(){return this;},dispose(){}};
      const tf={loadGraphModel:async()=>({execute:()=>({data:async()=>vector,dispose(){}}),dispose(){}}),tidy:fn=>fn(),browser:{fromPixels:()=>tensor}};
      guard=await createLocalFaceGuard(tf,data.context,rpc,event=>postMessage({type:'event',event}));postMessage({type:'ready'});
    }else if(data.type==='confirm')guard.confirmCapture();
    else if(data.type==='frame')postMessage({type:'frame-result',id:data.id,result:await guard.check(source,{faceLandmarks:[face]},data.time)});
  }catch(error){postMessage({type:'error',message:error.message});}
};
