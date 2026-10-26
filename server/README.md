# STUDY Windows 서버

웹은 **GitHub Pages**, 계정 인증·로그인은 **Firebase Auth**를 유지한다. 학습·친구·방·학교·AI API와 저장소는 Windows PC의 Node.js + PostgreSQL로 실행한다. Firebase의 기존 학습 데이터는 가져오지 않고 새 DB로 시작한다.

## 실행

**최신 개인용 portable EXE에는 연결 설정을 내장했다.** 현재 PC에서는 기존 암호화 설정을 유지하고, 새 PC에서는 내장한 Firebase 서버 계정과 NEIS·AI 키를 새 Windows 계정에 맞춰 자동 저장한다. 직접 할 네트워크 설정은 [USER-STEPS.md](USER-STEPS.md)에 실제 확인한 주소와 함께 정리했다. 연결 방식 기본값은 직접 HTTPS다. 실행창에서 현재 공인·내부 IP도 확인할 수 있다.

최신 개인용 버전: **`server/artifacts/portable/StudyServer.exe`**. Firebase 서버 계정과 NEIS·AI 키를 EXE에 내장했다. 다른 Windows 11 PC에는 이 EXE 하나만 복사해 실행하면 되며 최초 키 입력이나 백업 복원이 필요 없다. 실제 비밀 키가 포함된 개인용 파일이므로 공개 배포하지 않는다. [다른 PC로 옮기는 순서와 공유기 설정](MOVE-TO-ANOTHER-PC.md)을 따른다. 아래 최초 수동 설정은 키가 내장되지 않은 일반 빌드에서의 절차다.

1. `StudyServer.exe`를 연다.
2. 최초 설정에서 **STUDY 프로젝트의 Firebase 서비스 계정 JSON**을 선택한다. 웹용 `firebase-config.js`와 다른 파일이다. 프로젝트 설정의 서비스 계정 메뉴에서 서버용 파일을 발급할 수 있다. 계정 조회·토큰 검증과 단어앱 연결 복원용 토큰 서명에 필요한 권한을 갖춘 계정을 사용한다.
3. 학교 기능용 NEIS 키와 AI 기능용 Google AI 키를 입력한다. 해당 키가 없으면 관련 기능은 설정 안내 오류를 반환한다.
4. 외부 연결 방식을 선택한다. 로컬 확인으로 시작하면 PC의 `http://127.0.0.1:18081/health`까지만 연결된다.
5. 웹의 `backend-config.js`에 있는 API 주소와 실행창의 공개 API 주소를 일치시킨다. 기본값은 `https://api.study.junhyuk.site`다.

설정을 저장한 뒤부터 EXE를 열면 DB와 API가 함께 시작된다. 창 최소화는 실행을 유지하고, 창을 닫거나 서버 종료를 누르면 종료한다. Windows 서비스·자동 로그인·부팅 자동 실행을 설치하지 않는다.

EXE는 실행에 필요한 파일을 `%LOCALAPPDATA%\StudyServer\runtime`에 풀고 DB는 `%LOCALAPPDATA%\StudyServer\data\postgres`에 저장한다. EXE만 복사·교체해도 DB를 덮어쓰지 않는다. DB·실행 구성은 OneDrive 폴더 안에서 직접 실행하지 않는다. PostgreSQL Windows 초기화의 한글 경로 인코딩 문제를 확인했으므로 내부 실행·DB 경로는 영문 경로를 사용한다. EXE 파일 자체는 현재 한글 작업 폴더에서 실행할 수 있다.

## 네트워크: DNS를 다른 업체에서 관리하는 경우

**기존 웹 도메인의 GitHub Pages 연결은 유지한다.** 서버용 `api.study.junhyuk.site`만 별도로 연결한다. 아래 두 방식 중 하나를 최초 한 번 설정해야 한다. EXE가 DNS 계정이나 공유기 비밀번호를 자동으로 알아내지는 않는다.

### 직접 HTTPS

