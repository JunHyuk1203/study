import {defineSecret as cloudSecret} from 'firebase-functions/params';
export function defineSecret(name) {
  if (process.env.STUDY_BACKEND !== 'selfhost') return cloudSecret(name);
  return {value() {
    const value = process.env[name];
    if (!value) throw Object.assign(new Error('서버 설정에서 외부 API 키를 등록해 주세요.'), {code:'failed-precondition'});
    return value;
  }};
}
