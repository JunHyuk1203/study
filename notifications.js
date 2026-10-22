let timer;
export function showToast(message) {
  if (!document.body) return;
  let toast = document.querySelector('[data-toast-status]');
  if (!toast) {
    toast = document.createElement('div');toast.className='status-toast';toast.dataset.toastStatus='';
    toast.setAttribute('role','status');toast.setAttribute('aria-live','polite');toast.setAttribute('popover','manual');
    document.body.append(toast);
  }
  window.clearTimeout(timer);
  toast.textContent=message;toast.hidden=false;
  if(!toast.matches(':popover-open'))toast.showPopover?.();
  timer=window.setTimeout(()=>{toast.hidePopover?.();toast.hidden=true;},4000);
}