1. 공유기 WAN 주소가 직접 접속 가능한 공인 IP인지 확인한다. 이중 공유기·CGNAT이면 해당 경로부터 해결해야 한다.
2. 공유기에서 서버 PC의 내부 IP를 DHCP 예약한다.
3. 현재 DNS 업체에 `api.study.junhyuk.site`의 A 레코드를 공인 IPv4로 등록한다. 동적 IP라면 IP 변경 시 DNS 갱신이 필요하다.
4. 공유기의 TCP 443을 서버 PC의 443으로 전달한다. 이전 STUDY-HTTP(80) 전달 규칙은 사용하지 않는다. Windows 방화벽은 EXE가 Windows 권한 확인을 거쳐 동봉 Caddy의 443만 허용한다. 이전 자기 규칙이 80·443을 허용했다면 443으로 축소하며 다른 프로그램의 규칙은 변경하지 않는다.
5. EXE 설정에서 직접 HTTPS를 선택한다. Caddy는 80 포트와 관리 포트를 사용하지 않고 443에서 TLS-ALPN 방식으로 인증서를 발급하며 내부 `127.0.0.1:18081`로 연결한다. 외부 연결 표시는 10초마다 다시 확인한다. [Caddy 인증 방식](https://caddyserver.com/docs/caddyfile/directives/tls), [HTTP 리다이렉트 설정](https://caddyserver.com/docs/caddyfile/options#auto-https).
6. 휴대폰 모바일 데이터에서 `https://api.study.junhyuk.site/health`를 연다. EXE의 공개 연결 검사도 같은 실행 인스턴스인지 확인한다.

API의 18081과 DB의 15432는 공유기에 열지 않는다. 사용하지 않는 AAAA 레코드가 있으면 IPv6 연결 실패가 생길 수 있으므로 DNS를 점검한다.

### Cloudflare Tunnel

포트포워딩과 공인 IP를 쓰기 어려울 때 선택한다. 고정 공개 호스트를 제공할 수 있도록 Cloudflare DNS 구성이 필요하다. 현재 다른 DNS 업체를 사용하므로, 일반적인 전체 구역 방식에서는 네임서버를 Cloudflare로 옮기며 기존 GitHub Pages CNAME과 다른 DNS 레코드를 보존해야 한다. 기존 업체에 Tunnel CNAME 하나를 넣기만 하면 모든 구성에서 동작한다고 가정하지 않는다.

1. 기존 DNS 레코드를 보존해 Cloudflare 구역을 준비한다.
2. Cloudflare에서 고정 Tunnel을 만들고 공개 호스트 `api.study.junhyuk.site`를 **`http://127.0.0.1:18081`**에 연결한다.
3. 발급한 Tunnel 토큰을 EXE 설정에 입력한다. 서비스 설치 명령은 실행할 필요가 없다.
4. 서버가 외부 7844 TCP/UDP와 Firebase·AI·NEIS의 HTTPS에 연결할 수 있게 한다.
5. 모바일 데이터에서 공개 `/health`와 실제 앱을 확인한다.

Tunnel은 EXE의 자식 프로세스로 실행한다. 임시 trycloudflare 주소를 운영 주소로 쓰지 않는다. 일반 앱에 Cloudflare Access 로그인 화면이나 브라우저 챌린지를 추가하면 API·단어앱 연결이 막힐 수 있으므로 별도 인증 장벽을 무작정 켜지 않는다. API 자체에서 Firebase 토큰을 검사한다.

## 데이터와 백업

- 같은 Firebase UID로 로그인하면 새 서버에 프로필이 만들어진다. 기존 Firestore 학습 기록·친구·방·예산은 가져오지 않는다.
- 개발 폴더 전체 사본과 Git bundle은 구현 전에 `C:\Users\tntdr\AppData\Local\StudyServerBackups\study-20261024-154915`에 만들었다. 38,942개 파일 약 519MB를 복사했고, 개발 파일 358개의 SHA-256과 Git bundle을 검증했다.
- 실행창의 백업 버튼은 DB dump와 설정을 `.studybackup`으로 저장한다. 사용자가 지정한 암호로 AES-GCM 암호화하며, 암호를 잃으면 복원할 수 없다.
- 백업 복원은 기존 DB를 덮어쓰지 않고 새 DB에 복원한 뒤 성공하면 연결을 바꾼다. PostgreSQL 로그인 암호는 현재 서버의 값을 유지하고 Firebase·API·네트워크 설정은 백업에서 복원한다.
- 평소 설정은 현재 Windows 사용자에게 묶어 보호한다. 다른 PC로 옮길 때는 원시 설정 파일 대신 암호화 백업을 사용한다.
- Firebase Auth와 기존 클라우드 DB를 실제로 삭제하는 코드는 없다. 사용자가 기존 DB를 버려도 된다고 했으므로 데이터 이관을 생략한 것이다.

## 구현 구조

`functions/platform-*.js`가 실행 환경을 분리한다. 자체 서버 모드에서는 Firebase 배포 래퍼와 Firestore 연결을 사용하지 않고 HTTP와 PostgreSQL 저장소를 사용한다. 기존 학습시간·보상·AI 예산 규칙은 같은 업무 코드로 실행한다. Firebase Auth용 Admin SDK는 유지한다.

초기안의 정규화 테이블 일괄 재작성 대신 **PostgreSQL JSONB 문서 저장소**를 먼저 완성했다. `study_documents` 테이블, 인덱스, 트랜잭션, 원자적 증가, 조회 경계, Timestamp 정밀도를 구현해 기존 업무 규칙 변경을 줄였다. Firestore를 로컬 에뮬레이터로 운영하는 방식이 아니다. 쓰기 결정은 DB 트랜잭션 잠금으로 직렬화하므로 대규모 부하의 처리량은 실제 PC에서 별도 측정해야 한다.

브라우저의 `server-client.js`는 Firebase 로그인 후 ID 토큰을 자체 API로 전송한다. 401이면 토큰을 한 번 갱신한다. 사용자 기록 조회는 기존 권한 범위와 최대 50개 제한을 유지한다. 상태 알림과 AI 답변은 인증된 HTTP 스트림을 사용한다. 토큰을 URL에 넣지 않는다.

SP word의 작업 사본 `.codex-superword-sync`에도 자체 API 전환을 적용했다. 계정 연결·학습·종료와 스터디 기록 조회는 `study-server-client.js`를 사용한다. Word 자체 기록 저장은 기존 Word DB를 유지한다. 연결 복원 API만 스터디 로그인 없이 Word ID 토큰을 서버에서 검증하고, 나머지 API는 스터디 인증을 요구한다. 두 저장소의 웹 배포와 서버 재빌드가 필요하다. 기존 연결 문서는 새 DB로 이관하지 않았으므로 브라우저의 스터디 로그인이 남아 있으면 자동으로 다시 저장하고, 로그인도 없는 경우 스터디 계정을 한 번 다시 연결한다.

## 개발·검증 명령

```powershell
npm run test:unit
npm run test:selfhost
npm run build:server
```

`test:selfhost`는 영문 TEMP 경로에 분리된 DB를 만들고 로컬 테스트 포트 15433을 사용한다. 운영 Firebase 데이터에 접근하지 않으며 AI·NEIS는 테스트 응답으로 검증한다. 실패해도 테스트 로그와 임시 자료를 남긴다.

배포 EXE 자체 검증:

```powershell
$testPath = Join-Path $env:TEMP ('StudyServer-exe-test-' + [Guid]::NewGuid().ToString('N'))
Start-Process -FilePath '.\server\artifacts\release\StudyServer.exe' -ArgumentList @('--self-test', $testPath) -WindowStyle Hidden -Wait
Get-Content -LiteralPath (Join-Path $testPath 'result.json')
```

이 검사는 별도 테스트 폴더와 진단 전용 API 18082·DB 15434 포트에서 동봉 런타임 추출·실제 DB 시작·API 상태·미인증 거절·dump/restore·백업 암호화·종료를 확인한다. 운영 서버와 진단의 실행 잠금도 분리했다. 실제 운영 Firebase 로그인이나 인터넷 공개 연결을 검증했다는 뜻은 아니다.

실제 공개 전에는 DNS/공유기·방화벽과 실제 로그인·단어앱 연결을 확인해야 한다. 현재 PC의 Firebase 연결 파일·API 키는 준비했고 실제 서버 인증 조회·서명과 AI 모델 목록 조회를 검증했다. 저장소 push나 GitHub Pages 배포·DNS 변경은 실행하지 않았다. 개발용 `provision-current-user.cjs`는 기존 Firebase CLI 로그인으로 이 설정을 준비하는 도구이며 평소 EXE 실행에 필요하지 않다.
