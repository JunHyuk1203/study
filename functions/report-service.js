import {Timestamp} from 'firebase-admin/firestore';
import {HttpsError} from 'firebase-functions/v2/https';
import {buildDailyReport, studyDate} from './report-math.js';
import {MAX_SESSION_MS,splitStudyInterval} from './domain.js';

export async function dailyReport(db, uid) {
  const date = studyDate(), start = Date.parse(`${date}T00:00:00+09:00`);
  const profileRef = db.doc(`users/${uid}`);
  // One bounded server query includes sessions crossing midnight. No raw private
  // session records or other users' records are exposed to the browser.
  const [profile, sessions, days] = await Promise.all([
    profileRef.get(),
    profileRef.collection('sessions').where('startedAt','>=',Timestamp.fromMillis(start-MAX_SESSION_MS))
      .where('startedAt','<',Timestamp.fromMillis(start+86400000)).orderBy('startedAt').limit(1001).get(),
    profileRef.collection('dailyStats').orderBy('__name__').startAt(studyDate(start-6*86400000)).endAt(date).limit(7).get(),
  ]);
  if (sessions.size > 1000) throw new HttpsError('resource-exhausted','오늘 기록이 너무 많아 리포트를 불러오지 못했습니다.');
  const rows = sessions.docs.map(doc => {const row=doc.data(); return {...row,id:doc.id,startedAtMs:row.startedAt.toMillis(),endedAtMs:row.endedAt?.toMillis()};});
  // Older ordinary sessions persisted creditedSeconds without daily segments.
  for (const row of rows) if (!row.segments && row.status==='finished') {
    row.segments = splitStudyInterval(row.startedAtMs,row.endedAtMs);
  }
  const report = buildDailyReport(rows,date);
  const history = new Map(days.docs.map(doc => [doc.id,doc.data().totalSeconds||0]));
  report.days = Array.from({length:7},(_,i)=>{const day=studyDate(start-(6-i)*86400000);return {date:day,seconds:day===date?report.totalSeconds:history.get(day)||0};});
  report.subjects = Object.fromEntries([['other','기타'],['korean','국어'],['math','수학'],['english','영어'],['science','과학'],['social','사회'],...(profile.data()?.subjects||[]).map(row=>[row.id,row.name])]);
  report.hasActiveSession = rows.some(row=>row.status==='active');
  report.generatedAtMs = Date.now();
  return report;
}
