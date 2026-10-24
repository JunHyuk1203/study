# 카메라·SP word 동기화 수정 결과

2026-10-24 KST. `camera-spword-sync-improvements-2026-10-24.md`의 F01–F10 범위만 수정했다. 아래는 배포 전 구현·검증 기록이다. 이후 사용자가 두 저장소의 GitHub main 업로드와 Firebase 서버 배포를 승인했다.

STUDY는 현재 저장소를 수정했다. 별도 superword 저장소는 사용자의 요청에 따라 아래에 복제해 수정했다.

`C:\Users\tntdr\OneDrive\문서\ChatGPT\study\.codex-superword-sync`

## 반영 내용

| ID | 반영 |
|---|---|
| F01 | 카메라 상태 전환 대기열, 동일 이벤트 재시도, eventId 중복 처리, 역순 sequence 거절, 세션 교체 시 대기열 폐기. 반복 거절은 backoff한다. |
| F02 | superword의 단일 drain Promise가 start/sync 및 후속 finish를 함께 기다린다. 저장 실패는 명시적인 pending 결과와 복구 record를 남긴다. 계정 epoch·타이머 인스턴스를 캡처하고 이전 계정 종료가 확인된 뒤 새 타이머를 만든다. 팝업은 클릭 안에서 계속 열며, 이전 User 객체의 갱신된 인증으로 이전 기록을 종료한다. |
| F03 | 체크포인트에 canResume·terminalReason을 추가했다. 12시간 한도에서는 기존 기록을 확정하고 한 drain당 새 세션을 최대 한 번 생성한다. 구조화된 사유가 없는 재개 거절과 변경 없는 UI polling도 즉시 반복하지 않는다. 기기 자체 타이머도 12시간 이후 활성 구간을 열지 않는다. |
| F04 | 화면 시간은 confirmedMs와 provisionalMs를 분리하며, 새 유효 sequence의 서버 누적값으로 재기준을 잡는다. 예상 시간은 단조 시계와 서버 lease 안에서만 증가한다. |
| F05 | 객체 관측 id·시각·fresh·confidence·age를 전달한다. 휴대폰 정지는 독립 양성 관측 2회와 750ms 조건을 함께 요구한다. 새 음성 관측 및 오래된 관측은 양성 누적을 해제한다. |
| F06 | 단어 세션 생존 유예 45초와 적립 lease 10초를 분리했다. 카메라 정지 예약은 10초를 유지한다. 단어 heartbeat는 단조 시계의 송신 시각부터 계산하고 실패는 지수 backoff와 jitter를 적용한다. 복귀 시 카메라 정지와 단어 적립은 같은 트랜잭션에 남아 있다. |
| F07 | 카메라·단어 sync의 넓은 expireUserSessions 선행 조회를 제거하고 현재 세션 만료는 갱신 트랜잭션에서 검사한다. 시작·별도 복구·백그라운드 정리 경로는 유지한다. 단어 presence의 숫자 연장만으로 추가 카메라 전송을 만들지 않는다. 기존 동일 revision 조회 병합과 완료 전용 통계 캐시는 보존했다. |
| F08 | 얼굴 결과 반환과 객체 비동기 검사를 분리했다. TF 실행을 다음 task로 넘겨 현재 얼굴 결과를 먼저 반환한다. 손·자세는 400ms, 객체는 최소 800ms 간격이며, 복사한 픽셀을 사용해 Worker의 bitmap 종료와 충돌하지 않는다. 객체 실패는 얼굴을 중단하지 않는다. 모델별 지연과 객체 age를 진단 상태에 남기고 얼굴 기하에 종횡비를 보정했다. |
| F09 | 만료 정리는 100개씩 순차 페이지를 읽고 항목 오류를 격리한다. 실행당 20초·1000개 상한을 두며 처리·실패·갱신 수와 가장 오래된 잔여 만료 시각을 기록한다. 갱신 세션 재확인, 고아 lease 조건부 삭제, 오래된 lease 만료값 보정을 포함한다. |
| F10 | `docs/study-sync-contract.md`에 계약 버전·모드별 시간·재시도·만료·호환성 기준을 통합했다. 구형 prepareWordStudy와 기존 응답 필드를 보존하고 문서·상수 대조 테스트를 추가했다. 두 앱의 변경 모듈 URL 버전도 갱신했다. |

## 검증 결과

