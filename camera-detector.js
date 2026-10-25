// YOLOv10s/n COCO detector. All pixels and inference remain inside the camera Worker.
// Model: THU-MIG/yolov10, ONNX Community export (AGPL-3.0); see docs/camera-focus.md.
export const PHONE_MODEL = Object.freeze({
  name: 'yolov10n', size: 640,
  url: 'https://huggingface.co/onnx-community/YOLOv10/resolve/305deee9272dc7082fbc36e9f424a38d6ef23b8e/yolov10n.onnx',
  sha256: 'a77dd863933f184a19e84361c64b788228a7c7dacc2c78939239a96ad3efca3b',
});
export const PHONE_MODEL_ACCURATE=Object.freeze({name:'yolov10s',size:640,
  url:'https://huggingface.co/onnx-community/YOLOv10/resolve/305deee9272dc7082fbc36e9f424a38d6ef23b8e/yolov10s.onnx',
  sha256:'e2df1b4f5190e1ab4b7305181b2a80eb84ed7cc36d11aee0318781e91b0ad0b8'});
const LABELS = new Map([[67,'cell phone'],[73,'book'],[63,'laptop']]);

export function yoloLetterbox(width,height,size=PHONE_MODEL.size) {
  if(!(width>0&&height>0&&Number.isFinite(width)&&Number.isFinite(height)))throw new TypeError('Invalid image dimensions');
  const scale=Math.min(size/width,size/height);
  const scaledWidth=Math.max(1,Math.round(width*scale)),scaledHeight=Math.max(1,Math.round(height*scale));
  return {width,height,size,scaledWidth,scaledHeight,left:Math.floor((size-scaledWidth)/2),top:Math.floor((size-scaledHeight)/2),scaleX:scaledWidth/width,scaleY:scaledHeight/height};
}
export function yoloChannels(rgba,size=PHONE_MODEL.size) {
  const count=size*size;
  if(rgba.length!==count*4)throw new TypeError('Invalid RGBA tensor');
  const data=new Float32Array(count*3);
  for(let i=0;i<count;i++){data[i]=rgba[i*4]/255;data[count+i]=rgba[i*4+1]/255;data[count*2+i]=rgba[i*4+2]/255;}
  return data;
}
export function decodeYoloObjects(data,dims,transform,minimum=.15,model=PHONE_MODEL.name) {
  if(dims.length!==3||dims[0]!==1||dims[2]!==6||data.length!==dims[1]*6)throw new Error('Unexpected YOLO output layout');
  const result=[],{width,height,left,top,scaleX,scaleY}=transform;
  for(let i=0;i<data.length;i+=6){
    const [x1,y1,x2,y2,score,classId]=data.subarray(i,i+6),name=LABELS.get(classId);
    if(!name||![x1,y1,x2,y2,score].every(Number.isFinite)||score<minimum||score>1)continue;
    const x=Math.max(0,Math.min(width,(x1-left)/scaleX)),y=Math.max(0,Math.min(height,(y1-top)/scaleY));
    const right=Math.max(0,Math.min(width,(x2-left)/scaleX)),bottom=Math.max(0,Math.min(height,(y2-top)/scaleY));
    if(right>x&&bottom>y)result.push({class:name,score,bbox:[x,y,right-x,bottom-y],model});
  }
  return result.sort((a,b)=>b.score-a.score);
}
export async function createPhoneObjectDetector(ort,{fetchModel=fetch,model=PHONE_MODEL}={}) {
  const response=await fetchModel(model.url);
  if(!response.ok)throw new Error(`Phone model download failed (${response.status})`);
  const bytes=await response.arrayBuffer();
  const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
  if(hash!==model.sha256)throw new Error('Phone model checksum mismatch');
  const session=await ort.InferenceSession.create(bytes,{executionProviders:['wasm'],graphOptimizationLevel:'all'});
  const source=new OffscreenCanvas(1,1),sourceContext=source.getContext('2d');
  const input=new OffscreenCanvas(PHONE_MODEL.size,PHONE_MODEL.size),context=input.getContext('2d',{willReadFrequently:true});
  let closed=false;
  return {name:model.name,
    async detect(image,_count=30,minimum=.15) {
      if(closed)throw new Error('Phone detector is closed');
      const transform=yoloLetterbox(image.width,image.height),{size,scaledWidth,scaledHeight,left,top}=transform;
      source.width=image.width;source.height=image.height;sourceContext.putImageData(image,0,0);
      context.fillStyle='rgb(114,114,114)';context.fillRect(0,0,size,size);
      context.drawImage(source,0,0,image.width,image.height,left,top,scaledWidth,scaledHeight);
      const tensor=new ort.Tensor('float32',yoloChannels(context.getImageData(0,0,size,size).data),[1,3,size,size]);
      let outputs;
      try{outputs=await session.run({[session.inputNames[0]]:tensor});const output=outputs[session.outputNames[0]];return decodeYoloObjects(output.data,output.dims,transform,minimum,model.name);}
      finally{tensor.dispose();if(outputs)for(const output of Object.values(outputs))output.dispose();}
    },
    async dispose(){if(!closed){closed=true;await session.release();}},
  };
}
