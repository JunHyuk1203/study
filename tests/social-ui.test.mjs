import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const socialSource=(await readFile(new URL('../study-social.js',import.meta.url),'utf8')).replace(/^import .*;\r?\n/gm,'');
const reportSource=(await readFile(new URL('../daily-report.js',import.meta.url),'utf8')).replace(/^import .*;\r?\n/gm,'');
function setup(source,{call=async()=>({revision:1,room:null}),report=false}={}) {
  const events={},node={textContent:'',replaceChildren(...children){this.children=children;},append(){}};
  const context=vm.createContext({Date,Promise,console,JSON,Math,Set,FormData:class{},
    authReady:new Promise(()=>{}),user:{uid:'alice',emailVerified:true},getAuthUser:()=>context.user,
    getStudyData:()=>({ready:true,profile:{uid:context.user?.uid,studyRevision:1}}),
    studyDate:()=> '2026-10-23',studyCall:call,serviceError:error=>error.message,showToast(){},
    element:()=>({}),el:()=>({}),duration:value=>String(value),setInterval(){},navigator:{},
    window:{addEventListener:(name,handler)=>{events[name]=handler;}},
    document:{hidden:false,addEventListener(){},querySelector:selector=>report&&selector==='[data-daily-report]'?node:null,
      querySelectorAll:selector=>report&&selector==='[data-daily-report]'?[node]:[]},
  });
  vm.runInContext(source,context);return {context,events,node};
}
test('sign-out clears cached friend identities, invitations and room immediately',()=>{
  const {context,events}=setup(socialSource);
  vm.runInContext("owner='alice';state.friends=[{uid:'private-friend'}];state.room={id:'private-room'};state.roomInvites=[{roomId:'private-invite'}];",context);
  context.user=null;events['study:auth-changed']();
  const result=vm.runInContext('({friends:state.friends.length,room:state.room,invites:state.roomInvites.length,revision})',context);
  assert.equal(result.friends,0);assert.equal(result.room,null);assert.equal(result.invites,0);assert.equal(result.revision,-1);
});
test('an old account snapshot cannot overwrite a newly signed-in account',async()=>{
  let release;
  const {context,events}=setup(socialSource,{call:()=>new Promise(resolve=>{release=resolve;})});
  vm.runInContext("owner='alice';state.room={id:'old-room'};",context);
  const loading=vm.runInContext('poll(true)',context);
  context.user={uid:'bob',emailVerified:true};events['study:auth-changed']();
  release({revision:12,room:{id:'alice-private'},friends:[{uid:'alice-friend'}]});await loading;
  assert.equal(vm.runInContext('state.room',context),null);
  assert.equal(vm.runInContext('state.friends.length',context),0);
});
test('hidden tabs make no room heartbeat or friend-list requests',async()=>{
  let calls=0;const {context}=setup(socialSource,{call:async()=>{calls++;return {};}});
  context.document.hidden=true;vm.runInContext("state.room={id:'test'}",context);
  await vm.runInContext('poll(true)',context);assert.equal(calls,0);
});
test('an unchanged social revision preserves cached lists while refreshing room state',async()=>{
  const {context}=setup(socialSource,{call:async()=>({revision:7,room:null,code:'0123456789'})});
  vm.runInContext("state.friends=[{uid:'friend'}];state.room={id:'test'};revision=7;",context);
  await vm.runInContext('poll(true)',context);
  assert.equal(vm.runInContext('state.friends[0].uid',context),'friend');assert.equal(vm.runInContext('state.room',context),null);
});
test('a failed mutation keeps its message visible after a successful refresh',async()=>{
  const {context}=setup(socialSource,{call:async name=>{if(name==='updateStudySocial')throw new Error('초대가 만료되었습니다.');return {revision:1,room:null};}});
  await vm.runInContext("change('join',{roomId:'test'})",context);
  assert.equal(vm.runInContext('lastError',context),'초대가 만료되었습니다.');assert.equal(vm.runInContext('busy',context),false);
});
test('account changes clear a previously rendered private report before a new fetch',()=>{
  const {context,events,node}=setup(reportSource,{report:true});node.textContent='Alice private report';
  context.user=null;events['study:auth-changed']();
  assert.equal(node.textContent,'로그인하면 오늘의 리포트를 볼 수 있어요.');
  assert.equal(vm.runInContext('cached',context),null);
});
