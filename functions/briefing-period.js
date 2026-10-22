// KST slots are shared with the browser; device time is only a cache hint.
export function briefingPeriod(now = Date.now()) {
  const local = new Date(now + 9 * 3600000), hour = local.getUTCHours();
  const date = local.toISOString().slice(0,10);
  const [name, label, end] = hour < 6 ? ['dawn','새벽',6] : hour < 11 ? ['morning','아침',11] : hour < 17 ? ['lunch','점심',17] : hour < 22 ? ['evening','저녁',22] : ['night','심야',24];
  return {id:`${date}-${name}`,date,label,expiresAtMs:Date.parse(`${date}T00:00:00+09:00`)+end*3600000};
}
