const DAY_MS = 86400000;
const KST_MS = 9 * 3600000;
export const MAX_SESSION_MS = 12 * 3600000;
export const SUBJECTS = ['korean', 'math', 'english', 'science', 'social', 'other'];

export function validDisplayName(value) {
  return typeof value === 'string' && value.trim().length >= 2 && value.trim().length <= 20 && !/[\p{Cc}\p{Cf}]/u.test(value);
}

export function weekKey(date) {
  const day = new Date(`${date}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() - (day.getUTCDay() + 6) % 7);
  return day.toISOString().slice(0, 10);
}

export function splitStudyInterval(startMs, endMs) {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) throw new Error('Invalid session interval');
  const end = Math.min(Math.floor(endMs / 1000) * 1000, startMs + MAX_SESSION_MS);
  const segments = [];
  let cursor = Math.floor(startMs / 1000) * 1000;
  while (cursor < end) {
    const date = new Date(cursor + KST_MS).toISOString().slice(0, 10);
    const nextMidnight = (Math.floor((cursor + KST_MS) / DAY_MS) + 1) * DAY_MS - KST_MS;
    const until = Math.min(end, nextMidnight);
    segments.push({ date, week: weekKey(date), month: date.slice(0, 7), seconds: Math.floor((until - cursor) / 1000) });
    cursor = until;
  }
  return segments;
}

export function advanceStreak(summary, dates) {
  let lastDate = summary.lastStudyDate ?? null;
  let current = summary.currentStreak ?? 0;
  let longest = summary.longestStreak ?? 0;
  for (const date of [...new Set(dates)].sort()) {
    if (date === lastDate) continue;
    current = lastDate && Date.parse(date) - Date.parse(lastDate) === DAY_MS ? current + 1 : 1;
    longest = Math.max(longest, current);
    lastDate = date;
  }
  return { lastStudyDate: lastDate, currentStreak: current, longestStreak: longest };
}
