import { getStudyData } from './data.js?v=20261023-2';
import { updatePlan } from './integrations.js?v=20261023-2';
import { planSubjects } from './functions/plan-domain.js?v=20261022-18';
import { goalProgress, goalSummary, durationLabel, periodLabels } from './goal-state.js?v=20261022-18';
import { showToast } from './notifications.js?v=20261022-18';

const rendered = new WeakMap();
let pending = false;
let goalTrigger, closingGoal = false;
function showGoalForm(dialog, visible, focus = false) {
  const form=dialog.querySelector('[data-goal-form]'), button=dialog.querySelector('[data-goal-create]');
  form.hidden=!visible;button.hidden=visible;button.setAttribute('aria-expanded',String(visible));
  closePickers();
  if(focus)(visible ? form.querySelector('[data-picker-toggle]') : button).focus();
}
function closePickers() {
  for(const picker of document.querySelectorAll('.plan-picker')) {
    picker.querySelector('[data-picker-toggle]').setAttribute('aria-expanded','false');picker.querySelector('[role="listbox"]').hidden=true;
  }
}
function selectPicker(picker, value) {
  const options=[...picker.querySelectorAll('[data-picker-value]')];
  const chosen=options.find(option=>option.dataset.pickerValue===value) || options[0];
  if(!chosen)return;
  picker.querySelector('input').value=chosen.dataset.pickerValue;
  picker.querySelector('[data-picker-label]').textContent=chosen.textContent;
  for(const option of options)option.setAttribute('aria-selected',String(option===chosen));
}
function goalFrames(dialog, trigger) {
  const target=dialog.getBoundingClientRect(), origin=trigger.getBoundingClientRect();
  return [{opacity:.25,transform:`translate(${origin.left+origin.width/2-target.left-target.width/2}px,${origin.top+origin.height/2-target.top-target.height/2}px) scale(${origin.width/target.width},${origin.height/target.height})`,borderRadius:'22px'},{opacity:1,transform:'none',borderRadius:'24px'}];
}
function openGoals(trigger) {
  const dialog=document.getElementById(trigger.getAttribute('aria-controls'));
  if(!dialog || dialog.open || closingGoal)return;
  showGoalForm(dialog,false);
  goalTrigger=trigger;trigger.setAttribute('aria-expanded','true');dialog.showModal();
  if(!window.matchMedia('(prefers-reduced-motion: reduce)').matches) dialog.animate(goalFrames(dialog,trigger),{duration:380,easing:'cubic-bezier(.22,.61,.36,1)'});
}
async function closeGoals(dialog) {
  if(!dialog?.open || closingGoal)return;
  closingGoal=true;
  closePickers();
  try {
    if(goalTrigger?.isConnected && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      const animation=dialog.animate(goalFrames(dialog,goalTrigger).reverse(),{duration:240,easing:'cubic-bezier(.4,0,1,1)',fill:'both'});
      try {await animation.finished;} catch {} finally {dialog.close();animation.cancel();}
    } else dialog.close();
  } finally {goalTrigger?.setAttribute('aria-expanded','false');goalTrigger?.focus({preventScroll:true});closingGoal=false;}
}
function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text != null) element.textContent = text;
  return element;
}
function status(message, error = false) {
  for (const element of document.querySelectorAll('[data-plan-status]')) {
    element.textContent = message;element.hidden = !message;element.classList.toggle('is-error',error);
  }
}
function render() {
  const {profile,ready,user,stats,loading,failed} = getStudyData();
  const subjects = planSubjects(profile), goals = profile?.goals || [];
  const summary = goalSummary(goals,stats);
  const statsPending = ['today','days','month'].some(key => loading.has(key));
  const statsFailed = ['today','days','month'].some(key => failed.has(key));
  for (const element of document.querySelectorAll('[data-goal-summary]')) element.textContent = !ready ? '로딩 중…' : !user ? '로그인 후 목표를 세워 보세요' : statsFailed ? '학습 기록 확인 필요' : statsPending && goals.length ? '달성 현황 확인 중…' : `${summary.total}개 중 ${summary.completed}개 달성`;
  for (const element of document.querySelectorAll('[data-goal-summary-progress]')) element.style.width = `${summary.total ? summary.completed / summary.total * 100 : 0}%`;
  for (const element of document.querySelectorAll('[data-goal-list]')) {
    const signature = JSON.stringify([ready,user?.uid,subjects,goals,stats,statsPending,statsFailed]);
    if (rendered.get(element) === signature) continue;
    rendered.set(element,signature);element.replaceChildren();
    if (!ready || !user || !goals.length) {
      element.append(node('p','empty-data',!ready ? '로딩 중…' : !user ? '로그인하면 목표를 계정에 저장할 수 있습니다.' : '첫 목표를 추가해 보세요. 작은 목표부터 시작해도 좋아요.'));
      continue;
    }
    for (const goal of [...goals].sort((a,b) => Number(goalProgress(b,stats).current) - Number(goalProgress(a,stats).current))) {
      const progress = goalProgress(goal,stats), row = node('article',`goal-item${progress.complete ? ' is-complete' : ''}${!progress.current ? ' is-expired' : ''}`);
      const heading = node('div','goal-item-heading');
      const subject = goal.subjectId === 'all' ? '전체 공부' : subjects.find(subject => subject.id === goal.subjectId)?.name || '이전 과목';
      const title = node('div');title.append(node('span','goal-period',`${periodLabels[goal.period]} · ${goal.periodKey}`),node('h3','',`${subject} ${durationLabel(goal.targetSeconds)}`));
      const remove = node('button','goal-remove','삭제');remove.type='button';remove.dataset.goalRemove=goal.id;remove.disabled=pending;remove.setAttribute('aria-label',`${subject} ${periodLabels[goal.period]} 목표 삭제`);
      heading.append(title,remove);row.append(heading);
      row.append(node('p','tiny muted',!progress.current ? '기간 종료' : statsFailed ? '학습 기록을 불러오지 못했습니다. 새로고침해 주세요.' : statsPending ? '학습 기록 확인 중…' : `${durationLabel(progress.seconds)} / ${durationLabel(goal.targetSeconds)}${progress.complete ? ' · 달성 완료 ✓' : ''}`));
      const bar = node('div','progress'), fill = node('i');fill.style.width = `${progress.percent}%`;bar.append(fill);row.append(bar);element.append(row);
    }
  }
  for (const list of document.querySelectorAll('[data-goal-subject]')) {
    const signature = JSON.stringify(subjects);
    if (rendered.get(list) !== signature) {
      list.replaceChildren(...[{id:'all',name:'전체 공부시간'},...subjects].map(subject => {const option=node('button','',subject.name);option.type='button';option.dataset.pickerValue=subject.id;option.setAttribute('role','option');option.tabIndex=-1;return option;}));
      rendered.set(list,signature);
    }
  }
  for(const picker of document.querySelectorAll('.plan-picker'))selectPicker(picker,picker.querySelector('input').value);
  for (const element of document.querySelectorAll('[data-subject-list]')) {
    const signature=JSON.stringify([subjects,pending]);if(rendered.get(element)===signature)continue;
    rendered.set(element,signature);element.replaceChildren();
    for (const subject of subjects) {
      const row=node('div','subject-setting-row');row.append(node('span','',subject.name));
      if(subject.id==='other')row.append(node('span','tiny muted','기본 과목'));
      else {const remove=node('button','goal-remove','삭제');remove.type='button';remove.dataset.subjectRemove=subject.id;remove.disabled=pending;remove.setAttribute('aria-label',`${subject.name} 과목 삭제`);row.append(remove);}
      element.append(row);
    }
  }
  for (const form of document.querySelectorAll('[data-goal-form], [data-subject-form]')) for (const control of form.elements) control.disabled = pending || !ready || !user;
  for (const button of document.querySelectorAll('[data-goal-remove], [data-subject-remove]')) button.disabled=pending || !ready || !user;
}

