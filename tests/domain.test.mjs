import test from 'node:test';
import assert from 'node:assert/strict';
import { advanceStreak, checkpointCamera, MAX_SESSION_MS, splitStudyInterval, validDisplayName, weekKey } from '../functions/domain.js';

test('KST midnight splits daily, weekly and monthly credits correctly', () => {
  const segments = splitStudyInterval(Date.parse('2026-10-31T14:30:00Z'), Date.parse('2026-10-31T15:30:00Z'));
  assert.deepEqual(segments, [
    { date: '2026-10-31', week: '2026-10-26', month: '2026-10', seconds: 1800 },
    { date: '2026-11-01', week: '2026-10-26', month: '2026-11', seconds: 1800 },
  ]);
});

test('Monday starts a new ranking week', () => {
  assert.equal(weekKey('2026-10-25'), '2026-10-19');
  assert.equal(weekKey('2026-10-26'), '2026-10-26');
  const segments = splitStudyInterval(Date.parse('2026-10-25T14:50:00Z'), Date.parse('2026-10-25T15:10:00Z'));
  assert.deepEqual(segments.map(s => [s.week, s.seconds]), [['2026-10-19', 600], ['2026-10-26', 600]]);
});

test('stale sessions cap at twelve hours without trusting a submitted duration', () => {
  const start = Date.parse('2026-10-21T00:00:00Z');
  const segments = splitStudyInterval(start, start + 2 * MAX_SESSION_MS);
  assert.equal(segments.reduce((total, segment) => total + segment.seconds, 0), 43200);
  assert.throws(() => splitStudyInterval(start, start - 1));
});

test('same-day repeats do not inflate streak; missing a day resets it', () => {
  assert.deepEqual(advanceStreak({ lastStudyDate: '2026-10-20', currentStreak: 3, longestStreak: 5 }, ['2026-10-20', '2026-10-21', '2026-10-21']), { lastStudyDate: '2026-10-21', currentStreak: 4, longestStreak: 5 });
  assert.deepEqual(advanceStreak({ lastStudyDate: '2026-10-20', currentStreak: 3, longestStreak: 5 }, ['2026-10-22']), { lastStudyDate: '2026-10-22', currentStreak: 1, longestStreak: 5 });
});

test('account nicknames reject control characters and invalid lengths', () => {
  assert.equal(validDisplayName('준혁'), true);
  assert.equal(validDisplayName('  study  '), true);
  for (const value of ['', 'a', 'a'.repeat(21), 'ab\ncd', 'ab\u202Ecd', null, {}]) assert.equal(validDisplayName(value), false);
});

test('camera pauses exclude gaps and lease expiry cannot backfill offline time', () => {
  const start = Date.parse('2026-10-21T00:00:00Z');
  let session = { startedAtMs: start, segments: [] };
  session = { ...session, ...checkpointCamera(session, start, true) };
  session = { ...session, ...checkpointCamera(session, start + 10000, false) };
  assert.equal(session.accumulatedSeconds, 10);
  session = { ...session, ...checkpointCamera(session, start + 60000, true) };
  session = { ...session, ...checkpointCamera(session, start + 120000, false) };
  assert.equal(session.accumulatedSeconds, 40);
  assert.equal(session.activeSinceMs, null);
  assert.equal(checkpointCamera(session, start + 180000, false).accumulatedSeconds, 40);
});

test('camera heartbeat splits midnight and stops at the session duration limit', () => {
  const start = Date.parse('2026-10-31T14:59:50Z');
  const running = { startedAtMs: start, ...checkpointCamera({ startedAtMs: start }, start, true) };
  const paused = checkpointCamera(running, start + 20000, false);
  assert.deepEqual(paused.segments.map(s => [s.date, s.seconds]), [['2026-10-31', 10], ['2026-11-01', 10]]);
  assert.equal(checkpointCamera(running, start + MAX_SESSION_MS, true).activeSinceMs, null);
});
