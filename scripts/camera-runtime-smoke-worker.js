// Runtime-only probe for WebKit ports without OffscreenCanvas. No camera input.
self.onmessage=async()=>{
  let session,tensor,outputs;
  try{
    const {cameraRuntimeProfile,configureCameraOrt}=await import('../camera-runtime.js');
    const profile=cameraRuntimeProfile(),ORT_WASM_SCRIPT=profile.ortScript;
    const {PHONE_MODEL}=await import('../camera-detector.js');
    importScripts(ORT_WASM_SCRIPT);configureCameraOrt(self.ort,profile);
    const response=await fetch(PHONE_MODEL.url);if(!response.ok)throw Error('Model download failed');
    const bytes=await response.arrayBuffer(),digest=new Uint8Array(await crypto.subtle.digest('SHA-256',bytes));
    if(Array.from(digest,b=>b.toString(16).padStart(2,'0')).join('')!==PHONE_MODEL.sha256)throw Error('Model checksum mismatch');
    session=await self.ort.InferenceSession.create(bytes,{executionProviders:['wasm'],graphOptimizationLevel:'all'});
    tensor=new self.ort.Tensor('float32',new Float32Array(3*640*640),[1,3,640,640]);
    const started=performance.now();outputs=await session.run({[session.inputNames[0]]:tensor});
    const dims=outputs[session.outputNames[0]].dims,ms=performance.now()-started;
    tensor.dispose();tensor=null;for(const output of Object.values(outputs))output.dispose();outputs=null;
    await session.release();session=null;
    self.postMessage({type:'success',model:PHONE_MODEL.name,dims,ms,bootstrap:ORT_WASM_SCRIPT});
  }catch(error){self.postMessage({type:'error',message:String(error?.stack||error)});}
  finally{tensor?.dispose();if(outputs)for(const output of Object.values(outputs))output.dispose();if(session)await session.release();}
};
