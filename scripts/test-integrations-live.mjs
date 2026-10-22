// Explicit live integration test. Only this run's temporary QA account is used.
// Credentials remain in memory; no real user's data or quota is accessed.
import {createRequire} from 'node:module';
import {randomBytes} from 'node:crypto';
import assert from 'node:assert/strict';
import {initializeApp,deleteApp} from 'firebase/app';
import {getAuth,createUserWithEmailAndPassword,signOut,signInWithEmailAndPassword} from 'firebase/auth';
import {getFunctions,httpsCallable} from 'firebase/functions';
import {getFirestore,doc,getDoc} from 'firebase/firestore';
import {planPeriod} from '../functions/plan-domain.js';
import {firebaseConfig} from '../firebase-config.js';
import {schoolDates} from '../functions/integrations-domain.js';
import {MONTHLY_LIMIT} from '../functions/ai-budget.js';
const require=createRequire(import.meta.url),backend=createRequire(new URL('../functions/package.json',import.meta.url));
const cli=require('firebase-tools/lib/auth'),{requireAuth}=require('firebase-tools/lib/requireAuth');
const {initializeApp:adminApp,deleteApp:deleteAdmin}=backend('firebase-admin/app');
const {getAuth:adminAuth}=backend('firebase-admin/auth');
const {Client}=require('firebase-tools/lib/apiv2');
const account=cli.getProjectDefaultAccount(process.cwd());
if(!account)throw new Error('Firebase CLI login required');
await requireAuth({project:firebaseConfig.projectId,nonInteractive:true,...account});
const admin=adminApp({projectId:firebaseConfig.projectId,credential:{async getAccessToken(){const token=await cli.getAccessToken(account.tokens.refresh_token,['https://www.googleapis.com/auth/cloud-platform']);return {access_token:token.access_token,expires_in:token.expires_in||3600};}}},'integration-qa-admin');
const db=new Client({urlPrefix:'https://firestore.googleapis.com',auth:true});
const root=`/v1/projects/${firebaseConfig.projectId}/databases/study-data/documents`;
const app=initializeApp(firebaseConfig,'integration-qa-client'),auth=getAuth(app),functions=getFunctions(app,'asia-northeast3');
const invoke=(name,data={})=>httpsCallable(functions,name,{timeout:85000})(data).then(result=>result.data);
const email=`qa-${randomBytes(10).toString('hex')}@example.test`,password=randomBytes(24).toString('base64url');
let user,schoolId;
try{
  user=(await createUserWithEmailAndPassword(auth,email,password)).user.uid;
  await adminAuth(admin).updateUser(user,{emailVerified:true});
  await signOut(auth);await signInWithEmailAndPassword(auth,email,password);
  await invoke('ensureProfile',{displayName:'API연동검증'});
  if(process.argv.includes('--plan-only')) {
    const request=await httpsCallable(functions,'chatWithStudy',{timeout:245000}).stream({model:'gemini-3.8-flash',messages:[{role:'user',text:'검증용 물리라는 학습 과목을 추가하고, 그 과목의 이번 주 공부시간 목표를 2시간으로 지금 등록해 줘. 추천만 하지 말고 계정에 저장해 줘.'}]});
    let chunks=0;for await(const chunk of request.stream)if(chunk.text)chunks++;
    const result=await request.data;assert.ok(result.text);assert.equal(result.cutoff,false);
    const profile=(await getDoc(doc(getFirestore(app,'study-data'),'users',user))).data();
    const subject=profile.subjects?.find(row=>row.name==='검증용 물리');assert.ok(subject,'AI must actually save the requested subject');
    assert.ok(profile.goals?.some(goal=>goal.subjectId===subject.id&&goal.period==='week'&&goal.periodKey===planPeriod('week')&&goal.targetSeconds===7200),'AI must actually save the requested goal for this Sunday-based week');
    console.log(`PASS live AI subject creation and weekly goal registration, verified in Firestore (${chunks} streamed chunks).`);
  } else {
  const search=await invoke('searchSchools',{query:'서울고등학교'});assert.ok(search.schools.length);
  const school=search.schools.find(row=>row.name==='서울고등학교')||search.schools[0];schoolId=`${school.officeCode}_${school.schoolCode}`;
  await invoke('saveSchool',{officeCode:school.officeCode,schoolCode:school.schoolCode,grade:'1',className:'1'});
  const overview=await invoke('getSchoolOverview');assert.equal(overview.school.schoolCode,school.schoolCode);assert.equal(overview.errors.meals,false);assert.equal(overview.errors.timetable,false);
  console.log(`PASS live NEIS search, canonical school registration, timetable and meals (rows: ${overview.timetable.length}/${overview.meals.length}).`);
  for(const model of ['gemini-3.8-flash','gemini-4-argon','gemini-4-argon']){
    const request=await httpsCallable(functions,'chatWithStudy',{timeout:85000}).stream({model,messages:[{role:'user',text:'안녕 한 단어로만 답해 줘.'}]});let chunks=0;
    for await(const chunk of request.stream)if(chunk.text)chunks++;
    const result=await request.data;assert.ok(chunks&&result.text);assert.equal(result.model,model);assert.ok(result.usage.usedWon<=1000);
    console.log(`PASS live streaming ${model}.`);
  }
  await assert.rejects(()=>invoke('chatWithStudy',{model:'gemini-4-argon',messages:[{role:'user',text:'안녕'}]}),error=>error.code==='functions/resource-exhausted');
  const briefing=await invoke('getStudyBriefing');assert.ok(briefing.text);assert.equal(briefing.model,'gemini-3.8-flash');
  const usage=await invoke('getAiUsage');assert.equal(usage.argonRemaining,0);assert.ok(usage.usedWon<=1000);
  const month=schoolDates().date.slice(0,7);await db.patch(`${root}/users/${user}/aiUsage/${month}`,{fields:{spent:{integerValue:String(MONTHLY_LIMIT)},reserved:{integerValue:'0'}}});
  await assert.rejects(()=>invoke('chatWithStudy',{model:'gemini-3.8-flash',messages:[{role:'user',text:'안녕'}]}),error=>error.code==='functions/resource-exhausted');
  console.log('PASS live Flash-only briefing, shared usage, Argon third-call rejection and monthly limit rejection.');
  }
}finally{
  await signOut(auth).catch(()=>{});
  if(user){
    assert.equal((await adminAuth(admin).getUser(user)).email,email,'Cleanup must match this run\'s QA account');
    const reservations=await db.post(`${root}:runQuery`,{structuredQuery:{from:[{collectionId:'aiReservations'}],where:{fieldFilter:{field:{fieldPath:'user'},op:'EQUAL',value:{stringValue:user}}},limit:100}});
    for(const row of reservations.body||[])if(row.document){assert.equal(row.document.fields.user.stringValue,user);assert.ok(row.document.name.includes('/documents/aiReservations/'));await db.delete(`/v1/${row.document.name}`);}
    for(const scope of ['ai','school'])await db.delete(`${root}/integrationLimits/${user}_${scope}`);
    if(schoolId)await db.delete(`${root}/schoolLeaderboards/${schoolId}/weeks/${schoolDates().days[0]}/entries/${user}`);
    const collections=await db.post(`${root}/users/${user}:listCollectionIds`,{pageSize:100});
    for(const id of collections.body.collectionIds||[]){
      const rows=await db.get(`${root}/users/${user}/${id}`,{queryParams:{pageSize:100}});
      for(const row of rows.body.documents||[]){assert.ok(row.name.startsWith(`projects/${firebaseConfig.projectId}/databases/study-data/documents/users/${user}/`));await db.delete(`/v1/${row.name}`);}
    }
    await db.delete(`${root}/users/${user}`);await adminAuth(admin).deleteUser(user);
    console.log('CLEANUP: this test\'s QA account, usage, reservations and school selection removed.');
  }
  await deleteApp(app);await deleteAdmin(admin);
}
