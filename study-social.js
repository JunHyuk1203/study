import {authReady,getAuthUser} from './auth.js?v=20261022-1';
import {getStudyData} from './data.js?v=20261024-19';
import {studyCall,serviceError,element as el,duration} from './study-api.js';
import {showToast} from './notifications.js?v=20261022-18';
import {roomClock,memberTime,memberStatus} from './room-time.js?v=20261023-16';
import {openSocialPanel} from './social-dialog.js?v=20261023-8';
let state={friends:[],friendRequests:[],sentRequests:[],roomInvites:[],room:null,code:null};
let revision=-1,owner=null,requesting=false,busy=false,lastPoll=0,epoch=0,lastError='';
let roomClockAnchor=null;
const refreshQueue=new Set(),refreshing=new Set();
const roomNow=()=>roomClockAnchor?roomClockAnchor.serverMs+Math.max(0,performance.now()-roomClockAnchor.localMs):Date.now();
function button(text,action,id) {const node=el('button','social-button',text);node.type='button';node.dataset.socialAction=action;if(id)node.dataset.socialId=id;return node;}
function empty(text) {return el('p','empty-data',text);}
function pair(title,description,actions=[]) {
  const row=el('div','social-person'),copy=el('div','social-person-copy');copy.append(el('strong','',title));if(description)copy.append(el('p','tiny muted',description));
  const controls=el('div','social-actions');controls.append(...actions);row.append(copy,controls);return row;
}
function list(selector,rows,fallback,render) {
  for(const root of document.querySelectorAll(selector))root.replaceChildren(...(rows.length?rows.map(render):[empty(fallback)]));
}
function peerCards(room,compact=false) {
  const grid=el('div',compact?'room-peers room-peers-compact':'room-peers');
  const ownUid=getAuthUser()?.uid;
  for(const id of [...room.memberIds].sort((a,b)=>Number(b===ownUid)-Number(a===ownUid))) {
    const member=room.members[id];if(!member)continue;
    const statusValue=memberStatus(member,roomNow()),away=statusValue==='offline',studying=statusValue==='studying';
    const card=el('article',`room-peer${studying?' is-studying':''}`),avatar=el('div','room-avatar',studying?'◷':'☕');avatar.setAttribute('aria-hidden','true');
    const timer=el('span','room-peer-time',roomClock(memberTime(member,roomNow())));timer.dataset.roomMemberTime=id;
    const status=el('span','room-peer-status',away?'오프라인':studying?'공부중':'쉬는중');status.dataset.roomMemberStatus=id;
    card.append(avatar,el('strong','',`${member.displayName}${id===getAuthUser()?.uid?' (나)':''}${id===room.hostUid?' · 방장':''}`),status,el('span','tiny muted',member.subjectName||'시작 전'));
    card.append(el('span','tiny muted','오늘 이 방에서 공부한 시간'),timer);
    grid.append(card);
  }
  return grid;
}
function roomLeaders(room) {
  const root=el('section','room-leaders');root.setAttribute('aria-label','이 방의 공부시간 1위');
  for(const [period,label] of [['today','오늘 1위'],['week','이번 주 1위'],['month','이번 달 1위']]) {
    const rank=room.rankings?.[period],card=el('div','room-leader');
    card.append(el('span','tiny muted',label),el('strong','',rank?.winners?.length?rank.winners.map(row=>`${row.displayName}${row.uid===getAuthUser()?.uid?' (나)':''}`).join(' · '):'아직 기록이 없어요'),el('span','room-peer-time',roomClock(rank?.seconds||0)));
    root.append(card);
  }
  return root;
}
function mergeRoomSnapshot(previous,next) {
  if(!previous||!next||previous.id!==next.id)return next;
  const members={...next.members};let newer=false;
  for(const uid of next.memberIds||[])if(previous.members?.[uid]?.sampledAtMs>(members[uid]?.sampledAtMs??0)){members[uid]=previous.members[uid];newer=true;}
  return {...next,members,...(newer?{rankings:previous.rankings}:{})};
}
function tickRoomTimers() {
  if(document.hidden||!state.room)return;
  const now=roomNow();
  for(const node of document.querySelectorAll('[data-room-member-time]')) {
    const member=state.room.members[node.dataset.roomMemberTime];
    node.textContent=roomClock(memberTime(member,now));
  }
  for(const node of document.querySelectorAll('[data-room-member-status]')) {
    const member=state.room.members[node.dataset.roomMemberStatus];if(!member)continue;
    const status=memberStatus(member,now),studying=status==='studying';
    node.textContent=status==='offline'?'오프라인':studying?'공부중':'쉬는중';
    const card=node.closest('.room-peer');
    card?.classList.toggle('is-studying',studying);
    const avatar=card?.querySelector('.room-avatar');if(avatar)avatar.textContent=studying?'◷':'☕';
  }
}
function paintRefreshButtons() {
  for(const node of document.querySelectorAll('[data-social-scope]')) {
    const pending=refreshing.has(node.dataset.socialScope);
    node.disabled=busy||pending;node.textContent=pending?'갱신 중…':'새로고침';node.setAttribute('aria-busy',String(pending));
  }
}
const expandedRooms=new Set();
function previewCard(row,action='join') {
  const card=el('article','room-preview-card'),heading=el('div','room-heading'),copy=el('div');
  copy.append(el('strong','',row.title),el('p','tiny muted',`${row.permanent?'학년 기본방':row.visibility==='public'?`공개 · ${row.allowOtherGrades?'같은 학교 모든 학년':'같은 학교·학년'}`:'비공개'} · ${row.memberCount}명 참여 중`));
  const enter=button('입장',row.permanent?'joinSchool':action,row.id);enter.disabled=busy||Boolean(state.room);
  heading.append(copy,enter);card.append(heading);
  const details=el('details','room-preview-members');details.dataset.roomPreviewId=row.id;details.open=expandedRooms.has(row.id);
  const summary=el('summary','',`참여자 ${row.memberCount}명 보기`),people=el('ul','room-preview-list');
  if(row.permanent)people.append(el('li','muted','기본방 · 방장 없음'));
  for(const person of row.members||[])people.append(el('li',person.isHost?'room-preview-host':'',`${person.isHost?'방장 · ':''}${person.displayName}${person.isSelf?' (나)':''} · ${person.status==='offline'||!person.online?'오프라인':person.status==='studying'?'공부중':'쉬는중'}${person.participating===false?' · 미참여':''}`));
  if(!row.memberCount)people.append(el('li','muted','아직 참여자가 없어요.'));
  details.append(summary,people);card.append(details);return card;
}
function paintSchoolEntry() {
  const {ready,profile}=getStudyData(),school=profile?.school,user=getAuthUser();
  for(const node of document.querySelectorAll('[data-room-current]'))node.hidden=!state.room;
  for(const node of document.querySelectorAll('[data-room-browse]'))node.hidden=Boolean(state.room);
  for(const label of document.querySelectorAll('[data-school-room-label]'))label.textContent=!ready?'계정 정보를 불러오는 중…':school?`${school.name} ${school.grade}학년 기본방 · 공개·비공개방`:'함께 공부할 방을 만들거나 초대받아 입장하세요';
  list('[data-room-directory]',state.schoolRooms||[],state.schoolRooms?'입장 가능한 방이 없어요. 학교를 등록하거나 새 방을 만들어 보세요.':'방 목록을 불러오는 중…',row=>previewCard(row));
  for(const root of document.querySelectorAll('[data-room-code-preview]'))root.replaceChildren(...(state.codePreview?[previewCard(state.codePreview.preview,'joinCode')]:[]));
  for(const form of document.querySelectorAll('[data-social-form="createRoom"]')) {
    form.hidden=Boolean(state.room);
    const option=form.querySelector('option[value="public"]');if(option)option.disabled=!school||!user?.emailVerified;
  }
  for(const form of document.querySelectorAll('[data-room-settings]')) {
    const room=state.room;form.hidden=!room||room.hostUid!==user?.uid||room.permanent||!room.hostUid;
    if(!form.hidden) {
      const access=room.visibility||(room.type==='school'?'public':'private'),signature=JSON.stringify([room.id,room.title,access,room.allowOtherGrades===true]);
      if(form.dataset.signature!==signature){form.elements.title.value=room.title;form.elements.visibility.value=access;form.elements.allowOtherGrades.checked=room.allowOtherGrades===true;form.dataset.signature=signature;}
    }
  }
  for(const node of document.querySelectorAll('[data-room-code-tools]'))node.hidden=!state.room||state.room.hostUid!==user?.uid||(state.room.visibility||(state.room.type==='school'?'public':'private'))!=='private';
  for(const node of document.querySelectorAll('[data-room-code]'))node.textContent=state.room?.joinCode?.length===6?state.room.joinCode:'새 6자리 방 코드를 생성해 공유하세요.';
}

