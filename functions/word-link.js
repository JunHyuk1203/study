import {getApps,initializeApp} from 'firebase-admin/app';
import {getAuth} from 'firebase-admin/auth';
import {getFirestore,Timestamp} from './platform-store.js';
import {onCall} from './platform-http.js';
import {createWordLinkService} from './word-link-service.js';

const studyApp=getApps().find(app=>app.name==='[DEFAULT]')??initializeApp();
const wordApp=getApps().find(app=>app.name==='word-link-verifier')??initializeApp({projectId:'goodnotesword-454fa'},'word-link-verifier');
const studyAuth=getAuth(studyApp);
const service=createWordLinkService({
  db:getFirestore(studyApp,'study-data'),
  verifyWordToken:token=>getAuth(wordApp).verifyIdToken(token),
  getStudyUser:uid=>studyAuth.getUser(uid),
  mintToken:(uid,claims)=>studyAuth.createCustomToken(uid,claims),
  now:()=>Timestamp.now(),
});
const options={region:'asia-northeast3',invoker:'public',maxInstances:2,minInstances:0,memory:'256MiB',cpu:'gcf_gen1',concurrency:1,timeoutSeconds:30};
export const saveWordStudyLink=onCall(options,request=>service.save(request));
export const restoreWordStudyLink=onCall(options,request=>service.restore(request));
export const removeWordStudyLink=onCall(options,request=>service.remove(request));
