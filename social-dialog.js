export function openSocialPanel(kind,trigger) {
  const dialog=document.querySelector(`[data-social-panel="${kind}"]`);
  if(!dialog||dialog.open||dialog.closest('[data-social-content]')?.hidden)return;
  for(const other of document.querySelectorAll('[data-social-panel][open]'))other.close();
  dialog.classList.remove('is-closing');
  dialog.style.animation='none';
  dialog.showModal();
  const origin=trigger?.getBoundingClientRect(),target=dialog.getBoundingClientRect();
  dialog.style.setProperty('--social-from-x',`${origin?origin.left+origin.width/2-(target.left+target.width/2):0}px`);
  dialog.style.setProperty('--social-from-y',`${origin?origin.top+origin.height/2-(target.top+target.height/2):24}px`);
  dialog.style.animation='';
  window.dispatchEvent(new CustomEvent('study:panel-opened',{detail:{kind}}));
}

export async function closeSocialPanel(dialog) {
  if(!dialog?.open||dialog.classList.contains('is-closing'))return;
  dialog.classList.add('is-closing');
  const animations=dialog.getAnimations?.()||[];
  await Promise.allSettled(animations.map(animation=>animation.finished));
  if(dialog.open)dialog.close();
  dialog.classList.remove('is-closing');
}

document.addEventListener('click',event=>{
  const opener=event.target.closest('[data-social-open]');
  if(opener){openSocialPanel(opener.dataset.socialOpen,opener);return;}
  const closer=event.target.closest('[data-social-close]');
  if(closer){void closeSocialPanel(closer.closest('dialog'));return;}
  const dialog=event.target.closest('[data-social-panel]');
  if(!dialog)return;
  if(event.target.closest('a[href]')){dialog.close();return;}
  if(event.target===dialog){
    const box=dialog.getBoundingClientRect();
    if(event.clientX<box.left||event.clientX>box.right||event.clientY<box.top||event.clientY>box.bottom)void closeSocialPanel(dialog);
  }
});
document.addEventListener('cancel',event=>{
  if(!event.target.matches('[data-social-panel]'))return;
  event.preventDefault();void closeSocialPanel(event.target);
},true);
