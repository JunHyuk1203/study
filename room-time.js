export function roomClock(seconds=0) {
  const value=Math.max(0,Math.floor(Number(seconds)||0));
  return [Math.floor(value/3600),Math.floor(value%3600/60),value%60].map(part=>String(part).padStart(2,'0')).join(':');
}

// Extrapolate only the active interval confirmed by the server. An expired
// camera lease, pause or lost connection must never keep the display counting.
export function memberTime(member,nowMs) {
  const saved=Math.max(0,Number(member?.seconds)||0);
  if(!member||member.status!=='studying')return saved;
  const sampledAt=Number(member.sampledAtMs??member.lastSeenMs);
  const until=Number(member.countUntilMs??sampledAt);
  if(!Number.isFinite(sampledAt)||!Number.isFinite(until)||!Number.isFinite(nowMs))return saved;
  return saved+Math.max(0,Math.floor((Math.min(nowMs,until)-sampledAt)/1000));
}
