// Bounded, sequential pages. The finalizer rechecks presence in its transaction.
export async function cleanupExpiredSessions(db, finish, {now=()=>Date.now(),log=()=>{},budgetMs=20000,maxSessions=1000}={}) {
  const cutoff=now(),deadline=cutoff+budgetMs;
  let cursor=null,processed=0,failed=0,renewed=0;
  while(processed+failed+renewed<maxSessions && now()<deadline) {
    let query=db.collection('wordStudyLeases').where('expiresAtMs','<=',cutoff).orderBy('expiresAtMs').limit(Math.min(100,maxSessions-processed-failed-renewed));
    if(cursor)query=query.startAfter(cursor);
    const page=await query.get();
    if(!page.docs.length)break;
    for(const lease of page.docs) {
      if(now()>=deadline)break;
      cursor=lease;
      const {uid,sessionId}=lease.data();
      try {
        const result=await finish(uid,sessionId,cutoff);
        // Successful finalization removes its lease in the finalizer transaction.
        // Repair a stale query entry only after a fresh read of renewed presence.
        if(result?.notExpired)await db.runTransaction(async tx=>{
          const ref=db.doc(`users/${uid}/sessions/${sessionId}`);
          const [current,record]=await tx.getAll(lease.ref,ref);
          if(!current.exists || current.data().expiresAtMs>cutoff)return;
          const session=record.data();
          if(!session || session.status==='finished')tx.delete(lease.ref);
          else if(session.presenceUntilMs>cutoff)tx.update(lease.ref,{expiresAtMs:session.presenceUntilMs});
        });
        if(result?.notExpired)renewed++;else processed++;
      } catch(error) {
        if(error.code==='not-found') {
          const repaired=await db.runTransaction(async tx=>{
            const [current,session]=await tx.getAll(lease.ref,db.doc(`users/${uid}/sessions/${sessionId}`));
            if(current.exists && current.data().expiresAtMs<=cutoff && (!session.exists || session.data().status==='finished'))tx.delete(lease.ref);
          }).then(()=>true,error=>{log('session-cleanup-item',{code:error.code||'unknown'});return false;});
          if(repaired)processed++;else failed++;
        } else {failed++;log('session-cleanup-item',{code:error.code||'unknown'});}
      }
    }
    if(page.docs.length<100)break;
  }
  const remaining=await db.collection('wordStudyLeases').where('expiresAtMs','<=',cutoff).orderBy('expiresAtMs').limit(1).get();
  const oldestPendingMs=remaining.docs[0]?.data().expiresAtMs??null;
  const result={processed,failed,renewed,oldestPendingMs,elapsedMs:now()-cutoff};
  log('session-cleanup',result);
  return result;
}
