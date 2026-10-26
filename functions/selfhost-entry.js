process.env.STUDY_BACKEND='selfhost';
process.env.GCLOUD_PROJECT ||= 'study-junhyuk1203-20261021';
try {const {startSelfHost}=await import('./selfhost-server.js');await startSelfHost();}
catch(error){console.error(JSON.stringify({event:'startup-error',code:error.code||'startup',message:'서버 시작에 실패했습니다. 연결 설정과 DB 상태를 확인해 주세요.'}));process.exit(1);}
