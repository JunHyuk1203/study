import { planSubjects } from './plan-domain.js';
import { changePlan } from './plan-service.js';

export const studyPlanTools = [{name:'get_study_plan',description:'현재 계정에 등록한 과목과 공부 목표를 조회한다.',parameters:{type:'OBJECT',properties:{}}},
  {name:'add_study_subject',description:'사용자가 명시적으로 추가를 요청한 학습 과목을 계정 설정에 저장한다. 임의로 과목을 만들지 않는다.',parameters:{type:'OBJECT',properties:{name:{type:'STRING',description:'과목 이름, 1~20자'}},required:['name']}},
  {name:'add_study_goal',description:'사용자가 등록을 요청한 오늘·이번 주·이번 달 공부시간 목표를 저장한다. 과목 이름은 등록된 정확한 이름을 쓴다. 새 과목이면 먼저 add_study_subject로 추가한다. 불명확한 기간·시간은 사용자에게 물어본다.',parameters:{type:'OBJECT',properties:{period:{type:'STRING',enum:['day','week','month']},minutes:{type:'INTEGER',description:'목표 총 분 (예: 2시간 30분은 150)'},subjectName:{type:'STRING',description:'전체 공부시간이면 전체, 과목별이면 등록된 과목 이름'}},required:['period','minutes','subjectName']}}];

export async function runPlanTool(db, user, name, args) {
  if (name === 'add_study_subject') return changePlan(db,user,'addSubject',{name:args?.name});
  const profile = (await db.doc(`users/${user}`).get()).data();
  if (name === 'get_study_plan') return {subjects:planSubjects(profile),goals:profile?.goals || []};
  if (name !== 'add_study_goal') throw new Error('지원하지 않는 목표 도구입니다.');
  const subject = args?.subjectName === '전체' ? {id:'all'} : planSubjects(profile).find(row => row.name === args?.subjectName);
  if (!subject) throw new Error('해당 과목을 먼저 추가해 주세요.');
  return changePlan(db,user,'addGoal',{period:args.period,minutes:args.minutes,subjectId:subject.id});
}
