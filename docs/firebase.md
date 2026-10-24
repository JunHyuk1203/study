# Firebase 구성

## 2026-10-22 사용량 절약 변경

나이스 서버 캐시는 `neisDailyCache/{sha256(endpoint + canonicalParams)}`에 저장합니다. 학교 코드·API 종류·조회 월을 키로 사용하고 시간표에만 학년·반을 추가합니다. 사용자 UID를 키에 포함하지 않으므로 같은 학교/학반 전체가 응답을 공유합니다. 날짜 범위를 월별로 정규화한 뒤 요청한 범위로 필터링하여 학교 화면·시험 카드·AI의 겹치는 요청을 합칩니다. KST 날짜별 첫 호출 전에 트랜잭션으로 예약하여 함수 인스턴스가 달라도 외부 API 호출이 중복되지 않습니다. 성공/실패 모두 당일 재호출하지 않으며, 다음 날 첫 조회 시 갱신합니다. 이 서버 전용 캐시는 클라이언트 읽기·쓰기를 허용하지 않습니다. 학교 개요와 시험 일정의 브라우저 캐시도 KST 자정까지 재사용하며 수동 학교 새로고침은 저장된 당일 서버 결과를 읽습니다. 이전의 30분/6시간 학교 캐시 설명은 이 정책으로 대체됩니다.

- 초기 로딩에서 통계·랭킹 전체 구독을 제거했습니다. 프로필은 다른 기기 학습 시작/종료 감지를 위해 실시간으로 유지하고, 다른 탭의 활성 세션만 추가로 구독합니다. 자신의 카메라 상태는 callable의 서버 응답으로 갱신합니다.
- 화면에 필요한 통계만 단건/범위 조회하고 계정·날짜·학교·`studyRevision`별 로컬 캐시를 재사용합니다. 통계 TTL은 15분, 랭킹은 5분입니다. 오프라인 캐시와 기존 보안 규칙·인덱스 및 실시간 프로필 동기화가 필요해 Core SDK를 유지합니다. 학습 완료 트랜잭션이 revision을 증가시켜 다른 탭도 새 통계를 조회합니다.
- 얼굴 인식 상태가 같은 상태/자세 변경은 쓰기를 하지 않습니다. 정기 확인은 5초마다, 정지·재개 전환은 순서대로 보내며 적립 lease는 10초, 세션 생존 유예는 45초입니다. 갱신 트랜잭션에서 현재 세션 만료를 검사하고 시작·백그라운드 정리에서 넓은 복구 검사를 수행합니다. 완료와 동기화는 같은 세션 문서에서 직렬화되므로 종료된 세션을 다시 적립하지 않습니다. 실패 재시도는 5–60초 지수 간격을 사용합니다. 상세 기준은 [학습 동기화 계약](study-sync-contract.md)을 따릅니다.
- 브리핑은 KST 새벽 00–06, 아침 06–11, 점심 11–17, 저녁 17–22, 심야 22–24시에 홈을 이용할 때 해당 시간대에 한 번만 자동 생성합니다. `users/{uid}/integrations/briefing`에 결과와 시간대 ID를 저장하며 자동 캐시 적중은 통계 조회·요청 제한 쓰기·AI 호출 없이 결과를 반환합니다. 클라이언트 캐시 적중은 함수 호출도 하지 않습니다. 120초 생성 lease로 여러 탭의 중복 생성을 방지하고 실패 시 해제합니다. 수동 새로고침만 `force:true`로 최신 통계를 조회하고 다시 생성하며 AI 예산·호출 제한을 적용합니다.
- 학교 개요 30분, 시험 일정 6시간, AI 사용량 표시는 2분간 계정별 캐시를 사용합니다. 학교 수동 새로고침은 캐시를 건너뜁니다. AI의 실제 사용 한도는 항상 서버에서 검사합니다. 외부 학교/랭킹 변경은 TTL 이후 다음 화면 진입 때 반영될 수 있습니다.

