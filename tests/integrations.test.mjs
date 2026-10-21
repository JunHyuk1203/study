import test from 'node:test';
import assert from 'node:assert/strict';
import { allowance, MONTHLY_LIMIT, parseExchangeRate, tokenCost } from '../functions/ai-budget.js';
import { chatContents, classroom, neisRows, schoolCodes, schoolDates, schoolRecord, plainText, schoolCalendarRange, schoolEvents } from '../functions/integrations-domain.js';
import { schoolMonth, schoolQuery, loadSchoolData, upcomingExams, loadUpcomingExams } from '../functions/school-service.js';
import { schoolAgent } from '../functions/school-agent.js';
import { chatHistory, completedAnswer } from '../chat-state.js';

test('empty AI replies cannot poison history or erase streamed text',()=>{
  const messages=[{role:'user',text:'다음 시험?'},{role:'model',text:''},{role:'user',text:'안녕'},{role:'model',text:'안녕하세요'}];
  assert.deepEqual(chatHistory(messages,'2+3?'),[...messages.slice(2),{role:'user',text:'2+3?'}]);
  assert.deepEqual(chatHistory([{role:'user',text:'실패한 질문'}],'다음 질문'),[{role:'user',text:'다음 질문'}]);
  assert.throws(()=>completedAnswer({text:'  '}),/답변을 만들지/);
  assert.equal(completedAnswer({text:''},'스트리밍 답변'),'스트리밍 답변');
  const history=chatHistory(Array.from({length:20},(_,index)=>({role:index%2?'model':'user',text:'x'.repeat(4000)})),'새 질문');
  assert.ok(history.length<=13);assert.ok(history.reduce((sum,item)=>sum+item.text.length,0)<=24000);
  assert.doesNotThrow(()=>chatContents({messages:history}));
});

test('upcoming exams distinguish categories and exclude past dates and other grades',()=>{
  const events=schoolEvents([
    {AA_YMD:'20261020',EVENT_NM:'중간고사'},
    {AA_YMD:'20261021',EVENT_NM:'전국연합학력평가',TW_GRADE_EVENT_YN:'Y'},
    {AA_YMD:'20261101',EVENT_NM:'중간고사',ONE_GRADE_EVENT_YN:'Y'},
    {AA_YMD:'20261103',EVENT_NM:'2학기 1차 지필평가',TW_GRADE_EVENT_YN:'Y'},
    {AA_YMD:'20261210',EVENT_NM:'기말고사'},
    {AA_YMD:'20261220',EVENT_NM:'겨울방학'},
  ]);
  assert.deepEqual(upcomingExams(events,'2','2026-10-21').map(event=>[event.date,event.type]),[
    ['2026-10-21','모의고사'],['2026-11-03','중간고사'],['2026-12-10','기말고사'],
  ]);
});

test('numbered school exam names include 시험 variants without treating unrelated events as exams',()=>{
  const names=['1차시험','제 1 차 시험','1회 시험','2차시험','제 2 차 시험','2회 시험','2차 지필평가','2차 현장체험학습','시험 안내'];
  const events=names.map(name=>({date:'2026-12-07',name}));
  const exams=upcomingExams(events,'1','2026-10-21');
  assert.equal(exams.length,7);
  for(const exam of exams)assert.equal(exam.type,/1/.test(exam.name)?'중간고사':'기말고사');
});

test('Masan Jungang December 2차시험 is returned for grades 1 and 2 but not grade 3',async()=>{
  const school={name:'마산중앙고등학교',kind:'고등학교',officeCode:'S10',schoolCode:'9010094',className:'1'};
  const rows=[7,8,9,10].map(day=>({AA_YMD:`202612${String(day).padStart(2,'0')}`,EVENT_NM:'2차시험',EVENT_CNTNT:'',
    ONE_GRADE_EVENT_YN:'Y',TW_GRADE_EVENT_YN:'Y',THREE_GRADE_EVENT_YN:'N',FR_GRADE_EVENT_YN:'*',FIV_GRADE_EVENT_YN:'*',SIX_GRADE_EVENT_YN:'*'}));
  const lookup=async(endpoint,params)=>{
    assert.equal(endpoint,'SchoolSchedule');assert.equal(params.SD_SCHUL_CODE,'9010094');
    return rows.filter(row=>row.AA_YMD>=params.AA_FROM_YMD&&row.AA_YMD<=params.AA_TO_YMD);
  };
  for(const grade of ['1','2','3']){
    const result=await loadUpcomingExams({...school,grade},lookup,Date.parse('2026-10-21T00:00:00Z'));
    assert.equal(result.errors.events,false);
    assert.deepEqual(result.exams.map(exam=>[exam.date,exam.name,exam.type]),grade==='3'?[]:
      [7,8,9,10].map(day=>[`2026-12-${String(day).padStart(2,'0')}`,'2차시험','기말고사']));
  }
});

