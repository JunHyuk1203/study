export function planPeriod(period, now = Date.now()) {
  const date = new Date(now + 9 * 3600000).toISOString().slice(0, 10);
  if (period === 'day') return date;
  if (period === 'week') {
    const sunday = new Date(`${date}T00:00:00Z`);
    sunday.setUTCDate(sunday.getUTCDate() - sunday.getUTCDay());
    return sunday.toISOString().slice(0,10);
  }
  if (period === 'month') return date.slice(0, 7);
  throw new Error('오늘·이번 주·이번 달 중 기간을 선택해 주세요.');
}

export function subjectName(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 20 || /[\p{Cc}\p{Cf}]/u.test(value)) throw new Error('과목 이름은 1~20자로 입력해 주세요.');
  return value.trim();
}

export function planSubjects(profile) {
  return [{id:'other',name:'기타'}, ...(profile?.subjects || []).filter(row => row.id !== 'other')];
}

export function goalInput(input, profile, now = Date.now()) {
  const periodKey = planPeriod(input?.period, now);
  const subjectId = input.subjectId || 'all';
  if (subjectId !== 'all' && !planSubjects(profile).some(row => row.id === subjectId)) throw new Error('설정에 추가한 과목을 선택해 주세요.');
  const minutes = input.minutes;
  const month = new Date(now + 9 * 3600000);
  const monthDays = new Date(Date.UTC(month.getUTCFullYear(),month.getUTCMonth()+1,0)).getUTCDate();
  const maximum = {day:1440,week:10080,month:monthDays*1440}[input.period];
  if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > maximum) throw new Error('목표 시간은 기간 안에서 가능한 분 단위로 입력해 주세요.');
  return {period:input.period,periodKey,subjectId,targetSeconds:minutes * 60};
}

export function appendGoal(goals, goal) {
  const duplicate = goals.find(row => row.period === goal.period && row.periodKey === goal.periodKey && row.subjectId === goal.subjectId && row.targetSeconds === goal.targetSeconds);
  if (duplicate) return {goals,goal:duplicate,alreadyExists:true};
  if (goals.length >= 100) throw new Error('목표는 최대 100개입니다. 지난 목표를 삭제해 주세요.');
  return {goals:[...goals,goal],goal,alreadyExists:false};
}
