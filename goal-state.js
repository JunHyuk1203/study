import { planPeriod } from './functions/plan-domain.js?v=20261022-18';

export const periodLabels = {day:'오늘',week:'이번 주',month:'이번 달'};
export function goalProgress(goal, stats, now = Date.now()) {
  const current = goal.periodKey === planPeriod(goal.period,now);
  const record = stats?.[goal.period] || {};
  const seconds = current ? (goal.subjectId === 'all' ? record.totalSeconds : record.subjectSeconds?.[goal.subjectId]) || 0 : 0;
  return {current,seconds,complete:current && seconds >= goal.targetSeconds,percent:current ? Math.min(100,seconds / goal.targetSeconds * 100) : 0};
}
export function goalSummary(goals = [], stats, now = Date.now()) {
  const active = goals.map(goal => goalProgress(goal,stats,now)).filter(row => row.current);
  return {total:active.length,completed:active.filter(row => row.complete).length};
}
export function durationLabel(seconds) {
  const minutes = Math.floor(seconds / 60), hours = Math.floor(minutes / 60);
  return hours ? `${hours}시간${minutes % 60 ? ` ${minutes % 60}분` : ''}` : `${minutes}분`;
}
