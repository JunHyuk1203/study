import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { defineSecret } from 'firebase-functions/params';
import { schoolCodes, classroom, neisRows, schoolRecord, chatContents, schoolDates, schoolCalendarRange } from './integrations-domain.js';
import { generateForUser, usageFor } from './ai-service.js';
import { schoolMonth, loadSchoolData, loadUpcomingExams } from './school-service.js';
import { schoolAgent } from './school-agent.js';
import { runPlanTool } from './plan-agent.js';
import { cachedBriefing } from './briefing-cache.js';
import { createDailyNeis } from './neis-cache.js';

const db = getFirestore(getApps()[0] ?? initializeApp(), 'study-data');
const neisKey = defineSecret('NEIS_API_KEY');
const googleKey = defineSecret('GOOGLE_AI_API_KEY');
const options = {region:'asia-northeast3', maxInstances:2, minInstances:0, memory:'256MiB', cpu:'gcf_gen1', concurrency:1, timeoutSeconds:90,
  cors:[/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/, 'https://junhyuk1203.github.io', 'https://study.junhyuk.site']};
function uid(request, verified = false) {
  if (!request.auth) throw new HttpsError('unauthenticated', '로그인해 주세요.');
  if (verified && request.auth.token.email_verified !== true) throw new HttpsError('failed-precondition', '이메일 인증 후 AI를 이용할 수 있습니다.');
  return request.auth.uid;
}
async function rateLimit(user, scope, maximum) {
  const ref = db.doc(`integrationLimits/${user}_${scope}`), now = Date.now();
  await db.runTransaction(async tx => {
    const record = (await tx.get(ref)).data();
    const current = record && now - record.window < 60000;
    if (current && record.count >= maximum) throw new HttpsError('resource-exhausted', '요청이 많습니다. 잠시 후 다시 시도해 주세요.');
    tx.set(ref, {window:current ? record.window : now, count:current ? record.count + 1 : 1, expiresAt:Timestamp.fromMillis(now + 3600000)});
  });
}
function input(action) {
  try { return action(); } catch { throw new HttpsError('invalid-argument', '입력 내용을 확인해 주세요.'); }
}
// Never pass provider errors or request URLs to logs or client responses: NEIS
// authenticates in the URL, whereas Gemini uses a private request header.
const neis = createDailyNeis({db,fetchRows:async (endpoint, params) => {
  try {
    const url = new URL(`https://open.neis.go.kr/hub/${endpoint}`);
    for (const [key,value] of Object.entries({KEY:neisKey.value().trim(), Type:'json', pIndex:1, pSize:1000, ...params})) url.searchParams.set(key, value);
    const response = await fetch(url, {signal:AbortSignal.timeout(18000)});
    if (!response.ok) throw new Error('upstream');
    return neisRows(await response.json(), endpoint);
  } catch { throw new HttpsError('unavailable', '학교 정보를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.'); }
}});
export const searchSchools = onCall({...options, secrets:[neisKey]}, async request => {
  const user = uid(request);
  const query = request.data?.query;
  if (typeof query !== 'string' || query.trim().length < 2 || query.length > 40) throw new HttpsError('invalid-argument', '학교 이름을 2~40자로 입력해 주세요.');
  await rateLimit(user, 'school', 20);
  return {schools:(await neis('schoolInfo', {SCHUL_NM:query.trim(), pSize:30})).map(schoolRecord)};
});
export const saveSchool = onCall({...options, secrets:[neisKey]}, async request => {
  const user = uid(request), codes = input(() => schoolCodes(request.data)), room = input(() => classroom(request.data));
  await rateLimit(user, 'school', 20);
  const rows = await neis('schoolInfo', {ATPT_OFCDC_SC_CODE:codes.officeCode, SD_SCHUL_CODE:codes.schoolCode});
  if (!rows.length) throw new HttpsError('not-found', '학교를 찾을 수 없습니다. 다시 검색해 주세요.');
  const record = schoolRecord(rows[0]);
  input(() => classroom(room, record));
  const school = {...record, ...room}, schoolId = `${codes.officeCode}_${codes.schoolCode}`;
  const profileRef = db.doc(`users/${user}`), week = schoolDates().days[0];
  await db.runTransaction(async tx => {
    const profile = await tx.get(profileRef);
    if (!profile.exists) throw new HttpsError('failed-precondition', '계정이 준비 중입니다. 잠시 후 다시 시도해 주세요.');
    const ranking = await tx.get(db.doc(`leaderboards/${week}/entries/${user}`));
    const previous = profile.data().schoolId;
    if (previous && previous !== schoolId) tx.delete(db.doc(`schoolLeaderboards/${previous}/weeks/${week}/entries/${user}`));
    tx.update(profileRef, {schoolId, school, updatedAt:Timestamp.now()});
    if (ranking.exists) tx.set(db.doc(`schoolLeaderboards/${schoolId}/weeks/${week}/entries/${user}`), ranking.data());
  });
  return {school};
});
export const getSchoolOverview = onCall({...options, secrets:[neisKey]}, async request => {
  const user = uid(request);
  await rateLimit(user, 'school', 20);
  const school = (await db.doc(`users/${user}`).get()).data()?.school;
  const dates = schoolDates();
  const month = input(() => schoolMonth(request.data?.month ?? dates.date.slice(0,7)));
  if (!school) return {school:null, ...dates};
  const calendarRange = schoolCalendarRange(`${month}-01`);
  if (request.data?.eventsOnly === true) {
    const eventData = await loadSchoolData(school, {start:calendarRange.start,end:calendarRange.end,types:['events']}, neis);
    return {school, ...dates, calendarRange, ...eventData};
  }
  const [mealData, timetableData, eventData] = await Promise.all([
    loadSchoolData(school, {start:dates.date, end:dates.date, types:['meals']}, neis),
    loadSchoolData(school, {start:dates.days[0], end:dates.days[4], types:['timetable']}, neis),
    loadSchoolData(school, {start:calendarRange.start,end:calendarRange.end,types:['events']}, neis),
  ]);
  return {school, ...dates,
    meals:mealData.meals,
    timetable:timetableData.timetable,
    calendarRange,
    events:eventData.events,
    errors:{...mealData.errors,...timetableData.errors,...eventData.errors},
  };
});
export const getAiUsage = onCall(options, request => usageFor(uid(request)));
export const getUpcomingExams = onCall({...options,secrets:[neisKey]},async request=>{
  const user=uid(request);
  await rateLimit(user,'school',20);
  const school=(await db.doc(`users/${user}`).get()).data()?.school;
  return loadUpcomingExams(school,neis);
});
export const chatWithStudy = onCall({...options, timeoutSeconds:240, secrets:[googleKey,neisKey]}, async (request,response) => {
  const user = uid(request, true), contents = input(() => chatContents(request.data));
  await rateLimit(user, 'ai', 10);
  const school = (await db.doc(`users/${user}`).get()).data()?.school;
  const result = await schoolAgent({school,contents,lookup:neis,managePlan:(name,args)=>runPlanTool(db,user,name,args),generate:parameters=>generateForUser({
    ...parameters,user,model:request.data?.model,key:googleKey.value(),
    onChunk:request.acceptsStreaming?text=>response.sendChunk({text}):undefined,signal:response?.signal,
  })});
  return {text:result.text,model:result.model,cutoff:result.cutoff,interrupted:result.interrupted||false,usage:result.usage};
});
export const getStudyBriefing = onCall({...options, secrets:[googleKey]}, async request => {
  const user = uid(request, true);
  return cachedBriefing({db,user,force:request.data?.force === true,generate:async period => {
    await rateLimit(user, 'ai', 10);
    const {date,days}=schoolDates();
    const [daily,weekly]=await db.getAll(db.doc(`users/${user}/dailyStats/${date}`),db.doc(`users/${user}/weeklyStats/${days[0]}`));
    const today=daily.data()?.totalSeconds||0, week=weekly.data()?.totalSeconds||0;
    return generateForUser({user,model:'gemini-3.8-flash',key:googleKey.value(),requested:1024,contents:[{role:'user',parts:[{text:`한국 시간 ${period.label}. 오늘 공부 ${Math.floor(today/60)}분, 이번 주 ${Math.floor(week/60)}분. 이 실제 기록만 근거로 오늘 이어서 할 수 있는 구체적인 공부 제안 한 가지를 한국어 두 문장으로 써 줘. 과목과 목표는 등록되지 않았으니 임의로 단정하지 마.`}]}]});
  }});
});
