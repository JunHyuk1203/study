// Explicit deployment tool. Never prints credentials, keys or KMS response bodies.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
const project='study-junhyuk1203-20261021',location='asia-northeast3';
const ring=`projects/${project}/locations/${location}/keyRings/study-face`;
const key=`${ring}/cryptoKeys/face-envelope`;
const account=`study-windows-server@${project}.iam.gserviceaccount.com`;
const settingsPath=path.join(process.env.USERPROFILE,'AppData/Local/StudyServer/config/settings.protected');
const ps=(code,input)=>execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',code],{input,encoding:'utf8',windowsHide:true,env:{...process.env,STUDY_FACE_SETTINGS_PATH:settingsPath}});
async function main(){
  const {configstore}=require('../node_modules/firebase-tools/lib/configstore');
  const {getAccessToken}=require('../node_modules/firebase-tools/lib/auth');
  const token=await getAccessToken(configstore.get('tokens')?.refresh_token,['https://www.googleapis.com/auth/cloud-platform']);
  async function api(host,resource,{method='GET',body,allow404=false,attempt=0}={}){
    const response=await fetch(`https://${host}/${resource}`,{method,signal:AbortSignal.timeout(30000),headers:{Authorization:`Bearer ${token.access_token}`,'Content-Type':'application/json','x-goog-user-project':project},...(body?{body:JSON.stringify(body)}:{})});
    if(allow404&&response.status===404)return null;
    const value=await response.json();
    if(!response.ok){
      const reason=value.error?.details?.find(item=>item.reason)?.reason;
      if(reason==='SERVICE_DISABLED'&&attempt<12){await new Promise(resolve=>setTimeout(resolve,5000));return api(host,resource,{method,body,allow404,attempt:attempt+1});}
      throw Object.assign(Error(`${host} ${method} ${resource}: ${response.status} ${value.error?.status||'request-failed'} ${reason||''} ${(value.error?.message||'').slice(0,500)}`),{status:response.status});
    }
    return value;
  }
  const service=await api('serviceusage.googleapis.com',`v1/projects/${project}/services/cloudkms.googleapis.com`);
  console.log(JSON.stringify({project,kmsService:service.state,key,apply:process.argv.includes('--apply')}));
  if(!process.argv.includes('--apply'))return;
  if(service.state!=='ENABLED'){
    const operation=await api('serviceusage.googleapis.com',`v1/projects/${project}/services/cloudkms.googleapis.com:enable`,{method:'POST',body:{}});
    if(operation.name)for(let i=0;i<30;i++){const result=await api('serviceusage.googleapis.com',`v1/${operation.name}`);if(result.error)throw Error('KMS enablement failed');if(result.done)break;if(i===29)throw Error('KMS enablement timeout');await new Promise(resolve=>setTimeout(resolve,2000));}
  }
  if(!await api('cloudkms.googleapis.com',`v1/${ring}`,{allow404:true}))await api('cloudkms.googleapis.com',`v1/projects/${project}/locations/${location}/keyRings?keyRingId=study-face`,{method:'POST',body:{}});
  if(!await api('cloudkms.googleapis.com',`v1/${key}`,{allow404:true}))await api('cloudkms.googleapis.com',`v1/${ring}/cryptoKeys?cryptoKeyId=face-envelope`,{method:'POST',body:{purpose:'ENCRYPT_DECRYPT',versionTemplate:{algorithm:'GOOGLE_SYMMETRIC_ENCRYPTION',protectionLevel:'SOFTWARE'},rotationPeriod:'7776000s',nextRotationTime:new Date(Date.now()+90*86400000).toISOString()}});
  const policy=await api('cloudkms.googleapis.com',`v1/${key}:getIamPolicy`),member=`serviceAccount:${account}`,role='roles/cloudkms.cryptoKeyEncrypterDecrypter';
  policy.bindings??=[];let binding=policy.bindings.find(item=>item.role===role&&!item.condition);
  if(!binding){binding={role,members:[]};policy.bindings.push(binding);}
  if(!binding.members.includes(member)){binding.members.push(member);await api('cloudkms.googleapis.com',`v1/${key}:setIamPolicy`,{method:'POST',body:{policy}});}
  let settings=JSON.parse(ps("Add-Type -AssemblyName System.Security; $encrypted=[IO.File]::ReadAllBytes($env:STUDY_FACE_SETTINGS_PATH); [Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect($encrypted,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))"));
  const appRequire=require('node:module').createRequire(path.resolve(__dirname,'../functions/package.json'));
  const {initializeApp,cert}=appRequire('firebase-admin/app');
  const app=initializeApp({projectId:project,credential:cert(JSON.parse(settings.ServiceAccountJson))},'face-kms-deployment');
  const credential=await app.options.credential.getAccessToken();
  const plaintext=crypto.randomBytes(40).toString('base64'),aad=Buffer.from('study-face-deployment-verification-v1').toString('base64');
  async function kms(method,body){
    for(let i=0;i<6;i++){
      const response=await fetch(`https://cloudkms.googleapis.com/v1/${key}:${method}`,{method:'POST',signal:AbortSignal.timeout(20000),headers:{Authorization:`Bearer ${credential.access_token}`,'Content-Type':'application/json'},body:JSON.stringify(body)});
      if(response.ok)return response.json();
      if(response.status===403&&i<5){await new Promise(resolve=>setTimeout(resolve,5000));continue;}
      throw Error(`Service-account KMS ${method}: ${response.status}`);
    }
  }
  const sealed=await kms('encrypt',{plaintext,additionalAuthenticatedData:aad}),opened=await kms('decrypt',{ciphertext:sealed.ciphertext,additionalAuthenticatedData:aad});
  if(opened.plaintext!==plaintext)throw Error('KMS round-trip verification failed');
  settings.FaceKmsKey=key;
  ps("Add-Type -AssemblyName System.Security; $source=$env:STUDY_FACE_SETTINGS_PATH; $backup=$source+'.pre-face-kms-'+(Get-Date -Format 'yyyyMMdd-HHmmss'); Copy-Item -LiteralPath $source -Destination $backup -ErrorAction Stop; $plain=[Text.Encoding]::UTF8.GetBytes([Console]::In.ReadToEnd()); try { $encrypted=[Security.Cryptography.ProtectedData]::Protect($plain,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [IO.File]::WriteAllBytes($source,$encrypted) } finally { [Array]::Clear($plain,0,$plain.Length) }",JSON.stringify(settings));
  settings=null;
  console.log(JSON.stringify({kmsReady:true,key,serviceAccount:account,rotationDays:90,settingsSaved:true,roundTripVerified:true}));
}
main().catch(error=>{console.error(JSON.stringify({ok:false,message:error.message}));process.exitCode=1;});
