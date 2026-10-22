// Both saved aggregates and the live checkpoint describe the same server session.
export function wordLiveSeconds(stats, word, period, key, nowMs) {
  if(!word)return 0;
  if(stats?.wordCheckpoint?.sessionId!==word.sessionId && stats?.wordCheckpoint?.serverNowMs>word.serverNowMs)return 0;
  const matches=date=>period==='month'?date.slice(0,7)===key:period==='week'?date>=key&&date<new Date(Date.parse(key)+7*86400000).toISOString().slice(0,10):date===key;
  let seconds=(word.segments||[]).filter(row=>matches(row.date)).reduce((sum,row)=>sum+row.seconds,0);
  if(word.activeSinceMs!=null) {
    const end=Math.min(Math.floor(nowMs/1000)*1000,word.leaseUntilMs),start=word.activeSinceMs;
    for(let cursor=start;cursor<end;) {
      const date=new Date(cursor+32400000).toISOString().slice(0,10),until=Math.min(end,(Math.floor((cursor+32400000)/86400000)+1)*86400000-32400000);
      if(matches(date))seconds+=(until-cursor)/1000;
      cursor=until;
    }
  }
  return Math.max(0,Math.floor(seconds)-(stats?.wordCheckpoint?.sessionId===word.sessionId?stats.wordCheckpoint.seconds:0));
}
