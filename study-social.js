import {authReady,getAuthUser} from './auth.js?v=20261022-1';
import {getStudyData} from './data.js?v=20261023-6';
import {studyCall,serviceError,element as el,duration} from './study-api.js';
import {showToast} from './notifications.js?v=20261022-18';
let state={friends:[],friendRequests:[],sentRequests:[],roomInvites:[],room:null,code:null};
let revision=-1,owner=null,requesting=false,busy=false,lastPoll=0,epoch=0,lastError='';
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
  for(const id of room.memberIds) {
    const member=room.members[id];if(!member)continue;
    const away=Date.now()-member.lastSeenMs>45000,studying=!away&&member.status==='studying';
    const card=el('article',`room-peer${studying?' is-studying':''}`),avatar=el('div','room-avatar',studying?'◷':'☕');avatar.setAttribute('aria-hidden','true');
    card.append(avatar,el('strong','',`${member.displayName}${id===getAuthUser()?.uid?' (나)':''}${id===room.hostUid?' · 방장':''}`),el('span','room-peer-status',away?'연결 확인 중':studying?'공부 중':'휴식 중'),el('span','tiny muted',member.subjectName||'시작 전'),el('span','room-peer-time',duration(member.seconds)));
    grid.append(card);
  }
  return grid;
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
  list('[data-friend-list]',state.friends,'친구 코드를 입력해 첫 친구를 추가해 보세요.',row=>pair(row.displayName,'',[
    ...(state.room&&!state.room.memberIds.includes(row.uid)?[button('방에 초대','inviteOne',row.uid)]:[]),button('삭제','remove',row.uid)]));
  list('[data-friend-requests]',state.friendRequests,'받은 친구 요청이 없어요.',row=>pair(row.displayName,'친구 요청을 보냈어요.',[button('수락','accept',row.uid),button('거절','reject',row.uid)]));
  list('[data-sent-requests]',state.sentRequests,'보낸 친구 요청이 없어요.',row=>pair(row.displayName,'수락 대기 중',[button('취소','cancel',row.uid)]));
  const now=Date.now();
  list('[data-room-invites]',state.roomInvites,'받은 스터디룸 초대가 없어요.',row=>pair(row.title,`${row.hostName}님의 초대 · ${row.expiresAtMs>now?'30분 이내 수락':'만료된 초대'}`,[...(row.expiresAtMs>now?[button('입장','join',row.roomId)]:[]),button('지우기','decline',row.roomId)]));
  for(const root of document.querySelectorAll('[data-room-panel]')) {
    if(!state.room){root.replaceChildren(empty('방을 만들거나 친구의 초대를 수락하면 함께 공부할 수 있어요.'));delete root.dataset.roomId;continue;}
    const room=state.room,isHost=room.hostUid===user?.uid;
    if(root.dataset.roomId!==room.id) {
      root.dataset.roomId=room.id;root.replaceChildren();
      const heading=el('div','room-heading'),copy=el('div');copy.append(el('h3','',room.title),el('p','tiny muted','일회성 방 · 방장이 나가면 종료 · 최대 12시간'));
      heading.append(copy,button(isHost?'방 종료':'나가기',isHost?'confirmClose':'leave',room.id));
      const count=el('p','tiny muted');count.dataset.roomCount='';
      const peers=el('div');peers.dataset.roomPeers='';
      const link=el('a','primary-button','스터디캠으로 함께 공부하기');link.href='study.html';
      const invite=el('form','room-invite-form');invite.dataset.socialForm='invite';
      invite.append(el('h4','','친구 여러 명 초대하기'));const choices=el('div','room-invite-choices');choices.dataset.inviteChoices='';
      const send=el('button','secondary-button','선택한 친구 초대');send.type='submit';invite.append(choices,send);
      root.append(heading,count,peers,link,el('p','tiny muted','공부·휴식 상태와 현재 학습 세션 시간이 약 10초마다 공유됩니다.'),invite);
    }
    root.querySelector('[data-room-count]').textContent=`${room.memberIds.length}/12명 참여 중 · 영상·음성 전송 없이 상태 공유`;
    root.querySelector('[data-room-peers]').replaceChildren(peerCards(room));
    const choices=root.querySelector('[data-invite-choices]'),friends=state.friends.filter(row=>!room.memberIds.includes(row.uid));
    const signature=JSON.stringify(friends.map(row=>[row.uid,row.displayName,room.invitedUids.includes(row.uid)]));
    if(choices.dataset.signature!==signature) {
      choices.dataset.signature=signature;choices.replaceChildren();
      for(const friend of friends){const label=el('label','room-invite-choice'),input=el('input');input.type='checkbox';input.name='uids';input.value=friend.uid;label.append(input,el('span','',friend.displayName),...(room.invitedUids.includes(friend.uid)?[el('span','tiny muted','초대 보냄')]:[]));choices.append(label);}
      if(!friends.length)choices.append(empty('초대할 친구가 없습니다. 친구를 먼저 추가해 주세요.'));
    }
  }
  for(const form of document.querySelectorAll('[data-social-form="createRoom"]'))form.hidden=Boolean(state.room);
  paintDock();
  for(const node of document.querySelectorAll('[data-social] button'))node.disabled=busy;
}
function paintDock() {
  let dock=document.querySelector('[data-room-dock]');
  if(!state.room||!getAuthUser()){dock?.remove();return;}
  const focus=document.querySelector('.camera-focus .focus-content');
  if(focus) {
    if(!dock||!focus.contains(dock)){dock?.remove();dock=el('section','room-focus-peers');dock.dataset.roomDock='';focus.append(dock);}
    dock.replaceChildren(el('h3','',`${state.room.title} · ${state.room.memberIds.length}명`),peerCards(state.room,true));
  } else if(!document.querySelector('[data-social]')) {
    if(!dock||dock.tagName!=='A'){dock?.remove();dock=el('a','room-dock');dock.dataset.roomDock='';dock.href='play.html';document.body.append(dock);}
    dock.textContent=`◷ ${state.room.title} · ${state.room.memberIds.length}명 함께 공부 중`;
  } else dock?.remove();
}
async function poll(force=false) {
  const user=getAuthUser(),play=Boolean(document.querySelector('[data-social]'));
  if(!user?.emailVerified||document.hidden||requesting||busy)return;
  const data=getStudyData();if(!data.ready||!data.profile)return;
  if(!play&&!state.room&&!data.profile.activeRoomId)return;
  const period=state.room?10000:20000;
  if(!force&&Date.now()-lastPoll<period)return;
  requesting=true;lastPoll=Date.now();const token=epoch,uid=user.uid;
  try {
    const next=await studyCall('getStudySocial',{revision,includeLists:play});
    if(token!==epoch||getAuthUser()?.uid!==uid)return;
    const previousRoom=state.room;
    state={...state,...next};if(play)revision=next.revision;
    if(previousRoom&&!state.room)showToast('스터디룸이 종료되었거나 만료되었습니다.');
    lastError='';paint();
  } catch(error){if(token===epoch){lastError=serviceError(error);paint();}}
  finally{requesting=false;}
}
async function change(action,data={}) {
  if(busy)return;
  busy=true;lastError='';paint();const token=++epoch;
  let failure='';
  try {
    await studyCall('updateStudySocial',{action,...data});
    if(token!==epoch)return;
    const messages={code:'내 친구 코드가 준비되었습니다.',request:'친구 요청을 보냈습니다.',accept:'친구가 추가되었습니다.',reject:'친구 요청을 거절했습니다.',cancel:'친구 요청을 취소했습니다.',remove:'친구를 삭제했습니다.',createRoom:'일회성 스터디룸을 만들었습니다.',invite:'방 초대를 보냈습니다.',join:'스터디룸에 입장했습니다.',decline:'초대를 지웠습니다.',leave:'스터디룸에서 나왔습니다.',close:'스터디룸을 종료했습니다.'};
    showToast(messages[action]);revision=-1;
  }catch(error){if(token===epoch){failure=serviceError(error);lastError=failure;showToast(failure);}}
  finally{busy=false;paint();}
  // Force a snapshot even after a failure so stale requests/invitations disappear.
  await poll(true);
  if(failure&&token===epoch){lastError=failure;paint();}
}
document.addEventListener('submit',event=>{
  const form=event.target.closest('[data-social-form]');if(!form)return;event.preventDefault();
  const values=new FormData(form),action=form.dataset.socialForm;
  const data=action==='request'?{code:values.get('code')}:action==='createRoom'?{title:values.get('title')}:{roomId:state.room?.id,uids:values.getAll('uids')};
  void change(action,data);
});
document.addEventListener('click',event=>{
  const target=event.target.closest('[data-social-action]');if(!target)return;
  const action=target.dataset.socialAction,id=target.dataset.socialId;
  if(action==='refresh'){void poll(true);return;}
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
function navigate(){paint();void poll(true);}
window.addEventListener('study:navigated',navigate);
window.addEventListener('study:data-changed',()=>{paintDock();void poll();});
window.addEventListener('study:camera-changed',paintDock);
window.addEventListener('study:auth-changed',()=>{
  const uid=getAuthUser()?.uid||null;if(uid===owner)return;owner=uid;epoch++;revision=-1;lastPoll=0;lastError='';state={friends:[],friendRequests:[],sentRequests:[],roomInvites:[],room:null,code:null};paint();void poll(true);
});
document.addEventListener('visibilitychange',()=>{if(!document.hidden)void poll(true);});
setInterval(()=>{paintDock();void poll();},5000);
void authReady.then(navigate);
