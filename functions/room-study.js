import {weekKey} from './domain.js';
import {studyDate} from './report-math.js';

// Room time has its own ledger; session totals include time before joining.
export function roomStudyTotals(member,previous={},now=Date.now()) {
  const date=studyDate(now),week=weekKey(date),month=date.slice(0,7);
  const totals={displayName:member?.displayName||previous.displayName||'공부 친구'};
  for(const [period,key,start] of [['today',date,date],['week',week,week],['month',month,`${month}-01`]]) {
    const saved=previous[period]?.key===key?previous[period].ms||0:0;
    const from=Math.max(member?.sampledAtMs??now,member?.joinedAtMs??now,Date.parse(`${start}T00:00:00+09:00`));
    const until=Math.min(now,member?.countUntilMs??from);
    const pending=member?.roomTimer&&member.status==='studying'&&member.verificationType==='face-browser'?Math.max(0,until-from):0;
    totals[period]={key,ms:saved+pending};
  }
  return totals;
}

export function roomStudyMember(member,totals,now) {
  return {...member,roomTimer:true,studyDate:totals.today.key,studyMs:totals.today.ms,seconds:Math.floor(totals.today.ms/1000),sampledAtMs:now};
}

export function roomRankings(room,now=Date.now()) {
  const entries=[...new Set([...Object.keys(room.studyTotals||{}),...room.memberIds])].map(uid=>({uid,...roomStudyTotals(room.members[uid],room.studyTotals?.[uid],now)}));
  return Object.fromEntries(['today','week','month'].map(period=>{
    const seconds=Math.max(0,...entries.map(row=>Math.floor(row[period].ms/1000)));
    return [period,{seconds,winners:seconds?entries.filter(row=>Math.floor(row[period].ms/1000)===seconds).map(({uid,displayName})=>({uid,displayName})):[]}];
  }));
}
