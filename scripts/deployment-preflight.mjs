import {execFileSync} from 'node:child_process';
import {readFileSync,statSync} from 'node:fs';
const git=args=>execFileSync('git',args,{encoding:'utf8',windowsHide:true}).trim();
const list=text=>text?text.split(/\r?\n/):[];
const modified=[...list(git(['diff','--name-only','--diff-filter=ACDMRT'])),...list(git(['diff','--cached','--name-only','--diff-filter=ACDMRT']))];
const added=list(git(['ls-files','--others','--exclude-standard','--','docs','functions','server','scripts','tests','face-*.js','face-enrollment.css']));
const files=[...new Set([...modified,...added])].sort();
const patterns=[['private-key',/-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/],['oauth-access-token',/ya29\.[A-Za-z0-9_-]{30,}/],['oauth-refresh-token',/1\/\/[A-Za-z0-9_-]{40,}/],['github-token',/(?:ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/],['literal-ai-secret',/GOOGLE_AI_API_KEY\s*[:=]\s*['"][A-Za-z0-9_-]{25,}/]];
const findings=[];let bytes=0;
for(const file of files){
  if(/^\.codex-|(?:^|\/)(?:node_modules|artifacts|bin|obj|\.git)(?:\/|$)/.test(file))throw Error(`Private/generated path selected: ${file}`);
  const size=statSync(file).size;bytes+=size;if(size>5*1024*1024)throw Error(`Unexpected large source file: ${file}`);
  const text=readFileSync(file,'utf8');for(const [kind,pattern]of patterns)if(pattern.test(text))findings.push({file,kind});
}
if(findings.length){console.error(JSON.stringify({safe:false,findings}));process.exit(1);}
if(process.argv.includes('--stage'))execFileSync('git',['add','--',...files],{stdio:'inherit',windowsHide:true});
console.log(JSON.stringify({safe:true,files:files.length,bytes,staged:process.argv.includes('--stage'),paths:files}));