| 검증 | 결과 | 로그 |
|---|---|---|
| STUDY `npm run test:unit` | 212개 통과, 실패·취소·건너뜀 0 | `.codex-sync-unit-final.log` |
| Firebase Auth/Firestore 에뮬레이터 전체 통합 | 53개 통과, 실패·취소·건너뜀 0 | `.codex-sync-firebase-final.log` |
| 마지막 계약 응답 변경 후 카메라 전환·단어 지연·시간 한도·일반 heartbeat 추가 확인 | 4개 통과 | `.codex-sync-firebase-contract.log` |
| 마지막 정리 오류 지표 변경 후 `npm run test:sync` | 7개 통과 | `.codex-sync-targeted-final.log` |
| superword `npm run test:study` | 20개 통과, 실패·취소·건너뜀 0 | `.codex-sync-superword-unit.log` |
| superword 브라우저 통합 | 320·390·1280px 모두 통과, 페이지 오류 없음 | `.codex-sync-superword-ui-final.log` |
| 두 저장소 diff 공백 검사 | `git -c core.whitespace=cr-at-eol diff --check` 통과 | Windows CRLF 허용 |

회귀 검증에는 응답 대기 중 정지→재개→정지, 같은 이벤트 재시도, 중복·역순 요청, 종료 세션 재활성화 거절, 서버 시간 재보정, start/sync 중 finish 대기, 저장 실패 record 유지, 영구 재개 거절, 12시간 한도, 계정 교체 후 이전 인증으로 종료, 0.1/2/8/15초 지연 시 적립 상한, 새 음성 휴대폰 관측, 객체 검사 지연·실패, 종횡비 보정, 250개 만료 중 개별 실패·갱신 보존을 포함한다. 250개 정리 검증은 모의 DB 기반이다.

전체 Firebase 검증은 다음 명령으로 실행했다. 기본 포트 충돌을 피하려고 별도 로컬 설정을 사용했다.

```powershell
.\node_modules\.bin\firebase.cmd emulators:exec --config .codex-sync-firebase.json --project demo-study --only auth,firestore "node --test --test-concurrency=1 tests/firebase.test.mjs tests/room-live.test.mjs"
```

마지막 네 경로는 Windows 셸의 필터 해석을 피하도록 `node scripts/test-sync-contract.mjs`를 에뮬레이터 안에서 실행했다.

superword UI 검증은 번들 Playwright를 NODE_PATH로 지정하고 `node tests/study-integration-ui.cjs`를 실행했다. SDK·계정·네트워크는 테스트 fixture를 사용했으며 실제 계정의 상태를 변경하지 않았다.

이전 리뷰 및 `evidence/`의 원본 사본·진단은 수정 전 증거로 보존했다. 수정 전 문제를 기대하는 진단 스크립트 대신 위 제품 회귀 테스트를 현재 정상 동작 기준으로 사용한다.

## 남은 측정과 배포 조건

- 실제 모바일·세로 화면·안경·조명·독서 자세의 오탐률, 지연, 배터리는 측정하지 않았다. 같은 Worker의 TF 동기 계산이 후속 프레임을 지연시키는 정도와 객체 전용 Worker 필요 여부도 기기 측정 대상이다.
- 운영 환경 10명·50명 방의 문서 읽기/쓰기·트랜잭션 재시도·p95/p99, 실제 DB에서 250개 만료 처리시간은 측정하지 않았다. 방 데이터 구조와 함수 인스턴스·CPU·동시성은 이 결과 없이 변경하지 않았다.
- 서버 도착 전 실제 정지 시각은 소급 신뢰하지 않는다. 네트워크 도착 지연에 따른 오차가 남으며 새 서버 확인마다 화면이 확정값으로 보정될 수 있다.
- 배포 순서는 구형 클라이언트를 지원하는 서버 변경을 먼저 반영하고 두 앱을 갱신하는 방식이다. 대상은 STUDY의 학습 동기화 관련 함수 9개와 두 저장소의 main이며, superword 자체 AI 서버는 변경하지 않는다.

Gemini 보조 검토는 실행되지 않았다. 최초 시도는 CLI 인증·로그 접근 오류, 추가 시도는 저장소 diff·소스의 외부 전송 승인이 부족하다는 자동 승인 검토 거절로 중단했다. 해당 전송을 우회하지 않고 Codex가 직접 구현·검토·검증했다.
