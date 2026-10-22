# 단어앱 학습시간 연동

`word` 프로젝트: `C:/Users/tntdr/.gemini/antigravity-ide/scratch/superword`.

- 단어 카드·쇼츠·테스트 화면에서 자동 시작한다. 플래시카드·객관식·주관식·따라쓰기 테스트도 모두 합산한다. 편집·설정·기록·테스트 결과 화면 또는 10초 무입력 시 시간을 보존한 채 일시정지하고, 학습 화면에서 다시 입력하면 재개한다. 백그라운드·페이지 종료·로그아웃에서는 저장 후 종료한다. 상단 캡슐은 오늘 누적시간을 표시하므로 새 세션에서도 초기화되지 않는다.
- 설정 왼쪽 기록 버튼에서 오늘·이번 주·날짜별 시간을 본다. 한국 날짜 기준이며 최근 학습 500회를 집계한다.
- 단어앱 자체 기록은 단어앱 계정의 `users/{uid}/learningSessions/{id}`에 저장한다. 로컬 대기열을 먼저 기록하고 오프라인 저장은 다음 연결 시 재시도한다. 기기 기록과 서버 기록은 ID로 병합한다.
- 스터디 연동은 별도 이름의 Firebase 앱에서 기존 스터디 이메일 또는 Google 계정으로 로그인한다. 단어앱 로그인과 독립적이다. 연동 전 기록은 소급 적립하지 않는다.
- 스터디는 `startWordStudy` / `syncWordStudy` / `finishStudySession`을 사용한다. 영단어 과목을 재사용하거나 추가하며, 서버가 관측한 30초 유효 구간만 적립한다. 20초마다 갱신한다.
- 얼굴인식 학습 중 SP word를 열면 카메라 세션을 유지한다. SP word가 실제로 시간을 적립할 때만 서버 트랜잭션으로 카메라를 체크포인트 후 정지하고 `SP word 사용 중`을 표시한다. 10초 정지·메뉴·설정에서는 카메라가 다시 적립 가능하며, 실제 얼굴 인식·수동 일시정지 상태를 따른다. 연동된 SP word 창이 살아 있는 동안에는 스터디 탭이 뒤에 있어도 얼굴 감지를 허용하며, 영상은 기기 내에서만 처리한다.
- SP word는 `visibilitychange`와 창 `focus`/`blur`를 함께 확인한다. 다른 탭·창으로 전환하면 즉시 측정과 서버 presence를 종료한다. 얼굴인식과 단어 시간은 서버에서 상호 배제하며 한 구간을 두 번 적립하지 않는다.
- 종료 요청 실패에 대비해 `closeExpiredWordStudies`가 5분마다 만료된 전용 lease를 정리한다. 정리 시점에 세션 lease를 트랜잭션에서 재검증한다. 일반 종료와 재시도는 동일 세션 ID로 중복 집계를 막는다.
- 단어앱 자체 기록은 개인 기록이며 스터디 서버는 이 값을 보상·랭킹 적립의 근거로 사용하지 않는다.
- 연동 중 캡슐과 기록 화면은 스터디 서버의 영단어 과목 기록을 사용한다. 기기 자체 기록은 별도 버튼으로 확인하며, 연동 전·오프라인 기록을 소급하여 스터디에 적립하지 않는다. 스터디도 동일한 서버 체크포인트에서 진행 중인 시간을 표시한다.
- 서버는 20초 체크포인트마다 일·주·월 집계를 새로 발생한 초만큼 갱신한다. 종료 시 이미 집계한 시간은 다시 더하지 않는다. 완료 통계·보상·랭킹은 종료 시 한 번 확정한다.

## 적용 및 배포

두 프로젝트의 변경을 함께 배포해야 서비스에서 동작한다.

1. 스터디 Functions: `startWordStudy`, `syncWordStudy`, `closeExpiredWordStudies`, 변경한 `finishStudySession`.
2. 스터디 웹: `study.html`, `data.js`.
3. 단어앱 Firestore rules와 웹 파일: `index.html`, `study-integration.js`, `study-timer-core.js`, `study-integration.css`.
4. 단어앱이 제공되는 호스트가 스터디 Auth 승인 도메인에 있어야 한다. 현재 설정에 `junhyuk1203.github.io`와 localhost가 포함되어 있다. Android WebView에서는 이메일 연결을 사용할 수 있다.

웹에서는 자동으로 종료 요청을 보내지만 운영체제가 프로세스를 강제 종료하면 요청 자체가 실행되지 않을 수 있다. 스터디는 서버 lease 만료와 주기 정리로 종료하며 마지막 갱신 이후 최대 30초까지만 적립한다. 단어앱 자체 기록은 마지막으로 기기에 저장한 시점까지 복구한다.

## 검증

스터디: `npm run test:unit`, `npm run test:firebase`.

단어앱: `node --test tests/study-timer.test.mjs`, `npm run test:rules`. Playwright를 NODE_PATH에 지정한 환경에서 `node tests/study-integration-ui.cjs`로 모바일/데스크톱 화면과 자동 시작·종료·기록 집계를 검증한다.