function paint() {
  const user=getAuthUser(),verified=user?.emailVerified;
  for(const root of document.querySelectorAll('[data-social]')) {
    root.querySelector('[data-social-login]').hidden=Boolean(verified);
    root.querySelector('[data-social-content]').hidden=!verified;
    root.querySelector('[data-social-login]').textContent=!user?'로그인하면 친구를 추가하고 함께 공부할 수 있어요.':'계정에서 이메일 인증을 완료한 뒤 이용해 주세요.';
  }
  for(const node of document.querySelectorAll('[data-friend-code]'))node.textContent=state.code||'코드 만들기를 눌러 주세요';
  for(const node of document.querySelectorAll('[data-social-error]')){node.textContent=lastError;node.hidden=!lastError;}
  for(const node of document.querySelectorAll('[data-friend-request-count]')){node.textContent=String(state.friendRequests.length);node.hidden=!state.friendRequests.length;}
  for(const node of document.querySelectorAll('[data-room-invite-count]')){const count=state.roomInvites.filter(row=>row.expiresAtMs>roomNow()).length;node.textContent=String(count);node.hidden=!count;}
  list('[data-friend-list]',state.friends,'친구 코드를 입력해 첫 친구를 추가해 보세요.',row=>pair(row.displayName,'',[
    ...(state.room&&(state.room.visibility||(state.room.type==='school'?'public':'private'))==='private'&&!state.room.memberIds.includes(row.uid)?[button('방에 초대','inviteOne',row.uid)]:[]),button('삭제','remove',row.uid)]));
  list('[data-friend-requests]',state.friendRequests,'받은 친구 요청이 없어요.',row=>pair(row.displayName,'친구 요청을 보냈어요.',[button('수락','accept',row.uid),button('거절','reject',row.uid)]));
  list('[data-sent-requests]',state.sentRequests,'보낸 친구 요청이 없어요.',row=>pair(row.displayName,'수락 대기 중',[button('취소','cancel',row.uid)]));
  const now=Date.now();
  list('[data-room-invites]',state.roomInvites,'받은 스터디룸 초대가 없어요.',row=>pair(row.title,`${row.hostName}님의 초대 · ${row.expiresAtMs>now?'30분 이내 수락':'만료된 초대'}`,[...(row.expiresAtMs>now?[button('입장','join',row.roomId)]:[]),button('지우기','decline',row.roomId)]));
  for(const root of document.querySelectorAll('[data-room-panel]')) {
    if(!state.room){root.replaceChildren(empty('방을 만들거나 친구의 초대를 수락하면 함께 공부할 수 있어요.'));delete root.dataset.roomId;continue;}
    const room=state.room,isHost=room.hostUid===user?.uid;
    if(root.dataset.roomId!==JSON.stringify([room.id,room.title,room.visibility,room.hostUid])) {
      root.dataset.roomId=JSON.stringify([room.id,room.title,room.visibility,room.hostUid]);root.replaceChildren();
      const heading=el('div','room-heading'),copy=el('div');copy.append(el('h3','',room.title),el('p','tiny muted',room.permanent||!room.hostUid&&room.type==='school'?'학교·학년 기본방 · 상시 운영':`${(room.visibility||(room.type==='school'?'public':'private'))==='public'?'공개':'비공개'} · 모두 나가거나 전원 서비스 미접속 3시간 후 삭제`));
      heading.append(copy,button('나가기','leave',room.id));

      const count=el('p','tiny muted');count.dataset.roomCount='';
      const peers=el('div');peers.dataset.roomPeers='';
      const link=el('a','primary-button','스터디캠으로 함께 공부하기');link.href='study.html#study-camera';
      const invite=el('form','room-invite-form');invite.dataset.socialForm='invite';
      invite.hidden=(room.visibility||(room.type==='school'?'public':'private'))!=='private';
      invite.append(el('h4','','친구 여러 명 초대하기'));const choices=el('div','room-invite-choices');choices.dataset.inviteChoices='';
      const send=el('button','secondary-button','선택한 친구 초대');send.type='submit';invite.append(choices,send);
      root.append(heading,count,peers,link,el('p','tiny muted','이 방에서 공부한 시간만 별도로 누적합니다. 같은 방 재입장 시 이어지며, 오늘 시간은 자정에 초기화됩니다. 이번 주는 월요일부터 집계합니다.'),invite);
    }
    root.querySelector('[data-room-count]').textContent=`${room.memberIds.length}${room.permanent||!room.hostUid&&room.type==='school'?'':'/12'}명 참여 중 · 영상·음성 전송 없이 상태 공유`;
    root.querySelector('[data-room-peers]').replaceChildren(roomLeaders(room),peerCards(room));
    const choices=root.querySelector('[data-invite-choices]'),friends=state.friends.filter(row=>!room.memberIds.includes(row.uid));
    const signature=JSON.stringify(friends.map(row=>[row.uid,row.displayName,room.invitedUids.includes(row.uid)]));
    if(choices.dataset.signature!==signature) {
      choices.dataset.signature=signature;choices.replaceChildren();
      for(const friend of friends){const label=el('label','room-invite-choice'),input=el('input');input.type='checkbox';input.name='uids';input.value=friend.uid;label.append(input,el('span','',friend.displayName),...(room.invitedUids.includes(friend.uid)?[el('span','tiny muted','초대 보냄')]:[]));choices.append(label);}
      if(!friends.length)choices.append(empty('초대할 친구가 없습니다. 플레이 탭에서 친구를 먼저 추가해 주세요.'));
    }
  }
  for(const form of document.querySelectorAll('[data-social-form="createRoom"]'))form.hidden=Boolean(state.room);
  paintDock();
  for(const node of document.querySelectorAll('[data-social] button'))node.disabled=node.hasAttribute('data-social-close')||node.hasAttribute('data-social-open')?false:busy;
  paintSchoolEntry();paintRefreshButtons();tickRoomTimers();
}
function paintDock() {
  let dock=document.querySelector('[data-room-dock]');
  if(!state.room||!getAuthUser()){dock?.remove();return;}
  const focus=document.querySelector('.camera-focus .focus-content');
  if(focus) {
    if(!dock||!focus.contains(dock)){dock?.remove();dock=el('section','room-focus-peers');dock.dataset.roomDock='';focus.append(dock);}
    dock.replaceChildren(el('h3','',`${state.room.title} · ${state.room.memberIds.length}명`),roomLeaders(state.room),peerCards(state.room,true));
  } else if(!document.querySelector('[data-room-panel]')) {
    if(!dock||dock.tagName!=='A'){dock?.remove();dock=el('a','room-dock');dock.dataset.roomDock='';dock.href='study.html#study-room';document.body.append(dock);}
    dock.textContent=`◷ ${state.room.title} · ${state.room.memberIds.length}명 함께 공부 중`;
  } else dock?.remove();
}
async function poll(force=false,listScope) {
  const user=getAuthUser(),play=Boolean(document.querySelector('[data-social]'));
  if(!user?.emailVerified||document.hidden||busy)return;
  if(requesting){if(force){refreshQueue.add(listScope||'all');if(listScope){refreshing.add(listScope);paintRefreshButtons();}}return;}
  const data=getStudyData();if(!data.ready||!data.profile)return;
  if(!play&&!state.room&&!data.profile.activeRoomId)return;
  const period=state.room?5000:20000;
  if(!force&&Date.now()-lastPoll<period)return;
  requesting=true;lastPoll=Date.now();const token=epoch,uid=user.uid;
  if(listScope){refreshing.add(listScope);paintRefreshButtons();}
  try {
    const next=await studyCall('getStudySocial',{revision,includeLists:play,...(document.querySelector('[data-social-panel="rooms"][open]')?{includeSchoolRooms:true}:{}),...(listScope?{listScope}:{})});
    if(token!==epoch||getAuthUser()?.uid!==uid)return;
    const previousRoom=state.room;
    state={...state,...next,room:mergeRoomSnapshot(previousRoom,next.room)};if(play&&!listScope)revision=next.revision;
    if(Number.isFinite(next.serverNowMs))roomClockAnchor={serverMs:next.serverNowMs,localMs:performance.now()};
    if(previousRoom&&!state.room)showToast('스터디룸이 종료되었거나 만료되었습니다.');
    lastError='';paint();
    if(listScope)for(const node of document.querySelectorAll(`[data-social-refresh-status="${listScope}"]`))node.textContent='목록을 최신 상태로 불러왔습니다.';
  } catch(error){if(token===epoch){lastError=serviceError(error);paint();if(listScope)for(const node of document.querySelectorAll(`[data-social-refresh-status="${listScope}"]`))node.textContent='새로고침하지 못했습니다. 다시 시도해 주세요.';}}
  finally{
    requesting=false;if(listScope)refreshing.delete(listScope);else refreshing.clear();paintRefreshButtons();
    if(refreshQueue.size){const next=refreshQueue.has('all')?'all':refreshQueue.values().next().value;if(next==='all')refreshQueue.clear();else refreshQueue.delete(next);void poll(true,next==='all'?undefined:next);}
  }
}
async function change(action,data={}) {
  if(busy)return;
  if(action==='previewCode')state.codePreview=null;
  busy=true;lastError='';paint();const token=++epoch;
  let failure='';
  try {
    const result=await studyCall('updateStudySocial',{action,...data});
    if(token!==epoch)return;
    if(action==='previewCode'){state.codePreview=result;paint();return;}
    if(['join','joinSchool','joinCode','createRoom','createSchoolRoom'].includes(action))state.codePreview=null;
    const messages={code:'내 친구 코드가 준비되었습니다.',request:'친구 요청을 보냈습니다.',accept:'친구가 추가되었습니다.',reject:'친구 요청을 거절했습니다.',cancel:'친구 요청을 취소했습니다.',remove:'친구를 삭제했습니다.',createRoom:'스터디룸을 만들었습니다.',joinCode:'스터디룸에 입장했습니다.',roomCode:'방 코드를 생성했습니다.',updateRoom:'방 설정을 저장했습니다.',joinSchool:'학교·학년 스터디룸에 입장했습니다.',invite:'방 초대를 보냈습니다.',join:'스터디룸에 입장했습니다.',decline:'초대를 지웠습니다.',leave:'스터디룸에서 나왔습니다.',close:'스터디룸을 종료했습니다.'};
    showToast(action==='createSchoolRoom'?'학교·학년 공개방을 만들고 참가했습니다.':messages[action]);revision=-1;
  }catch(error){if(token===epoch){failure=serviceError(error);lastError=failure;showToast(failure);}}
  finally{busy=false;paint();}
  // Force a snapshot even after a failure so stale requests/invitations disappear.
  if(action!=='previewCode')await poll(true);
  if(failure&&token===epoch){lastError=failure;paint();}
}
document.addEventListener('submit',event=>{
  const form=event.target.closest('[data-social-form]');if(!form)return;event.preventDefault();
  const values=new FormData(form),action=form.dataset.socialForm;
  const data=['request','previewCode'].includes(action)?{code:values.get('code')}:['createRoom','createSchoolRoom','updateRoom'].includes(action)?{title:values.get('title'),visibility:values.get('visibility'),allowOtherGrades:values.get('allowOtherGrades')==='on',...(action==='updateRoom'?{roomId:state.room?.id}:{})}:{roomId:state.room?.id,uids:values.getAll('uids')};
  void change(action,data);
});
document.addEventListener('click',event=>{
  const target=event.target.closest('[data-social-action]');if(!target)return;
  const action=target.dataset.socialAction,id=target.dataset.socialId;
  if(action==='refreshSchoolRooms'){void poll(true);return;}
  if(action==='joinCode'){void change(action,{code:state.codePreview?.code});return;}
  if(action==='roomCode'){void change(action,{roomId:state.room?.id});return;}
  if(action==='joinSchool'){void change(action,id?{roomId:id}:{});return;}
  if(action==='refresh'){void poll(true,target.dataset.socialScope);return;}
  if(action==='copy') {
    if(!state.code)return;
    if(!navigator.clipboard){showToast(`내 친구 코드: ${state.code}`);return;}
    void navigator.clipboard.writeText(state.code).then(()=>showToast('친구 코드를 복사했습니다.')).catch(()=>showToast(`내 친구 코드: ${state.code}`));return;
  }
  if(action==='confirmClose'||action==='remove') {
    const dialog=document.querySelector('[data-social-confirm]');if(!dialog)return;
    dialog.querySelector('[data-confirm-text]').textContent=action==='confirmClose'?'모든 참여자의 방이 종료되고 이 방에는 다시 입장할 수 없습니다.':'친구 목록에서 서로 삭제됩니다. 다시 추가하려면 친구 요청이 필요합니다.';
    dialog.querySelector('[data-confirm-action]').dataset.pendingAction=action==='confirmClose'?'close':'remove';dialog.querySelector('[data-confirm-action]').dataset.pendingId=id;dialog.showModal();return;
  }
  if(action==='confirm') {
    const actual=target.dataset.pendingAction,pendingId=target.dataset.pendingId;target.closest('dialog').close();void change(actual,actual==='close'?{roomId:pendingId}:{uid:pendingId});return;
  }
  if(action==='dismiss'){target.closest('dialog').close();return;}
  if(action==='inviteOne'){void change('invite',{roomId:state.room?.id,uids:[id]});return;}
  void change(action,['join','decline','leave','close'].includes(action)?{roomId:id}:{uid:id});
});
document.addEventListener('toggle',event=>{const id=event.target.dataset?.roomPreviewId;if(id){if(event.target.open)expandedRooms.add(id);else expandedRooms.delete(id);}},true);
function navigate(){paint();void poll(true);if(window.location?.hash==='#study-room')openSocialPanel('rooms',document.querySelector('[data-social-open="rooms"]'));}
window.addEventListener('study:navigated',navigate);
window.addEventListener('study:panel-opened',event=>{if(event.detail?.kind==='rooms')void poll(true);});
window.addEventListener('study:data-changed',()=>{paintSchoolEntry();paintDock();void poll();});
window.addEventListener('study:camera-changed',paintDock);
window.addEventListener('study:room-activity',event=>{
  const update=event.detail,uid=getAuthUser()?.uid;
  if(!uid||!state.room||update?.roomId!==state.room.id||!state.room.memberIds.includes(uid)||!update.member)return;
  if((state.room.members[uid]?.sampledAtMs??0)>update.member.sampledAtMs)return;
  state.room={...state.room,members:{...state.room.members,[uid]:update.member},rankings:update.rankings||state.room.rankings};
  if(Number.isFinite(update.serverNowMs))roomClockAnchor={serverMs:update.serverNowMs,localMs:performance.now()};
  paint();
});
window.addEventListener('study:auth-changed',()=>{
  const uid=getAuthUser()?.uid||null;if(uid===owner)return;owner=uid;epoch++;revision=-1;lastPoll=0;lastError='';roomClockAnchor=null;refreshQueue.clear();refreshing.clear();for(const dialog of document.querySelectorAll('[data-social-panel][open]'))dialog.close();expandedRooms.clear();state={friends:[],friendRequests:[],sentRequests:[],roomInvites:[],room:null,code:null};paint();void poll(true);
});
document.addEventListener('visibilitychange',()=>{if(!document.hidden)void poll(true);});
setInterval(()=>{paintDock();void poll();},5000);
setInterval(tickRoomTimers,1000);
window.addEventListener('hashchange',()=>{if(window.location.hash==='#study-room')navigate();});
void authReady.then(navigate);
