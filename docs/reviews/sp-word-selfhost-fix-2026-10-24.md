# SP word 자체 서버 연동 수정 (2026-10-24)

원인: 스터디 서버는 HTTP/PostgreSQL로 전환했지만 SP word의 호출·스터디 기록 조회·종료 요청은 Firebase를 사용했다. SP word CSP에도 새 API 주소가 없었으며 자체 서버는 스터디 로그인 복원 API에도 기존 스터디 로그인을 요구했다.

수정: `.codex-superword-sync`의 `study-server-client.js`, `study-integration.js`, `index.html` 및 관련 테스트. 스터디 서버의 `functions/selfhost-server.js`는 복원 요청에 한해 Word 토큰을 업무 계층에서 검증하고, 나머지 경로의 인증과 Origin 제한을 유지한다. 익명 복원 요청은 접속 IP 기준 횟수 제한을 적용한다. 계정 전환 시 이전 사용자 자격으로 미완료 기록을 종료한다. 스터디 통계는 자체 서버에서 5초마다 조회하며 Word 자체 DB는 기존대로 유지한다.

검증: PostgreSQL/HTTP 통합 18개 통과, SP word 타이머·계정 전환 20개 통과, 자체 서버 전송 4개 통과, 기존 계정 연결 서비스 3개 통과. 320/390/1280px UI 통과. 별도 EXE 빌드 성공.

산출물: `server/artifacts/word-link-fix/StudyServer.exe`, `server/artifacts/word-link-fix/sp-word-web-update.zip`. ZIP은 SP word 저장소 루트의 웹 파일 3개 교체용이며 단독 웹앱이 아니다. 서버 EXE는 기존 사용자 설정을 사용하며 이번 빌드에는 인증정보를 내장하지 않았다.

적용 상태: 소스와 빌드 산출물만 준비했다. 공개 웹 배포·기존 서버 교체·운영 로그인 실검증은 수행하지 않았다. SP word 웹 업데이트와 서버 교체가 모두 필요하다. 기존 Firestore 연결 문서는 이전하지 않았으므로 스터디 로그인도 유실된 경우 한 번 다시 연결해야 한다.

서버 통합 테스트 로그: C:/Users/tntdr/AppData/Local/Temp/study-selfhost-test-bf4b13914eec494a86246f87ae9ff05e/tests.log
EXE SHA-256: A219C4AD7E0DFF0E254AC8CACB87A2E1EC10FBD7A394E238BC12DB31441DC548
