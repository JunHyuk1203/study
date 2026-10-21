import test from 'node:test';
import assert from 'node:assert/strict';
import { allowance, MONTHLY_LIMIT, parseExchangeRate, tokenCost } from '../functions/ai-budget.js';
import { chatContents, classroom, neisRows, schoolCodes, schoolDates, schoolRecord, plainText } from '../functions/integrations-domain.js';

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
