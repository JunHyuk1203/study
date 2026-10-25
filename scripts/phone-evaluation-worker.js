// Public-fixture comparison only. No camera permission or remote writes.
let models;
self.onmessage=async({data})=>{
  try{
    if(data.type==='init'){
      importScripts('https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js');
      importScripts('https://cdn.jsdelivr.net/npm/@tensorflow/tfjs-backend-wasm@4.22.0/dist/tf-backend-wasm.js');
      self.tf.wasm.setWasmPaths('https://cdn.jsdelivr.net/npm/@tensorflow/tfjs-backend-wasm@4.22.0/dist/');
      await self.tf.setBackend('wasm');await self.tf.ready();
      const {ORT_WASM_SCRIPT,configureCameraOrt}=await import('../camera-runtime.js');
      importScripts(ORT_WASM_SCRIPT);configureCameraOrt(self.ort);
      const {createStudyObjectDetector}=await import('../camera-objects.js');
      const {createPhoneObjectDetector,PHONE_MODEL_ACCURATE}=await import('../camera-detector.js');
      models={ssd:await createStudyObjectDetector(self.tf),yolo:await createPhoneObjectDetector(self.ort),yoloAccurate:await createPhoneObjectDetector(self.ort,{model:PHONE_MODEL_ACCURATE})};
      self.postMessage({type:'ready'});
    }else if(data.type==='frame'){
      try{
        const canvas=new OffscreenCanvas(data.bitmap.width,data.bitmap.height),ctx=canvas.getContext('2d');
        ctx.drawImage(data.bitmap,0,0);const pixels=ctx.getImageData(0,0,canvas.width,canvas.height),result={};
        for(const [name,model] of Object.entries(models)){
          const started=performance.now(),objects=await model.detect(pixels,30,0);
          result[name]={ms:Math.round(performance.now()-started),phones:objects.filter(o=>o.class==='cell phone').map(o=>({score:o.score,box:o.bbox})).slice(0,5)};
        }
        self.postMessage({type:'result',name:data.name,result});
      }finally{data.bitmap.close();}
    }
  }catch(error){self.postMessage({type:'error',message:String(error?.stack||error)});}
};
