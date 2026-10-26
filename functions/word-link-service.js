import {HttpsError} from './platform-http.js';

// Dependencies are injected so account ownership and restoration can be tested.
export function createWordLinkService({db,verifyWordToken,getStudyUser,mintToken,now}) {
  async function wordUser(request) {
    const token=request.data?.wordIdToken;
    if(typeof token!=='string'||token.length<32||token.length>8192)throw new HttpsError('unauthenticated','단어앱에 로그인해 주세요.');
    let user;
    try{user=await verifyWordToken(token);}catch{throw new HttpsError('unauthenticated','단어앱 로그인을 다시 확인해 주세요.');}
    if(user.email_verified!==true)throw new HttpsError('failed-precondition','단어앱 이메일을 인증해 주세요.');
    return user;
  }
  function studyUser(request,wordUid) {
    if(!request.auth)throw new HttpsError('unauthenticated','스터디에 로그인해 주세요.');
    if(request.auth.token.email_verified!==true)throw new HttpsError('failed-precondition','스터디 이메일을 인증해 주세요.');
    if(request.auth.token.wordLinkUid&&request.auth.token.wordLinkUid!==wordUid)throw new HttpsError('permission-denied','현재 단어앱 계정으로 스터디를 다시 연결해 주세요.');
    return request.auth.uid;
  }
  return {
    async save(request) {
      const word=await wordUser(request),studyUid=studyUser(request,word.uid);
      await db.doc(`wordAccountLinks/${word.uid}`).set({wordUid:word.uid,studyUid,updatedAt:now()});
      return {linked:true,studyUid};
    },
    async restore(request) {
      const word=await wordUser(request),ref=db.doc(`wordAccountLinks/${word.uid}`);
      const link=(await ref.get()).data();
      if(!link)return {linked:false};
      let study;
      try{study=await getStudyUser(link.studyUid);}catch(error){if(error.code==='auth/user-not-found')return {linked:false};throw error;}
      if(study.disabled||!study.emailVerified)throw new HttpsError('failed-precondition','연결된 스터디 계정 상태를 확인해 주세요.');
      return {linked:true,token:await mintToken(study.uid,{wordLinkUid:word.uid})};
    },
    async remove(request) {
      const word=await wordUser(request),studyUid=studyUser(request,word.uid),ref=db.doc(`wordAccountLinks/${word.uid}`);
      await db.runTransaction(async tx=>{
        const link=(await tx.get(ref)).data();
        if(link&&link.studyUid!==studyUid)throw new HttpsError('permission-denied','연결된 스터디 계정이 일치하지 않습니다.');
        if(link)tx.delete(ref);
      });
      return {linked:false};
    },
  };
}
