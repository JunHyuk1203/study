# 직접 할 일 — 최초 한 번

이 PC에서 사용할 Firebase 서버 연결 파일, NEIS 키, AI 키는 이미 설정했다. EXE에서 다시 입력하거나 Firebase 콘솔에서 키를 발급할 필요가 없다. 계정 인증과 로그인은 Firebase Auth, 웹은 GitHub Pages를 유지한다.

## 1. 서버 실행 전 마지막 작업

`junhyuk.site`의 현재 권한 네임서버는 `launch1.spaceship.net`, `launch2.spaceship.net`이다. Spaceship에서 `api.study` → `39.124.233.99` A 레코드를 저장했다. 기존 `@`, `study`, `word` GitHub Pages 레코드는 건드리지 않았다. API용 AAAA 레코드는 추가하지 않았다.

위 IP는 2026-10-24 이 PC에서 확인한 인터넷 출구 주소다. 실행창도 현재 IP를 자동 조회한다. 공유기 인터넷/WAN IPv4와 이 값이 같아야 직접 접속할 수 있다. 다르면 이중 공유기·통신사 공유 주소 또는 VPN 여부를 먼저 확인해야 한다. IP가 바뀌면 A 레코드도 갱신해야 한다.

## 2. 네트워크 설정 확인 완료

관리 주소: `http://192.168.0.1`.

새 서버 PC의 내부 IP는 **192.168.0.200**이다. 공유기의 HTTPS 전달 대상이 이 주소인 것을 확인했다. 최신 EXE는 443만 사용하므로 이전 HTTP(80) 전달은 사용하지 않는다.

| 프로토콜 | 외부 포트 | 내부 IP | 내부 포트 |
|---|---|---|---|
| TCP | 443 | 192.168.0.200 | 443 |

공유기에 이미 있던 WireGuard·Tailscale 규칙은 그대로 두었다. PC 주소는 고정 할당돼 있다. API 18081과 DB 15432는 외부에 열지 않았고 DMZ도 사용하지 않는다.

## 3. EXE 열기

기존에 실행 중인 이전 서버 창을 먼저 닫은 뒤, 최신 개인용 파일 **`server/artifacts/portable/StudyServer.exe`**를 실행한다. Firebase 서버 계정과 NEIS·AI 키가 내장돼 있어 새 PC에도 EXE 하나만 복사하면 된다. 새 PC의 설정과 DB를 자동으로 만들고 API·HTTPS를 함께 시작한다. 창을 열어 둬야 서버가 실행된다. [PC 이전과 공유기 변경 상세 안내](MOVE-TO-ANOTHER-PC.md)를 따른다.

최초 실행 시 Windows 권한 확인 창에서 **예**를 누르면 방화벽을 자동 설정한다. 동봉된 **Caddy 실행 파일에 한해서 TCP 443 인바운드를 허용**한다. 이전 80·443 규칙이 있으면 자기 규칙만 443으로 축소하므로 다시 권한 확인이 나올 수 있다. 취소하면 서버 시작을 중단하며, 서버 시작 버튼으로 다시 시도할 수 있다. API 18081과 DB 15432는 허용하지 않는다.

웹 앱은 `https://api.study.junhyuk.site`의 자체 API만 사용하도록 전환해 GitHub Pages에 배포했다. 배포 커밋은 `5724d5a554f1595f449949ec5d5899b216cd3f72`다. 이전에 열어 둔 탭은 Ctrl+Shift+R로 한 번 새로고침한다. Firebase Auth는 로그인과 토큰 발급에만 사용하고, 서버 연결이 실패해도 Firebase 저장소나 Functions로 되돌아가지 않는다. 서버가 꺼져 있어도 GitHub Pages의 화면과 로그인은 열리지만 기록 조회·저장·학교·AI 기능은 서버 연결 오류를 표시한다.

서버 창이 실행 중이면 휴대폰의 Wi-Fi를 끄고 `https://api.study.junhyuk.site/health`를 열어 응답을 확인한다. 외부 HTTPS 응답과 실제 계정 기능 검증은 최신 EXE가 실행된 뒤 완료할 수 있다.

## 이미 처리한 것

- 구현 전 개발 폴더 전체 백업 및 Git bundle 검증.
- API 주소, Firebase 프로젝트, 허용 웹 주소, DB·API 포트, 직접 HTTPS 방식 기본값.
- 서버 전용 Firebase 계정 생성과 `roles/firebaseauth.viewer` 권한 부여. Auth 사용자 변경 권한이나 Firestore 접근 권한은 주지 않았다. 커스텀 토큰은 해당 계정의 로컬 개인 키로 서명한다.
- 기존 Secret Manager의 NEIS·AI 키를 재사용. 공개 소스·EXE에는 개인 키와 API 비밀 키를 넣지 않았다.
- `%LOCALAPPDATA%\StudyServer\config\settings.protected`에 Windows 사용자 단위 암호화 저장. 이 PC의 현재 Windows 계정에서 자동으로 읽는다.
- 실제 Firebase 사용자 조회 권한, 로컬 토큰 서명, AI 모델 목록 조회(HTTP 200) 검증. 사용자 생성이나 AI 답변 생성 요청은 하지 않았다.
- 실행창에서 현재 공인·내부 IP 자동 안내와 HTTPS 인증서 자동 발급 구성.

이전 Windows 계정에 묶인 암호화 설정 파일을 복사할 필요는 없다. 개인용 portable EXE가 내장한 계정·키를 새 Windows 계정에 맞춰 자동 저장한다. 기존 학습 DB까지 옮기고 싶을 때만 백업·복원을 사용한다. 이 EXE에는 추출 가능한 실제 비밀 키가 포함돼 있으므로 본인 서버 PC 외에 공유하거나 공개 저장소에 올리지 않는다.

기술 근거: [Caddy 자동 HTTPS](https://caddyserver.com/docs/automatic-https), [Firebase ID 토큰 검증](https://firebase.google.com/docs/auth/admin/verify-id-tokens).
