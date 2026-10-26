// Developer provisioning: reuses the existing Firebase CLI login. Never prints secrets.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawnSync} = require('node:child_process');
const project = 'study-junhyuk1203-20261021';
const account = `study-windows-server@${project}.iam.gserviceaccount.com`;
const target = path.join(process.env.LOCALAPPDATA, 'StudyServer', 'config', 'settings.protected');
function ps(code, input) {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', code], {input, encoding:'utf8', windowsHide:true});
  if(result.status !== 0) throw new Error('Windows protected settings operation failed');
  return result.stdout.trim();
}
function save(settings) {
  ps(`$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $p=[Environment]::GetEnvironmentVariable('STUDY_PROVISION_PATH'); [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($p))|Out-Null; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $v=[Security.Cryptography.ProtectedData]::Protect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [IO.File]::WriteAllBytes($p+'.tmp',$v); Move-Item -LiteralPath ($p+'.tmp') -Destination $p -Force`, Buffer.from(JSON.stringify(settings)).toString('base64'));
}
async function main() {
  process.env.STUDY_PROVISION_PATH = target;
  const {configstore} = require('../node_modules/firebase-tools/lib/configstore');
  const {getAccessToken} = require('../node_modules/firebase-tools/lib/auth');
  const token = await getAccessToken(configstore.get('tokens')?.refresh_token, ['https://www.googleapis.com/auth/cloud-platform']);
  async function api(host, resource, method='GET', body) {
    const response = await fetch(`https://${host}/${resource}`, {method, signal:AbortSignal.timeout(30000), headers:{Authorization:`Bearer ${token.access_token}`, 'Content-Type':'application/json'}, ...(body ? {body:JSON.stringify(body)} : {})});
    const value = await response.json();
    if(!response.ok) { const error = new Error(`${host} ${method}: ${response.status} ${value.error?.status||''}`); error.status=response.status; throw error; }
    return value;
  }
  const secrets=await api('secretmanager.googleapis.com',`v1/projects/${project}/secrets`);
  console.log(JSON.stringify({project, existingSecrets:(secrets.secrets||[]).map(s=>s.name.split('/').pop())}));
  const [ns, dns, publicIp] = await Promise.all([
    fetch('https://dns.google/resolve?name=junhyuk.site&type=NS',{signal:AbortSignal.timeout(15000)}).then(r=>r.json()),
    fetch('https://dns.google/resolve?name=api.study.junhyuk.site&type=A',{signal:AbortSignal.timeout(15000)}).then(r=>r.json()),
    fetch('https://api.ipify.org?format=json',{signal:AbortSignal.timeout(15000)}).then(r=>r.json())
  ]);
  console.log(JSON.stringify({nameServers:ns.Answer?.map(x=>x.data)||[],apiDns:dns.Answer?.map(x=>x.data)||[],publicIp:publicIp.ip}));
  if(!process.argv.includes('--apply')&&!process.argv.includes('--verify')) return;
  let settings={};
  if(fs.existsSync(target)) settings=JSON.parse(ps(`Add-Type -AssemblyName System.Security; $b=[IO.File]::ReadAllBytes($env:STUDY_PROVISION_PATH); [Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))`));
  if(process.argv.includes('--verify')) {
    const appRequire=require('node:module').createRequire(path.resolve(__dirname,'../functions/package.json'));
    const {initializeApp,cert}=appRequire('firebase-admin/app');
    const {getAuth}=appRequire('firebase-admin/auth');
    const app=initializeApp({credential:cert(JSON.parse(settings.ServiceAccountJson)),projectId:project},'provision-check');
    const auth=getAuth(app);
    let lookup=false;
    try { await auth.getUser('__study_server_provision_check__'); lookup=true; } catch(error) { if(error.code==='auth/user-not-found')lookup=true; else throw new Error(`Firebase credential verification: ${error.code}`); }
    const signed=await auth.createCustomToken('__study_server_provision_check__');
    const models=await fetch('https://generativelanguage.googleapis.com/v1beta/models',{headers:{'x-goog-api-key':settings.AiKey},signal:AbortSignal.timeout(15000)});
    console.log(JSON.stringify({protectedSettingsReadable:true,authLookup:lookup,customTokenSigning:signed.split('.').length===3,aiModelsStatus:models.status,neisConfigured:!!settings.NeisKey,noUserCreated:true}));
    return;
  }
  settings={PublicUrl:'https://api.study.junhyuk.site',NetworkMode:'direct',AllowedOrigins:'https://study.junhyuk.site\nhttps://junhyuk1203.github.io\nhttp://127.0.0.1:5173\nhttp://localhost:5173',OwnerPassword:crypto.randomBytes(32).toString('hex'),AppPassword:crypto.randomBytes(32).toString('hex'),DatabaseName:'study',...settings};
  if(!settings.ServiceAccountJson) {
    try { await api('iam.googleapis.com',`v1/projects/${project}/serviceAccounts/${account}`); }
    catch(error) { if(error.status!==404) throw error; await api('iam.googleapis.com',`v1/projects/${project}/serviceAccounts`,'POST',{accountId:'study-windows-server',serviceAccount:{displayName:'STUDY Windows Server',description:'Local STUDY server: Firebase Auth user lookup and private-key custom-token signing only.'}}); }
    const policy=await api('cloudresourcemanager.googleapis.com',`v1/projects/${project}:getIamPolicy`,'POST',{options:{requestedPolicyVersion:3}});
    const member=`serviceAccount:${account}`;
    let binding=policy.bindings.find(b=>b.role==='roles/firebaseauth.viewer'&&!b.condition);
    if(!binding?.members.includes(member)) {
      if(binding) binding.members.push(member); else policy.bindings.push({role:'roles/firebaseauth.viewer',members:[member]});
      await api('cloudresourcemanager.googleapis.com',`v1/projects/${project}:setIamPolicy`,'POST',{policy});
    }
    const key=await api('iam.googleapis.com',`v1/projects/${project}/serviceAccounts/${account}/keys`,'POST',{privateKeyType:'TYPE_GOOGLE_CREDENTIALS_FILE',keyAlgorithm:'KEY_ALG_RSA_2048'});
    settings.ServiceAccountJson=Buffer.from(key.privateKeyData,'base64').toString('utf8');
    try { save(settings); } catch(error) { await api('iam.googleapis.com',`v1/${key.name}`,'DELETE').catch(()=>{}); throw error; }
  }
  for(const [name,field] of [['NEIS_API_KEY','NeisKey'],['GOOGLE_AI_API_KEY','AiKey']]) {
    if(!settings[field]) { const secret=await api('secretmanager.googleapis.com',`v1/projects/${project}/secrets/${name}/versions/latest:access`); settings[field]=Buffer.from(secret.payload.data,'base64').toString('utf8').trim(); save(settings); }
  }
  save(settings);
  console.log(JSON.stringify({provisioned:true,settingsPath:target,serviceAccount:JSON.parse(settings.ServiceAccountJson).client_email,neisConfigured:!!settings.NeisKey,aiConfigured:!!settings.AiKey,mode:settings.NetworkMode}));
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
