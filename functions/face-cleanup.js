// No face data or keys are present here. Short-lived metadata is erased hourly.
export async function cleanupFaceSecurity(db,{now=Date.now(),limit=1000}={}) {
  let processed=0;
  for(const [collection,field]of [['faceSecurity','cleanupAtMs'],['faceSecurityRates','until']]){
    while(processed<limit){
      const rows=await db.collection(collection).where(field,'<=',now).orderBy(field).limit(Math.min(100,limit-processed)).get();
      if(!rows.docs.length)break;
      for(const row of rows.docs){await db.runTransaction(async tx=>{
        const state=(await tx.get(row.ref)).data();if(!state||state[field]>now)return;
        if(collection==='faceSecurityRates'){tx.delete(row.ref);return;}
        for(const key of ['challenge','ticket','unlock','grant'])if(state[key]?.expiresAtMs<=now)state[key]=null;
        state.audit=(state.audit||[]).filter(item=>now-item.at<90*86400000);
        state.registrations=(state.registrations||[]).filter(at=>now-at<86400000);
        state.cleanupAtMs=now+3600000;tx.set(row.ref,state);
      });processed++;}
    }
  }
  return {processed};
}
