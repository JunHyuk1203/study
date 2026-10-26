import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile,mkdtemp} from 'node:fs/promises';
import {resolve,join,extname} from 'node:path';
import {homedir,tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {createFaceService,authorizeFaceStudy} from '../functions/face-service.js';

const runtime=process.env.STUDY_PLAYWRIGHT_ROOT||join(homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules');
const {chromium}=createRequire(join(runtime,'x.js'))('playwright');
const origin='https://study.junhyuk.site',root=fileURLToPath(new URL('..',import.meta.url));

test('Chromium stores cloned CryptoKeys, seals in a Worker, survives process restart and locks on account change',async()=>{
  const rows=new Map(),envelopes=new Map();let tail=Promise.resolve(),authTime=Math.floor(Date.now()/1000),authCount=0;
  const snapshot=ref=>({exists:rows.has(ref.path),data:()=>structuredClone(rows.get(ref.path))});
  const db={doc:path=>({path,get:async()=>snapshot({path})}),runTransaction:fn=>{
    const result=tail.then(async()=>{const writes=new Map();const value=await fn({get:async ref=>snapshot(ref),set:(ref,data)=>writes.set(ref.path,structuredClone(data))});for(const [key,value]of writes)rows.set(key,value);return value;});tail=result.catch(()=>{});return result;
  }};
  const kms={async seal(value,aad){const id=Buffer.from(randomUUID()).toString('base64');envelopes.set(id,{value,aad});return id;},async open(id,aad){const item=envelopes.get(id);assert.equal(item?.aad,aad);return item.value;}};
  const service=createFaceService({db,kms,projectId:'demo-study'});
  const profile=await mkdtemp(join(tmpdir(),'study-face-browser-'));
  let context;
  let delaySeal=false,releaseSeal,onSeal,failCommitOnce=false;
  const actionCounts=new Map();
  const failures=[];
  async function open(){
    context=await chromium.launchPersistentContext(profile,{headless:true,channel:process.env.STUDY_BROWSER_CHANNEL||'msedge',viewport:{width:390,height:844},reducedMotion:'reduce'});
    await context.exposeFunction('faceCall',async(action,data,uid)=>{
      actionCounts.set(action,(actionCounts.get(action)||0)+1);
      if(action==='sealFaceKeyEnvelope'&&delaySeal){delaySeal=false;await new Promise(resolve=>{releaseSeal=resolve;onSeal?.();});}
      if(action==='commitFaceEnrollment'&&failCommitOnce){failCommitOnce=false;throw Error('일시적 서버 저장 실패 테스트');}
      return service(action,{auth:{uid,token:{email_verified:true,auth_time:authTime,firebase:{sign_in_provider:'password'}}},data});
    });
    await context.exposeFunction('faceReauth',()=>{authTime=Math.floor(Date.now()/1000);authCount++;});
    await context.route('**/*',async route=>{
      const url=new URL(route.request().url());assert.equal(url.origin,origin,'no real provider, camera image or remote model request is allowed in this harness');
      let body,type='text/javascript';
      if(url.pathname==='/'){
        type='text/html';body='<html lang="ko"><head><meta charset="utf-8"></head><body><button id="start">얼굴 확인 시작</button><script type="module">import * as api from "/face-session.js";window.api=api;window.testUid="owner";document.querySelector("#start").onclick=()=>{window.finished=false;window.pending=api.prepareFaceSession().then(()=>{window.finished=true;}).catch(error=>{window.error=error.message;});};window.loaded=true;</script></body></html>';
      }else if(url.pathname==='/auth.js')body='export const authReady=Promise.resolve(true);export const getAuthUser=()=>({uid:window.testUid,email:"test@example.invalid",providerData:[{providerId:"password"}]});export async function reauthenticateFaceAccount(){await window.faceReauth();}';
      else if(url.pathname==='/server-client.js')body='export const serverCallable=name=>async data=>({data:await window.faceCall(name,data,window.testUid)});';
      else if(url.pathname==='/__face-worker.js')body=`let pending=new Map(),seq=0;const rpc=(action,data)=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});postMessage({type:'rpc',id,action,data});});onmessage=async({data})=>{if(data.type==='reply'){const item=pending.get(data.id);pending.delete(data.id);if(data.error)item.reject(Error(data.error));else item.resolve(data.result);return;}try{if(data.failStorage){const original=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(...args){const request=original.apply(this,args);if(this.name==='profiles')request.addEventListener('success',()=>this.transaction.abort());return request;};}const {createFaceVault}=await import('/face-vault.js');const vault=createFaceVault(data.context,rpc,event=>postMessage({type:'event',event}));let samples=await vault.load();if(!samples){const vector=Array(1024).fill(0);vector[0]=1;samples=await vault.save(Array.from({length:12},()=>[...vector]));}postMessage({type:'done',valid:samples.length===12&&samples.every(row=>row.length===1024&&Math.abs(row[0]-1)<.00001)});vault.close();}catch(error){postMessage({type:'error',message:error.message});}};`;
      else if(url.pathname==='/__face-manual-worker.js')body=await readFile(resolve(root,'tests/fixtures/face-manual-worker.js'));
      else{const path=resolve(root,decodeURIComponent(url.pathname.slice(1)));assert.ok(path.startsWith(root));body=await readFile(path);if(extname(path)==='.css')type='text/css';}
      await route.fulfill({status:200,contentType:type,body});
    });
    const page=context.pages()[0];page.on('pageerror',error=>failures.push(error.message));await page.goto(origin);await page.waitForFunction(()=>window.loaded);return page;
  }
  async function runVault(page,failStorage=false){
    await page.evaluate(()=>{window.vaultDone=null;window.vaultError=undefined;const worker=new Worker('/__face-worker.js');window.testWorker=worker;worker.onmessage=async({data})=>{if(data.type==='rpc'){try{const result=await window.api.handleFaceWorkerRPC(data.action,data.data);worker.postMessage({type:'reply',id:data.id,result});}catch(error){worker.postMessage({type:'reply',id:data.id,error:error.message});}}else if(data.type==='event')window.api.handleFaceWorkerEvent(data.event);else if(data.type==='done'){window.vaultDone=data.valid;window.api.handleFaceWorkerEvent({type:'face-verified'});worker.terminate();}else if(data.type==='error')window.vaultError=data.message;};worker.postMessage({context:window.api.faceWorkerContext(),failStorage:window.failStorage===true});});
    await page.waitForFunction(()=>window.vaultDone!==null||window.vaultError);if(failStorage){assert.match(await page.evaluate(()=>window.vaultError),/저장/);assert.notEqual(await page.evaluate(()=>window.vaultDone),true);return;}assert.equal(await page.evaluate(()=>window.vaultError),undefined);assert.equal(await page.evaluate(()=>window.vaultDone),true);
  }
  async function runManualEnrollment(page){
    await page.evaluate(()=>{
      window.guardReady=false;window.guardError=null;window.guardReply=null;
      const worker=new Worker('/__face-manual-worker.js',{type:'module'});window.guardWorker=worker;
      window.confirmCapture=()=>worker.postMessage({type:'confirm'});window.addEventListener('study:face-capture',window.confirmCapture);
      worker.onmessage=async({data})=>{
        if(data.type==='rpc'){try{const result=await window.api.handleFaceWorkerRPC(data.action,data.data);worker.postMessage({type:'reply',id:data.id,result});}catch(error){worker.postMessage({type:'reply',id:data.id,error:error.message});}}
        else if(data.type==='event')window.api.handleFaceWorkerEvent(data.event);
        else if(data.type==='ready')window.guardReady=true;
        else if(data.type==='frame-result')window.guardReply=data.result;
        else if(data.type==='error')window.guardError=data.message;
      };
      worker.postMessage({type:'init',context:window.api.faceWorkerContext()});
    });
    await page.waitForFunction(()=>window.guardReady||window.guardError);assert.equal(await page.evaluate(()=>window.guardError),null);
    let time=0;
    const frame=async(jump=500)=>{
      time+=jump;await page.evaluate(time=>{window.guardReply=null;window.guardWorker.postMessage({type:'frame',time});},time);
      await page.waitForFunction(()=>window.guardReply||window.guardError,{},{timeout:2000});assert.equal(await page.evaluate(()=>window.guardError),null);
      return page.evaluate(()=>window.guardReply);
    };
    await frame();assert.equal(await page.locator('[role=progressbar]').getAttribute('aria-valuenow'),'0');
    let target=0;
    for(const count of [4,2,2,2,2]){
      await page.getByRole('button',{name:'자세 확인 · 촬영',exact:true}).click();
      for(let i=0;i<count;i++)await frame();
      target+=count;assert.equal(await page.locator('[role=progressbar]').getAttribute('aria-valuenow'),String(target));
    }
    delaySeal=true;failCommitOnce=true;const sealPaused=new Promise(resolve=>{onSeal=resolve;});
    await page.getByRole('button',{name:'정면 확인 및 저장',exact:true}).click();
    assert.equal((await frame()).status,'saving');await sealPaused;
    // A storage request pending for longer than the 5s camera watchdog cannot block frame replies.
    assert.equal((await frame(6000)).status,'saving');releaseSeal();
    await page.getByRole('button',{name:'저장 다시 시도',exact:true}).waitFor();
    assert.match(await page.locator('[data-face-status]').textContent(),/일시적 서버 저장 실패 테스트/);
    assert.equal(await page.locator('[role=progressbar]').getAttribute('aria-valuenow'),'12');
    const seals=actionCounts.get('sealFaceKeyEnvelope');
    await page.getByRole('button',{name:'저장 다시 시도',exact:true}).click();
    await frame();await frame();
    await page.waitForFunction(()=>window.api.faceSessionState().phase==='READY');
    assert.equal(await page.locator('.face-enrollment').count(),0);
    assert.equal(await page.evaluate(()=>window.api.faceSessionState().verified),false);
    assert.equal(await page.evaluate(()=>window.api.waitForFaceSessionReady()),true);
    const beforeFirstMatch=await page.evaluate(()=>window.api.faceStudyAuthorization({controllerId:'controller'}));
    assert.equal((await db.runTransaction(tx=>authorizeFaceStudy(tx,db,'owner',{controllerId:'controller',faceAuthorization:beforeFirstMatch}))).verificationType,'face-browser');
    assert.equal(actionCounts.get('sealFaceKeyEnvelope'),seals,'retry reuses the existing ciphertext and envelope');
    for(let i=0;i<6;i++)await frame();
    assert.equal(await page.evaluate(()=>window.api.faceSessionState().verified),true);
    await page.evaluate(()=>{window.removeEventListener('study:face-capture',window.confirmCapture);window.guardWorker.terminate();});
  }
  try{
    let page=await open();await page.click('#start');await page.locator('.face-enrollment input[type=checkbox]').check();await page.locator('input[type=password]').fill('not-a-real-password');await page.getByRole('button',{name:'계정 인증',exact:true}).click();await page.waitForFunction(()=>window.finished);
    await page.evaluate(()=>{window.verificationResult=null;window.verificationWait=window.api.waitForFaceVerification().then(result=>{window.verificationResult=result;});});
    assert.equal(await page.evaluate(()=>window.verificationResult),null);
    // A generated video tests live framing without opening a physical camera.
    await page.evaluate(()=>{
      const source=document.createElement('canvas');source.width=640;source.height=480;
      const context=source.getContext('2d');context.fillStyle='#18243b';context.fillRect(0,0,640,480);context.fillStyle='#cf6953';context.beginPath();context.ellipse(320,260,80,100,0,0,Math.PI*2);context.fill();
      window.previewStream=source.captureStream(5);window.api.attachFacePreview(window.previewStream);
      window.api.handleFaceWorkerEvent({type:'face-framing',framing:{width:640,height:480,transform:[1,0,0,1,-208,-155]}});
    });
    await page.waitForFunction(()=>{const canvas=document.querySelector('.face-preview canvas');return canvas?.getContext('2d').getImageData(112,112,1,1).data[0]>180;});
    await page.screenshot({path:resolve(root,'.codex-face-autoframe-preview.png')});
    await page.evaluate(()=>window.previewStream.getTracks().forEach(track=>track.stop()));
    await runManualEnrollment(page);await page.waitForFunction(()=>!document.querySelector('.face-enrollment'));
    assert.equal(await page.evaluate(()=>window.verificationResult),true);
    const original=await page.evaluate(async()=>{const s=window.api.faceWorkerContext();const {faceStore,faceRecordKey}=await import('/face-storage.js');const record=await faceStore('profiles','readonly',faceRecordKey(s.uid,s.installationId,s.binding.profileId));return {id:s.binding.profileId,ciphertext:record.ciphertext,hasSamples:'samples'in record,hasLocalKey:'wrappedKey'in record,extractable:s.keys.wrappingKey.extractable,state:window.api.faceSessionState()};});
    assert.equal(original.hasSamples,false);assert.equal(original.hasLocalKey,false);assert.equal(original.extractable,false);assert.equal(original.state.verified,true);assert.equal(authCount,1);
    const signed=await page.evaluate(()=>window.api.faceStudyAuthorization({controllerId:'controller',tracking:true,sequence:1}));assert.ok(signed.signature);
    assert.equal((await db.runTransaction(tx=>authorizeFaceStudy(tx,db,'owner',{controllerId:'controller',tracking:true,sequence:1,faceAuthorization:signed}))).verificationType,'face-browser');
    await context.close();page=await open();await page.click('#start');await page.waitForFunction(()=>window.finished);assert.equal(await page.locator('input[type=password]').count(),0);assert.equal(await page.locator('.face-enrollment').count(),0);await runVault(page);assert.equal(authCount,1);
    const restored=await page.evaluate(()=>({id:window.api.faceWorkerContext().binding.profileId,ciphertext:window.api.faceWorkerContext().record.ciphertext}));assert.equal(restored.id,original.id);assert.equal(restored.ciphertext,original.ciphertext);
    await page.evaluate(()=>{window.testUid='other';window.dispatchEvent(new Event('study:auth-changed'));});assert.equal(await page.evaluate(()=>window.api.faceWorkerContext()),null);
    await page.click('#start');await page.locator('.face-enrollment input[type=checkbox]').waitFor();
    const box=await page.locator('.face-enrollment').boundingBox();assert.ok(box.width<=390&&box.height<=844);
    await page.screenshot({path:resolve(root,'.codex-face-enrollment-mobile.png')});
    await page.getByRole('button',{name:'취소',exact:true}).click();await page.waitForFunction(()=>window.error);assert.equal(await page.locator('.face-enrollment').count(),0);assert.equal(rows.get('faceSecurity/owner').active.profileId,original.id);
    await page.click('#start');await page.locator('.face-enrollment input[type=checkbox]').check();await page.locator('input[type=password]').fill('not-a-real-password');await page.getByRole('button',{name:'계정 인증',exact:true}).click();await page.waitForFunction(()=>window.finished);
    await page.evaluate(()=>{window.verificationResult=null;window.verificationWait=window.api.waitForFaceVerification().then(result=>{window.verificationResult=result;});window.failStorage=true;});await runVault(page,true);assert.equal(rows.get('faceSecurity/other').active,undefined);assert.equal(await page.evaluate(()=>window.api.faceSessionState().verified),false);
    await page.evaluate(()=>window.api.handleFaceWorkerEvent({type:'face-progress',state:'RECOVERY_REQUIRED',label:'저장 실패. 취소 후 다시 시도해 주세요.'}));assert.equal(await page.getByRole('button',{name:'취소',exact:true}).isEnabled(),true);await page.getByRole('button',{name:'취소',exact:true}).click();
    assert.equal(await page.evaluate(()=>window.verificationResult),false);
    await page.evaluate(()=>{window.testUid='owner';window.pendingDelete=window.api.deleteFaceEnrollment();});await page.locator('.face-enrollment input[type=checkbox]').check();await page.locator('input[type=password]').fill('not-a-real-password');await page.getByRole('button',{name:'계정 인증',exact:true}).click();await page.evaluate(()=>window.pendingDelete);assert.equal(rows.get('faceSecurity/owner').active.revoked,true);
    const erased=await page.evaluate(async()=>{const {faceStore}=await import('/face-storage.js');const installation=await faceStore('settings','readonly','installation');return await faceStore('keys','readonly',`owner:${installation}`);});assert.equal(erased,undefined);assert.deepEqual(failures,[]);
  }finally{await context?.close();}
});