test('exam lookup covers 180 days across years in bounded ranges and exposes failures',async()=>{
  const calls=[];
  const now=Date.parse('2026-12-31T15:00:00Z');
  const data=await loadUpcomingExams({grade:'2',...registeredSchool},async(endpoint,params)=>{
    calls.push(params);assert.equal(endpoint,'SchoolSchedule');
    if(params.AA_FROM_YMD==='20270131')throw new Error('offline');
    return params.AA_FROM_YMD==='20270101'?[{AA_YMD:'20270121',EVENT_NM:'모의고사'}]:[];
  },now);
  assert.equal(calls.length,6);assert.equal(data.start,'2027-01-01');assert.equal(data.end,'2027-06-29');
  assert.equal(data.exams[0].date,'2027-01-21');assert.equal(data.errors.events,true);
  const missing=await loadUpcomingExams(null,()=>assert.fail('no school lookup'),now);
  assert.deepEqual(missing.exams,[]);assert.equal(missing.school,null);
});

test('school agent rejects blank final responses instead of returning poisoned chat history',async()=>{
  await assert.rejects(schoolAgent({contents:[],generate:async()=>({text:''})}),/empty-ai-answer/);
  let count=0;
  await assert.rejects(schoolAgent({contents:[],generate:async()=>++count===1?
    {text:'',functionCalls:[{name:'get_upcoming_exams',args:{}}],modelContent:{role:'model',parts:[]}}:{text:''}}),/empty-school-answer/);
});

