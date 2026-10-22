import { randomUUID } from 'node:crypto';
import { HttpsError } from 'firebase-functions/v2/https';
import { Timestamp } from 'firebase-admin/firestore';
import { appendGoal, goalInput, planSubjects, subjectName } from './plan-domain.js';

// Every write is scoped to the authenticated owner and serialized on their profile.
export async function changePlan(db, uid, action, input, now = Date.now()) {
  const ref = db.doc(`users/${uid}`);
  return db.runTransaction(async tx => {
    const snapshot = await tx.get(ref);
    if (!snapshot.exists) throw new HttpsError('failed-precondition','계정 프로필을 먼저 생성해 주세요.');
    const profile = snapshot.data(), update = {updatedAt:Timestamp.fromMillis(now)};
    let result;
    try {
      if (action === 'addSubject') {
        const name = subjectName(input?.name), subjects = profile.subjects || [];
        const existing = planSubjects(profile).find(row => row.name.toLocaleLowerCase() === name.toLocaleLowerCase());
        if (existing) return {subject:existing,alreadyExists:true};
        if (subjects.length >= 30) throw new Error('직접 추가할 수 있는 과목은 최대 30개입니다.');
        const subject = {id:`s_${randomUUID()}`,name};
        update.subjects = [...subjects,subject];result = {subject};
      } else if (action === 'removeSubject') {
        if (!input?.id || input.id === 'other') throw new Error('기타 과목은 삭제할 수 없습니다.');
        if (profile.activeSessionId) throw new Error('학습을 종료한 뒤 과목을 삭제해 주세요.');
        if ((profile.goals || []).some(goal => goal.subjectId === input.id)) throw new Error('이 과목의 목표를 먼저 삭제해 주세요.');
        update.subjects = (profile.subjects || []).filter(row => row.id !== input.id);result = {removed:true};
      } else if (action === 'addGoal') {
        const goal = {...goalInput(input,profile,now),id:randomUUID()};
        result = appendGoal(profile.goals || [],goal);update.goals = result.goals;
        delete result.goals;
      } else if (action === 'removeGoal') {
        if (typeof input?.id !== 'string') throw new Error('삭제할 목표를 선택해 주세요.');
        update.goals = (profile.goals || []).filter(row => row.id !== input.id);result = {removed:true};
      } else throw new Error('지원하지 않는 요청입니다.');
    } catch (error) {throw new HttpsError('invalid-argument',error.message);}
    tx.update(ref,update);
    return result;
  });
}
