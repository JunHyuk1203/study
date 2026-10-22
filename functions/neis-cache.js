import { createHash } from 'node:crypto';
import { HttpsError } from 'firebase-functions/v2/https';

const rangeFields={SchoolSchedule:['AA_FROM_YMD','AA_TO_YMD','AA_YMD'],mealServiceDietInfo:['MLSV_FROM_YMD','MLSV_TO_YMD','MLSV_YMD']};
for(const endpoint of ['elsTimetable','misTimetable','hisTimetable','spsTimetable'])rangeFields[endpoint]=['TI_FROM_YMD','TI_TO_YMD','ALL_TI_YMD'];

// Expand ranges to whole months so the home card, calendar and AI share reads.
export function neisRequestParts(endpoint,params) {
  const fields=rangeFields[endpoint];
  if(!fields)return [{params}];
  const [from,to,dateField]=fields,start=params[from],end=params[to];
  if(!/^\d{8}$/.test(start)||!/^\d{8}$/.test(end))throw new Error('invalid-neis-range');
  const parts=[];
  let cursor=new Date(`${start.slice(0,4)}-${start.slice(4,6)}-01T00:00:00Z`);
  while(cursor.toISOString().slice(0,10).replaceAll('-','')<=end){
    const first=cursor.toISOString().slice(0,10).replaceAll('-','');
    cursor.setUTCMonth(cursor.getUTCMonth()+1);
    const last=new Date(cursor.getTime()-86400000).toISOString().slice(0,10).replaceAll('-','');
    parts.push({params:{...params,[from]:first,[to]:last},dateField,start,end});
    if(parts.length>8)throw new Error('invalid-neis-range');
  }
  return parts;
}

export function createDailyNeis({db,fetchRows,now=Date.now}) {
  const memory=new Map();
  async function load(endpoint,params) {
    const date=new Date(now()+9*3600000).toISOString().slice(0,10);
    const canonical=JSON.stringify([endpoint,Object.entries(params).sort(([a],[b])=>a.localeCompare(b))]);
    const id=createHash('sha256').update(canonical).digest('hex'),key=`${date}:${id}`;
    if(memory.has(key))return memory.get(key);
    let pendingElsewhere=false;
    const request=(async()=>{
      const ref=db.doc(`neisDailyCache/${id}`);
      const saved=await db.runTransaction(async tx=>{
        const existing=(await tx.get(ref)).data();
        if(existing?.date===date){
          if(existing.status==='ready')return existing.rows;
          // Reserve the day's upstream attempt before fetching. A crash or an
          // upstream failure cannot trigger repeated paid work from other tabs.
          pendingElsewhere=existing.status==='pending';
          throw new HttpsError('unavailable',pendingElsewhere?'학교 정보를 준비 중입니다. 잠시 후 다시 불러와 주세요.':'오늘 학교 정보 조회에 실패했습니다. 다음 날 다시 갱신됩니다.');
        }
        tx.set(ref,{date,status:'pending',updatedAtMs:now()});
        return null;
      });
      if(saved!==null)return saved;
      try {
        const rows=await fetchRows(endpoint,params);
        await ref.set({date,status:'ready',rows,updatedAtMs:now()});
        return rows;
      } catch(error) {
        await ref.set({date,status:'error',updatedAtMs:now()}).catch(()=>{});
        throw error;
      }
    })();
    if(memory.size>=100)memory.delete(memory.keys().next().value);
    memory.set(key,request);
    // A pending request owned by another instance may finish shortly; let the
    // next client retry read Firestore, without making another upstream call.
    void request.catch(()=>{if(pendingElsewhere)memory.delete(key);});
    return request;
  }
  return async(endpoint,params)=>{
    const rows=await Promise.all(neisRequestParts(endpoint,params).map(async part=>{
      const result=await load(endpoint,part.params);
      return part.dateField?result.filter(row=>row[part.dateField]>=part.start&&row[part.dateField]<=part.end):result;
    }));
    return rows.flat();
  };
}
