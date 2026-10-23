import test from 'node:test';
import assert from 'node:assert/strict';
import {hourlyInterval,mergeHours,buildDailyReport} from '../functions/report-math.js';
import {checkpointCamera,splitStudyInterval} from '../functions/domain.js';
const ms=value=>Date.parse(value);
test('hourly credit splits at KST midnight and conserves seconds',()=>{
  const hours=hourlyInterval(ms('2026-10-22T23:59:50+09:00'),ms('2026-10-23T00:00:15+09:00'));
  assert.deepEqual(hours,{'2026-10-22':{'23':10},'2026-10-23':{'0':15}});
  assert.equal(mergeHours(hours,hours)['2026-10-23'][0],30);
});
test('camera hourly checkpoints never credit an expired lease or pauses twice',()=>{
  const start=ms('2026-10-23T09:59:55+09:00');
  let session={startedAtMs:start,...checkpointCamera({startedAtMs:start},start,true)};
  session={...session,...checkpointCamera(session,start+60000,false)};
  assert.deepEqual(session.hourlySeconds,{'2026-10-23':{'9':5,'10':5}});
  assert.equal(session.accumulatedSeconds,10);
  assert.deepEqual(checkpointCamera(session,start+90000,false).hourlySeconds,session.hourlySeconds);
});
test('report clips cross-day sessions, excludes active records and preserves unknown history',()=>{
  const start=ms('2026-10-22T23:30:00+09:00'),end=start+3600000;
  const rows=[{id:'ordinary',status:'finished',subjectId:'math',startedAtMs:start,endedAtMs:end,segments:splitStudyInterval(start,end)},
    {id:'old-camera',status:'finished',cameraMode:true,subjectId:'math',startedAtMs:end,endedAtMs:end+600000,segments:[{date:'2026-10-23',seconds:300}]},
    {id:'active',status:'active',subjectId:'math',startedAtMs:end,segments:[{date:'2026-10-23',seconds:1000}]}];
  const report=buildDailyReport(rows,'2026-10-23');
  assert.equal(report.totalSeconds,2100);assert.equal(report.sessionCount,2);
  assert.equal(report.longestSeconds,1800);assert.equal(report.averageSeconds,1050);
  assert.equal(report.hourly[0],1800);assert.equal(report.unallocatedSeconds,300);
  assert.equal(report.pauseSeconds,300);assert.equal(report.subjectSeconds.math,2100);
  assert.equal(report.sourceSeconds['일반 학습'],1800);assert.equal(report.sourceSeconds['스터디캠'],300);
});
test('empty report has no NaN and no invented activity',()=>{
  const report=buildDailyReport([],'2026-10-23');
  assert.equal(report.studyRatio,0);assert.equal(report.averageSeconds,0);
  assert.equal(report.hourly.reduce((sum,value)=>sum+value,0),0);
});
