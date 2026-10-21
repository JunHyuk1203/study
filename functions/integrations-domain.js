export function schoolCodes(data) {
  if (!/^[A-Z]\d{2}$/.test(data?.officeCode || '') || !/^\d{7}$/.test(data?.schoolCode || '')) throw new Error('invalid-school');
  return { officeCode: data.officeCode, schoolCode: data.schoolCode };
}
export function classroom(data) {
  const grade = String(data?.grade ?? ''), className = String(data?.className ?? '');
  if (!/^[1-6]$/.test(grade) || !/^[1-9]\d?$/.test(className)) throw new Error('invalid-class');
  return { grade, className };
}
export function neisRows(body, endpoint) {
  const result = body.RESULT || body[endpoint]?.[0]?.head?.find(item => item.RESULT)?.RESULT;
  if (result?.CODE === 'INFO-200') return [];
  if (result?.CODE !== 'INFO-000') throw new Error('neis-unavailable');
  return body[endpoint]?.[1]?.row || [];
}
export function plainText(value) {
  return String(value || '').replace(/<br\s*\/?\s*>/gi, '\n').replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').trim();
}
export function schoolRecord(row) {
  return { ...schoolCodes({officeCode:row.ATPT_OFCDC_SC_CODE, schoolCode:row.SD_SCHUL_CODE}), name:plainText(row.SCHUL_NM), kind:plainText(row.SCHUL_KND_SC_NM), address:plainText(row.ORG_RDNMA) };
}
export function chatContents(data) {
  if (!Array.isArray(data?.messages) || !data.messages.length || data.messages.length > 13) throw new Error('invalid-chat');
  let total = 0;
  const contents = data.messages.map((message, index) => {
    if (!['user','model'].includes(message?.role) || message.role !== (index % 2 ? 'model' : 'user') || typeof message.text !== 'string' || !message.text.trim() || message.text.length > 4000) throw new Error('invalid-chat');
    total += message.text.length;
    return {role:message.role, parts:[{text:message.text.trim()}]};
  });
  if (total > 24000 || contents.at(-1).role !== 'user') throw new Error('invalid-chat');
  return contents;
}
export function schoolDates(now = Date.now()) {
  const date = new Date(now + 9 * 3600000).toISOString().slice(0,10);
  const monday = new Date(`${date}T00:00:00Z`);
  monday.setUTCDate(monday.getUTCDate() - (monday.getUTCDay() + 6) % 7);
  const days = Array.from({length:5}, (_,i) => new Date(monday.getTime() + i * 86400000).toISOString().slice(0,10));
  return {date, days};
}
export function schoolCalendarRange(date) {
  const start = `${date.slice(0, 7)}-01`;
  const end = new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)), 0)).toISOString().slice(0, 10);
  return {start, end};
}
export function schoolEvents(rows) {
  const events = new Map();
  for (const row of rows) {
    const rawDate = String(row.AA_YMD || '');
    const name = plainText(row.EVENT_NM);
    if (!/^\d{8}$/.test(rawDate) || !name) continue;
    const date = `${rawDate.slice(0,4)}-${rawDate.slice(4,6)}-${rawDate.slice(6,8)}`;
    const description = plainText(row.EVENT_CNTNT);
    const key = JSON.stringify([date, name, description]);
    const flags=['ONE','TW','THREE','FR','FIV','SIX'].map(prefix=>row[`${prefix}_GRADE_EVENT_YN`]);
    const grades=flags.flatMap((flag,index)=>flag==='Y'?[String(index+1)]:[]);
    events.set(key, {date, name, description, ...(grades.length?{grades}:{})});
  }
  return [...events.values()].sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name, 'ko'));
}