async function mutate(input, form) {
  if(pending)return;
  const owner=getStudyData().user?.uid;
  pending=true;status('저장 중…');render();
  try {
    await updatePlan(input);
    if(getStudyData().user?.uid!==owner)return;
    form?.reset();status('');showToast(input.action.startsWith('remove') ? '삭제했습니다.' : '계정에 저장했습니다.');
    if(input.action==='addGoal' && form)showGoalForm(form.closest('dialog'),false,true);
  } catch(error) {
    if(getStudyData().user?.uid===owner)status(error.message || '저장하지 못했습니다. 다시 시도해 주세요.',true);
  } finally {pending=false;render();}
}

document.addEventListener('submit',event => {
  const form=event.target;
  if(form.matches('[data-goal-form]')) {
    event.preventDefault();if(!form.reportValidity() || pending)return;
    const minutes=Number(form.elements.hours.value)*60+Number(form.elements.minutes.value);
    if(minutes<1){status('목표 시간을 1분 이상 입력해 주세요.',true);return;}
    void mutate({action:'addGoal',period:form.elements.period.value,subjectId:form.elements.subjectId.value,minutes},form);
  }
  if(form.matches('[data-subject-form]')) {
    event.preventDefault();if(!form.reportValidity() || pending)return;
    void mutate({action:'addSubject',name:form.elements.subjectName.value},form);
  }
});
document.addEventListener('click',event => {
  const create=event.target.closest('[data-goal-create], [data-goal-create-cancel]');
  if(create){showGoalForm(create.closest('dialog'),create.hasAttribute('data-goal-create'),true);status('');return;}
  const pickerToggle=event.target.closest('[data-picker-toggle]');
  if(pickerToggle) {
    const open=pickerToggle.getAttribute('aria-expanded')!=='true';closePickers();
    pickerToggle.setAttribute('aria-expanded',String(open));pickerToggle.closest('.plan-picker').querySelector('[role="listbox"]').hidden=!open;return;
  }
  const option=event.target.closest('[data-picker-value]');
  if(option) {
    const picker=option.closest('.plan-picker');selectPicker(picker,option.dataset.pickerValue);closePickers();picker.querySelector('[data-picker-toggle]').focus();return;
  }
  if(!event.target.closest('.plan-picker'))closePickers();
  const toggle=event.target.closest('[data-goal-toggle]');
  if(toggle) {
    openGoals(toggle);
    return;
  }
  if(event.target.closest('[data-goal-close]')){void closeGoals(event.target.closest('dialog'));return;}
  if(event.target.matches('dialog.goal-dialog')) {
    const box=event.target.getBoundingClientRect();
    if(event.clientX<box.left || event.clientX>box.right || event.clientY<box.top || event.clientY>box.bottom)void closeGoals(event.target);
  }
  const goal=event.target.closest('[data-goal-remove]');if(goal)void mutate({action:'removeGoal',id:goal.dataset.goalRemove});
  const subject=event.target.closest('[data-subject-remove]');if(subject)void mutate({action:'removeSubject',id:subject.dataset.subjectRemove});
});
document.addEventListener('cancel',event => {if(event.target.matches('dialog.goal-dialog')){event.preventDefault();void closeGoals(event.target);}},true);
document.addEventListener('keydown',event => {
  const picker=event.target.closest('.plan-picker');if(!picker)return;
  const trigger=picker.querySelector('[data-picker-toggle]');
  if(event.key==='Escape' && trigger.getAttribute('aria-expanded')==='true'){event.preventDefault();event.stopPropagation();closePickers();trigger.focus();return;}
  if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return;
  event.preventDefault();
  const options=[...picker.querySelectorAll('[data-picker-value]')].filter(option=>!option.disabled);
  if(!options.length)return;
  if(trigger.getAttribute('aria-expanded')!=='true'){closePickers();trigger.setAttribute('aria-expanded','true');picker.querySelector('[role="listbox"]').hidden=false;}
  const index=options.indexOf(document.activeElement), delta=event.key==='ArrowUp'?-1:1;
  const next=event.key==='Home'?0:event.key==='End'?options.length-1:index<0?Math.max(0,options.findIndex(option=>option.getAttribute('aria-selected')==='true')):(index+delta+options.length)%options.length;
  options[next].focus();
});
for(const event of ['study:data-changed','study:navigated','study:page-prepared','study:auth-changed'])window.addEventListener(event,render);
render();
