export function calendarCells(month,events=[]) {
  const first=new Date(`${month}-01T00:00:00Z`);
  const count=new Date(Date.UTC(first.getUTCFullYear(),first.getUTCMonth()+1,0)).getUTCDate();
  const cells=Array.from({length:first.getUTCDay()},()=>null);
  for(let day=1;day<=count;day++){
    const date=`${month}-${String(day).padStart(2,'0')}`;
    cells.push({date,day,events:events.filter(event=>event.date===date&&!/^토요\s*휴업일$/.test(event.name))});
  }
  while(cells.length%7)cells.push(null);
  return cells;
}

export function renderCalendar(container,{month,events=[],selected,today,status,hint},document=globalThis.document) {
  container.replaceChildren();
  const weekdays=document.createElement('div');weekdays.className='school-calendar-weekdays';
  for(const label of ['일','월','화','수','목','금','토']){
    const day=document.createElement('span');day.textContent=label;weekdays.append(day);
  }
  const grid=document.createElement('div');grid.className='school-calendar-grid';
  for(const cell of calendarCells(month,events)){
    const element=document.createElement(cell?'button':'span');
    if(cell){
      element.type='button';element.dataset.schoolCalendarDay=cell.date;
      element.className=`school-calendar-day${cell.events.length?' has-events':''}`;
      element.disabled=Boolean(hint)||status!=='ready';
      element.setAttribute('aria-label',`${cell.date}${cell.events.length?` · ${cell.events.map(event=>event.name).join(', ')}`:' · 일정 없음'}`);
      element.setAttribute('aria-pressed',String(cell.date===selected));
      if(cell.date===today)element.setAttribute('aria-current','date');
      const number=document.createElement('span');number.className='school-calendar-number';number.textContent=String(cell.day);element.append(number);
      if(cell.events.length){
        const badge=document.createElement('span');badge.className='school-calendar-event';
        badge.textContent=cell.events[0].name;badge.title=cell.events.map(event=>event.name).join(' · ');element.append(badge);
        if(cell.events.length>1){const more=document.createElement('span');more.className='school-calendar-more';more.textContent=`+${cell.events.length-1}`;element.append(more);}
      }
    }else element.className='school-calendar-empty';
    grid.append(element);
  }
  container.append(weekdays,grid);
  const reset=document.createElement('button');reset.type='button';reset.className='secondary-button school-calendar-reset';reset.dataset.schoolCalendarAll='';
  reset.textContent=selected?`${Number(selected.slice(5,7))}/${Number(selected.slice(8,10))} 선택 · 전체 일정 보기`:'날짜를 누르면 해당 일정만 볼 수 있어요';reset.disabled=!selected;
  container.append(reset);
}