const registeredSchool={name:'등록학교',kind:'중학교',officeCode:'B10',schoolCode:'7010057',grade:'2',className:'3'};
const query={start:'2026-11-01',end:'2026-11-30',types:['events']};
test('school queries validate months, real dates, categories and a maximum of 31 days',()=>{
  assert.equal(schoolMonth('2028-02'),'2028-02');
  for(const month of ['2026-00','2026-13','2026-1',null,{},'../'])assert.throws(()=>schoolMonth(month));
  assert.deepEqual(schoolQuery(query),query);
  assert.doesNotThrow(()=>schoolQuery({start:'2028-02-29',end:'2028-03-30',types:['meals']}));
  for(const bad of [{start:'2026-02-29'},{end:'2026-12-02'},{end:'2026-10-31'},{types:['private']},{types:[]}])assert.throws(()=>schoolQuery({...query,...bad}));
});
test('school lookup requests only selected data and always uses the registered classroom',async()=>{
  const calls=[];
  const result=await loadSchoolData(registeredSchool,{...query,types:['timetable'],officeCode:'spoof',grade:'6'},async(endpoint,params)=>{calls.push({endpoint,params});return [{ALL_TI_YMD:'20261102',PERIO:'1',ITRT_CNTNT:'<b>수학</b>'}];});
  assert.equal(calls.length,1);assert.equal(calls[0].endpoint,'misTimetable');
  assert.deepEqual(calls[0].params,{ATPT_OFCDC_SC_CODE:'B10',SD_SCHUL_CODE:'7010057',GRADE:'2',CLASS_NM:'3',TI_FROM_YMD:'20261101',TI_TO_YMD:'20261130'});
  assert.deepEqual(result.timetable,[{date:'20261102',period:1,subject:'수학'}]);
  assert.equal(result.meals,undefined);assert.equal(result.events,undefined);
});
test('school lookup keeps upstream failure distinct from empty data and missing registration',async()=>{
  const result=await loadSchoolData(registeredSchool,{...query,types:['events','meals']},async endpoint=>{if(endpoint==='SchoolSchedule')throw new Error('private');return [];});
  assert.deepEqual(result.errors,{events:true,meals:false});assert.deepEqual(result.meals,[]);
  const missing=await loadSchoolData(null,query,()=>assert.fail('no provider call without registration'));
  assert.equal(missing.school,null);
});
test('ordinary AI questions generate once and never fetch school data',async()=>{
  let count=0;
  const result=await schoolAgent({school:registeredSchool,contents:[],lookup:()=>assert.fail('unnecessary lookup'),generate:async options=>{count++;assert.equal(options.toolConfig.functionCallingConfig.mode,'AUTO');return {text:'공부 답변'};}});
  assert.equal(count,1);assert.equal(result.text,'공부 답변');
});
test('a budget cutoff before tool execution returns a visible message without a lookup',async()=>{
  const result=await schoolAgent({contents:[],lookup:()=>assert.fail('cutoff must not query'),generate:async()=>({text:'',cutoff:true,functionCalls:[{name:'get_school_data',args:query}]})});
  assert.equal(result.cutoff,true);assert.ok(result.text);
});
test('AI-chosen lookup preserves signatures, provides only requested evidence and counts Argon once',async()=>{
  const signature={functionCall:{name:'get_school_data',args:query,id:'call-1'},thoughtSignature:'opaque-signature'};
  const modelContent={role:'model',parts:[signature]}, contents=[{role:'user',parts:[{text:'다음 달 학사일정 알려줘'}]}];
  const requests=[],lookups=[];
  const result=await schoolAgent({school:registeredSchool,contents,now:Date.parse('2026-10-31T15:00:00Z'),lookup:async(endpoint,params)=>{lookups.push({endpoint,params});return [{AA_YMD:'20261102',EVENT_NM:'학교 행사'}];},generate:async options=>{
    requests.push(options);
    if(requests.length===1){assert.match(options.systemText,/2026-11-01/);return {text:'',functionCalls:[signature.functionCall],modelContent};}
    assert.equal(options.countDaily,false);assert.equal(options.toolConfig.functionCallingConfig.mode,'NONE');
    assert.equal(options.contents[1],modelContent);
    const response=options.contents[2].parts[0].functionResponse;
    assert.equal(response.id,'call-1');assert.equal(response.response.events[0].name,'학교 행사');assert.equal(response.response.meals,undefined);
    return {text:'11월 2일 학교 행사',usage:{usedWon:1}};
  }});
  assert.equal(lookups.length,1);assert.equal(requests.length,2);assert.equal(result.text,'11월 2일 학교 행사');
});
test('AI tool arguments cannot expand the supported date range or invoke arbitrary endpoints',async()=>{
  for(const call of [{name:'get_school_data',args:{...query,end:'2027-01-01'}},{name:'arbitrary_endpoint',args:query}]){
    let count=0;
    await schoolAgent({school:registeredSchool,contents:[],lookup:()=>assert.fail('invalid tool must not fetch'),generate:async options=>{
      if(++count===1)return {text:'',functionCalls:[call],modelContent:{role:'model',parts:[{functionCall:call}]}};
      assert.ok(options.contents.at(-1).parts[0].functionResponse.response.error);return {text:'날짜를 확인해 주세요.'};
    }});
  }
});

