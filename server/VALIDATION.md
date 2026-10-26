# 자체 서버 구현·검증 결과

2026-10-24 기준. **로컬 구현과 실행 검증을 완료했으며 공개 서비스 전환은 아직 하지 않았다.**

## 백업

- 위치: `C:\Users\tntdr\AppData\Local\StudyServerBackups\study-20261024-154915`.
- 구현 전 개발 폴더 전체 38,942개 파일, 약 519MB 복사. 복사 실패·불일치 0개.
- `.git`, 미추적·무시 파일, 의존성, 로그·검토 자료까지 포함했다.
- 별도 `repository.bundle`에 전체 Git refs를 보관하고 검증했다.
- 개발 파일 358개에 대해 원본과 사본 SHA-256이 모두 일치했다. 백업 폴더의 `verification.json`에 기록했다.
- 기존 Firebase 학습 데이터는 이관하지 않아도 된다는 사용자 지시에 따라 클라우드 DB 반출·삭제는 수행하지 않았다. Auth는 유지한다.

## 산출물

- 기존 사전 설정 실행 파일: `server/artifacts/ready/StudyServer.exe` — 303,378,403바이트, Windows x64 단일 배포 파일. 이전 release 파일의 잠금 때문에 별도 경로로 publish했다. 현재 권장 개인용 파일은 아래 portable 빌드다.
- SHA-256: `BADD96CE1F0ADCA6BD7DD5F79A173D3FE6995BF5C448C7763B32567392735753`.
- Node.js 24.22.1, PostgreSQL 18.6, .NET 8.0.32, Caddy 2.11.7, cloudflared 2026.10.3과 앱 전용 C++ 런타임을 포함한다.
- 런타임 원본 URL·해시와 Microsoft 서명 확인된 C++ DLL의 버전·해시는 `server/artifacts/validation/runtime-manifest.json`에 기록했다.
- 프로그램은 서비스 설치나 부팅 자동 실행 없이 사용자가 직접 실행·종료한다. 웹 파일은 GitHub Pages에서 제공한다.

## 완료한 검증

| 검증 | 결과 | 근거 |
|---|---|---|
| 기존 단위·UI 계약 테스트 | 234/234 통과 | `server/artifacts/validation/unit.log` |
| 실제 PostgreSQL + HTTP + 브라우저 전송 계층 통합 | 16/16 통과 | `server/artifacts/validation/integration.log` |
| 최종 EXE 하나만 빈 폴더에 복사해 실행 | 종료 코드 0 | `server/artifacts/validation/exe-result.json` |
| 런처 빌드·publish | 오류·경고 0 | `.codex-selfhost-publish.log` |
| JavaScript 구문·diff 공백 검사 | 통과 | `node --check`, `git diff --check` |

통합 테스트는 병렬 저장과 롤백, 깊은 병합·얕은 수정, Timestamp 정밀도·삭제된 페이지 경계, 본인·학교 접근 권한, 동시 시작과 중복 종료 보상, 카메라·단어 상호 배제, 친구·방 삭제, NEIS 캐시, AI 예약·일일 동시 제한·HTTP 스트림, 브라우저 토큰 재갱신과 응답 복원을 검증한다.

EXE 자체 검증 8항목은 내장 런타임 추출, PostgreSQL 시작, API health, 미인증 거절, pg_dump, pg_restore, 백업 암호화·오류 암호 거절, 정상 종료다. 사용 중인 운영 DB를 덮어쓰지 않고 별도 TEMP 폴더에서 검사했다. 렌더링한 실행창도 확인했다: `server/artifacts/validation/launcher.png`.

단위·통합 테스트와 EXE 검증을 합쳐도 **실제 운영 Firebase 계정의 로그인·Google 팝업·실제 AI 청구·공개 인터넷 회선 연결까지 검증한 것은 아니다.** 통합 테스트의 인증 신원과 외부 AI·NEIS는 테스트 응답을 사용했다. EXE 자체 시험도 현재 PC에서 수행했으며, 다른 깨끗한 Windows 11 PC에서의 재검증은 별도다.

