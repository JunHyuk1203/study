import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createWordLinkService} from '../functions/word-link-service.js';

function fixture() {
  const rows=new Map(),minted=[];
  const ref=path=>({path,get:async()=>({data:()=>rows.get(path)}),set:async value=>rows.set(path,value)});
  const db={doc:ref,runTransaction:async action=>action({get:r=>r.get(),delete:r=>rows.delete(r.path)})};
  let word={uid:'word-a',email_verified:true},study={uid:'study-a',emailVerified:true};
  const service=createWordLinkService({db,verifyWordToken:async token=>{if(token==='bad'.repeat(12))throw Error('bad signature');return word;},getStudyUser:async()=>study,mintToken:async(uid,claims)=>{minted.push({uid,claims});return 'one-time-custom-token';},now:()=>123});
  const request={auth:{uid:'study-a',token:{email_verified:true}},data:{wordIdToken:'verified'.repeat(8),wordUid:'spoofed'}};
  return {rows,minted,service,request,setWord:value=>{word=value;},setStudy:value=>{study=value;}};
}
test('link save requires both verified identities and stores only account IDs',async()=>{
  const f=fixture();await assert.rejects(()=>f.service.save({...f.request,auth:null}),e=>e.code==='unauthenticated');
  await assert.rejects(()=>f.service.save({...f.request,data:{wordIdToken:'bad'.repeat(12)}}),e=>e.code==='unauthenticated');
  f.setWord({uid:'word-a',email_verified:false});await assert.rejects(()=>f.service.save(f.request),e=>e.code==='failed-precondition');
  f.setWord({uid:'word-a',email_verified:true});await f.service.save(f.request);
  assert.deepEqual(f.rows.get('wordAccountLinks/word-a'),{wordUid:'word-a',studyUid:'study-a',updatedAt:123});
  assert.equal(f.rows.has('wordAccountLinks/spoofed'),false);
});
test('reopen restores only the verified word account mapping and denies disabled study users',async()=>{
  const f=fixture();assert.deepEqual(await f.service.restore(f.request),{linked:false});await f.service.save(f.request);
  const result=await f.service.restore({...f.request,auth:null});assert.equal(result.linked,true);
  assert.deepEqual(f.minted,[{uid:'study-a',claims:{wordLinkUid:'word-a'}}]);
  f.setWord({uid:'word-b',email_verified:true});assert.deepEqual(await f.service.restore(f.request),{linked:false});
  f.setWord({uid:'word-a',email_verified:true});f.setStudy({uid:'study-a',emailVerified:true,disabled:true});
  await assert.rejects(()=>f.service.restore(f.request),e=>e.code==='failed-precondition');
});
test('unlink is owner checked and a restored session cannot link a different word account',async()=>{
  const f=fixture();await f.service.save(f.request);
  await assert.rejects(()=>f.service.remove({...f.request,auth:{uid:'study-b',token:{email_verified:true}}}),e=>e.code==='permission-denied');
  await assert.rejects(()=>f.service.save({...f.request,auth:{uid:'study-a',token:{email_verified:true,wordLinkUid:'word-b'}}}),e=>e.code==='permission-denied');
  await f.service.remove(f.request);assert.deepEqual(await f.service.restore(f.request),{linked:false});
});
