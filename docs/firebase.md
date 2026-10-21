# Firebase 구성

## 배포된 리소스

- 프로젝트: `study-junhyuk1203-20261021` (표시 이름 STUDY)
- 콘솔: https://console.firebase.google.com/project/study-junhyuk1203-20261021/overview
- Firestore: `study-data`, Enterprise Native mode, 서울 `asia-northeast3`, 무료 사용량 대상 DB
- 이메일/비밀번호 및 Google 로그인 활성화
- 비밀번호 정책: 12~128자, 이메일 계정 존재 여부 추측 방지 활성화
- 로그인 허용 도메인: localhost, 127.0.0.1, junhyuk1203.github.io, 프로젝트 Firebase 기본 도메인
- 클라이언트 보안 규칙 및 인덱스 배포

`firebase-config.js`에는 공개 웹 앱 식별자만 있습니다. 관리자 키·로그인 토큰·서비스 계정 JSON은 저장소에 포함하지 않습니다. 새 접속 도메인을 사용한다면 `firebase.json`의 허용 도메인을 추가한 후 `node scripts/configure-auth.mjs`로 적용합니다. 이 명령은 로컬 Firebase CLI 로그인 계정으로만 실행하며 자격 증명을 출력하지 않습니다.

## 앱과 DB 연결

브라우저는 Firebase Authentication과 이름 지정 DB `study-data`를 초기화합니다. 로그인 후 `ensureProfile`을 호출해 개인 프로필을 최초 생성하고, 본인의 통계와 인증된 사용자용 랭킹을 실시간으로 구독합니다. 학습 종료 후 통계·랭킹을 바로 갱신하고 다른 탭·기기의 활성 세션도 동기화해야 하므로 Enterprise SDK의 Core 실시간 리스너를 사용합니다. DB에서 미리 집계한 문서를 읽으며, 브라우저에서 전체 사용자 기록을 다운로드해 집계하지 않습니다.

Firestore는 문서가 처음 저장될 때 컬렉션을 만듭니다. 새 사용자는 프로필 생성 후 학습을 저장하면 통계·랭킹 문서가 생성됩니다. 실제 검증에 사용한 임시 계정과 기록은 삭제했습니다.

## 데이터 구조

| 경로 | 내용 | 클라이언트 권한 |
|---|---|---|
| `users/{uid}` | uid, displayName, schoolId, activeSessionId, createdAt, updatedAt | 본인 단건 조회 |
| `users/{uid}/sessions/{sessionId}` | subjectId, startedAt, endedAt, status, creditedSeconds, capped | 본인 조회 |
| `users/{uid}/dailyStats/{YYYY-MM-DD}` | totalSeconds, subjectSeconds | 본인 조회 |
| `users/{uid}/weeklyStats/{monday}` | totalSeconds, subjectSeconds | 본인 조회 |
| `users/{uid}/monthlyStats/{YYYY-MM}` | totalSeconds, subjectSeconds | 본인 조회 |
| `users/{uid}/stats/summary` | totalSeconds, sessionCount, currentStreak, longestStreak, lastStudyDate | 본인 조회 |
| `leaderboards/{monday}/entries/{uid}` | uid, displayName, totalSeconds, updatedAt | 로그인한 사용자 조회 |
| `schoolLeaderboards/{schoolId}/weeks/{monday}/entries/{uid}` | 같은 학교 주간 랭킹 | 해당 학교 구성원 조회 |

모든 클라이언트 쓰기는 차단합니다. 목록 조회는 `limit(50)` 이하가 필요합니다. 이메일·비밀번호는 Firestore에 복제하지 않습니다. 학교 소속은 클라이언트가 임의로 지정하지 못하며, 현재 학교 소속 검증/배정 서비스는 연결하지 않았습니다.

## 배포된 서버 함수

- `ensureProfile`: 로그인 UID로 개인 프로필을 최초 1회 생성합니다.
- `updateAccount`: 본인의 닉네임만 변경합니다. UID·학교·역할·점수는 입력에서 가져오지 않습니다.
- `startStudySession`: 이메일 인증 사용자의 학습을 시작하며, 계정별 활성 세션을 하나로 제한합니다.
- `finishStudySession`: 서버 시작/종료 시각으로 시간을 계산합니다. 12시간을 상한으로 일·주·월 통계, 연속 학습 일수와 랭킹을 한 트랜잭션에서 갱신합니다. 중복 종료는 점수를 다시 더하지 않습니다.

날짜는 한국 시간, 주간 기준은 월요일입니다. 초 단위로 집계하며 자정·월말·주 경계를 분리합니다. 닉네임 수정 시 현재 주간 랭킹의 이름도 함께 갱신하며, 지난 주간 랭킹은 당시 이름을 유지합니다. 기록 시간은 서버가 측정한 경과 시간이며 실제 집중 여부를 증명하는 기능은 아닙니다.

사용자가 Blaze로 업그레이드한 후 서울 리전에 서버 함수를 배포했습니다. 함수별 최소 인스턴스 0, 최대 2, 동시 처리 1, 메모리 256MiB이며 기존 학습 함수는 30초, 학교·AI 연동 함수는 90초 제한입니다. 빌드 컨테이너 이미지는 1일 뒤 정리하도록 설정했습니다.