## 현재 PC 사전 설정 검증

전용 `study-windows-server` 서비스 계정을 생성하고 `roles/firebaseauth.viewer`를 부여했다. 기존 Firebase 로그인으로 Secret Manager에서 NEIS·Google AI 키를 읽어 현재 사용자의 DPAPI 보호 설정에 저장했다. EXE나 공개 저장소에 비밀 값을 포함하지 않았다.

`node server/provision-current-user.cjs --verify`가 종료 코드 0으로 완료되었다. 실제 서버 계정의 Auth 조회에서 존재하지 않는 진단 UID에 대해 정상적인 user-not-found를 확인했고, 커스텀 토큰의 로컬 개인 키 서명과 Google AI 모델 목록 조회(HTTP 200)를 검증했다. 로그인·신규 사용자 생성·AI 답변 생성·공개 배포는 하지 않았다.

기본 연결 방식은 직접 HTTPS, 주소는 `https://api.study.junhyuk.site`다. 현재 공인 IPv4·내부 IP 자동 안내를 추가했다. DNS는 Spaceship 네임서버로 확인했으며 API A 레코드는 아직 없다. 구체적인 사용자 작업은 `server/USER-STEPS.md`에 기록했다. Windows 방화벽 규칙 자동 추가는 사용자의 명시적인 추가 승인을 받아 구현했다. 직접 HTTPS로 서버를 시작할 때 필요한 경우에만 UAC를 거쳐 Caddy 프로그램 경로·TCP 80/443에 제한된 이름 있는 규칙을 생성/갱신한다. API·DB 내부 포트는 개방하지 않는다.

`server/test-firewall.ps1`에서 실제 생성 스크립트의 기존 규칙 재사용, 읽기 전용 검사, 정확한 범위의 신규 생성, 변경된 런타임 경로 갱신, 중복 적용 방지 5개 사례를 모의 OS 경계로 검증했다. 테스트 과정에서 운영 방화벽을 변경하지 않았다. 실제 UAC 승인·Windows 규칙 적용·공개 회선 검증은 최초 실행 시 확인해야 한다.

방화벽 기능을 포함한 최종 `ready` EXE도 별도 진단 포트에서 자체 검사 8항목을 모두 통과했고 종료 코드 0을 확인했다. 증거는 `server/artifacts/validation/firewall-exe-result.json`이다. 실행 중인 이전 서버 창은 종료하지 않았다. 공개 DNS·공유기·방화벽 연결은 아직 검증하지 못했다.

보조 모델 검토는 도구 훅·Windows 명령행 제한 및 빈 응답 문제로 유효한 결과를 얻지 못했다. 외부 모델의 검토가 완료되었다고 간주하지 않고 직접 코드 확인과 위 실행 결과를 근거로 삼았다.

## 웹앱 자체 서버 전환 검증 — 2026-10-24