아래 구성 설명의 기존 ‘모든 통계를 실시간 구독’ 및 ‘카메라 10초 확인’은 위 정책으로 대체됩니다. 요청을 한 번에 묶어도 문서별 과금은 사라지지 않으므로, 불필요한 조회·쓰기 자체와 반복 호출을 줄이는 데 초점을 맞췄습니다.

## 배포된 리소스

- 프로젝트: `study-junhyuk1203-20261021` (표시 이름 STUDY)
- 콘솔: https://console.firebase.google.com/project/study-junhyuk1203-20261021/overview
- Firestore: `study-data`, Enterprise Native mode, 서울 `asia-northeast3`, 무료 사용량 대상 DB
- 이메일/비밀번호 및 Google 로그인 활성화
- 비밀번호 정책: 12~128자, 이메일 계정 존재 여부 추측 방지 활성화
- 로그인 허용 도메인: localhost, 127.0.0.1, junhyuk1203.github.io, 프로젝트 Firebase 기본 도메인
- 로컬 Google 로그인은 API 키의 웹사이트 제한에도 주소가 필요합니다. 현재 테스트 서버용으로 `http://127.0.0.1:4174/*`, `http://localhost:4174/*`를 허용하며, 포트를 바꾸면 해당 주소도 추가해야 합니다.
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

사용자가 Blaze로 업그레이드한 후 서울 리전에 서버 함수를 배포했습니다. 함수별 최소 인스턴스 0, 최대 2, 동시 처리 1, 메모리 256MiB이며 기존 학습 함수는 30초, 학교·AI 연동 함수는 90초, 조회 도구를 사용하는 `chatWithStudy`는 240초 제한입니다. 빌드 컨테이너 이미지는 1일 뒤 정리하도록 설정했습니다.

추가 함수는 `searchSchools`, `saveSchool`, `getSchoolOverview`, `chatWithStudy`, `getStudyBriefing`, `getAiUsage`입니다. NEIS와 Google AI 키는 Secret Manager의 `NEIS_API_KEY`, `GOOGLE_AI_API_KEY`로 저장하고 필요한 함수에만 바인딩합니다. 코드·GitHub·클라이언트 설정에는 키를 넣지 않습니다. `saveSchool`은 NEIS에서 확인한 공식 학교 코드/이름과 사용자가 선택한 학년·반을 저장하며 실제 재학 인증을 의미하지 않습니다.

2026-10-21에 `chatWithStudy`와 `getSchoolOverview`를 다시 배포했습니다. AI는 학교 정보가 필요할 때만 `get_school_data` 도구를 호출하며, 서버가 로그인 사용자의 등록 학교·학반으로 조회합니다. 요청한 종류와 날짜(최대 31일)만 반환하고 일반 질문에는 조회하지 않습니다. 도구 호출과 최종 답변의 비용은 모두 월 예산에 반영하며 Argon 하루 횟수는 한 질문에 한 번 차감합니다. `getSchoolOverview`는 `month`(`YYYY-MM`)로 학사일정의 월을 선택할 수 있습니다. 로컬 함수 수정은 운영 서버에 자동 반영되지 않으므로 서버 동작을 바꾸면 해당 함수를 별도로 배포해야 합니다.

AI 채팅은 `gemini-3.8-flash`, `gemini-4-argon`만 허용합니다. 브리핑은 Flash로 고정합니다. `users/{uid}/aiUsage/{YYYY-MM}`에 합산 비용과 예약 비용, `aiDaily/{YYYY-MM-DD}`에 Argon 호출 횟수를 서버에서 관리합니다. Argon은 KST 하루 2회, 두 모델과 브리핑 합계는 월 1,000원 서비스 예산을 적용합니다. 생성 전에 최대 비용을 트랜잭션으로 예약하고 잔액에 맞춰 `maxOutputTokens`를 제한합니다. 생각 토큰도 출력 비용에 포함하며 스트림에서 사용량 한도에 닿으면 중단합니다. 정상 완료 후 실제 토큰 수로 정산하고, 과금 여부가 불명확한 실패는 최대 예약액을 차감합니다. 모든 사용량·예약·비밀 컬렉션은 클라이언트 읽기/쓰기를 허용하지 않습니다.

