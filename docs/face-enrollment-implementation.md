# 얼굴 등록 보안 구현·검증 기록

작성일: 2026-10-26. 기준: `face-enrollment-security-plan.md`. 운영 배포 전 로컬 구현 결과다.

후속 배포 준비: 2026-10-26 사용자의 명시적 승인으로 서울 리전 Cloud KMS API·전용 키와 키 범위 암복호화 권한을 설정했다. 실제 서버 계정의 암복호화 왕복과 기존 Windows 보호 설정 저장을 검증했다. 최신 개인용 EXE 빌드 및 독립 실행 검증 8항목도 통과했다. 운영 서버 직접 교체 대신 날짜·시간이 포함된 EXE를 Drive로 전달한다.

## 변경 전 전체 백업

- 위치: `C:\Users\tntdr\.codex\visualizations\2026\10\25\01a17577-e465-7073-a307-e83a7a0f1082\study-full-backup-20261026-copy`
- 작업 디렉터리 전체의 `.git`, 추적되지 않은 파일, 기존 작업 중 변경, 의존성, 모델·검증 자료, 빌드 결과를 포함했다.
- Robocopy 결과: 파일 67,968개, 약 4.802GiB, 실패 0, 불일치 0, 종료 코드 1(복사 성공). 앞선 중단된 복사에 이어 모든 파일을 확인·복사했다.
- 원본 로그: 같은 상위 디렉터리의 `study-backup.log`. 이 백업 디렉터리가 최종 백업이며, 앞선 tar/zip 시도의 불완전한 파일은 복구용이 아니다.
- 백업은 이 프로젝트 폴더의 파일 백업이다. 프로젝트 밖에서 실행되는 운영 PostgreSQL, Firebase 계정·데이터, Windows 서버 설정의 별도 온라인 백업을 의미하지 않는다.
- 복구 시 서버·편집기를 먼저 종료하고, 현재 폴더를 별도 보관한 뒤 백업 폴더를 새 위치에 복사한다. 자동으로 현재 작업을 덮어쓰는 복구 명령은 실행하지 않았다.

## 구현한 동작

1. 기존 Firebase 제공자로 일일 명시적 재인증. 비밀번호와 Google 팝업, 이미 설정된 TOTP MFA 챌린지를 처리한다. Google 계정 선택이 비밀번호 재입력이나 실명 확인을 보장한다고 표시하지 않는다. SMS MFA는 자동 우회하지 않고 지원 안내로 중단한다.
2. 서버 `auth_time`, 챌린지 발급 시각, 서울 날짜 검증. 오늘의 허가는 다음 서울 자정까지이며, 기기·계정·정책·등록 세대에 결합된다. 키 API는 최신 Firebase 폐기·비활성화 상태를 검사한다.
3. 계정당 활성 등록 하나, 24시간 내 등록 확정 3회, 5분 등록 티켓, 60초 일회용 해제 nonce. 실패 요청도 UID별 60회/분 제한에 포함한다. 서버 트랜잭션으로 충돌·nonce 소비·세대 교체를 처리한다.
4. 브라우저별 비추출 AES-KW 키와 ECDSA P-256 개인키를 IndexedDB에 저장한다. 얼굴 특징값은 Worker에서 AES-256-GCM으로 암호화하며, 로컬로 감싼 DEK를 Cloud KMS 외부 봉투로 다시 감싼다. KMS 자격 증명·키가 없으면 대체 평문/로컬 KEK 경로로 통과시키지 않는다.
5. 고정 순서 AAD에 프로젝트·origin·UID·설치·프로필·세대·모델·전처리·스키마·목적을 결합한다. 브라우저에는 암호문·IV·외부 봉투만 저장한다. 평문 특징값과 중간 `W_local`은 서버 DB·브라우저 영구 저장소에 저장하지 않는다.
6. 저장 트랜잭션 완료 → 서버 확정 → 인증된 봉투 재해제 → 별도 얼굴 대조 순서를 따른다. pending 포인터와 idempotency key로 응답 유실·재시작을 복구한다. 실패·불일치·날짜 변경·Worker 교체 때문에 기존 얼굴을 새 얼굴로 자동 덮어쓰지 않는다.
7. 5방향 12개 표본과 독립 정면 재확인. 얼굴 크기·위치는 자동 보정하며, 잘림·밝기·역광·반사·거의 균일한 영상·느린 관측·잘못된 방향에서는 진행을 보류한다. 여러 얼굴이 감지되면 후보를 초기화한다. 사용자 요청으로 등록 표본 간 유사도에 따른 얼굴 변경 판단과 자동 초기화는 제거했다. 등록 후 대조는 상위 3개 점수 평균과 5회 중 4회 관측을 사용한다.
8. 원형 미리보기, 방향별 완료·실제 표본 진행률, 동의·계정 표시, 키보드 취소, 단계별 스크린리더 안내, 모바일 레이아웃, 동작 줄이기를 제공한다. 저장 확정 중에는 취소 버튼을 잠깐 잠가 원자적 확정과 취소 안내가 충돌하지 않게 한다. 저장 오류는 복구 안내로 전환한다.
9. 학습 요청마다 브라우저 서명을 UID·프로필·세대·허가·제어 ID·세션·sequence·tracking·서버 기준 시각에 결합한다. 기존 이벤트·sequence·임대 규칙을 보존한다. 자정·권한 임대 이후 구간은 종료·정리 경로에서도 인정하지 않는다. 기존 카메라 임대 10초가 추가 권한 임대 60초보다 짧으므로 10초 제한이 우선한다. 일반 학습 요청의 계정 폐기 캐시는 셀프호스트·클라우드 모두 45초로 제한해 기존 10초 시간 임대와 합쳐 60초를 넘기지 않게 했다. 키 API는 캐시를 사용하지 않는다.
10. 수동 타이머는 `manual`, 단어앱은 `word-activity`, 얼굴 학습은 `face-browser`로 서버가 구분한다. 수동·단어앱 개인 학습 기록과 서비스 상태는 유지하되, 얼굴 확인 Focus Time 보상·전체/학교 순위·방 인정 시간은 늘리지 않는다. 화면에도 수동 기록의 보상 제외를 안내한다.
11. 로그아웃·계정 변경·학습 종료·자정·5분 비활성화 시 메모리를 잠그고 Worker를 종료한다. 탭 간 등록 교체·삭제·로그아웃을 전파한다. 계정 설정에서 최근 재인증 뒤 서버 폐기와 해당 계정의 로컬 암호문·키·pending 정보를 삭제할 수 있다.
12. 기존 `study-camera-identity` DB를 버전 2로 올려 평문 프로필을 정리하고 구버전의 버전 1 재열기를 막는다. 구버전 탭이 업그레이드를 막으면 탭 종료 안내를 제공한다. 서버도 기기 증명이 없는 구버전 카메라 요청을 거부한다.
13. 얼굴 메타데이터 컬렉션은 Firestore 기본 거부 규칙과 셀프호스트 조회 allowlist로 클라이언트 직접 접근을 차단한다. 시간별 정리 작업은 만료 챌린지·티켓·허가와 90일 이전 감사 기록을 정리한다. 감사 기록은 이벤트·시각·세대만 포함한다.