- GitHub Pages의 웹앱 데이터·실시간 구독·기능 호출은 `https://api.study.junhyuk.site/api/v1/`을 사용한다. Firebase Auth는 로그인과 ID 토큰 발급에만 사용한다.
- 브라우저 진입점에서 도달하는 모듈 27개를 확인했다. Firebase Firestore·Functions·Storage SDK와 클라우드 데이터 주소를 불러오는 경로는 없다.
- 기존 웹앱 테스트 234개와 오류 안내 수정 후 관련 테스트 55개가 통과했다. 근거: `server/artifacts/validation/web-switch-unit.log`, `web-switch-focused.log`.
- 실제 PostgreSQL + HTTP + 브라우저 전송 통합 테스트 17개가 통과했다. 서버 중단 때 읽기·저장을 거절하고 Firebase 데이터 서비스로 우회하지 않는 검사도 포함한다. 근거: `server/artifacts/validation/web-switch-selfhost-elevated.log`.
- Firebase 서버 연결 파일·NEIS·AI 키는 현재 Windows 사용자 암호화 설정에 등록했다. Spaceship A 레코드와 공유기의 TCP 80·443 전달 규칙을 저장했다. Caddy 전용 Windows 방화벽 규칙은 최신 EXE 최초 실행 시 권한 확인 후 설정한다.
- GitHub Pages 배포 완료: `5724d5a554f1595f449949ec5d5899b216cd3f72`, [배포 실행](https://github.com/JunHyuk1203/study/actions/runs/40095095985). 최초 공개 검사에서 누락됐던 `server-client.js`는 Jekyll 명시적 포함 설정으로 수정했다.
- 공개 사이트에서 웹앱 모듈 27개가 모두 HTTP 200이며 Firebase 데이터 SDK가 없고, 자체 서버 주소·인증 토큰 요청·Firebase Auth 유지가 반영된 것을 확인했다. 근거: `server/artifacts/validation/pages-deployment-result.json`.
- 공개 API health는 여전히 시간 초과다. 프런트엔드 배포와 별도로 최신 EXE 실행 및 실제 계정 기능 확인은 아래 항목으로 남는다.
- 공개 저장소에는 웹앱 파일 21개만 올렸다. 서버 구현·운영 문서·비밀 설정은 이번 공개 커밋에 포함하지 않았다.

## 실서버에서 남은 확인

1. 최신 `server/artifacts/portable/StudyServer.exe`를 실행하고 `https://api.study.junhyuk.site/health`의 외부 응답을 확인한다.
2. 실제 Firebase 로그인과 학교·AI 기능, 여러 탭을 실제 계정으로 확인한다. 서버가 꺼져 있어도 Pages 화면과 Firebase 로그인은 열리지만 데이터 기능은 연결 오류를 표시한다.
3. 별도 `superword` 저장소의 STUDY 호출을 HTTP API로 함께 전환한다. 이 저장소에는 외부 앱 소스가 없어 해당 저장소는 아직 변경하지 않았다.

기존 Firebase Functions와 클라우드 데이터는 삭제하지 않았다. 웹앱에는 해당 데이터 서비스로 되돌아가는 경로가 없다.

실행·설정 순서는 [서버 안내](README.md)를 따른다.

## 계정·키 내장 개인용 portable EXE — 2026-10-24

- 파일: `server/artifacts/portable/StudyServer.exe`, 303,386,595바이트.
- SHA-256: `C6D9C7AB8E7E34FDB2383C828E52DEE450481B84F5A701CAC807165AC961BE2B`.
- 사용자 요청에 따라 Firebase 서버 계정 JSON과 NEIS·AI 키를 EXE 리소스에 내장했다. API 주소·Firebase 프로젝트·허용 출처·직접 HTTPS 기본값도 추가 입력 없이 사용한다. DB 암호는 새 PC마다 별도로 생성한다.
- 새 PC에서는 기존 DPAPI 설정이나 데이터 백업 없이 시작한다. 기존 로컬 설정이 있으면 덮어쓰지 않는다. 키는 첫 실행한 Windows 사용자로 다시 암호화해 저장한다.
- 빌드 옵션은 `server/build.ps1 -SkipRuntime -EmbedCurrentSettings`다. 기본 일반 빌드에는 키를 넣지 않는다. 빌드용 임시 평문 설정은 finally에서 삭제하며, 개인용 바이너리·obj·bin은 Git에서 제외한다. 이 개인용 EXE는 외부에 공개하지 않았다.
- EXE 하나만 별도 폴더에 복사하고 빈 진단 데이터 폴더에서 실행했다. 내장 Firebase 개인 키 유효성, NEIS·AI 설정 존재, 새 사용자 암호화 왕복, 기존 설정·DB 암호 보존 검증이 통과했다. 근거: `server/artifacts/validation/portable-embedded-settings-result.json`.
- 동일 EXE의 런타임 추출·실제 PostgreSQL·API health·미인증 거절·dump/restore·백업 암호화·정상 종료 8항목이 종료 코드 0으로 통과했다. 근거: `server/artifacts/validation/portable-result.json`, 빌드 로그 `portable-build.log`.
- 진단용 한글 데이터 경로에서는 PostgreSQL 초기화 UTF-8 오류가 발생했다. 현재 PC의 실제 기본 경로와 같은 영문 사용자 데이터 경로의 별도 폴더로 재검증해 통과했다. 다른 PC의 Windows 사용자 데이터 경로가 한글이면 같은 제약을 확인해야 한다. 실제 다른 PC 하드웨어에서의 실행과 변경 후 공유기 외부 연결 검증은 아직 하지 않았다.
- 상세 이전 절차와 공유기 설정: [MOVE-TO-ANOTHER-PC.md](MOVE-TO-ANOTHER-PC.md).

## 최신 HTTPS 443 전용 수정 — 2026-10-24

- 현재 권장 파일: `server/artifacts/portable/StudyServer.exe`, 303,394,787바이트. 동일 빌드 원본은 `server/artifacts/portable-https443/StudyServer.exe`다.
- SHA-256: `7B981C05146AAFD60F2B50F61E487CF51E22E2A3645587966E1AC062D33C3AFD`.
- 새 PC `192.168.0.200`에서 80 포트를 PID 6556이 점유하고 443 리스너가 없는 것을 사용자 제공 netstat 결과로 확인했다. 기존 프로그램은 종료하지 않았다. 공유기의 80·443 대상은 이미 `.200`이며, DNS와 WAN IP도 `39.124.233.99`로 일치한다.
- Caddy는 HTTPS 443만 수신하고 HTTP 리다이렉트·HTTP 인증서 challenge·관리 리스너를 사용하지 않는다. 인증서는 TLS-ALPN으로 발급한다. Caddy 전용 방화벽도 443으로 축소한다. 인증서 검증은 유지한다.
- 공개 health의 instanceId 일치 여부를 10초마다 다시 검사한다. HTTPS 프로세스 종료도 감지해 단순 외부 연결 확인 대기와 구분한다.
- 방화벽 범위·이전 규칙 축소·경로 교체·멱등성 등 6개 모의 검사를 통과했다. 운영 방화벽은 테스트에서 변경하지 않았다.
- 최종 EXE의 진단은 내장 키 자동 설정, Caddy 실제 설정 JSON의 443 전용·HTTP challenge 비활성화·TLS-ALPN 사용·관리 리스너 비활성화를 확인했다. 논리적 HTTP 포트를 별도 리스너로 점유한 상태에서도 실제 Caddy HTTPS 프록시의 health가 통과했다. 진단 인증서는 생성한 인증서만 정확히 pin하고 호스트 이름도 확인하며 시스템 신뢰 저장소는 바꾸지 않았다.
- 실제 PostgreSQL·API·미인증 거절·dump/restore·암호화·종료 검증도 종료 코드 0이다. 근거: `server/artifacts/validation/https443-https-result.json`, `https443-embedded-settings-result.json`, `https443-result.json`, `https443-build.log`.
- 사용자에게 EXE 교체 후 실행 완료를 받았으나 LAN 직접 및 공개 HTTPS는 아직 연결되지 않았다. 현재 서버 창 상태와 시작 직후 오류를 요청했다. 실제 새 PC 연결 완료로 간주하지 않는다.
- 공유기의 기존 STUDY-HTTP(80) 전달은 제거/비활성화 대상이다. 관리 세션이 만료돼 아직 수정하지 않았으며, HTTPS(443) 대상과 기존 UDP 규칙은 변경하지 않았다.
