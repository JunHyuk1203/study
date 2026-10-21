import { plainText, schoolEvents, schoolDates } from './integrations-domain.js';

export function upcomingExams(events, grade, today) {
  return events.filter(event=>event.date>=today && (!event.grades?.length || event.grades.includes(String(grade))))
    .flatMap(event=>{
      const name=event.name.replace(/\s/g,'');
      const type=/모의고사|모의평가|학력평가|전국연합/.test(name)?'모의고사'
        :/중간|1(?:차|회)(?:지필|고사|시험)/.test(name)?'중간고사'
          :/기말|2(?:차|회)(?:지필|고사|시험)/.test(name)?'기말고사':null;
      return type?[{...event,type}]:[];
    }).sort((a,b)=>a.date.localeCompare(b.date)||a.name.localeCompare(b.name,'ko'));
}

// Share the same future calendar evidence between the home card and AI tool.
export async function loadUpcomingExams(school, neis, now=Date.now()) {
  const start=schoolDates(now).date;
  const end=new Date(Date.parse(`${start}T00:00:00Z`)+179*86400000).toISOString().slice(0,10);
  if(!school)return {school:null,start,end,exams:[],message:'학교 탭에서 학교·학년·반을 먼저 등록해 주세요.'};
  const ranges=Array.from({length:6},(_,index)=>{
    const from=Date.parse(`${start}T00:00:00Z`)+index*30*86400000;
    return {start:new Date(from).toISOString().slice(0,10),end:new Date(from+29*86400000).toISOString().slice(0,10),types:['events']};
  });
  const results=await Promise.all(ranges.map(query=>loadSchoolData(school,query,neis)));
  return {school:results[0].school,start,end,source:results[0].source,
    exams:upcomingExams(results.flatMap(result=>result.events),school.grade,start),
    errors:{events:results.some(result=>result.errors.events)}};
}

export function schoolMonth(value) {
  if (typeof value !== 'string' || !/^(20\d{2})-(0[1-9]|1[0-2])$/.test(value)) throw new Error('invalid-month');
  return value;
}
export function schoolQuery(value) {
  const {start, end, types} = value || {};
  const validDate = date => typeof date === 'string' && /^20\d{2}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(`${date}T00:00:00Z`)) && new Date(`${date}T00:00:00Z`).toISOString().slice(0,10) === date;
  if (!validDate(start) || !validDate(end) || end < start || Date.parse(end) - Date.parse(start) > 30 * 86400000) throw new Error('invalid-range');
  if (!Array.isArray(types) || !types.length || types.length > 3 || types.some(type => !['meals','timetable','events'].includes(type))) throw new Error('invalid-types');
  return {start, end, types:[...new Set(types)]};
}

// Only the authenticated user's stored school is supplied by the caller.
export async function loadSchoolData(school, query, neis) {
  const {start, end, types} = schoolQuery(query);
  if (!school) return {school:null, start, end, message:'학교 탭에서 학교·학년·반을 먼저 등록해 주세요.'};
  const codes = {ATPT_OFCDC_SC_CODE:school.officeCode, SD_SCHUL_CODE:school.schoolCode};
  const endpoint = {'초등학교':'elsTimetable', '중학교':'misTimetable', '고등학교':'hisTimetable', '특수학교':'spsTimetable'}[school.kind];
  const compact = date => date.replaceAll('-', '');
  const data = {school:{name:school.name, grade:school.grade, className:school.className}, start, end, source:'나이스 교육정보 개방 포털', errors:{}};
  await Promise.all(types.map(async type => {
    if (type === 'timetable' && !endpoint) {data.timetable=[];data.errors.timetable=true;return;}
    try {
      const rows = await (type === 'meals'
        ? neis('mealServiceDietInfo', {...codes, MLSV_FROM_YMD:compact(start), MLSV_TO_YMD:compact(end)})
        : type === 'timetable'
          ? neis(endpoint, {...codes, GRADE:school.grade, CLASS_NM:school.className, TI_FROM_YMD:compact(start), TI_TO_YMD:compact(end)})
          : neis('SchoolSchedule', {...codes, AA_FROM_YMD:compact(start), AA_TO_YMD:compact(end)}));
      data[type] = type === 'meals' ? rows.map(row => ({date:row.MLSV_YMD, name:plainText(row.MMEAL_SC_NM), items:plainText(row.DDISH_NM).split('\n').filter(Boolean), calories:plainText(row.CAL_INFO)}))
        : type === 'timetable' ? rows.map(row => ({date:row.ALL_TI_YMD, period:Number(row.PERIO), subject:plainText(row.ITRT_CNTNT)})).filter(row => row.period > 0 && row.period <= 12)
          : schoolEvents(rows);
      data.errors[type] = false;
    } catch {data[type]=[];data.errors[type]=true;}
  }));
  return data;
}
