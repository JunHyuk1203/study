import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {roomClock,memberTime} from '../room-time.js';
const socialSource=(await readFile(new URL('../study-social.js',import.meta.url),'utf8')).replace(/^import .*;\r?\n/gm,'');
const reportSource=(await readFile(new URL('../daily-report.js',import.meta.url),'utf8')).replace(/^import .*;\r?\n/gm,'');
function setup(source,{call=async()=>({revision:1,room:null}),report=false}={}) {
  const events={},node={textContent:'',replaceChildren(...children){this.children=children;},append(){}};
  const context=vm.createContext({Date,Promise,console,JSON,Math,Set,FormData:class{},
    authReady:new Promise(()=>{}),user:{uid:'alice',emailVerified:true},getAuthUser:()=>context.user,
    getStudyData:()=>({ready:true,profile:{uid:context.user?.uid,studyRevision:1}}),
    studyDate:()=> '2026-10-23',studyCall:call,serviceError:error=>error.message,showToast(){},
    element:()=>({}),el:()=>({}),duration:value=>String(value),roomClock,memberTime,openSocialPanel(){},closeSocialPanel(){},performance:{now:()=>0},setInterval(){},navigator:{},
    window:{addEventListener:(name,handler)=>{events[name]=handler;}},
    document:{hidden:false,addEventListener(){},querySelector:selector=>report&&selector==='[data-daily-report]'?node:null,
      querySelectorAll:selector=>report&&selector==='[data-daily-report]'?[node]:[]},
  });
  vm.runInContext(source,context);return {context,events,node};
}
test('unified room previews show counts, collapsible people and the three presence labels',()=>{
  const {context}=setup(socialSource);
  const node=(tag,classes,textContent)=>({tag,classes,textContent,dataset:{},children:[],append(...children){this.children.push(...children);},replaceChildren(...children){this.children=children;}});
  context.el=node;context.row={id:'preview-room',title:'테스트 방',visibility:'private',memberCount:3,members:[{displayName:'방장',isHost:true,online:true,status:'studying'},{displayName:'친구',online:true,status:'resting'},{displayName:'다른 친구',online:false,status:'offline'}]};
  const card=vm.runInContext('previewCard(row)',context),details=card.children[1];
  assert.equal(details.tag,'details');assert.equal(details.open,false);
  assert.equal(details.children[0].textContent,'참여자 3명 보기');
  assert.deepEqual(details.children[1].children.map(person=>person.textContent),['방장 · 방장 · 공부중','친구 · 쉬는중','다른 친구 · 오프라인']);
  vm.runInContext("expandedRooms.add('preview-room')",context);assert.equal(vm.runInContext('previewCard(row)',context).children[1].open,true);
});

test('private code lookup previews a room without joining it',async()=>{
  const calls=[],preview={id:'private',title:'비공개',memberCount:0,members:[]};
  const {context}=setup(socialSource,{call:async(name,data)=>{calls.push(data);return {code:'ABCDEF123456',preview};}});
  await vm.runInContext("change('previewCode',{code:'ABCDEF123456'})",context);
  assert.equal(calls.length,1);assert.equal(calls[0].action,'previewCode');
  assert.equal(vm.runInContext('state.room',context),null);
  assert.equal(vm.runInContext('state.codePreview.preview.id',context),'private');
});

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
test('service visits outside the study tab still refresh active room presence',async()=>{
  const calls=[];
  const {context}=setup(socialSource,{call:async(name,data)=>{calls.push({name,data});return {room:null,revision:1};}});
  context.getStudyData=()=>({ready:true,profile:{activeRoomId:'active-room'}});
  await vm.runInContext('poll(true)',context);
  assert.equal(calls.length,1);assert.equal(calls[0].name,'getStudySocial');assert.equal(calls[0].data.includeLists,false);
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

test('request refresh forces its own list without consuming the shared revision or replacing invitations',async()=>{
  let args;
  const {context}=setup(socialSource,{call:async(name,data)=>{args=data;return {revision:99,room:null,friendRequests:[{uid:'new-friend'}],sentRequests:[]};}});
  context.document.querySelector=selector=>selector==='[data-social]'?{}:null;
  vm.runInContext("revision=3;state.roomInvites=[{roomId:'keep-invitation'}]",context);
  await vm.runInContext("poll(true,'requests')",context);
  assert.equal(args.listScope,'requests');assert.equal(args.includeLists,true);
  assert.equal(vm.runInContext('revision',context),3);
  assert.equal(vm.runInContext('state.friendRequests[0].uid',context),'new-friend');
  assert.equal(vm.runInContext('state.roomInvites[0].roomId',context),'keep-invitation');
});

test('a list refresh clicked during polling is queued instead of discarded',async()=>{
  let release;const calls=[];
  const {context}=setup(socialSource,{call:async(name,data)=>{calls.push(data);if(calls.length===1)return new Promise(resolve=>{release=resolve;});return {revision:4,room:null,roomInvites:[]};}});
  context.document.querySelector=selector=>selector==='[data-social]'?{}:null;
  const first=vm.runInContext('poll(true)',context);
  await vm.runInContext("poll(true,'invites')",context);
  assert.equal(calls.length,1);release({revision:3,room:null});await first;await Promise.resolve();
  assert.equal(calls.length,2);assert.equal(calls[1].listScope,'invites');
});

test('closed report popups do not fetch detailed records until opened',async()=>{
  let calls=0;const {context,node}=setup(reportSource,{report:true,call:async()=>{calls++;}});
  node.closest=()=>({open:false});
  await vm.runInContext('load()',context);assert.equal(calls,0);
});
