# Firebase 호출 최적화 계획

작성일: 2026-10-24 (Asia/Seoul) · 분석 기준: 로컬 HEAD `86340a4`

후속 구현: 위험이 낮은 요청 내부 재사용과 제한적인 버전 분리 등을 적용했다. 구현 범위·호출 수 비교·검증·보류 항목은 [OPTIMIZATION_RESULTS.md](OPTIMIZATION_RESULTS.md)를 참고한다. 아래의 미수정·미실행 설명은 최초 계획 작성 시점의 기록이다.

## 1. 결론과 분석 범위

가장 큰 개선 후보는 **영단어 체크포인트에 따른 광범위한 캐시 무효화**, **매 heartbeat 전후의 같은 문서 재조회**, **스터디룸 조회와 상태 게시의 중복 쓰기**, **방 목록의 반복 조회**다. 실시간 리스너를 일괄 제거하거나 heartbeat 간격을 늘리는 방식은 권장하지 않는다. 현재 시간 정산과 상태 전파 계약을 유지하면서 요청당 작업을 줄이는 것이 우선이다.

이 문서는 계획만 작성한다. 애플리케이션 코드, Firebase 설정·규칙·인덱스는 변경하지 않았고 배포 및 운영 데이터 접근도 수행하지 않았다. 아래 위치는 분석 시점의 1-based 행 번호다.

- 루트 JS/HTML 36개, `functions/` JS 26개, `scripts/` MJS 6개, `tests/` MJS 17개를 대상으로 호출·import·관련 식별자를 검색했다. 발견된 Firebase 경로와 이를 호출하는 화면·캐시·세션 생명주기를 추적했다.
- `firebase.json`, `firebase-config.js`, `firestore.rules`, `firestore.indexes.json`, 두 `package.json`을 확인했다. 의존성·생성물·기존 `.codex-*` 임시 산출물은 운영 코드 조사 범위에서 제외했다.
- DB는 설정상 **Enterprise / Native SDK 사용 / `study-data`**, 리전은 `asia-northeast3`다. Web SDK 13.0.0, Admin SDK 14.5.0, Functions SDK 7.4.0이다. 실제 배포 상태와 운영 인덱스가 로컬 설정과 같은지는 미확인이다.
- Storage SDK, 버킷 업로드·다운로드, Realtime Database, Firestore 문서 트리거 호출은 조사한 소스에서 발견하지 못했다. Storage 비용 개선안을 임의로 만들지 않는다. 외부 단어앱 저장소와 콘솔에서만 구성한 서비스는 범위 밖이다.
- 운영 요청량, 실제 문서 크기, 재시도율, Query Explain, 청구 내역은 측정하지 않았다. 아래 수치는 **코드상 문서 접근/호출 수의 조건부 추정**이며 절감 금액이나 실측 절감률이 아니다.

