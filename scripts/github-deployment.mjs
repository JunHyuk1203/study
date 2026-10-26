import {execFileSync} from 'node:child_process';
const repository=process.argv[2];
if(!['JunHyuk1203/study','JunHyuk1203/superword'].includes(repository))throw Error('Choose an authorized deployment repository');
let token;
try{
  const value=execFileSync('git',['-c','credential.interactive=never','credential','fill'],{input:'protocol=https\nhost=github.com\n\n',encoding:'utf8',windowsHide:true,timeout:15000,env:{...process.env,GIT_TERMINAL_PROMPT:'0'},stdio:['pipe','pipe','pipe']});
  token=value.split(/\r?\n/).find(line=>line.startsWith('password='))?.slice(9);
}catch{/* Public deployment metadata can still be queried without a stored credential. */}
async function get(path){const response=await fetch('https://api.github.com/'+path,{headers:{Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28',...(token?{Authorization:`Bearer ${token}`}:{})},signal:AbortSignal.timeout(20000)});if(!response.ok)return {httpStatus:response.status};return response.json();}
const base=`repos/${repository}`;
const [commit,pages,build,runs]=await Promise.all([get(`${base}/commits/main`),get(`${base}/pages`),get(`${base}/pages/builds/latest`),get(`${base}/actions/runs?branch=main&per_page=5`)]);
console.log(JSON.stringify({repository,head:commit.sha,pages:{url:pages.html_url,status:pages.status,buildType:pages.build_type,source:pages.source,httpStatus:pages.httpStatus},latestBuild:{status:build.status,commit:build.commit,error:build.error,httpStatus:build.httpStatus},runs:runs.workflow_runs?.map(run=>({id:run.id,sha:run.head_sha,status:run.status,conclusion:run.conclusion,url:run.html_url,name:run.name}))},null,2));
