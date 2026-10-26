# SP word 사용자 도메인 CORS 수정 (2026-10-24)

운영 확인 결과 https://junhyuk1203.github.io/superword/ 는 https://word.junhyuk.site/ 로 리디렉트된다. 웹과 새 연결 모듈은 정상 배포됐지만 자체 API는 Origin https://word.junhyuk.site 에 403을 반환하고, study.junhyuk.site 및 junhyuk1203.github.io 에만 204를 반환했다. 브라우저는 이를 네트워크 실패로 표시한다.

서버는 별도 PC 192.168.0.200 에서 실행되고 있다. 진단 당시 이 개발 PC의 주소는 192.168.0.10/192.168.0.8 이었으므로 개발 PC의 설정 변경이나 서버 실행으로 운영 서버를 대체하지 않았다.

즉시 조치: 운영 서버 창의 설정 > 허용할 웹 주소에 https://word.junhyuk.site 를 별도 줄로 추가하고 저장 후 서버를 재시작한다. 기존 주소는 유지한다.

영구 수정: 런처 신규 기본값과 기존 암호화 설정 자동 보정에 위 주소를 추가했다. Node 단독 실행의 기본 목록도 수정했다. 빌드 산출물은 server/artifacts/word-domain-fix/StudyServer.exe 이다. 기존 서버 창 종료 후 해당 파일을 운영 PC에서 실행하면 저장된 설정을 유지하면서 주소를 추가한다. 새 EXE에는 키를 내장하지 않았다.

배포된 웹을 다시 수정할 필요는 없다. 운영 PC 설정 변경 또는 수정 EXE 적용 후 실제 Origin 요청이 204인지 재검증해야 한다.
EXE SHA-256: 9F14CB5680371F3217B2D63CA64C6C900D327C5FB126BF592B78D19D94F5DB79