추가 함수는 `searchSchools`, `saveSchool`, `getSchoolOverview`, `chatWithStudy`, `getStudyBriefing`, `getAiUsage`입니다. NEIS와 Google AI 키는 Secret Manager의 `NEIS_API_KEY`, `GOOGLE_AI_API_KEY`로 저장하고 필요한 함수에만 바인딩합니다. 코드·GitHub·클라이언트 설정에는 키를 넣지 않습니다. `saveSchool`은 NEIS에서 확인한 공식 학교 코드/이름과 사용자가 선택한 학년·반을 저장하며 실제 재학 인증을 의미하지 않습니다.

AI 채팅은 `gemini-3.8-flash`, `gemini-4-argon`만 허용합니다. 브리핑은 Flash로 고정합니다. `users/{uid}/aiUsage/{YYYY-MM}`에 합산 비용과 예약 비용, `aiDaily/{YYYY-MM-DD}`에 Argon 호출 횟수를 서버에서 관리합니다. Argon은 KST 하루 2회, 두 모델과 브리핑 합계는 월 1,000원 서비스 예산을 적용합니다. 생성 전에 최대 비용을 트랜잭션으로 예약하고 잔액에 맞춰 `maxOutputTokens`를 제한합니다. 생각 토큰도 출력 비용에 포함하며 스트림에서 사용량 한도에 닿으면 중단합니다. 정상 완료 후 실제 토큰 수로 정산하고, 과금 여부가 불명확한 실패는 최대 예약액을 차감합니다. 모든 사용량·예약·비밀 컬렉션은 클라이언트 읽기/쓰기를 허용하지 않습니다.

환산은 ECB 환율에 원/달러 2,000원 하한, 세금 10%, 여유분 20%를 적용하고 프로모션 종료 후 정가로 보수적으로 계산합니다. 표시 금액은 카드 청구액이 아닌 서비스 이용 예산입니다. 모델 요금 변경 시 `functions/ai-budget.js`를 갱신해야 합니다. Google AI 외 Firebase 인프라 비용은 이 한도에 포함되지 않습니다. 공식 근거: [모델 요금](https://ai.google.dev/gemini-api/docs/pricing), [Firebase 비밀 설정](https://firebase.google.com/docs/functions/config-env).

`syncStudyCamera`는 인증된 소유자와 세션 시작 탭의 controllerId 및 증가하는 sequence를 확인합니다. 클라이언트가 보낸 시간은 받지 않고 서버 시각으로 인식 활성 구간을 합산합니다. 시작 시에는 정지 상태이며 인식 후 재개합니다. 인식 중 10초마다 연결 확인, 상태 변경 시 즉시 동기화하고, 마지막 연결 이후 최대 30초까지만 적립합니다. 브라우저 종료/네트워크 단절이 즉시 서버에 전달되는 것은 보장되지 않습니다. 날짜별 활성 구간을 세션의 segments에 합산하고 종료 시 기존 통계·랭킹 트랜잭션에 반영합니다. 실시간 타이머·다른 탭의 세션 종료 동기화가 필수여서 기존 Core onSnapshot 리스너를 유지합니다. 영상·얼굴 좌표는 DB에 저장하지 않습니다. 클라이언트 감지 상태는 위조 가능하므로 부정행위 방지를 증명하지 않습니다.

웹 파일은 GitHub에만 올리며 Firebase Hosting은 사용하지 않습니다. 현재 승인된 GitHub Pages 도메인은 `junhyuk1203.github.io`입니다. 도메인이 바뀌면 허용 도메인도 갱신해야 합니다.

## 검증

개발 검증만 하려면 `npm ci`와 `npm ci --prefix functions`로 의존성을 설치합니다.

```powershell
npm run test:unit
npm run test:firebase
```

Java 21 이상이 필요합니다. 자동 테스트는 `demo-study` 프로젝트와 로컬 Auth/Firestore 에뮬레이터만 사용합니다. 계정 격리·쓰기 거부·랭킹 권한·이메일/Google 자격 증명·동시 시작·중복 종료와 집계 값을 검증합니다.

`node scripts/test-integrations-live.mjs`는 별도의 임시 QA 계정에서 실제 학교 검색·등록·급식·시간표, 두 모델 스트리밍, Flash 브리핑, Argon 하루 제한 및 월 예산 차단을 확인합니다. 자신의 테스트 계정·선택한 학교·사용량·예약만 정리하며 기존 사용자의 데이터나 일일 호출 횟수는 사용하지 않습니다.

`node scripts/test-live.mjs`는 별도의 명시적 운영 smoke test입니다. 임시 QA 계정 하나를 생성해 실제 이메일 로그인·서버 함수·DB 조회·랭킹·중복 종료를 확인하고 자신의 테스트 데이터와 계정을 정리합니다. 로컬 Firebase CLI 관리자 로그인이 필요하며 자격 증명을 출력하지 않습니다. 브라우저 QA 계정 정리는 `scripts/qa-account.mjs`로 제한된 QA 이메일 형식만 허용합니다. Google 팝업의 실제 계정 선택과 모바일 앱 내 OAuth 동작은 실기기에서 별도 확인해야 합니다.

보안 규칙은 소유자 조회·서버 전용 쓰기를 적용한 프로토타입입니다. 공개 서비스 전 추가 검토와 검증이 필요합니다.

I've set up prototype Security Rules to keep the data in Firestore safe. They are designed to be secure for private owner-only account reads, authenticated ranking reads, and server-only writes. However, you should review and verify them before broadly sharing your app. If you'd like, I can help you harden these rules.
