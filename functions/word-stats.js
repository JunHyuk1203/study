import {FieldValue} from './platform-store.js';

export function remainingWordSegments(segments, settled=[]) {
  const previous=new Map(settled.map(row=>[row.date,row.seconds]));
  return segments.map(row=>({...row,seconds:Math.max(0,row.seconds-(previous.get(row.date)||0))})).filter(row=>row.seconds>0);
}

// Persist only new seconds; finish and retried checkpoints share this ledger.
export function settleWordStats(tx,db,uid,sessionId,subjectId,segments,settled,now) {
  const remaining=remainingWordSegments(segments,settled),buckets=new Map();
  for(const row of segments)for(const [collection,period]of [['dailyStats',row.date],['weeklyStats',row.week],['monthlyStats',row.month]]) {
    const path=`users/${uid}/${collection}/${period}`,bucket=buckets.get(path)||{seconds:0,delta:0};
    bucket.seconds+=row.seconds;
    bucket.delta+=remaining.find(item=>item.date===row.date)?.seconds||0;
    buckets.set(path,bucket);
  }
  for(const [path,bucket]of buckets)if(bucket.delta>0)tx.set(db.doc(path),{uid,totalSeconds:FieldValue.increment(bucket.delta),subjectSeconds:{[subjectId]:FieldValue.increment(bucket.delta)},wordCheckpoint:{sessionId,seconds:bucket.seconds,serverNowMs:now.toMillis()},updatedAt:now},{merge:true});
  return remaining.reduce((sum,row)=>sum+row.seconds,0);
}
