import { randomUUID } from 'node:crypto';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp, FieldValue } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { allowance, MODELS, parseExchangeRate, tokenCost } from './ai-budget.js';
import { schoolDates } from './integrations-domain.js';
const db=getFirestore(getApps()[0]??initializeApp(),'study-data');
const systemInstruction={parts:[{text:'너는 STUDY의 한국어 학습 도우미다. 질문에 명확하고 친절하게 답하고 학습을 도와라. 모르는 정보는 추측하지 말고 불확실함을 밝혀라. 간결하게 답하되 문제 풀이에는 필요한 과정을 설명해라.'}]};
let exchange;
async function exchangeRate() {
  if(exchange&&Date.now()-exchange.time<6*3600000)return exchange.value;
  try {
    const response=await fetch('https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml',{signal:AbortSignal.timeout(10000)});
    if(!response.ok)throw new Error();
    exchange={value:parseExchangeRate(await response.text()),time:Date.now()};return exchange.value;
  }catch{throw new HttpsError('unavailable','비용 계산에 필요한 환율을 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.');}
}
export async function usageFor(user) {
  const {date}=schoolDates();
  const [month,day]=await db.getAll(db.doc(`users/${user}/aiUsage/${date.slice(0,7)}`),db.doc(`users/${user}/aiDaily/${date}`));
  const usage=month.data()||{};
  return {month:date.slice(0,7), usedWon:Math.ceil(((usage.spent||0)+(usage.reserved||0))/1e6), limitWon:1000, argonRemaining:Math.max(0,2-(day.data()?.argonCalls||0))};
}
async function reserve(user, model, inputTokens, rate, requested, countDaily = true) {
  const {date}=schoolDates(), monthRef=db.doc(`users/${user}/aiUsage/${date.slice(0,7)}`),dayRef=db.doc(`users/${user}/aiDaily/${date}`),reservationRef=db.doc(`aiReservations/${randomUUID()}`);
  return db.runTransaction(async tx=>{
    const dailyLimited=countDaily&&model==='gemini-4-argon';
    const [monthly,daily]=await tx.getAll(...(dailyLimited?[monthRef,dayRef]:[monthRef])), spent=monthly.data()?.spent||0,reserved=monthly.data()?.reserved||0;
    if(dailyLimited&&(daily.data()?.argonCalls||0)>=2)throw new HttpsError('resource-exhausted','Argon은 한국 시간 기준 하루 2회까지 이용할 수 있습니다.');
    let quote;
    try{quote=allowance({model,inputTokens,spent,reserved,exchangeRate:rate,requested});}catch{throw new HttpsError('resource-exhausted','이번 달 AI 이용 한도 1,000원에 도달했습니다.');}
    tx.set(monthRef,{spent,reserved:reserved+quote.amount,updatedAt:Timestamp.now()},{merge:true});
    if(dailyLimited)tx.set(dayRef,{argonCalls:(daily.data()?.argonCalls||0)+1,updatedAt:Timestamp.now()},{merge:true});
    tx.create(reservationRef,{user,month:date.slice(0,7),model,amount:quote.amount,status:'reserved',createdAt:Timestamp.now()});
    return {...quote,monthRef,reservationRef,rate};
  });
}
async function settle(reservation, amount) {
  await db.runTransaction(async tx=>{
    const saved=await tx.get(reservation.reservationRef);
    if(saved.data()?.status!=='reserved')return;
    // On ambiguous upstream failure, retain the full worst-case charge. A crash
    // leaves the reservation held, so retries cannot spend that balance twice.
    const charged=amount==null?reservation.amount:Math.min(reservation.amount,Math.max(0,amount));
    tx.update(reservation.monthRef,{reserved:FieldValue.increment(-reservation.amount),spent:FieldValue.increment(charged),updatedAt:Timestamp.now()});
    tx.update(reservation.reservationRef,{status:'settled',charged,updatedAt:Timestamp.now()});
  });
}
export async function generateForUser({user,model,contents,key,requested=2048,onChunk,signal,systemText='',tools,toolConfig,countDaily=true}) {
  if(!MODELS[model])throw new HttpsError('invalid-argument','지원하지 않는 AI 모델입니다.');
  const rate=await exchangeRate();
  const headers={'content-type':'application/json','x-goog-api-key':key.trim()};
  const base=`https://generativelanguage.googleapis.com/v1beta/models/${model}`;
  const instruction = {parts:[...systemInstruction.parts, ...(systemText ? [{text:systemText}] : [])]};
  const payload = {systemInstruction:instruction, contents, ...(tools ? {tools,toolConfig} : {})};
  let inputTokens;
  try{
    const counted=await fetch(`${base}:countTokens`,{method:'POST',headers,signal:AbortSignal.timeout(15000),body:JSON.stringify({generateContentRequest:{model:`models/${model}`,...payload}})});
    const data=await counted.json();
    if(!counted.ok||!Number.isSafeInteger(data.totalTokens))throw new Error();
    inputTokens=data.totalTokens;
  }catch{throw new HttpsError('unavailable','AI 요청 비용을 계산하지 못했습니다. 잠시 후 다시 시도해 주세요.');}
  const reservation=await reserve(user,model,inputTokens,rate,requested,countDaily);
  const controller=new AbortController();
  const timeout=setTimeout(()=>controller.abort(),65000);
  const abort=()=>controller.abort();
  signal?.addEventListener('abort',abort,{once:true});
  if(signal?.aborted)controller.abort();
  let full='',usage,finishReason,cutoff=false,settled=false;
  const parts=[];
  try{
    // maxOutputTokens includes thinking tokens: generation stops at the provider
    // when the affordable output allocation is exhausted, even mid-sentence.
    const response=await fetch(`${base}:streamGenerateContent?alt=sse`,{method:'POST',headers,signal:controller.signal,
      body:JSON.stringify({...payload,generationConfig:{maxOutputTokens:reservation.output,temperature:.6,thinkingConfig:{thinkingLevel:'low'}}})});
    if(!response.ok)throw new HttpsError(response.status===429?'resource-exhausted':'unavailable',response.status===429?'AI 요청이 많습니다. 잠시 후 다시 시도해 주세요.':'AI에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.');
    const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';
    while(true){
      const {done,value}=await reader.read();buffer+=decoder.decode(value||new Uint8Array(),{stream:!done});
      const events=buffer.split(/\r?\n\r?\n/);buffer=events.pop();if(done&&buffer.trim())events.push(buffer);
      for(const event of events){
        const data=event.split(/\r?\n/).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trim()).join('\n');
        if(!data||data==='[DONE]')continue;
        const chunk=JSON.parse(data);if(chunk.error)throw new Error('provider-error');
        usage=chunk.usageMetadata||usage;
        const candidate=chunk.candidates?.[0];finishReason=candidate?.finishReason||finishReason;
        parts.push(...(candidate?.content?.parts||[]));
        const part=candidate?.content?.parts?.filter(item=>!item.thought).map(item=>item.text||'').join('')||'';
        if(part){full+=part;await onChunk?.(part);}
        // A defensive live check complements the provider-side token limit.
        if(usage&&tokenCost(model,usage.promptTokenCount||inputTokens,(usage.candidatesTokenCount||0)+(usage.thoughtsTokenCount||0),rate)>=reservation.amount){cutoff=true;controller.abort();break;}
      }
      if(done||cutoff)break;
    }
    cutoff ||= reservation.limited&&finishReason==='MAX_TOKENS';
    const billable=usage&&Number.isSafeInteger(usage.promptTokenCount)?tokenCost(model,usage.promptTokenCount,(usage.candidatesTokenCount||0)+(usage.thoughtsTokenCount||0),rate):null;
    await settle(reservation,billable);settled=true;
    const functionCalls=parts.filter(part=>part.functionCall).map(part=>part.functionCall);
    if(!full.trim()&&!functionCalls.length)throw new HttpsError('failed-precondition',cutoff?'이번 달 AI 이용 한도에 도달했습니다.':'AI가 답변을 만들지 못했습니다. 질문을 바꿔 다시 시도해 주세요.');
    return {text:full.trim(),model,cutoff,usage:await usageFor(user),...(functionCalls.length ? {functionCalls,modelContent:{role:'model',parts}} : {})};
  }catch(error){
    if(!settled)await settle(reservation,null);
    if(full.trim()&&controller.signal.aborted)return {text:full.trim(),model,cutoff,interrupted:!cutoff,usage:await usageFor(user)};
    if(error instanceof HttpsError)throw error;
    throw new HttpsError('unavailable','AI 응답을 받지 못했습니다. 잠시 후 다시 시도해 주세요.');
  }finally{clearTimeout(timeout);signal?.removeEventListener('abort',abort);}
}
