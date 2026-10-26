import {authReady,getAuthUser,reauthenticateFaceAccount} from './auth.js?v=20261022-1';
import {serverCallable} from './server-client.js?v=20261024-selfhost1';
import {faceStore,faceRecordKey,createBrowserFaceKeys,clearLegacyFaceProfile,deleteLocalFaceAccount} from './face-storage.js';
import {signFace,hashFace} from './face-crypto.js';
import {FACE_POLICY,FACE_ORIGIN,studyNonce} from './functions/face-protocol.js';

let session=null,dialog=null,previousFocus=null,expiryTimer=null,hiddenTimer=null,progressTimer=null,epoch=0,verified=false;
let phase='SIGNED_OUT',lastProgress=-1,lastProgressAt=0;
let channel;
let previewFrame=null,previewFraming=null;
const element=(tag,text,className)=>{const node=document.createElement(tag);if(text)node.textContent=text;if(className)node.className=className;return node;};
const invoke=async(name,data)=>{const response=await serverCallable(name) (data);return response.data;};
const broadcast=()=>{channel??=typeof BroadcastChannel==='function'?new BroadcastChannel('study-face-policy-v1'):null;return channel;};
function ensureStyle(){if(!document.querySelector('[data-face-style]')){const link=document.createElement('link');link.rel='stylesheet';link.href=new URL('./face-enrollment.css',import.meta.url).href;link.dataset.faceStyle='';document.head.append(link);}}
function closeDialog(){clearInterval(progressTimer);progressTimer=null;cancelAnimationFrame(previewFrame);previewFrame=null;previewFraming=null;dialog?.close();dialog?.remove();dialog=null;previousFocus?.focus();previousFocus=null;}
function setPhase(value,label) {
  phase=value;
  const status=dialog?.querySelector('[data-face-status]');
  if(status&&status.textContent!==label)status.textContent=label;
  if(dialog)dialog.dataset.phase=value;
  const cancel=dialog?.querySelector('[data-face-cancel]');if(cancel)cancel.disabled=value==='ENROLLMENT_COMMITTING';
}
function makeDialog(){
  ensureStyle();closeDialog();previousFocus=document.activeElement;
  dialog=element('dialog',null,'face-enrollment');dialog.setAttribute('aria-labelledby','face-enrollment-title');
  dialog.append(element('h2','계정과 얼굴 확인'));dialog.firstChild.id='face-enrollment-title';
  dialog.append(element('p','계정 확인 → 촬영 준비 → 얼굴 등록 → 저장 완료','face-steps'));
  const account=element('p',getAuthUser()?.email||'','face-account');dialog.append(account);
  const status=element('p','계정을 확인하고 있습니다.');status.dataset.faceStatus='';status.setAttribute('role','status');status.setAttribute('aria-live','polite');dialog.append(status);
  const cancel=element('button','취소');cancel.type='button';cancel.dataset.faceCancel='';
  cancel.addEventListener('click',()=>lockFaceSession('얼굴 확인을 취소했습니다.'));
  dialog.addEventListener('cancel',event=>{event.preventDefault();if(phase!=='ENROLLMENT_COMMITTING')lockFaceSession('얼굴 확인을 취소했습니다.');});
  dialog.append(cancel);document.body.append(dialog);dialog.showModal();return dialog;
}
function addPreview(){
  if(!dialog||dialog.querySelector('.face-preview'))return;
  const guide=element('div',null,'face-preview'),video=element('video');video.autoplay=true;video.muted=true;video.playsInline=true;video.setAttribute('aria-hidden','true');guide.append(video);
  const canvas=element('canvas');canvas.width=canvas.height=224;canvas.setAttribute('aria-hidden','true');guide.append(canvas);
  const ring=element('div',null,'face-ring');ring.setAttribute('role','progressbar');ring.setAttribute('aria-label','얼굴 등록 진행률');ring.setAttribute('aria-valuemin','0');ring.setAttribute('aria-valuemax','12');ring.setAttribute('aria-valuenow','0');guide.append(ring);
  const directions=element('p','정면 ○ · 왼쪽 ○ · 오른쪽 ○ · 위 ○ · 아래 ○','face-directions');directions.dataset.faceDirections='';
  dialog.insertBefore(guide,dialog.querySelector('[data-face-cancel]'));dialog.insertBefore(directions,dialog.querySelector('[data-face-cancel]'));
  const hint=element('p','얼굴 전체가 카메라에 나오면 크기·위치를 자동으로 맞춥니다. 안내가 바뀔 때만 고개를 조금 움직이고 잠시 멈춰 주세요.','face-preview-hint');dialog.insertBefore(hint,dialog.querySelector('[data-face-cancel]'));
}
export function attachFacePreview(stream){
  addPreview();const video=dialog?.querySelector('video'),canvas=dialog?.querySelector('canvas');if(!video||!canvas)return;
  video.srcObject=stream;void video.play().catch(()=>{});cancelAnimationFrame(previewFrame);
  const context=canvas.getContext('2d');
  let lastVideoTime=-1;
  const draw=()=>{
    if(!dialog||!canvas.isConnected)return;
    if(video.readyState>=2&&video.currentTime!==lastVideoTime){
      lastVideoTime=video.currentTime;
      context.setTransform(1,0,0,1,0,0);context.fillStyle='#808080';context.fillRect(0,0,224,224);
      if(previewFraming){const {transform:t,width,height}=previewFraming;context.setTransform(t[0]*width/video.videoWidth,t[1]*width/video.videoWidth,t[2]*height/video.videoHeight,t[3]*height/video.videoHeight,t[4],t[5]);}
      else{const scale=224/Math.min(video.videoWidth,video.videoHeight);context.setTransform(scale,0,0,scale,(224-video.videoWidth*scale)/2,(224-video.videoHeight*scale)/2);}
      context.drawImage(video,0,0);context.setTransform(1,0,0,1,0,0);
    }
    previewFrame=requestAnimationFrame(draw);
  };draw();
}
export function faceWorkerContext(){return session;}
export function faceSessionState(){return {phase,verified,profileId:session?.binding?.profileId};}
export function waitForFaceVerification(){
  const current=session;
  if(!current)return Promise.resolve(false);
  if(verified)return Promise.resolve(true);
  return new Promise(resolve=>{
    const finish=()=>{
      window.removeEventListener('study:face-verified',finish);
      window.removeEventListener('study:face-locked',finish);
      resolve(session===current&&verified);
    };
    window.addEventListener('study:face-verified',finish);
    window.addEventListener('study:face-locked',finish);
  });
}
export function lockFaceSession(reason='얼굴 확인을 다시 시작해 주세요.',{remote=false}={}) {
  const old=session;epoch++;session=null;verified=false;phase='PROFILE_LOCKED';
  clearTimeout(expiryTimer);clearTimeout(hiddenTimer);closeDialog();
  if(old?.ticket)void signFace(old.keys,'cancel',old.uid,old.installationId,old.ticket.id).then(signature=>invoke('cancelFaceEnrollment',{installationId:old.installationId,ticketId:old.ticket.id,signature})).catch(()=>{});
  if(remote&&old?.grant)void signFace(old.keys,'lock',old.uid,old.installationId,old.grant.id).then(signature=>invoke('lockFaceEnrollment',{installationId:old.installationId,signature})).catch(()=>{});
  window.dispatchEvent(new CustomEvent('study:face-locked',{detail:{reason}}));
}
async function askReauthentication({enrolling,replace,keys,uid,installationId,revoke=false}) {
  const root=dialog||makeDialog();
  setPhase('DAILY_REAUTH_REQUIRED',enrolling?'계정을 다시 인증한 뒤 이 브라우저에 얼굴을 등록합니다.':'오늘 첫 학습을 위해 계정을 다시 인증해 주세요.');
  const description=element('p',enrolling?'사진과 영상은 저장하지 않습니다. 얼굴 비교 정보는 이 브라우저에 암호화해 보관합니다. 사이트 데이터를 삭제하면 복구할 수 없습니다. 일반 웹캠의 얼굴 확인은 실명 확인이나 Face ID 수준의 위조 탐지를 보장하지 않습니다.':'기존 얼굴 등록을 유지하며 오늘의 계정 인증만 갱신합니다.');root.append(description);
  if(replace)root.append(element('p','이 브라우저의 정보가 없거나 손상되었습니다. 새 등록을 완료하면 이전 브라우저의 활성 등록이 교체됩니다. 기존 얼굴과 불일치했다는 이유로 자동 교체하지 않습니다.','face-warning'));
  const consent=element('label'),checkbox=element('input');checkbox.type='checkbox';consent.append(checkbox,document.createTextNode(enrolling?'안내를 확인했으며 얼굴 비교 정보의 암호화 저장에 동의합니다.':'오늘의 계정 재인증을 진행합니다.'));root.append(consent);
  const passwordAccount=getAuthUser().providerData.some(row=>row.providerId==='password');
  const passwordLabel=element('label','비밀번호'),password=element('input');password.type='password';password.autocomplete='current-password';password.setAttribute('aria-label','계정 비밀번호');if(passwordAccount)root.append(passwordLabel,password);
  const button=element('button',passwordAccount?'계정 인증':'Google 계정으로 다시 인증');button.type='button';root.append(button);
  root.append(root.querySelector('[data-face-cancel]'));
  const attempt=epoch;
  return new Promise((resolve,reject)=>{
    const cancelled=()=>{password.value='';window.removeEventListener('study:face-locked',cancelled);reject(new Error('얼굴 확인을 취소했습니다.'));};
    window.addEventListener('study:face-locked',cancelled,{once:true});
    button.addEventListener('click',async()=>{
      if(!checkbox.checked){setPhase('DAILY_REAUTH_REQUIRED','안내를 확인한 뒤 동의해 주세요.');return;}
      button.disabled=true;
      try{
        const challenge=revoke?null:await invoke('beginDailyFaceAuth',{installationId,publicKey:keys.publicKey,enrollmentOnly:enrolling});
        await reauthenticateFaceAccount({password:password.value,getTotpCode:()=>new Promise(done=>{
          const otp=element('input');otp.inputMode='numeric';otp.autocomplete='one-time-code';otp.setAttribute('aria-label','인증 앱의 6자리 코드');const submit=element('button','인증 코드 확인');submit.type='button';root.append(otp,submit);otp.focus();submit.addEventListener('click',()=>{if(!/^\d{6}$/.test(otp.value))return;const value=otp.value;otp.value='';otp.remove();submit.remove();done(value);},{once:false});
        })});
        password.value='';
        if(epoch!==attempt||getAuthUser()?.uid!==uid)throw new Error('계정 또는 인증 상태가 변경되었습니다.');
        const signature=revoke?null:await signFace(keys,'daily',uid,installationId,challenge.challengeId);
        const result=revoke?{grant:null}:await invoke('completeDailyFaceAuth',{installationId,challengeId:challenge.challengeId,signature});
        window.removeEventListener('study:face-locked',cancelled);
        description.remove();consent.remove();passwordLabel.remove();password.remove();button.remove();
        resolve(result.grant?{...result.grant,serverNowMs:result.serverNowMs}:null);
      }catch(error){password.value='';if(epoch!==attempt)return;setPhase('DAILY_REAUTH_REQUIRED',error.message||'계정을 다시 확인해 주세요.');button.disabled=false;}
    });
    (passwordAccount?password:button).focus();
  });
}
export async function prepareFaceSession(){
  if(!await authReady||!getAuthUser())throw new Error('로그인 후 이용해 주세요.');
  if(location.origin!==FACE_ORIGIN||!crypto.subtle||!globalThis.indexedDB)throw new Error('정식 HTTPS 학습 사이트와 보안 저장소를 지원하는 브라우저가 필요합니다.');
  const attempt=++epoch,uid=getAuthUser().uid;verified=false;
  let installationId=await faceStore('settings','readonly','installation');
  if(!installationId){installationId=crypto.randomUUID();await faceStore('settings','readwrite','installation',installationId);}
  const keyId=`${uid}:${installationId}`;
  let keys=await faceStore('keys','readonly',keyId);
  const status=await invoke('getFaceEnrollmentStatus',{installationId});
  if(!status.enabled)throw new Error('얼굴 보안 키 설정이 필요합니다. 관리자에게 문의해 주세요.');
  let record=status.active?.installationId===installationId?await faceStore('profiles','readonly',faceRecordKey(uid,installationId,status.active.profileId)):null;
  const pendingId=await faceStore('settings','readonly',`${keyId}:pending`);
  const pending=pendingId?await faceStore('profiles','readonly',faceRecordKey(uid,installationId,pendingId)):null;
  // Server confirmation wins over a lost commit response. Uncommitted candidates never unlock.
  if(!record&&pending?.binding.profileId===status.active?.profileId)record=pending;
  const recovering=Boolean(keys&&pending&&pending.binding.profileId===status.pending?.profileId&&pending.ticketId===status.pending.id);
  const enrolling=(!record||!keys)&&!recovering;
  if(!keys){keys=await createBrowserFaceKeys();await faceStore('keys','readwrite',keyId,keys);keys=await faceStore('keys','readonly',keyId);if(!keys?.signingKey||!keys.wrappingKey)throw new Error('이 브라우저는 보안 키 저장을 지원하지 않습니다.');}
  makeDialog();
  let grant=status.grant;
  if(enrolling||!grant)grant=await askReauthentication({enrolling,replace:Boolean(status.active),keys,uid,installationId});
  if(attempt!==epoch||getAuthUser()?.uid!==uid)throw new Error('얼굴 확인이 취소되었습니다.');
  if(recovering){
    const signature=await signFace(keys,'commit',uid,installationId,`${pending.ticketId}:${status.pending.envelopeHash}`);
    const committed=await invoke('commitFaceEnrollment',{installationId,ticketId:pending.ticketId,idempotencyKey:pending.idempotencyKey,envelopeHash:status.pending.envelopeHash,signature});
    record=pending;grant={...committed.grant,serverNowMs:grant.serverNowMs||status.serverNowMs};
  }
  let ticket=null;
  if(enrolling){
    await clearLegacyFaceProfile();
    const persisted=await navigator.storage?.persist?.().catch(()=>false)||false;
    await faceStore('settings','readwrite',`${keyId}:consent`,{policyVersion:FACE_POLICY,persisted,acceptedAt:Date.now()});
    const signature=await signFace(keys,'enroll',uid,installationId,grant.id),idempotencyKey=crypto.randomUUID();
    ({ticket}=await invoke('beginFaceEnrollment',{installationId,idempotencyKey,signature}));
  }
  session={uid,installationId,keys,grant,record,ticket,binding:record?.binding||ticket.binding};
  setPhase(enrolling?'ENROLLING':'VERIFYING',enrolling?'카메라를 편하게 바라봐 주세요. 얼굴 크기와 위치를 자동으로 맞춥니다':'기존에 등록한 얼굴을 확인합니다. 정면을 봐 주세요.');addPreview();
  lastProgressAt=performance.now();lastProgress=-1;
  progressTimer=setInterval(()=>{if(dialog&&phase==='ENROLLING'&&performance.now()-lastProgressAt>45000)setPhase('ENROLLING','촬영이 진행되지 않습니다. 조명·거리·카메라 속도를 확인하거나 취소 후 다시 시도해 주세요. 고개를 움직이기 어렵다면 관리자에게 문의해 주세요.');},5000);
  const now=performance.now(),serverNowMs=grant.serverNowMs||status.serverNowMs,duration=grant.expiresAtMs-serverNowMs;
  session.serverNowMs=serverNowMs;session.monotonicStart=now;
  session.deadline=now+Math.max(0,duration);
  clearTimeout(expiryTimer);expiryTimer=setTimeout(()=>lockFaceSession('날짜가 바뀌었습니다. 오늘의 계정을 다시 인증해 주세요.'),Math.max(0,duration));
  broadcast()?.postMessage({uid,event:'generation',profileId:session.binding.profileId});
  return session;
}
const workerActions=new Set(['beginFaceUnlock','unlockFaceKeyEnvelope','sealFaceKeyEnvelope','commitFaceEnrollment']);
export async function handleFaceWorkerRPC(action,data){
  const current=session;if(!current||!workerActions.has(action)||data.installationId!==current.installationId||getAuthUser()?.uid!==current.uid)throw new Error('얼굴 보안 세션이 종료되었습니다.');
  const result=await invoke(action,data);
  if(session!==current)throw new Error('얼굴 보안 세션이 종료되었습니다.');
  if(action==='commitFaceEnrollment'){current.ticket=null;current.binding=result.active;current.grant=result.grant;current.record=await faceStore('profiles','readonly',faceRecordKey(current.uid,current.installationId,result.active.profileId));broadcast()?.postMessage({uid:current.uid,event:'generation',profileId:result.active.profileId});}
  return result;
}
export function handleFaceWorkerEvent(data){
  if(!session)return;
  if(data.type==='face-framing'){previewFraming=data.framing;return;}
  if(data.type==='face-progress'){
    if(data.progress!==undefined&&data.progress!==lastProgress){lastProgress=data.progress;lastProgressAt=performance.now();}
    setPhase(data.state,data.label||'얼굴 정보를 안전하게 저장하고 있어요');
    const ring=dialog?.querySelector('[role="progressbar"]');if(ring&&data.progress!==undefined){ring.setAttribute('aria-valuenow',String(data.progress));ring.style.setProperty('--face-progress',String(data.progress/12));}
    const directions=dialog?.querySelector('[data-face-directions]');if(directions&&data.counts)directions.textContent=['정면','왼쪽','오른쪽','위','아래'].map((label,i)=>`${label} ${data.counts[i]>=(i?2:4)?'✓':'○'}`).join(' · ');
  }
  if(data.type==='face-unlocked'){session.binding=data.binding;setPhase('VERIFYING','저장된 얼굴을 다시 확인합니다. 정면을 봐 주세요.');}
  if(data.type==='face-verified'&&!verified){verified=true;setPhase('VERIFIED','✓ 얼굴 확인이 완료됐어요');window.dispatchEvent(new Event('study:face-verified'));setTimeout(()=>{if(verified)closeDialog();},500);}
}
export async function faceStudyAuthorization(data){
  const current=session;
  if(!current||!verified||getAuthUser()?.uid!==current.uid||performance.now()>=current.deadline)throw new Error('오늘의 계정 인증과 얼굴 확인을 완료해 주세요.');
  const faceAuthorization={installationId:current.installationId,profileId:current.binding.profileId,generation:current.binding.generation,grantId:current.grant.id,issuedAt:Math.floor(current.serverNowMs+performance.now()-current.monotonicStart)};
  faceAuthorization.signature=await signFace(current.keys,'study',current.uid,current.installationId,studyNonce({...data,faceAuthorization}));return faceAuthorization;
}
export async function deleteFaceEnrollment(){
  if(!await authReady||!getAuthUser())throw new Error('로그인해 주세요.');
  lockFaceSession('얼굴 등록을 삭제하기 위해 계정을 확인합니다.');
  const uid=getAuthUser().uid,installationId=await faceStore('settings','readonly','installation')||crypto.randomUUID();
  await invoke('getFaceEnrollmentStatus',{installationId});makeDialog();
  await askReauthentication({enrolling:false,replace:false,uid,installationId,revoke:true});
  await invoke('revokeFaceEnrollment',{installationId});
  await deleteLocalFaceAccount(uid,installationId);broadcast()?.postMessage({event:'revoked',uid});lockFaceSession('얼굴 등록을 삭제했습니다.');
}
window.addEventListener('study:auth-changed',()=>{if(session&&getAuthUser()?.uid!==session.uid){broadcast()?.postMessage({event:'logout',uid:session.uid});lockFaceSession('계정이 변경되었습니다.',{remote:true});}});
window.addEventListener('pagehide',()=>lockFaceSession('학습 화면이 닫혔습니다.'));
window.addEventListener('study:before-logout',()=>{if(session){broadcast()?.postMessage({event:'logout',uid:session.uid});lockFaceSession('로그아웃했습니다.',{remote:true});}});
document.addEventListener('visibilitychange',()=>{clearTimeout(hiddenTimer);if(document.hidden)hiddenTimer=setTimeout(()=>lockFaceSession('장시간 자리를 비워 얼굴 확인을 잠갔습니다.'),300000);else if(session&&performance.now()>=session.deadline)lockFaceSession('오늘의 계정을 다시 인증해 주세요.');});
broadcast()?.addEventListener('message',({data})=>{if(session&&data?.uid===session.uid&&(data.event!=='generation'||data.profileId!==session.binding.profileId))lockFaceSession('다른 탭에서 계정 또는 얼굴 등록이 변경되었습니다.');});
document.addEventListener('click',event=>{if(event.target.closest('[data-face-delete]'))void deleteFaceEnrollment().catch(error=>window.alert(error.message));});
