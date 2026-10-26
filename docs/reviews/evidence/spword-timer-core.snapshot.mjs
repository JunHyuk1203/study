// Review input only. Upstream blob SHA: 068a616f5e445a4498f3a75f629e553023e32c93
// Source: https://github.com/JunHyuk1203/superword/blob/main/study-timer-core.js
// randomUUID is restricted to secure contexts; getRandomValues also works on HTTP.
export function studyUuid(cryptoApi=globalThis.crypto) {
  if (typeof cryptoApi?.randomUUID === 'function') return cryptoApi.randomUUID();
  const bytes=cryptoApi.getRandomValues(new Uint8Array(16));
  bytes[6]=(bytes[6]&15)|64;
  bytes[8]=(bytes[8]&63)|128;
  const hex=Array.from(bytes,value=>value.toString(16).padStart(2,'0')).join('');
  return [hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),hex.slice(16,20),hex.slice(20)].join('-');
}

// One queue owns start/heartbeat/finish, including navigation during a request.
export class AutoStudyTimer {
  constructor({api,store,now=()=>Date.now(),onChange=()=>{},keepAlive=false,startWhenIdle=keepAlive,heartbeatMs=20000}) {
    Object.assign(this,{api,store,now,onChange,keepAlive,startWhenIdle,heartbeatMs});
    this.record=store.read(); this.session=null; this.desired=false; this.finishing=false; this.tracking=false;
    this.busy=false; this.retryAt=0; this.lastSync=0; this.sequence=0; this.error='';
  }
  update(active, finish=false) {
    this.desired=active;
    this.finishing=this.finishing || finish;
    if (this.busy) return Promise.resolve();
    if (this.now()<this.retryAt) return Promise.resolve();
    this.pending=this.run();
    return this.pending;
  }
  async run() {
    this.busy=true;
    try {
      // A persisted start may have succeeded even if its reply was lost.
      if (!this.session && (this.record || !this.finishing && (this.desired || this.startWhenIdle))) {
        this.record ??= {controllerId:studyUuid()};
        this.store.write(this.record);
        const result=await this.api.start(this.record);
        this.record=result?{...this.record,sessionId:result.sessionId}:null;
        this.store.write(this.record);
        if(result)this.observe(result);
        this.lastSync=result?.initialSyncComplete?this.now():0;
      }
      if (this.session && this.finishing) {
        const result=await this.api.finish(this.record);
        this.lastSaved=result.creditedSeconds;
        this.record=null; this.session=null; this.store.write(null);
        this.tracking=false;
        this.finishing=false;
      } else if (this.session && (this.tracking!==this.desired || (this.desired||this.keepAlive) && this.now()-this.lastSync>=this.heartbeatMs)) {
        const result=await this.api.sync({...this.record,sequence:++this.sequence,tracking:this.desired});
        this.observe(result); this.lastSync=this.now();
      }
      this.error=''; this.retryAt=0;
      if(!this.session&&!this.record)this.finishing=false;
    } catch(error) {
      // Keep the pending record so reload/offline recovery cannot double-credit.
      if (error.code==='functions/failed-precondition' && this.record?.sessionId && /진행 중인 영단어/.test(error.message)) {
        await this.api.finish(this.record).then(()=>{this.record=null;this.session=null;this.store.write(null);}).catch(()=>{});
      }
      this.error=error.code==='functions/internal'?'스터디 서버에서 기록을 처리하지 못했습니다. 잠시 후 자동으로 다시 시도합니다.':error.message || '인터넷 연결을 확인해 주세요.';
      this.retryAt=this.now()+1000;
    } finally {this.busy=false;this.onChange();}
    // Handle leaving during an in-flight start/sync without waiting for a tick.
    if (this.session && !this.error && (this.finishing || this.tracking!==this.desired)) return this.run();
  }
  finish(){return this.update(false,true);}
  observe(result) {
    this.session=result.session;
    this.tracking=this.session.activeSinceMs!=null;
    this.observedAt=this.now();
    this.sequence=Math.max(this.sequence,this.session.sequence || 0);
  }
  seconds() {
    if (!this.session) return this.lastSaved || 0;
    const session=this.session;
    const serverNow=session.serverNowMs+Math.max(0,this.now()-this.observedAt);
    return (session.accumulatedSeconds || 0)+(session.activeSinceMs==null?0:Math.max(0,Math.min(serverNow,session.leaseUntilMs)-session.activeSinceMs)/1000);
  }
}

export function todayStudySeconds(history, session, sessionId, now=Date.now()) {
  const today=new Date(now+32400000).toISOString().slice(0,10);
  let seconds=Object.values(history).reduce((sum,row)=>sum+(row.id===sessionId&&session?0:row.dailySeconds?.[today]||0),0);
  if(session) {
    seconds+=session.dailySeconds?.[today]||0;
    const midnight=Date.parse(`${today}T00:00:00+09:00`);
    if(session.activeSinceMs!=null)seconds+=Math.max(0,Math.min(now,session.leaseUntilMs)-Math.max(midnight,session.activeSinceMs))/1000;
  }
  return Math.floor(seconds);
}

export function isLearning({visible,signedIn,words,test,blocked,idleMs}) {
  return visible && signedIn && !blocked && (words || test) && idleMs<10000;
}

export function localApi(store, now=()=>Date.now(), onCheckpoint=()=>{}) {
  let current=store.read();
  function checkpoint(tracking, finished=false) {
    const time=now(), session=current.session;
    if (session.activeSinceMs!=null) {
      const until=Math.max(session.activeSinceMs,Math.min(time,session.leaseUntilMs,session.startedAtMs+43200000));
      session.accumulatedSeconds+=(until-session.activeSinceMs)/1000;
      session.dailySeconds ??= {};
      for(let cursor=session.activeSinceMs;cursor<until;) {
        const date=new Date(cursor+32400000).toISOString().slice(0,10);
        const end=Math.min(until,(Math.floor((cursor+32400000)/86400000)+1)*86400000-32400000);
        session.dailySeconds[date]=(session.dailySeconds[date]||0)+(end-cursor)/1000;
        cursor=end;
      }
    }
    Object.assign(session,{activeSinceMs:tracking?time:null,leaseUntilMs:tracking?Math.min(time+30000,session.startedAtMs+43200000):null,serverNowMs:time});
    store.write(current);
    onCheckpoint({id:current.sessionId,startedAtMs:session.startedAtMs,updatedAtMs:time,seconds:Math.floor(session.accumulatedSeconds),dailySeconds:Object.fromEntries(Object.entries(session.dailySeconds||{}).map(([date,seconds])=>[date,Math.floor(seconds)])),status:finished?'finished':tracking?'active':'paused'});
    return {sessionId:current.sessionId,session:{...session}};
  }
  return {
    async start() {
      current ??= {sessionId:studyUuid(),session:{startedAtMs:now(),accumulatedSeconds:0,dailySeconds:{},activeSinceMs:null,leaseUntilMs:null,serverNowMs:now()}};
      store.write(current);
      return {sessionId:current.sessionId,session:{...current.session}};
    },
    async sync({tracking=true}={}){return checkpoint(tracking);},
    async finish(){checkpoint(false,true);const creditedSeconds=Math.floor(current.session.accumulatedSeconds);current=null;store.write(null);return {creditedSeconds};},
  };
}
