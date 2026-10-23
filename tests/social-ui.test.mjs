import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {roomClock,memberTime,memberStatus} from '../room-time.js';
const socialSource=(await readFile(new URL('../study-social.js',import.meta.url),'utf8')).replace(/^import .*;\r?\n/gm,'');
const reportSource=(await readFile(new URL('../daily-report.js',import.meta.url),'utf8')).replace(/^import .*;\r?\n/gm,'');
function setup(source,{call=async()=>({revision:1,room:null}),report=false}={}) {
  const events={},node={textContent:'',replaceChildren(...children){this.children=children;},append(){}};
  const context=vm.createContext({Date,Promise,console,JSON,Math,Set,FormData:class{},
    authReady:new Promise(()=>{}),user:{uid:'alice',emailVerified:true},getAuthUser:()=>context.user,
    getStudyData:()=>({ready:true,profile:{uid:context.user?.uid,studyRevision:1}}),
    studyDate:()=> '2026-10-23',studyCall:call,serviceError:error=>error.message,showToast(){},
    element:()=>({}),el:()=>({}),duration:value=>String(value),roomClock,memberTime,memberStatus,openSocialPanel(){},closeSocialPanel(){},performance:{now:()=>0},setInterval(){},navigator:{},
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

test('full and focus participant lists put self first and show self room time',()=>{
  const {context}=setup(socialSource);
  context.el=(tag,classes,textContent)=>({tag,classes,textContent,dataset:{},children:[],setAttribute(){},append(...children){this.children.push(...children);}});
  const now=Date.now();context.room={hostUid:'host',memberIds:['host','guest','alice'],members:Object.fromEntries(['host','guest','alice'].map(uid=>[uid,{displayName:uid,lastSeenMs:now,status:'resting',seconds:42}]))};
  for(const compact of [true,false]) {
    const cards=vm.runInContext(`peerCards(room,${compact})`,context).children;
    assert.equal(cards[0].children.find(child=>child.tag==='strong').textContent,'alice (나)');
    assert.equal(cards[0].children.find(child=>child.classes==='room-peer-time').textContent,'00:00:42');
    assert.equal(cards[1].children.find(child=>child.tag==='strong').textContent,'host · 방장');
  }
});
test('late room polls cannot rewind a more recent confirmed resume',()=>{
  const {context}=setup(socialSource);
  context.previous={id:'room',memberIds:['alice'],members:{alice:{sampledAtMs:200,status:'studying'}}};
  context.next={id:'room',memberIds:['alice'],members:{alice:{sampledAtMs:100,status:'resting'}}};
  assert.equal(vm.runInContext('mergeRoomSnapshot(previous,next).members.alice.status',context),'studying');
  context.next.memberIds=[];context.next.members={};
  assert.equal(vm.runInContext('Object.keys(mergeRoomSnapshot(previous,next).members).length',context),0);
});

test('confirmed camera room acknowledgements update self and reject an older reply',()=>{
  const {context,events}=setup(socialSource);
  vm.runInContext("paint=()=>{};state.room={id:'room',memberIds:['alice','peer'],members:{alice:{sampledAtMs:10,status:'resting'},peer:{sampledAtMs:10,status:'studying'}}}",context);
  events['study:room-activity']({detail:{roomId:'room',member:{sampledAtMs:20,status:'studying',seconds:50}}});
  assert.equal(vm.runInContext('state.room.members.alice.status',context),'studying');
  events['study:room-activity']({detail:{roomId:'room',member:{sampledAtMs:15,status:'resting',seconds:0}}});
  assert.equal(vm.runInContext('state.room.members.alice.seconds',context),50);
  assert.equal(vm.runInContext('state.room.members.peer.status',context),'studying');
});

test('room browser shows participation and creation only until joined, then restores them after leaving',()=>{
  const {context}=setup(socialSource),current={hidden:true},join={hidden:false},create={hidden:false};
  context.document.querySelectorAll=selector=>selector==='[data-room-current]'?[current]:selector==='[data-room-browse]'?[join,create]:[];
  vm.runInContext('paintSchoolEntry()',context);
  assert.equal(current.hidden,true);assert.equal(join.hidden,false);assert.equal(create.hidden,false);
  vm.runInContext("state.room={id:'joined-room'};paintSchoolEntry()",context);
  assert.equal(current.hidden,false);assert.equal(join.hidden,true);assert.equal(create.hidden,true);
  vm.runInContext('state.room=null;paintSchoolEntry()',context);
  assert.equal(current.hidden,true);assert.equal(join.hidden,false);assert.equal(create.hidden,false);
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