## 코드 위치

- `functions/face-service.js`, `face-api.js`, `face-kms.js`, `face-cleanup.js`, `face-protocol.js`: 서버 권한·암호 봉투·메타데이터 수명.
- `face-storage.js`, `face-crypto.js`, `face-vault.js`: 로컬 CryptoKey 저장, Worker 암호화·복호화, pending 복구.
- `face-session.js`, `face-enrollment.css`, `auth.js`, `camera-identity.js`, `camera-worker.js`, `camera.js`: 재인증·등록 화면과 카메라 생명주기.
- `functions/index.js`, `domain.js`, `session-lifecycle.js`, `room-service.js`, `room-study.js`, `word-study.js`, `data.js`: 시간 인정과 보상 분리.
- `server/launcher/Program.cs`: 암호화된 서버 설정에 `FaceKmsKey`를 보관하고 API 프로세스에 `FACE_KMS_KEY`로 전달.

## 검증 결과

| 검증 | 결과 |
|---|---|
| `npm run test:unit` | 273개 통과. 얼굴 보안 테스트 17개 포함 |
| `npm run test:selfhost` | 전용 임시 PostgreSQL에서 21개 통과 |
| Auth·Firestore 에뮬레이터 | `demo-study`, 별도 로컬 포트 19499·18480에서 53개 통과 |
| `npm run test:face:browser` | 실제 Edge Chromium에서 통과. CryptoKey의 IndexedDB 직렬화, Worker 내 암호화, 프로세스 종료·재시작 후 동일 프로필/암호문 복원, 브라우저 서명의 서버 검증, 계정 변경 잠금, 취소, 모바일, 트랜잭션 success 후 강제 abort 시 등록 미확정, 재인증 삭제를 검증 |
| Windows 런처 | `dotnet build server/launcher/StudyServer.csproj --no-restore --nologo` 성공, 경고·오류 0 |
| 패치 검사 | Windows CRLF를 허용한 `git -c core.whitespace=cr-at-eol diff --check` 통과 |

로그는 `.codex-face-security-unit.log`, `-tests.log`, `-selfhost.log`, `-firebase.log`, `-browser.log`, `-launcher.log`에 남겼다. 모바일 시안은 `.codex-face-enrollment-mobile.png`다. 브라우저 테스트는 합성 특징값과 모의 제공자·KMS를 사용하며 실제 얼굴 정확도나 Google 인증을 검증한 것이 아니다.

agy 독립 검토는 인증 실패로 실행되지 않았다. 다른 모델로 대체하지 않았으며 코드 검토와 최종 검증은 Codex가 수행했다.

## 운영에 적용하기 전

### Cloud KMS