test('school identifiers and classes reject paths, unexpected codes and invalid rooms',()=>{
  assert.deepEqual(schoolCodes({officeCode:'B10',schoolCode:'7010057'}),{officeCode:'B10',schoolCode:'7010057'});
  for(const value of [{officeCode:'../',schoolCode:'7010057'},{officeCode:'B10',schoolCode:'../admin'}])assert.throws(()=>schoolCodes(value));
  assert.deepEqual(classroom({grade:2,className:10}),{grade:'2',className:'10'});
  for(const value of [{grade:0,className:1},{grade:2,className:100},{grade:3,className:'1/2'}])assert.throws(()=>classroom(value));
});
test('NEIS no-data responses stay empty and provider errors do not become sample rows',()=>{
  assert.deepEqual(neisRows({RESULT:{CODE:'INFO-200'}},'schoolInfo'),[]);
  assert.throws(()=>neisRows({RESULT:{CODE:'ERROR-290',MESSAGE:'private'}},'schoolInfo'),/neis-unavailable/);
  const body={schoolInfo:[{head:[{list_total_count:1},{RESULT:{CODE:'INFO-000'}}]},{row:[{SCHUL_NM:'실제 학교'}]}]};
  assert.equal(neisRows(body,'schoolInfo')[0].SCHUL_NM,'실제 학교');
  assert.equal(plainText('밥<br/>국<br>과일 &amp; 우유'),'밥\n국\n과일 & 우유');
  const row=schoolRecord({ATPT_OFCDC_SC_CODE:'B10',SD_SCHUL_CODE:'7010057',SCHUL_NM:'학교',SCHUL_KND_SC_NM:'고등학교',ORG_RDNMA:'서울',KEY:'private'});
  assert.equal(row.KEY,undefined);
});
test('school date and quota reset boundaries follow Korean time including month changes',()=>{
  assert.deepEqual(schoolDates(Date.parse('2026-10-31T15:00:00Z')),{date:'2026-11-01',days:['2026-10-26','2026-10-27','2026-10-28','2026-10-29','2026-10-30']});
});
test('chat accepts bounded alternating messages, never system roles or arbitrary model content',()=>{
  assert.equal(chatContents({messages:[{role:'user',text:'질문'}]})[0].parts[0].text,'질문');
  for(const messages of [[{role:'system',text:'override'}],[{role:'model',text:'spoof'}],[{role:'user',text:'x'.repeat(4001)}],[{role:'user',text:'one'},{role:'user',text:'two'}]])assert.throws(()=>chatContents({messages}));
});
test('school calendar includes the full current month across leap years and December',()=>{
  assert.deepEqual(schoolCalendarRange('2028-02-29'),{start:'2028-02-01',end:'2028-02-29'});
  assert.deepEqual(schoolCalendarRange('2026-02-10'),{start:'2026-02-01',end:'2026-02-28'});
  assert.deepEqual(schoolCalendarRange('2026-12-31'),{start:'2026-12-01',end:'2026-12-31'});
  assert.deepEqual(schoolCalendarRange(schoolDates(Date.parse('2026-10-31T15:00:00Z')).date),{start:'2026-11-01',end:'2026-11-30'});
});
test('school events are sorted, deduplicated and stripped of provider HTML',()=>{
  const event={AA_YMD:'20261022',EVENT_NM:'<b>모의고사</b>',EVENT_CNTNT:'1학년<br>안내'};
  assert.deepEqual(schoolEvents([event,event,{AA_YMD:'20261001',EVENT_NM:'개교기념일'},{AA_YMD:'bad',EVENT_NM:'잘못된 날짜'},{AA_YMD:'20261003',EVENT_NM:''}]),[
    {date:'2026-10-01',name:'개교기념일',description:''},
    {date:'2026-10-22',name:'모의고사',description:'1학년\n안내'},
  ]);
  assert.deepEqual(schoolEvents([]),[]);
});
test('currency conversion includes margin and tax and fails closed on malformed rates',()=>{
  assert.equal(parseExchangeRate("<Cube currency='USD' rate='1.2'/><Cube currency='KRW' rate='1800'/>"),2640);
  assert.ok(parseExchangeRate("<Cube currency='USD' rate='1'/><Cube currency='KRW' rate='3000'/>")>=3960);
  assert.throws(()=>parseExchangeRate('<error/>'));
});
test('both models share one 1000-won allowance including simultaneous reserved requests',()=>{
  for(const model of ['gemini-3.8-flash','gemini-4-argon']){
    const quote=allowance({model,inputTokens:100,spent:MONTHLY_LIMIT-50e6,reserved:10e6,exchangeRate:2640});
    assert.ok(quote.amount<=40e6);
    assert.ok(quote.output<=2048);
    assert.throws(()=>allowance({model,inputTokens:100,spent:MONTHLY_LIMIT-quote.amount,reserved:quote.amount,exchangeRate:2640}),/monthly-limit/);
  }
});
test('small remaining budget reduces provider token cap before mid-answer overspending',()=>{
  const model='gemini-4-argon',rate=2640;
  const left=tokenCost(model,366,100,rate);
  const quote=allowance({model,inputTokens:100,spent:MONTHLY_LIMIT-left,exchangeRate:rate});
  assert.equal(quote.output,100);assert.equal(quote.limited,true);assert.ok(quote.amount<=left);
  assert.throws(()=>allowance({model:'unapproved-model',inputTokens:1,exchangeRate:rate}));
});