환산은 ECB 환율에 원/달러 2,000원 하한, 세금 10%, 여유분 20%를 적용하고 프로모션 종료 후 정가로 보수적으로 계산합니다. 표시 금액은 카드 청구액이 아닌 서비스 이용 예산입니다. 모델 요금 변경 시 `functions/ai-budget.js`를 갱신해야 합니다. Google AI 외 Firebase 인프라 비용은 이 한도에 포함되지 않습니다. 공식 근거: [모델 요금](https://ai.google.dev/gemini-api/docs/pricing), [Firebase 비밀 설정](https://firebase.google.com/docs/functions/config-env).

`syncStudyCamera`는 인증된 소유자와 세션 시작 탭의 controllerId 및 증가하는 sequence를 확인합니다. 클라이언트가 보낸 시간은 받지 않고 서버 시각으로 인식 활성 구간을 합산합니다. 시작 시에는 정지 상태이며 인식 후 재개합니다. 인식 중 5초마다 연결 확인, 정지·재개 전환은 순서대로 동기화하고, 마지막 연결 이후 최대 10초까지만 적립합니다. 세션 생존 유예는 45초입니다. 브라우저 종료/네트워크 단절이 즉시 서버에 전달되는 것은 보장되지 않습니다. 날짜별 활성 구간을 세션의 segments에 합산하고 종료 시 기존 통계·랭킹 트랜잭션에 반영합니다. 자신의 카메라는 callable 응답, 다른 탭의 세션은 Core onSnapshot 리스너로 동기화합니다. 영상·얼굴 좌표는 DB에 저장하지 않습니다. 클라이언트 감지 상태는 위조 가능하므로 부정행위 방지를 증명하지 않습니다.

웹 파일은 GitHub에만 올리며 Firebase Hosting은 사용하지 않습니다. 현재 승인된 GitHub Pages 도메인은 `junhyuk1203.github.io`입니다. 도메인이 바뀌면 허용 도메인도 갱신해야 합니다.

## 검증

홈의 다가오는 시험은 `getUpcomingExams`가 나이스 학사일정 180일을 30일씩 조회해 등록 학년에 해당하는 모의고사·중간·기말을 분류합니다. AI 호출이나 AI 예산 차감은 없습니다. 학년 대상 정보가 없는 일정은 공통 일정으로 처리합니다. 조회 오류와 등록 일정 없음은 구분합니다. AI 채팅에서는 같은 조회 함수를 `get_upcoming_exams` 도구로 사용할 수 있습니다. 빈 답변은 성공으로 반환하지 않으며, 클라이언트는 빈 대화 쌍을 다음 질문에서 제외하고 스트리밍 답변을 빈 최종 응답으로 덮어쓰지 않습니다.

2026-10-21 `chatWithStudy`, `getUpcomingExams` 배포 후 `node scripts/test-school-agent-live.mjs --exam`으로 시험 카드 데이터 조회, 다음 시험 답변(학교 도구 조회 후 생성 2회), 후속 일반 질문을 실제 서버에서 검증했습니다. 임시 QA 계정과 데이터는 정리했습니다.

2026-10-21 `1차시험`·`2차시험` 등 차수별 시험 명칭 인식을 수정하고, 사용자 승인 후 `chatWithStudy`, `getUpcomingExams`에 배포했습니다. 단위 테스트 48개 및 `node scripts/test-school-agent-live.mjs --masan-exam`이 통과했으며, 운영 조회에서 마산중앙고 1학년의 2026-12-07~10 `2차시험` 4일을 확인했습니다. 코덱스 브라우저의 로컬 홈에서도 `기말고사 D-47`, `2026-12-07 2차시험` 표시를 확인했고 임시 QA 계정과 데이터는 정리했습니다.

개발 검증만 하려면 `npm ci`와 `npm ci --prefix functions`로 의존성을 설치합니다.

Focus Time 화폐는 `users/{uid}/stats/focusTime`에 초 단위로 저장합니다. `balanceSeconds`는 사용 가능한 잔액, `earnedSeconds`와 `spentSeconds`는 누적 적립·사용량입니다. 기존 공부 총계에서 소급 적립하지 않으며, 이후 학습 완료 시 서버에서 인정한 시간을 공부 집계와 같은 트랜잭션으로 적립합니다. 중복 완료 요청은 다시 적립하지 않습니다. 플레이 화면은 이 잔액을 실시간으로 표시합니다.

소비는 `functions/focus-time.js`의 서버 내부 함수 `spendFocusTime(db, { uid, purchaseId, itemId, costSeconds }, grant)`로 준비했습니다. 향후 구매 함수에서 인증한 UID와 서버 상품 목록의 가격을 전달하고, `grant(transaction)`에서 상품 지급을 같은 트랜잭션으로 처리하세요. 동일 구매 재시도에는 같은 `purchaseId`를 사용합니다. 잔액 부족·중복 차감을 방지하고 총 공부시간은 변경하지 않습니다. 거래 내역은 `users/{uid}/focusTimeTransactions`에 서버 전용으로 기록하며, 소비 UI와 외부 호출 함수는 아직 연결하지 않았습니다.

```powershell
npm run test:unit
npm run test:firebase
```

Java 21 이상이 필요합니다. 자동 테스트는 `demo-study` 프로젝트와 로컬 Auth/Firestore 에뮬레이터만 사용합니다. 계정 격리·쓰기 거부·랭킹 권한·이메일/Google 자격 증명·동시 시작·중복 종료와 집계 값을 검증합니다.

`node scripts/test-integrations-live.mjs`는 별도의 임시 QA 계정에서 실제 학교 검색·등록·급식·시간표, 두 모델 스트리밍, Flash 브리핑, Argon 하루 제한 및 월 예산 차단을 확인합니다. 자신의 테스트 계정·선택한 학교·사용량·예약만 정리하며 기존 사용자의 데이터나 일일 호출 횟수는 사용하지 않습니다.

`node scripts/test-school-agent-live.mjs`는 임시 QA 계정으로 일반 질문(생성 1회), 학교 조회 질문(도구 호출 후 답변으로 생성 2회), 월별 학사일정, Argon 횟수 중복 차감 방지를 실제 운영 서버에서 확인합니다. 비용 예약 기록으로 도구 경유 여부를 검증하며, 종료 시 자신의 테스트 계정과 데이터만 정리합니다.

`node scripts/test-live.mjs`는 별도의 명시적 운영 smoke test입니다. 임시 QA 계정 하나를 생성해 실제 이메일 로그인·서버 함수·DB 조회·랭킹·중복 종료를 확인하고 자신의 테스트 데이터와 계정을 정리합니다. 로컬 Firebase CLI 관리자 로그인이 필요하며 자격 증명을 출력하지 않습니다. 브라우저 QA 계정 정리는 `scripts/qa-account.mjs`로 제한된 QA 이메일 형식만 허용합니다. Google 팝업의 실제 계정 선택과 모바일 앱 내 OAuth 동작은 실기기에서 별도 확인해야 합니다.

보안 규칙은 소유자 조회·서버 전용 쓰기를 적용한 프로토타입입니다. 공개 서비스 전 추가 검토와 검증이 필요합니다.

I've set up prototype Security Rules to keep the data in Firestore safe. They are designed to be secure for private owner-only account reads, authenticated ranking reads, and server-only writes. However, you should review and verify them before broadly sharing your app. If you'd like, I can help you harden these rules.
