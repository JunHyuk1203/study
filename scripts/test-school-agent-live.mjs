// Explicit production smoke test. Uses and removes only its own temporary account.
import {createRequire} from 'node:module';
import {randomBytes,createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {initializeApp,deleteApp} from 'firebase/app';
import {getAuth,createUserWithEmailAndPassword,signOut,signInWithEmailAndPassword} from 'firebase/auth';
import {getFunctions,httpsCallable} from 'firebase/functions';
import {firebaseConfig} from '../firebase-config.js';
import {schoolDates} from '../functions/integrations-domain.js';
import {neisRequestParts} from '../functions/neis-cache.js';

const require=createRequire(import.meta.url),backend=createRequire(new URL('../functions/package.json',import.meta.url));
const cli=require('firebase-tools/lib/auth'),{requireAuth}=require('firebase-tools/lib/requireAuth');
const {initializeApp:adminApp,deleteApp:deleteAdmin}=backend('firebase-admin/app');
const {getAuth:adminAuth}=backend('firebase-admin/auth');
const {Client}=require('firebase-tools/lib/apiv2');
const account=cli.getProjectDefaultAccount(process.cwd());
assert.ok(account,'Firebase CLI login required');
await requireAuth({project:firebaseConfig.projectId,nonInteractive:true,...account});
const admin=adminApp({projectId:firebaseConfig.projectId,credential:{async getAccessToken(){
  const token=await cli.getAccessToken(account.tokens.refresh_token,['https://www.googleapis.com/auth/cloud-platform']);
  return {access_token:token.access_token,expires_in:token.expires_in||3600};
}}},'school-agent-qa-admin');
const db=new Client({urlPrefix:'https://firestore.googleapis.com',auth:true});
const root=`/v1/projects/${firebaseConfig.projectId}/databases/study-data/documents`;
const app=initializeApp(firebaseConfig,'school-agent-qa-client'),auth=getAuth(app),functions=getFunctions(app,'asia-northeast3');
const invoke=(name,data={})=>httpsCallable(functions,name,{timeout:245000})(data).then(result=>result.data);
const masanExam=process.argv.includes('--masan-exam');
const cacheOnly=process.argv.includes('--cache-only');
const email=`qa-school-${randomBytes(10).toString('hex')}@example.test`,password=randomBytes(24).toString('base64url');
let user,schoolId;
async function reservations() {
  const result=await db.post(`${root}:runQuery`,{structuredQuery:{from:[{collectionId:'aiReservations'}],where:{fieldFilter:{field:{fieldPath:'user'},op:'EQUAL',value:{stringValue:user}}},limit:100}});
  return (result.body||[]).filter(row=>row.document).map(row=>row.document);
}
async function chat(text,model='gemini-3.8-flash',history=[]) {
  const before=(await reservations()).length;
  const request=await httpsCallable(functions,'chatWithStudy',{timeout:245000}).stream({model,messages:[...history,{role:'user',text}]});
  let chunks=0;for await(const chunk of request.stream)if(chunk.text)chunks++;
  const answer=await request.data;assert.ok(answer.text?.trim()&&chunks,`Empty AI answer: ${JSON.stringify(answer)}`);assert.equal(answer.model,model);
  assert.ok(!answer.cutoff&&!answer.interrupted);assert.ok(answer.usage.usedWon<=1000);
  return {...answer,generations:(await reservations()).length-before};
}
try {
  user=(await createUserWithEmailAndPassword(auth,email,password)).user.uid;
  await adminAuth(admin).updateUser(user,{emailVerified:true});
  await signOut(auth);await signInWithEmailAndPassword(auth,email,password);
  await invoke('ensureProfile',{displayName:'학교AI연동검증'});
  if(!masanExam&&!cacheOnly){
  const generic=await chat('2+3은 얼마야? 숫자만 답해 줘.');
  assert.match(generic.text,/5/);assert.equal(generic.generations,1);
  console.log('PASS general question: one generation, no school lookup.');
  }
  const schoolName=masanExam||cacheOnly?'마산중앙고등학교':'서울고등학교';
  const schools=(await invoke('searchSchools',{query:schoolName})).schools;
  const school=schools.find(row=>row.name===schoolName);assert.ok(school);
  schoolId=`${school.officeCode}_${school.schoolCode}`;
  await invoke('saveSchool',{officeCode:school.officeCode,schoolCode:school.schoolCode,grade:'1',className:'1'});
  if(cacheOnly){
    const month=schoolDates().date.slice(0,7);
    const data=await invoke('getSchoolOverview',{month,eventsOnly:true});
    assert.equal(data.errors.events,false);assert.ok(data.events.every(event=>!/^토요\s*휴업일$/.test(event.name)));
    const params=neisRequestParts('SchoolSchedule',{ATPT_OFCDC_SC_CODE:school.officeCode,SD_SCHUL_CODE:school.schoolCode,AA_FROM_YMD:`${month.replace('-','')}01`,AA_TO_YMD:`${month.replace('-','')}28`})[0].params;
    const id=createHash('sha256').update(JSON.stringify(['SchoolSchedule',Object.entries(params).sort(([a],[b])=>a.localeCompare(b))])).digest('hex');
    const before=(await db.get(`${root}/neisDailyCache/${id}`)).body;
    assert.equal(before.fields.status.stringValue,'ready');assert.equal(before.fields.date.stringValue,schoolDates().date);
    const repeated=await invoke('getSchoolOverview',{month,eventsOnly:true});
    const after=(await db.get(`${root}/neisDailyCache/${id}`)).body;
    assert.deepEqual(repeated.events,data.events);assert.equal(after.fields.updatedAtMs.integerValue,before.fields.updatedAtMs.integerValue);
    console.log(`PASS live daily NEIS cache: ${school.name}, ${month}, ${data.events.length} events; repeated request reuses the same saved response, Saturday closures excluded, no AI generation.`);
  } else if(process.argv.includes('--exam')||masanExam) {
    const schedule=await invoke('getUpcomingExams');
    assert.equal(schedule.school.name,school.name);assert.equal(schedule.errors.events,false);
    assert.ok(schedule.exams.every(exam=>['모의고사','중간고사','기말고사'].includes(exam.type)&&exam.date>=schedule.start&&exam.date<=schedule.end));
    console.log(`PASS upcoming-exam card data: ${schedule.exams.length} exams, ${schedule.start} ~ ${schedule.end}.`);
    if(masanExam){
      assert.deepEqual(schedule.exams.filter(exam=>exam.name==='2차시험'&&exam.date.startsWith('2026-12')).map(exam=>[exam.date,exam.type]),
        ['2026-12-07','2026-12-08','2026-12-09','2026-12-10'].map(date=>[date,'기말고사']));
      console.log('PASS 마산중앙고 1학년 2차시험: 2026-12-07 ~ 2026-12-10.');
    } else {
    const question='다음 시험이 언제야?';
    const answer=await chat(question);console.log(`PASS next exam answer: ${answer.text}`);
    assert.equal(answer.generations,2,'Exam answer must use actual school calendar evidence');
    const followup=await chat('2+3은 얼마야? 숫자만 답해 줘.','gemini-3.8-flash',[{role:'user',text:question},{role:'model',text:answer.text}]);
    assert.match(followup.text,/5/);console.log('PASS follow-up after next-exam question.');
    }
  } else {
  for(const month of ['2026-11','2026-12']){
    const data=await invoke('getSchoolOverview',{month});assert.equal(data.calendarRange.start,`${month}-01`);
    assert.equal(data.errors.events,false);console.log(`PASS calendar month ${month}, ${data.events.length} events.`);
  }
  const today=schoolDates().date;
  const daily=await chat('등록한 학교의 오늘 급식 메뉴와 우리 반 오늘 시간표를 조회해서 알려줘.','gemini-4-argon');
  assert.equal(daily.generations,2,'School question must perform a tool call and then answer');
  assert.equal(daily.usage.argonRemaining,1,'One question must count once even with a tool call');
  assert.ok(daily.text.includes(school.name));
  console.log(`PASS Argon registered-school meals/timetable (${today}); lookup + answer, daily quota counted once.\n${daily.text}`);
  const calendar=await chat('등록한 학교의 다음 달 학사일정을 조회해서 알려줘.');
  assert.equal(calendar.generations,2,'Calendar question must perform a tool call and then answer');
  assert.ok(calendar.text.includes(school.name));
  console.log(`PASS Flash next-month calendar: lookup + answer.\n${calendar.text}`);
  }
} finally {
  await signOut(auth).catch(()=>{});
  if(user){
    assert.equal((await adminAuth(admin).getUser(user)).email,email,'Cleanup must match this test account');
    for(const document of await reservations()){
      assert.equal(document.fields.user.stringValue,user);assert.ok(document.name.includes('/documents/aiReservations/'));
      await db.delete(`/v1/${document.name}`);
    }
    for(const scope of ['ai','school'])await db.delete(`${root}/integrationLimits/${user}_${scope}`);
    if(schoolId)await db.delete(`${root}/schoolLeaderboards/${schoolId}/weeks/${schoolDates().days[0]}/entries/${user}`);
    const collections=await db.post(`${root}/users/${user}:listCollectionIds`,{pageSize:100});
    for(const id of collections.body.collectionIds||[]){
      const rows=await db.get(`${root}/users/${user}/${id}`,{queryParams:{pageSize:100}});
      for(const row of rows.body.documents||[]){assert.ok(row.name.startsWith(`projects/${firebaseConfig.projectId}/databases/study-data/documents/users/${user}/`));await db.delete(`/v1/${row.name}`);}
    }
    await db.delete(`${root}/users/${user}`);await adminAuth(admin).deleteUser(user);
    console.log('CLEANUP: temporary QA account and its data removed.');
  }
  await deleteApp(app);await deleteAdmin(admin);
}