Enterprise는 문서 개수만으로 과금액을 계산할 수 없다. 읽기는 처리 데이터 크기, 쓰기는 문서·인덱스 쓰기, 실시간 갱신은 별도 요금 항목을 고려해야 한다. 이 문서의 `R/W`는 청구 단위가 아니라 애플리케이션 문서 읽기/쓰기 작업을 의미한다. 쿼리 결과 제한도 인덱스 스캔량의 상한을 보장하지 않는다. [공식 Enterprise 과금 설명](https://firebase.google.com/docs/firestore/enterprise/pricing)

## 2. 호출 지도와 이미 적용된 최적화

| 영역 | 진입점·위치 | 호출과 생명주기 | 현재 평가 |
| --- | --- | --- | --- |
| Auth | `auth.js:56`, `auth.js:180`, `data.js:587` | 앱/Auth 초기화 재사용, Auth 상태 관찰 1개, 미인증 계정 복귀 시 reload, 시작·종료 전 강제 토큰 갱신 | Auth 관찰은 Firestore 읽기가 아니다. 강제 갱신 범위만 개선 후보 |
| 개인 데이터 | `data.js:409`, `data.js:436`, `data.js:479` | 프로필 1개 실시간 구독, 조건부 활성 세션 1개 구독, 보이는 통계만 단발 조회 | 모든 통계/랭킹을 실시간 구독하는 구조가 아님 |
| 통계·랭킹 | `data.js:448–474` | 날짜·UID·revision·학교별 캐시, 통계 15분/랭킹 5분, 동일 키 진행 중 요청 병합 | 7일 조회와 오늘 조회 중복도 이미 제거. revision 범위가 넓음 |
| 학습 | `data.js:367–406`, `functions/index.js:68–175` | start/finish, camera sync 또는 일반 heartbeat, 만료 확인, 매분 lease 정리 | 소유 controller·sequence·정산 원자성 유지 필수 |
| 영단어 | `functions/word-study.js:32`, `functions/word-study.js:77`, `functions/word-stats.js:9` | 외부 앱 callable, 체크포인트마다 delta만 통계에 반영, 프로필·lease·연결 카메라·방 갱신 | 중복 시간 정산은 막지만 변경 전파 범위가 큼. 외부 앱 실제 호출 주기는 미확인 |
| 소셜·방 | `study-social.js:169`, `functions/social-service.js:77`, `functions/room-service.js:177` | 방 참가 중 약 5초, 방 없는 Play 약 20초 polling; 숨긴 문서는 중단; 목록은 socialRevision 재사용 | 진행 중 요청은 1개. 방 조회 자체에 쓰기 포함 |
| 리포트 | `daily-report.js:70`, `functions/report-service.js:6` | 열린 화면/패널에서 UID·날짜·studyRevision 캐시; 세션 최대 1001개 + 7일 통계 조회 | 무제한 전체 이력 스캔은 아님. 활성 세션은 리포트 합계에서 제외 |
| 학교·브리핑 | `integrations.js:23`, `functions/integrations.js:73`, `functions/neis-cache.js:25`, `functions/briefing-cache.js:6` | 클라이언트 캐시, 학교 자료 일별·월 범위 공유 캐시, 브리핑 시간대별 서버 캐시·생성 lease | 기존 중복 생성 방지와 실패 정책을 보존 |
| AI·계획 | `functions/ai-service.js:24`, `functions/school-agent.js:19`, `functions/plan-service.js:7`, `functions/plan-agent.js:8` | 사용자 요청 시 실행, AI 예산 예약·정산, 도구 반복 최대 3회, 서버 트랜잭션으로 목표 저장 | 예산·권한 판단을 캐시로 대체하지 않음 |
| 계정 연결 | `functions/word-link.js:7–20`, `functions/word-link-service.js:19–41` | 타 프로젝트 토큰 검증, 연결 문서 조회, 대상 Auth 사용자 검사, custom token 발급 | 보안상 필요한 호출. 연결 복원 응답/token 캐싱 금지 |
| 예약 작업 | `functions/index.js:28`, `functions/index.js:168`, `functions/room-service.js:230` | 방 정리와 세션 lease 정리가 각각 매분 실행 | 유지하되 방 레거시 감사 스캔 분리 후보 |
| 관리·테스트 | `scripts/configure-auth.mjs`, `scripts/qa-account.mjs`, `scripts/test-*-live.mjs`, `tests/firebase.test.mjs`, `tests/room-live.test.mjs` | Auth 관리/테스트 계정·callable·DB 검증 | 사용자 화면의 반복 호출과 구분. 운영 연결 스크립트는 실행하지 않음 |

추가 확인: 루트 소스의 동일 로컬 모듈 import에 서로 다른 버전 URL이 섞인 사례는 검색에서 발견되지 않았다. `navigation.js:59`의 HTML fetch는 Firebase 데이터 조회가 아니다. 화면 이동은 기존 모듈을 유지하고 `study:navigated`를 전달하므로, 화면 이동마다 Firebase 앱이 새로 생성된다고 판단하지 않는다.

## 3. 우선순위

P0는 구현 전 계측·회귀 기준, P1은 반복 비용이 큰 경로, P2는 후속 개선이다. 확정은 해당 코드 경로의 동작이 확인됐다는 뜻이며 운영 영향 규모가 확인됐다는 뜻은 아니다.

| ID | 우선순위 | 개선 대상 | 근거 수준 | 기대 효과 | 기능 위험 / 난이도 |
| --- | --- | --- | --- | --- | --- |
| O1 | P1 | 영단어 revision에 의한 전체 통계·랭킹 캐시 무효화 | 확정 | 매 체크포인트의 무관한 조회 제거 | 높음 / 중상 |
| O2 | P1 | heartbeat의 사전 만료 조회와 트랜잭션 재조회 | 확정 | 정상 요청마다 1–3개 중복 읽기 감소 후보 | 높음 / 높음 |
| O3 | P1 | room polling과 camera/word의 중복 상태 게시 | 확정 | 방 쓰기·충돌·전송량 감소 | 높음 / 높음 |
| O4 | P1 | 매 polling 방 목록 조회와 초대 N+1 | 확정 | 중복 문서 조회 및 직렬 왕복 감소 | 중간 / 중간 |
| O5 | P1 | 진행 중 영단어 학습에 따른 리포트 재스캔 | 확정 | 열린 리포트의 반복 세션 스캔 감소 | 중간 / 중간 |
| O6 | P2 | 매분 실행되는 레거시 방 전체 순회 | 확정 | 정상 방 중복 조회·커서 쓰기 감소 | 중간 / 중간 |
| O7 | P2 | 시작·종료마다 Auth 강제 토큰 갱신 | 확정 | 불필요한 인증 왕복·대기 감소 | 중간 / 낮음 |
| O8 | P2 | 일반 세션 소유 탭의 조건부 중복 리스너 | 응답 순서에 따른 경로 확인, 빈도 미측정 | 해당 경로의 자기 heartbeat 수신 감소 | 중간 / 중간 |
| O9 | P2 | 학교 응답 캐시의 전체/달력 중복 및 in-flight 부재 | 확정, 동시 호출 빈도 미측정 | 중복 callable·rate-limit 읽기/쓰기 감소 | 낮음~중간 / 낮음 |
| O10 | P2 | AI 내부 단계마다 불필요한 usage 조회 | 확정 | 단계별 부수 읽기 감소 | 중간 / 중간 |
| O11 | P2 | 인덱스·큰 동적 문서의 쓰기 증폭 | 조건부: 운영 인덱스/크기 확인 필요 | Enterprise 쓰기 단위·전송량 감소 가능 | 중간~높음 / 중상 |
| O12 | P2 | 동일 값 저장과 목표 도구의 재조회 | 확정 | 낮은 빈도의 무변경 쓰기·중복 읽기 감소 | 낮음~중간 / 낮음 |

## 4. 문제별 근거와 개선 방법

### O1. 영단어 revision이 무관한 통계·랭킹까지 만료시킴

- **위치·발생 원인:** `functions/word-study.js:100–105`는 새 공부 시간이 있으면 `studyRevision`을 증가시킨다. `data.js:439–449`, `data.js:531–537`은 이 revision을 모든 보이는 데이터의 캐시 키에 넣고 다시 조회한다. 실제 체크포인트 쓰기는 `functions/word-stats.js:17`의 일/주/월 통계이며 summary·focusTime·전체/학교 랭킹은 보통 종료 정산에서 바뀐다(`functions/session-lifecycle.js:48–60`). 지난주 기록도 현재 구간과 무관할 수 있다.
- **개선:** 변경 종류를 서버가 구분하는 버전/무효화 정책을 설계한다. 체크포인트는 영향을 받은 기간 통계만 갱신하고, 정산·랭킹·focusTime은 해당 변경 때 갱신한다. 서버가 확정한 wordSnapshot·wordCheckpoint를 기존 기간 합계에 병합할 때 이미 반영된 seconds를 빼서 이중 가산을 막는다. 랭킹의 기존 5분 TTL과 종료 후 갱신을 유지한다.
- **예상 효과:** 영단어 요청 간격을 `h`초, 화면에서 불필요하게 다시 읽는 문서 수를 `U`라고 하면 시간당 약 `(3600/h) × U`의 읽기 제거 후보다. 예를 들어 실제 h=5초이고 보이는 랭킹 50행이 매번 채워져 있으면 그 목록만 약 36,000 문서 접근/시간의 반복 경로가 생긴다. 외부 앱 h 및 화면별 U는 실측해야 한다.
- **위험·검증:** TTL만 늘리면 실시간 통계가 늦어진다. 날짜/월요일/월 경계, 다른 탭 종료, 학교·표시명 변경, 과거 세션의 지연 정산, 잔액 사용에 대한 정확한 무효화가 필요하다. 최초 로드·재연결은 서버 상태로 재동기화한다.

### O2. 정상 heartbeat도 만료 검사 후 같은 프로필·세션을 다시 읽음

- **위치·발생 원인:** `functions/index.js:95–118`, `functions/index.js:124–135`, `functions/word-study.js:77–105`는 먼저 `expireUserSessions()`를 실행한다. 이 함수는 프로필 1개와 활성 세션 최대 2개를 개별 조회한다(`functions/session-lifecycle.js:64–80`). 이후 본 트랜잭션에서 동일 문서를 다시 읽는다.
- **현재 비용 예:** 활성 카메라 1개·방 없음·만료 없음·재시도 없음이면 사전 2R + 본 트랜잭션 2R, 2W(session/lease)다. 방에 있으면 방 조회/갱신이 추가되어 5R/3W다. 일반 heartbeat는 기본 3R/2W다. 5초 간격이 유지되는 이상적 상황은 약 720회/시간이며 실제로는 응답 지연과 상태 변경에 따라 달라진다.
- **개선:** 먼저 입력 형식 검증을 DB 접근보다 앞으로 옮긴다. 정상 대상 세션의 만료·소유권·sequence 검사를 heartbeat 트랜잭션 읽기와 결합하고, 다른 연결 세션의 만료 정산이 필요한 경우에만 별도 흐름을 실행한다. 요청 밖에서 읽은 프로필을 권한의 최종 근거로 재사용하지 않는다.
- **예상 효과:** 정상 단일 카메라 경로에서 중복 2R/회, 일반 heartbeat는 최소 중복 session 1R/회 감소 후보다. 연결된 두 세션의 추가 절감은 설계 검증 후 산정한다. callable 횟수와 필수 checkpoint/lease 쓰기는 그대로다.
- **위험·검증:** 가장 위험한 변경 중 하나다. 만료 후 세션 부활, finish와 heartbeat 경쟁, camera↔word 인계, stale sequence, 중복 정산을 막아야 한다. 만료된 세션은 갱신하지 않고 기존 원자적 종료 경로로 보내며, transaction의 읽기-쓰기 순서도 지킨다.

### O3. 방 조회가 매번 방 전체 상태를 쓰며 학습 동기화와 중첩됨

- **위치·발생 원인:** `study-social.js:175–180`의 약 5초 polling → `functions/social-service.js:93` → `syncRoom()`(`functions/room-service.js:177–201`)은 프로필·방·활성 세션을 읽고 `publishRoomActivity()`를 호출한다. 이 함수는 변경 여부와 무관하게 `members`, `studyTotals` 맵과 만료 시각을 갱신한다(`functions/room-service.js:219–228`). 같은 카메라/영단어 동기화도 이 함수를 호출한다(`functions/index.js:115`, `functions/word-study.js:99`).
- **개선:** 방의 상태 게시 책임을 구분한다. 학습 heartbeat가 이미 제공한 서버 확정 상태와 읽기 응답을 재사용하고, room-only 방문 heartbeat와 학습 상태 쓰기의 중복을 합친다. 단일 탭에서 두 callable을 결합하는 방안은 해당 탭의 peer 응답 주기를 5초 이내로 유지하는지 검증한 뒤 적용한다. 우선 요청 내 중복만 제거하고, 필요하면 멤버별 필드 패치로 전체 맵 전송을 줄인다.
- **예상 효과:** 참가자 1명당 room polling만 약 720W/시간 후보이며 카메라 상태 게시가 같은 정도로 더해질 수 있다. 정상 단일 활성 세션의 social 요청은 목록 제외 약 4R/1W다. 어떤 쓰기가 실제 중복인지는 두 요청의 시각·상태·lease를 비교해야 하며 720회를 모두 삭제할 수 있다고 단정하지 않는다.
- **위험·검증:** 휴식 중 방문도 온라인 판정과 3시간 방 수명에 필요하다. 상태가 같아도 `countUntilMs`, `lastSeenMs`, `statusUntilMs`는 의미가 있으므로 단순 equality 검사로 생략하면 안 된다. 일반 타이머는 현재 방 상태를 별도 polling이 게시하므로 선행 대체 없이 제거 불가. 방별 일/주 누적, 탈퇴자 순위, 정렬·동률, 입퇴장, 공개 범위 변경을 보존한다. 멤버 필드 패치만으로 동일 문서의 transaction 충돌이 없어지지는 않는다.

### O4. 방 패널을 열어 두면 목록을 매번 다시 읽고 초대 방을 직렬 조회

- **위치·발생 원인:** `study-social.js:180`은 방 패널이 열리면 매 polling에 `includeSchoolRooms`를 보낸다. `functions/social-service.js:83`은 socialRevision과 무관하게 `roomDirectory()`를 호출한다. `functions/room-service.js:162–172`는 일반방 1개, 학교방 최대 50개, 초대 최대 50개, 소유방 최대 50개와 초대별 방 문서를 읽는다. 이미 학교방/소유방에서 읽은 방도 초대 처리 시 다시 읽는다. 목록 revision이 바뀐 요청에는 초대 컬렉션도 `socialSnapshot():89`에서 다시 조회될 수 있다.
- **개선:** 요청 단위로 방 ID→문서 맵과 초대 결과를 공유한다. 이미 얻은 방은 재사용하고 누락된 초대 방만 중복 제거 후 getAll로 조회한다. 독립 목록 조회는 읽기 일관성 요구를 확인하고 병렬화한다. 후속으로 공개 목록/멤버 미리보기의 서버 버전을 도입해 변경 시 갱신하되, 현재 polling 수준의 신선도를 유지한다.
- **예상 효과:** 중복 초대 방 `D`개면 D개의 추가 문서 읽기, 중복 초대 목록이면 최대 50행 재조회 제거 후보. 나머지 I개를 getAll로 바꾸면 직렬 왕복은 줄지만 I개 문서 읽기 자체가 없어지는 것은 아니다. 학교가 있고 각 목록이 50개라면 현재 함수는 최대 약 `151 + 유효 초대 수` 문서 접근 경로가 있다(쿼리 최소 과금·스캔량 제외).
- **위험·검증:** TTL 캐시만 도입하면 새 방, 닫힌 방, 멤버 온라인 상태, 초대 철회 반영이 늦어진다. 현재 socialRevision은 다른 사람의 공개방 생성·heartbeat를 모두 대표하지 않으므로 이를 목록 전체 캐시 버전으로 사용하면 안 된다. 서버의 학교/학년/초대/공개권한 검사를 유지한다. limit 전 필터를 바꾸면 목록 구성도 바뀌므로 별도 정합성 검증이 필요하다.

### O5. 완료 기록 리포트가 진행 중 체크포인트마다 재집계됨

- **위치·발생 원인:** `daily-report.js:76–89`는 전체 studyRevision으로 캐시를 무효화한다. 서버는 최근 최대 36시간 시작 세션을 1001개까지 읽고 7일 통계와 프로필을 읽는다(`functions/report-service.js:11–27`). 리포트 합계는 완료 기록 기반인데 영단어 진행 중 revision에도 재실행된다. 요청 중 중복은 pending으로 막지만 응답 후 다음 revision은 다시 조회한다.
- **개선:** 완료 세션/리포트 데이터 버전과 현재 활성 여부를 분리한다. 완료 집계는 UID·KST 날짜·완료 버전·과목 표시 정보로 재사용하고 활성 표시만 현재 상태에서 갱신한다. 필요하면 서버에 완료 세션의 일별 리포트 집계를 만들어 원본 대비 검증 후 도입한다. 초기 단계는 버전 분리만으로 충분한지 먼저 측정한다.
- **예상 효과:** 세션 결과 S개인 요청당 최대 약 `S + 8` 문서 접근(프로필 1, 날짜 최대 7)을 반복한다. 완료 기록이 안 바뀐 체크포인트에서는 이 스캔을 생략할 수 있다. 마감 집계를 만들면 추가 쓰기·백필 비용과 비교해야 한다.
- **위험·검증:** 자정 교차·과거 형식·시간대별 분포·과목 이름·강제 새로고침·hasActiveSession을 유지한다. 1000개 초과 시 명시적 오류를 조용한 잘림으로 바꾸지 않는다. O1과 효과가 겹치므로 절감량을 이중 합산하지 않는다.

### O6. 레거시 방 감사가 정상 방도 매분 재조회

- **위치·발생 원인:** `functions/room-service.js:230–242`: due 최대 30개 + 이름순 audit 최대 50개 + cursor 1개를 읽고, 두 결과의 합집합 문서를 transaction으로 다시 읽은 뒤 매번 cursor를 쓴다. `functions/index.js:28`에서 매분 실행한다.
- **개선:** 실제 만료 큐 정리는 매분 유지한다. legacy 데이터 보정은 완료 여부·남은 수를 계측한 별도 마이그레이션/저빈도 감사로 분리한다. 일반방 등 구조상 정리 대상이 아닌 문서는 불필요한 transaction 진입을 줄인다. 실제 삭제 후보는 반드시 최신 transaction 재검증 후 삭제한다.
- **예상 효과:** 결과 수를 d, a, 합집합 u라 하면 정리 전 기본 접근은 `1+d+a+u`R와 cursor 1W다. d=0,a=u=50인 예는 매분 101R다. audit 분리는 이 중 100R/분 상당의 정상방 순회 부담을 줄일 후보이며 운영 데이터 수에 따라 달라진다.
- **위험·검증:** deleteAfterMs가 없는 레거시 방이나 잘못된 만료 값이 영구 잔류하면 안 된다. 짧은 주기의 due 처리, 입장·갱신과 삭제의 경쟁 검사, 프로필·초대·코드 정리를 보존한다. 세션 lease 정리(`functions/index.js:168`)는 limit(100) 큐 처리이며 동일한 전체 스캔 문제로 보지 않는다. 처리 지연·backlog만 계측한다.

### O7. 모든 시작·종료에서 ID token 강제 갱신

- **위치·발생 원인:** `data.js:587`의 `getIdToken(true)`가 시작과 종료 모두에 적용된다. 이메일 인증 완료에 대한 reload/강제 갱신은 이미 `auth.js:180–191`에 있다.
- **개선:** 인증 전환 직후나 토큰 claim이 뒤처진 것이 확인된 경우에만 강제 갱신한다. 정상 요청은 SDK의 유효 토큰 재사용 경로를 사용한다. 서버가 미인증 claim으로 거절한 경우의 갱신·재시도는 1회로 제한하고, 쓰기 요청의 멱등성도 확인한다.
- **예상 효과:** 정상 시작·종료 각 1회의 강제 Auth 네트워크 왕복과 지연을 제거할 수 있다. Firestore 문서 읽기 절감으로 계산하지 않는다.
- **위험·검증:** 인증 직후 첫 시작, 장시간 열린 탭, 계정 변경, 만료 토큰을 검증한다. 서버 `email_verified` 검증은 유지한다. 계정 연결 복원 시 disabled/emailVerified를 검사하는 Admin `getUser`는 이 최적화 대상이 아니다.

### O8. 응답 순서에 따라 일반 세션 소유 탭에 자기 구독이 남을 수 있음

- **위치·발생 원인:** `data.js:527`에서 새 세션의 controller를 아직 모르면 session 구독을 연다. 시작 callable 응답이 나중에 도착하면 `data.js:592–595`에서 소유 상태를 알게 되지만 명시적 해제는 cameraMode에만 있다. 일반 타이머는 heartbeat 응답(`functions/index.js:135`)과 session snapshot 양쪽에서 자기 변경을 받을 수 있다. 프로필 snapshot보다 callable 응답이 먼저 오는 경우에는 해당 구독이 생기지 않을 수 있다.
- **개선:** 구독 개수를 먼저 계측하고, 소유 controller가 확정된 일반 세션에서도 authoritative callable 응답으로 충분한 조건을 명시해 중복 구독을 해제한다. 다른 탭이 소유한 활성 세션 리스너는 유지한다.
- **예상 효과:** 이 순서로 진입한 탭에서는 heartbeat 갱신당 자기 session 수신 1회 감소 후보. 전체 사용자의 확정 절감으로 산정하지 않는다.
- **위험·검증:** 외부 종료, 단어앱 인계, controller 변경, 뒤늦은 snapshot, 화면 이동을 확인한다. 프로필 리스너를 숨김 시 무조건 해제하면 원격 종료·인계 탐지가 늦어질 수 있다. 현재 구조상 최대 약 1–2개의 Firestore 문서 구독이며 리스너 누수가 확정된 것은 아니다.

### O9. 학교 응답 캐시의 중복 표현과 진행 중 요청 재사용 부족

- **위치·발생 원인:** `integrations.js:23–33`은 완료 응답만 캐시하고 진행 중 Promise는 공유하지 않는다. `integrations.js:231`의 전체 overview와 `:236`의 eventsOnly는 서로 다른 키다. 전체 overview를 받은 달로 돌아오면 이미 보유한 학사일정도 eventsOnly callable을 추가 호출할 수 있다. 화면별 loading/key guard가 있어 상시 중복이라고 보지는 않는다.
- **개선:** 같은 UID·학교·학반·날짜·월의 전체 overview에서 검증된 events 부분을 달력 캐시에도 제공한다. 동일 의미 요청에 in-flight 공유를 추가하되 force 요청, 오류 결과, 다른 사용자·날짜는 분리한다. 서버 NEIS 월 캐시와 일 단위 갱신은 유지한다.
- **예상 효과:** 제거되는 학교 callable마다 rateLimit 1R/1W + 프로필 1R와 서버 캐시 조회의 일부를 줄일 수 있다(`functions/integrations.js:23–29`, `:73–83`). NEIS 인스턴스 메모리에 적중한 경우 외부 API 절감은 이미 0일 수 있다.
- **위험·검증:** 수동 새로고침을 기존 요청에 잘못 합치지 않는다. 부분 오류를 성공 캐시로 만들지 않는다. 계정/학교/학반 변경·KST 자정·월 왕복을 검증한다. 캐시된 브리핑은 시간대별 유지가 의도된 동작이므로 학습 heartbeat마다 재생성하지 않는다.

### O10. AI 내부 단계의 부수 DB 읽기

- **위치·발생 원인:** `functions/ai-service.js:27`은 모델 및 countDaily와 무관하게 monthly/daily를 모두 읽지만 daily 제한 검사는 Argon 첫 호출에만 필요하다. `:99`는 도구 호출이 포함된 중간 생성에도 `usageFor()` 2R를 수행한다. `functions/school-agent.js:23–52`는 여러 생성 단계를 진행하고 보통 최종 결과의 usage를 반환한다.
- **개선:** daily 제한을 실제 적용하는 경우에만 해당 문서를 읽도록 분기한다. 중간 단계 usage는 UI/중단 반환에 필요한지 확인해 최종 반환 시 한 번 조회하도록 정리한다. 중단·부분 응답도 최신 usage를 반환해야 한다.
- **예상 효과:** daily 검사가 필요 없는 예약 단계당 1R, 최종 결과에 사용되지 않는 중간 usage 조회당 2R 제거 후보. 외부 생성·token count 비용 및 예약/정산 쓰기는 줄어들지 않는다.
- **위험·검증:** 모델 공통 월 예산 예약, Argon 일일 제한, 여러 탭 동시 요청, 실패 시 보수적 정산, streaming 취소, 도구 반복 제한을 그대로 유지한다. 예산 장부를 TTL 캐시로 대체하지 않는다.

### O11. 큰 동적 필드·인덱스의 쓰기 증폭은 운영 설정 확인 후 판단

- **위치·발생 원인:** `firestore.indexes.json:1–30`에는 복합 인덱스 3개와 빈 fieldOverrides가 있다. 자주 갱신되는 `studyRooms.members/studyTotals`(`functions/room-service.js:227`), `users.wordSnapshot`(`functions/word-study.js:103–104`), 세션 시간대/구간 맵, NEIS rows(`functions/neis-cache.js:50`)는 조회 조건으로 쓰이지 않는 큰 필드 후보다. Enterprise의 실제 인덱스 정책은 로컬 빈 fieldOverrides만으로 판단할 수 없다.
- **개선:** 운영 인덱스 목록·문서 크기·Write Units를 확인한다. 실제 자동/수동 인덱스에 포함된 불필요 필드만 제외 대상으로 정하고, 필요한 query/orderBy 필드는 유지한다. 방 단일 문서가 병목이면 멤버 상태 문서 분리를 후속 설계로 검토하되 조회 fan-out 증가와 원자성 비용도 비교한다.
- **예상 효과:** 불필요 인덱스 쓰기·저장량과 큰 payload 전송량 감소 가능. 이미 인덱싱되지 않았다면 인덱스 절감 효과는 없다. 사용하지 않는 것으로 보이는 sessions(status,startedAt) 인덱스도 외부 소비자·관리 쿼리 확인 없이 삭제하지 않는다.
- **위험·검증:** ranking의 totalSeconds/uid, 방 schoolId/status/createdAtMs/hostUid/deleteAfterMs, lease expiresAtMs, 세션 startedAt 등 실제 쿼리에 대한 Explain/인덱스 검증이 선행되어야 한다. 학교/학년별 방 조회의 후단 필터를 옮길 때 기존 limit 및 접근 범위를 보존한다. [공식 Query Explain 기반 최적화](https://firebase.google.com/docs/firestore/enterprise/optimize-query-performance)

### O12. 같은 값 저장과 목표 도구의 요청 내부 재조회

- **위치·발생 원인:** `functions/index.js:47–61`은 표시명이 동일해도 프로필과 존재하는 랭킹을 갱신하고, `data.js:684–685`는 Auth updateProfile도 호출한다. `functions/plan-service.js:22–36`은 이미 없는 과목/목표 제거에도 배열·updatedAt을 다시 쓴다. `functions/plan-agent.js:10–15`는 목표 등록 전 프로필을 읽고 changePlan이 transaction에서 다시 읽는다.
- **개선:** 서버의 현재값과 정규화한 요청값이 같으면 no-op 성공을 반환한다. Auth와 Firestore 표시명은 각각 비교해 불일치 복구를 유지한다. 목표 이름→ID 검증은 changePlan의 최신 transaction 데이터에서 한 번 처리하도록 계약을 정리한다.
- **예상 효과:** 같은 이름 저장 시 프로필 및 최대 두 랭킹 쓰기와 불필요 Auth update 감소, 중복 삭제 요청의 1W 감소, 목표 도구 요청당 사전 1R 감소 후보다. 일상 빈도는 낮을 수 있어 P2다.
- **위험·검증:** 멱등적인 성공 응답과 권한 검증을 유지한다. 외부 앱·AI 도구의 반환 계약과 동시 과목 삭제/목표 추가를 검증한다. UI의 낙관적 값만 믿고 서버 검증을 생략하지 않는다.

## 5. 캐싱·실시간성·보안 유지 기준

| 데이터 | 허용할 재사용 | 필수 무효화/유지 조건 |
| --- | --- | --- |
| 개인 일/주/월 통계 | 서버 확정 버전·체크포인트에 따른 부분 재사용 | UID, 기간, 정산, 늦은 기록, word delta 반영 |
| 완료 리포트 | 완료 기록 버전별 캐시 | 자정, 종료 정산, 과목 표시 정보, 수동 새로고침 |
| 전체·학교 랭킹 | 기존 5분 TTL 내 재사용 | 종료 정산·표시명·학교 변경 반영, 학교 접근권한 재검증 |
| 학교 정보 | 기존 일별/월 범위 캐시와 요청 병합 | 학교·학년·반·날짜·조회 유형 분리, 부분 실패 재시도 정책 |
| 방 상태·미리보기 | 동일 요청의 중복 읽기 및 서버 확정 상태 재사용 | 현재 약 5초/20초 갱신 수준, 초 단위 화면 타이머, lease 종료, 초대 철회 |
| 인증/권한/예산/연결 token | SDK가 관리하는 토큰 수명 외 임의 캐싱 금지 | 매 서버 요청의 인증·소유권·학교권한·disabled·예산 동시성 검사 |

- 카메라 credit lease 10초, presence 45초, 영단어/일반 세션 lease 10초, 최대 학습 12시간(`functions/domain.js:4–8`)을 유지한다. 5초 heartbeat를 30초로 늘리면 정산 계약이 깨지므로 절감안에서 제외한다.
- 현재 학교 랭킹 규칙은 사용자 프로필을 읽어 학교 소속을 확인한다(`firestore.rules:10–12`). 부수 비용을 줄이려고 이 권한 검사를 제거하지 않는다. Admin 호출은 규칙 대신 서버의 권한 검사에 의존하므로 클라이언트 캐시로 대체하지 않는다.
- 통계·프로필·랭킹의 클라이언트 직접 쓰기 금지, UID별 캐시 격리, 계정 전환 중 늦게 도착한 응답 폐기, 서버 시간·sequence·멱등성을 유지한다.
- IndexedDB 영속 캐시는 기본 권고에서 제외한다. 현재 localStorage 응답 캐시와 중복될 수 있고 공유 기기의 개인 데이터 보존 정책을 확인해야 한다. 다중 탭 공유나 영속 캐시가 필요하면 계정 전환·로그아웃·권한 회수 검증 후 별도 도입한다. 리스너 재연결은 설정에 따라 재조회 비용이 발생하므로 숨길 때 해제하는 전략이 항상 저렴하지는 않다. [공식 오프라인 캐시 설명](https://firebase.google.com/docs/firestore/manage-data/enable-offline), [공식 Enterprise 리스너 과금](https://cloud.google.com/firestore/enterprise/pricing)

## 6. 실행 순서와 완료 조건

### P0 — 기준선 확보

1. 운영과 분리된 테스트 환경에 callable별 invocation/지연/실패, transaction 시도 횟수, 문서 접근 수·크기, Firestore Read/Write/Realtime Units, listener attach/detach, 캐시 hit/miss/무효화 사유를 측정한다. 토큰·개인 본문은 로그에 남기지 않는다.
2. 재현 시나리오를 고정한다: 일반 방문, 카메라 10분, 일반 타이머 10분, 영단어 10분, 카메라+단어앱 인계, 방 1/5/최대 인원, 열린 방 목록·리포트, 탭 2개, 숨김/복귀, 네트워크 지연, KST 자정/월요일/월 변경.
3. 현재 heartbeat 간격과 peer 표시 지연 p50/p95, 정산 초, 랭킹/잔액, 방 수명과 종료 반영을 기준으로 저장한다. 5초는 polling 설정이지 cold start를 포함한 보장 지연이라고 표현하지 않는다.
4. O4/O5/O11 쿼리는 실제 Enterprise 환경의 Explain 및 인덱스 상태를 확인한다. 설명용 분석도 운영 데이터 읽기 비용이 생길 수 있으므로 테스트 데이터로 시작한다.

### P1 — 호출량이 큰 경로부터 단계별 적용

1. **O1 + O5:** 변경 버전 분리와 무효화 테스트를 먼저 설계하고, 같은 기록·화면 결과에서 무관한 통계/완료 리포트 재조회가 없어지는지 확인한다.
2. **O4:** 요청 단위 문서 중복 제거·초대 재사용·getAll을 적용한다. 결과 목록과 권한을 동일하게 유지하고 요청 왕복/읽기 감소를 확인한다.
3. **O2:** heartbeat 정상 경로와 만료 정산 경로를 분리해 transaction 경쟁 테스트를 통과시킨다. 변경 전후 만료·정산 결과를 비교한다.
4. **O3:** 위 변경 후 방 상태 게시의 중복을 줄인다. 방 peer 신선도와 방문·정산 계약이 같음을 입증한 범위만 제거한다. 복잡한 멤버 문서 분리는 필요성이 실측된 경우로 제한한다.

### P2 — 부수 비용 및 규모 대응

- O7, O9, O12의 작은 변경 → O8 리스너 정리 → O10 AI 부수 조회 → O6 감사 작업 분리 → O11 인덱스/문서 구조 순으로 독립 배포한다. O11은 측정 결과에 따라 P1으로 올릴 수 있다.
- Functions의 `minInstances:0`, `maxInstances:2`, `concurrency:1` 설정(`functions/index.js:19`, `functions/integrations.js:16`, `functions/word-link.js:17`)은 비용 상한을 의식한 설정이다. cold start·대기열 때문에 lease를 놓치는지 먼저 측정한다. concurrency/CPU/minInstances 변경은 Firestore 중복 호출 제거와 별개이며, 낮은 비용을 보장하지 않는다.
- 캐시 TTL 연장, 권한 검사 생략, 서버 정산의 비동기 지연, 무조건 polling 중단은 이 계획의 완료 수단으로 허용하지 않는다.

### 회귀 검증과 롤백

- 캐시/학교/브리핑: `tests/firebase-cost.test.mjs`, `tests/integrations.test.mjs`, `tests/school-ui.test.mjs`.
- 시간 정산·인계·권한: `tests/firebase.test.mjs`, `tests/room-live.test.mjs`, `tests/domain.test.mjs`, `tests/room-time.test.mjs`, `tests/word-link.test.mjs`.
- 화면 생명주기·리포트: `tests/timer-ui.test.mjs`, `tests/navigation-ui.test.mjs`, `tests/social-ui.test.mjs`, `tests/report.test.mjs`.
- 구현 단계에서 추가할 검증: 동일 revision 중복 요청 수, word checkpoint가 무관 랭킹을 읽지 않음, 느린 요청의 최신 revision 재동기화, listener 수 불변, 초대 방 중복 읽기 0, 중간 AI usage 조회 수, 정상 heartbeat 문서 접근 예산. 값만 맞는 테스트와 호출 수 테스트를 함께 둔다.
- transaction 충돌 시 재시도가 정상 동작한다는 전제에서 횟수를 계측한다. `getAll`/batch화는 왕복 감소이지 자동으로 문서 과금 감소가 아니며, 시간 정산 트랜잭션을 단순 batch로 대체하지 않는다. [공식 transaction 동작](https://firebase.google.com/docs/firestore/manage-data/transactions)
- 변경은 항목별로 분리하고 신·구 응답 계약의 호환 기간을 둔다. 집계/문서 분리가 있으면 이중 반영 없이 백필·비교하고 기존 읽기 경로를 롤백 기간 유지한다. 데이터 삭제는 별도 단계다.
- 완료 조건: 동일 입력에서 정산·랭킹·잔액·접근권한 결과 동일, 현재 실시간 반영 지연 악화 없음, 목표 요청당 R/W·Units 감소 확인, 실패·재시도율 증가 없음. 예상 절감량의 중복(O1↔O5, O2↔O3)을 제거한 뒤 실제 세션당 비용을 비교한다.

## 7. 이번 단계의 검증 결과와 남은 한계

- 실행: `node --test tests/firebase-cost.test.mjs tests/room-time.test.mjs tests/word-link.test.mjs tests/report.test.mjs`.
- 결과: **27개 통과, 실패 0, 종료 코드 0**. 기존 캐시 경계·계정 격리·중복 생성 방지·방 시간 계산·계정 연결·리포트 계산의 기준선을 확인했다. 이 결과는 아직 구현하지 않은 최적화의 성능이나 운영 정합성을 증명하지 않는다.
- Firebase 에뮬레이터/운영 부하 테스트·배포는 수행하지 않았다. 위의 전체 회귀 행렬은 후속 구현 단계의 요구사항이다.
- Serena는 실제 경로를 활성화했지만 JS 언어 서버가 없어 심볼 조회를 사용할 수 없었다. 파일별 검색과 제한된 코드 읽기로 추적했다.
- agy 보조 수집은 인증·파일 접근 오류로 분석 결과 없이 실패했다. 해당 결과를 근거로 사용하지 않고 서버 경로도 직접 검토했다.
- 실제 배포 리소스, 데이터 분포, 외부 단어앱 주기, 운영 지표가 없으므로 확정 절감 금액·비율을 제시하지 않는다. 정적 근거와 조건부 효과를 분리한 본 계획을 후속 계측·구현의 기준으로 사용한다.
