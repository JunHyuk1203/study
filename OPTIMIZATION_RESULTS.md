# Firebase 최적화 구현·검증 결과

작성일: 2026-10-24. 기준 커밋: `86340a4`. 운영 사용량·청구 데이터는 조회하지 않았다.

## 구현

- **O4:** 방 목록의 요청 내부 문서 재사용, 미조회 초대 방만 getAll, 소셜 응답과 방 목록 사이의 초대 쿼리 공유. 학교·학년·초대·만료 검사는 유지하며 캐시를 다음 polling으로 넘기지 않는다.
- **O1 일부:** 영단어 체크포인트가 studyRevision과 wordCheckpointRevision을 같은 transaction에서 증가시킨다. summary/focusTime/랭킹은 두 값의 차이를 캐시 버전으로 사용한다. 일/주/월/7일 데이터는 기존 전체 버전으로 계속 갱신한다. 종료 정산은 전체 버전만 증가시켜 모든 관련 데이터를 갱신한다. 구형 프로필은 checkpoint 값을 0으로 취급하고 구형 클라이언트도 기존 studyRevision을 계속 사용할 수 있다. 캐시 키 v2로 이전 캐시와 충돌을 막았다.
- **O9:** 동일 학교 요청의 진행 중 Promise를 공유하고 전체 overview 캐시를 달력에도 재사용한다. force 요청은 새 요청을 시작하며 늦은 이전 응답이 최신 캐시를 덮지 못한다. 실패·부분 오류는 캐싱하지 않는다.
- **O10 일부:** Flash 또는 Argon 후속 단계처럼 일일 제한을 검사하지 않는 AI 예약에서 daily 문서 읽기를 생략한다. 월 예산 transaction과 Argon 첫 요청의 일일 제한은 유지한다. 중간 usage 응답 최적화는 적용하지 않았다.
- **O12 일부:** 같은 표시명의 프로필·랭킹 쓰기와 Auth updateProfile, 존재하지 않는 목표·과목 제거 쓰기를 생략한다. 랭킹의 기존 불일치는 여전히 복구한다. 권한·입력·활성 학습 검사 후 no-op을 판단한다.
- **O2 일부:** 잘못된 heartbeat 입력은 만료 검사 DB 접근 전에 거절한다. 정상 heartbeat의 만료 처리와 정산 transaction은 그대로 유지한다.
- 정적 모듈과 HTML의 앱 버전을 `20261024-1`로 갱신했다. 권한 규칙·인덱스·lease·polling 간격은 변경하지 않았다.

## 호출 수 비교

아래는 테스트 계수기로 측정한 애플리케이션 문서 접근/요청 수다. Firebase Enterprise의 실제 청구 Units나 운영 절감률이 아니다.

| 시나리오 | 전 | 후 | 방법 |
| --- | --- | --- | --- |
| 소유방 2개와 초대방 3개가 겹치는 방 목록 | 8 문서 접근 | 6 | 동일 fixture를 코드 수정 전후 실행 |
| 위 방 목록 + 초대 목록을 함께 반환하는 소셜 요청 | 12 | 7 | 동일 fixture를 코드 수정 전후 실행 |
| 통계 화면 최초 로드 + word checkpoint 갱신 5회, 두 랭킹 각 50행 | 624 | 109 | 실제 loadVisibleData를 VM에서 실행; 이전 전체 버전 정책과 새 정책 비교 |
| 위 화면에서 이후 종료 정산 | 104 | 104 | 종료 버전 변경 후 모든 대상 다시 조회 확인 |
| 동일 학교 요청 동시 2개 + 같은 달 달력 조회 | 3 callable 경로 | 1 callable | 변경 전 경로의 정적 산정 / 변경 후 VM 호출 계수 |
| Flash 예약 / Argon 후속 예약 | 2 문서 읽기 | 1 | 이전 getAll 인자 정적 확인 / 변경 후 실제 reserve 함수 VM 계수 |
| Argon 첫 예약 | 2 | 2 | 변경 후 VM 계수 및 기존 일일 제한 회귀 |
| 없는 목표/과목 삭제 | 각 1 쓰기 | 0 | 이전 update 경로 정적 확인 / 변경 후 transaction mock 계수 |

방의 getAll은 중복 문서를 빼는 효과와 별개로 직렬 왕복을 줄인다. 미조회 문서 자체의 읽기 과금이 없어지는 것은 아니다. 같은 표시명 쓰기는 최대 프로필 1개와 랭킹 2개를 생략할 수 있으나 실제 사용자 빈도는 미측정이다.

## 검증

- `npm run test:unit`: **201개 통과, 실패 0**. 새 최적화 테스트 8개 포함. 원본 로그: `.codex-optimization-unit.log`.
- Auth/Firestore Enterprise 에뮬레이터 전체 통합: **51개 통과, 실패 0**. 인증·학교 접근·예산 동시성·만료·카메라/단어앱 인계·방 동시성·실시간 상태 포함. 로그: `.codex-optimization-emulator-verified.log`.
- 마지막 입력 검증 순서 변경 이후 인증·카메라 소유권·영단어 체크포인트/종료 버전 통합 검증 **3개 추가 통과**. 로그: `.codex-optimization-final-regression.log`. 실행기 인용 문제와 잔류 포트 충돌을 해결한 최종 실행 결과이며, 전체 51개 결과와 별도로 기록한다.
- 소스 diff 공백 검사는 CRLF를 허용하는 `git -c core.whitespace=cr-at-eol diff --check`로 확인한다.

## 남은 항목과 추정 한계

- O2 정상 heartbeat 읽기 통합, O3 방 쓰기 통합, O6 레거시 감사 주기, O8 리스너 변경, O11 인덱스/문서 분리는 운영 지표와 추가 경쟁조건 검증 후 진행한다.
- O5 리포트는 완료 합계 외에도 7일 통계와 활성 표시를 반환한다. 전체 revision을 단순 제거하면 자정 교차 중 영단어의 이전 날짜 통계가 늦게 반영될 수 있어 이번 구현에서 제외했다.
- O7 강제 인증 갱신, O10 중간 usage 제거, O12 목표 도구 transaction 통합도 이번 배포에 포함하지 않는다.
- 운영 문서 크기, 실제 word heartbeat 간격, 동시 사용자 수, cache hit 비율, transaction 재시도·청구 Units는 미측정이다. 시간당/월별 비용 절감은 **추정 가능성**이며 확정 금액·비율을 주장하지 않는다. 위 수치는 고정 fixture에 한정된다.
- 서버를 먼저 배포하고 GitHub main/Pages로 정적 파일을 배포한다.

## 배포

- 운영 프로젝트 `study-junhyuk1203-20261021` / `asia-northeast3`의 함수 8개 업데이트 성공: getStudySocial, syncWordStudy, updateAccount, updateStudyPlan, chatWithStudy, getStudyBriefing, syncStudyCamera, heartbeatStudySession. Firebase CLI 종료 코드 0, `Deploy complete!` 확인. 로그: `.codex-optimization-deploy.log`.
- 정적 앱은 GitHub `JunHyuk1203/study`의 기존 `main`/Pages 배포 경로를 사용한다. 앱과 공유 모듈의 버전은 `20261024-1`이다. Firebase Hosting·보안 규칙·인덱스 배포는 수행하지 않는다.
