import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {checkpointCamera,CAMERA_LEASE_MS,CAMERA_PRESENCE_MS,WORD_LEASE_MS,WORD_PRESENCE_MS,MAX_SESSION_MS,HEARTBEAT_MS,STUDY_CONTRACT_VERSION} from '../functions/domain.js';

test('documented server contract preserves credit limits and distinguishes ownership presence',async()=>{
  const doc=await readFile(new URL('../docs/study-sync-contract.md',import.meta.url),'utf8');
  assert.ok(doc.includes(STUDY_CONTRACT_VERSION));
  assert.ok(doc.includes(`| 카메라 | ${HEARTBEAT_MS} | ${CAMERA_LEASE_MS} | ${CAMERA_PRESENCE_MS} | ${MAX_SESSION_MS} |`));
  assert.ok(doc.includes(`| SP word 연동 | ${HEARTBEAT_MS} | ${WORD_LEASE_MS} | ${WORD_PRESENCE_MS} | ${MAX_SESSION_MS} |`));
  const client=await readFile(new URL('../data.js',import.meta.url),'utf8');
  assert.ok(client.includes(`contractVersion:'${STUDY_CONTRACT_VERSION}'`));
  assert.match(client,/Date\.now\(\) - cameraLastSync < 5000/);
});

for(const delay of [100,2000,8000,15000])test(`word renewal after ${delay}ms RTT credits no unobserved gap`,()=>{
  const start=100000;
  const session={startedAtMs:start,segments:[],activeSinceMs:start,leaseUntilMs:start+WORD_LEASE_MS};
  const received=start+5000+delay;
  const renewed=checkpointCamera(session,received,true,WORD_LEASE_MS);
  assert.equal(renewed.accumulatedSeconds,Math.min(10,Math.floor((received-start)/1000)));
  assert.equal(renewed.activeSinceMs,Math.floor(received/1000)*1000);
  assert.equal(renewed.canResume,true);
  assert.ok(received<start+WORD_PRESENCE_MS);
});

test('12 hour boundary returns a stable terminal reason without extending credit',()=>{
  const session={startedAtMs:0,activeSinceMs:MAX_SESSION_MS-5000,leaseUntilMs:MAX_SESSION_MS+5000};
  const result=checkpointCamera(session,MAX_SESSION_MS+1000,true);
  assert.equal(result.accumulatedSeconds,5);assert.equal(result.activeSinceMs,null);
  assert.equal(result.canResume,false);assert.equal(result.terminalReason,'max-duration');
});
