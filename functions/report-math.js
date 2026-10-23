const KST = 9 * 3600000;
export const studyDate = (ms = Date.now()) => new Date(ms + KST).toISOString().slice(0, 10);
export function hourlyInterval(start, end) {
  const result = {};
  for (let cursor = Math.floor(start / 1000) * 1000; cursor < end;) {
    const until = Math.min(end, (Math.floor(cursor / 3600000) + 1) * 3600000);
    const date = studyDate(cursor), hour = new Date(cursor + KST).getUTCHours();
    result[date] ??= {};
    result[date][hour] = (result[date][hour] || 0) + Math.floor((until - cursor) / 1000);
    cursor = until;
  }
  return result;
}
export function mergeHours(...maps) {
  const result = {};
  for (const map of maps) for (const [date, hours] of Object.entries(map || {})) {
    result[date] ??= {};
    for (const [hour, seconds] of Object.entries(hours)) result[date][hour] = (result[date][hour] || 0) + seconds;
  }
  return result;
}
export function buildDailyReport(sessions, date) {
  const start = Date.parse(`${date}T00:00:00+09:00`), end = start + 86400000;
  const report = {date, totalSeconds:0, sessionCount:0, longestSeconds:0, elapsedSeconds:0, pauseSeconds:0,
    hourly:Array(24).fill(0), subjectSeconds:{}, sourceSeconds:{}, sessions:[], unallocatedSeconds:0};
  for (const session of sessions) {
    if (session.status !== 'finished') continue;
    const from = Math.max(start, session.startedAtMs), until = Math.min(end, session.endedAtMs);
    if (!(until > from)) continue;
    const seconds = (session.segments || []).filter(row => row.date === date).reduce((sum, row) => sum + row.seconds, 0);
    if (!seconds) continue;
    const elapsed = Math.floor((until - from) / 1000);
    const hours = session.hourlySeconds?.[date] || (!session.cameraMode && !session.activityMode ? hourlyInterval(from, until)[date] : {}) || {};
    const known = Object.values(hours).reduce((sum, value) => sum + value, 0);
    for (let hour = 0; hour < 24; hour++) report.hourly[hour] += hours[hour] || 0;
    report.unallocatedSeconds += Math.max(0, seconds - known);
    report.totalSeconds += seconds; report.sessionCount++;
    report.longestSeconds = Math.max(report.longestSeconds, seconds);
    report.elapsedSeconds += elapsed;
    report.pauseSeconds += Math.max(0, elapsed - seconds);
    report.subjectSeconds[session.subjectId] = (report.subjectSeconds[session.subjectId] || 0) + seconds;
    const source = session.source === 'superword' ? '영단어' : session.cameraMode ? '스터디캠' : '일반 학습';
    report.sourceSeconds[source] = (report.sourceSeconds[source] || 0) + seconds;
    report.sessions.push({id:session.id, subjectId:session.subjectId, from, until, seconds, pauseSeconds:Math.max(0, elapsed-seconds), source});
  }
  report.sessions.sort((a,b) => a.from-b.from);
  report.averageSeconds = report.sessionCount ? Math.floor(report.totalSeconds/report.sessionCount) : 0;
  report.studyRatio = report.elapsedSeconds ? Math.round(report.totalSeconds/report.elapsedSeconds*100) : 0;
  return report;
}
