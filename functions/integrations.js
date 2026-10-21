import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { defineSecret } from 'firebase-functions/params';
import { schoolCodes, classroom, neisRows, plainText, schoolRecord, chatContents, schoolDates } from './integrations-domain.js';
import { generateForUser, usageFor } from './ai-service.js';

const db = getFirestore(getApps()[0] ?? initializeApp(), 'study-data');
const neisKey = defineSecret('NEIS_API_KEY');
const googleKey = defineSecret('GOOGLE_AI_API_KEY');
const options = {region:'asia-northeast3', maxInstances:2, minInstances:0, memory:'256MiB', cpu:'gcf_gen1', concurrency:1, timeoutSeconds:90,
  cors:[/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/, 'https://junhyuk1203.github.io']};
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
const neisCache = new Map();
async function neis(endpoint, params) {
  const cacheId = JSON.stringify([endpoint, params]);
  const cached = neisCache.get(cacheId);
  if (cached && cached.expires > Date.now()) return cached.rows;
  try {
    const url = new URL(`https://open.neis.go.kr/hub/${endpoint}`);
    for (const [key,value] of Object.entries({KEY:neisKey.value().trim(), Type:'json', pIndex:1, pSize:1000, ...params})) url.searchParams.set(key, value);
    const response = await fetch(url, {signal:AbortSignal.timeout(18000)});
    if (!response.ok) throw new Error('upstream');
    const rows = neisRows(await response.json(), endpoint);
    if (neisCache.size > 120) neisCache.clear();
    neisCache.set(cacheId, {rows, expires:Date.now()+600000});
    return rows;
  } catch { throw new HttpsError('unavailable', '학교 정보를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.'); }
}
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
  const school = {...schoolRecord(rows[0]), ...room}, schoolId = `${codes.officeCode}_${codes.schoolCode}`;
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
  if (!school) return {school:null, ...dates};
  const codes = {ATPT_OFCDC_SC_CODE:school.officeCode, SD_SCHUL_CODE:school.schoolCode};
  const endpoint = {'초등학교':'elsTimetable', '중학교':'misTimetable', '고등학교':'hisTimetable', '특수학교':'spsTimetable'}[school.kind];
  const compact = date => date.replaceAll('-', '');
  const results = await Promise.allSettled([
    neis('mealServiceDietInfo', {...codes, MLSV_YMD:compact(dates.date)}),
    endpoint ? neis(endpoint, {...codes, GRADE:school.grade, CLASS_NM:school.className, TI_FROM_YMD:compact(dates.days[0]), TI_TO_YMD:compact(dates.days[4])}) : Promise.resolve([]),
  ]);
  return {school, ...dates,
    meals:results[0].status === 'fulfilled' ? results[0].value.map(row => ({name:plainText(row.MMEAL_SC_NM), items:plainText(row.DDISH_NM).split('\n').filter(Boolean), calories:plainText(row.CAL_INFO)})) : [],
    timetable:results[1].status === 'fulfilled' ? results[1].value.map(row => ({date:row.ALL_TI_YMD, period:Number(row.PERIO), subject:plainText(row.ITRT_CNTNT)})).filter(row=>row.period>0 && row.period<=12) : [],
    errors:{meals:results[0].status==='rejected', timetable:results[1].status==='rejected'},
  };
});
export const getAiUsage = onCall(options, request => usageFor(uid(request)));
export const chatWithStudy = onCall({...options, secrets:[googleKey]}, async (request,response) => {
  const user = uid(request, true), contents = input(() => chatContents(request.data));
  await rateLimit(user, 'ai', 10);
  return generateForUser({user,model:request.data?.model,contents,key:googleKey.value(),onChunk:request.acceptsStreaming?text=>response.sendChunk({text}):undefined,signal:response?.signal});
});
export const getStudyBriefing = onCall({...options, secrets:[googleKey]}, async request => {
  const user = uid(request, true), {date, days} = schoolDates();
  const ref = db.doc(`users/${user}/integrations/briefing`);
  const saved = (await ref.get()).data();
  if (saved?.date === date && Date.now() - saved.updatedAt.toMillis() < 3600000) return {text:saved.text};
  await rateLimit(user, 'ai', 10);
  const today = (await db.doc(`users/${user}/dailyStats/${date}`).get()).data()?.totalSeconds || 0;
  const week = (await db.doc(`users/${user}/weeklyStats/${days[0]}`).get()).data()?.totalSeconds || 0;
  const result = await generateForUser({user,model:'gemini-3.8-flash',key:googleKey.value(),requested:1024,contents:[{role:'user',parts:[{text:`오늘 공부 ${Math.floor(today/60)}분, 이번 주 ${Math.floor(week/60)}분. 이 실제 기록만 근거로 오늘 이어서 할 수 있는 구체적인 공부 제안 한 가지를 한국어 두 문장으로 써 줘. 과목과 목표는 등록되지 않았으니 임의로 단정하지 마.`}]}]});
  const text = result.text;
  await ref.set({date,text,updatedAt:Timestamp.now()});
  return {text,model:'gemini-3.8-flash',cutoff:result.cutoff};
});