- 기존 API 프로젝트에서 대칭 암호화용 Cloud KMS 키를 준비하고, API 서비스 계정에 해당 키 범위의 `roles/cloudkms.cryptoKeyEncrypterDecrypter`만 부여한다. 키 삭제·비활성화·회전·감사 담당자를 정한다. 이번 작업에서 유료 리소스나 IAM 권한을 생성·변경하지 않았다.
- Windows 서버 설정의 **얼굴 Cloud KMS 키 경로**에 `projects/PROJECT/locations/LOCATION/keyRings/RING/cryptoKeys/KEY`를 입력한다. 직접 API 실행 시 같은 값을 `FACE_KMS_KEY` 환경 변수로 설정한다.
- 자격 증명은 기존 ADC/서비스 계정을 사용한다. 키 경로는 비밀키가 아니며, 서버 KEK 원문을 환경 변수에 넣는 기능은 없다. 실제 KMS 권한·비활성화·복호화 거절·키 회전 시나리오는 아직 운영 환경에서 검증하지 않았다.
- 외부 봉투는 KMS의 기존 버전 참조를 포함한다. 키 회전 뒤 기존 프로필을 열어야 하므로 이전 버전을 즉시 파괴하면 안 된다. 강제 재봉투화와 운영자 관리 UI는 별도 운영 작업이다.

### 프런트 보안 헤더와 배포

- 정식 얼굴 origin은 `https://study.junhyuk.site`다. 대체 GitHub Pages 주소, 단어앱 도메인, HTTP 개발 주소에서 얼굴 키 API를 허용하지 않는다.
- 현재 GitHub Pages 배포를 변경하지 않았다. `server/frontend-security.caddy.example`은 별도 정적 호스트를 사용할 때의 검토용 헤더 예제다. `server/prepare-frontend.ps1`은 프런트 자산과 브라우저용 `functions/face-protocol.js`만 새 디렉터리로 내보낸다. 소스 저장소를 웹 루트로 직접 노출하지 않는다.
- CSP는 먼저 Report-Only 예제로 준비했다. 기존 Firebase 로그인 팝업·MediaPipe·TFJS WASM·모델 다운로드를 실제 정식 origin의 스테이징에서 검사하고 필요한 출처만 조정한 뒤 강제 정책으로 전환해야 한다. Report-Only만으로 XSS 방어 적용이 끝났다고 간주하지 않는다. `frame-ancestors`는 HTTP 헤더로 적용해야 한다.
- 외부 런타임/모델 버전은 고정했지만 전체 자체 호스팅·모델 무결성 검증은 끝내지 않았다. 인증·키 해제 API 응답은 no-store이며 별도 서비스 워커 캐시를 추가하지 않았다.
- 프런트와 API를 함께 업데이트하고 캐시를 무효화한다. 구버전 클라이언트는 새 권한 검사에서 차단되므로, 새로고침 안내와 롤백 시 구버전 보상 인정 여부를 운영자가 검토해야 한다.
- 기존 배포 EXE의 내장 payload는 소스 수정만으로 갱신되지 않는다. 배포 전 `server/prepare-runtime.ps1`로 최신 함수 파일을 다시 포함한 뒤 `server/build.ps1`로 EXE를 만들어야 한다. 이번 작업은 소스와 런처 컴파일을 검증했으며 기존 운영 EXE·서버 프로세스를 교체하지 않았다.
- 로그·분석·세션 리플레이에서 등록 화면과 키 API 본문을 수집하지 않도록 실제 프록시·분석 도구도 확인해야 한다.

### 실기기·사용자 검증

- 0.65 대조 임계값과 각도·밝기 기준은 초기값이다. 등록 후보 간 0.85 일관성 검사는 사용자 요청으로 제거했다. 모델 입력은 정렬된 224×224 RGB float 0..255, 출력은 1024차원으로 유지했다. 공식 FaceRes 구현도 0..1 입력을 255배하고 1024차원 descriptor를 선택한다. [공식 구현](https://github.com/vladmandic/human/blob/main/src/face/faceres.ts)
- Chrome/Edge 외에 Safari·Firefox, 느린 기기, 안경·피부색·조명·방향 가동성, 실제 다인·대리 등록, 사진·화면 재생·가상 카메라, 오수락·오거부를 아직 실측하지 않았다. 합성 벡터 테스트를 인식 성능 검증으로 설명하지 않는다.
- Firebase 실제 비밀번호·Google 팝업·TOTP·팝업 차단·계정 복구와 KMS 실제 권한 조합을 검증해야 한다. 신규 TOTP 등록·Identity Platform 활성화·운영자 실명 확인 절차를 도입하지 않았다.
- PC 재부팅, 브라우저 데이터 수동 삭제, 저장공간 실제 고갈, 비공개 창 종료, Safari 장기 비상호작용 정리는 실기기 확인이 남아 있다. JavaScript 버퍼 정리는 물리적 메모리 완전 삭제를 보장하지 않는다.

관련 공식 자료: [Firebase 재인증](https://firebase.google.com/docs/auth/web/manage-users), [Firebase TOTP](https://firebase.google.com/docs/auth/web/totp-mfa), [KMS 암복호화](https://cloud.google.com/kms/docs/encrypt-decrypt), [KMS AAD](https://cloud.google.com/kms/docs/additional-authenticated-data).
