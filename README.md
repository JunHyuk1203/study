# STUDY.

UI.pdf를 바탕으로 만든 HTML/CSS/JavaScript 앱입니다. 상단바·하단 메뉴는 제자리에 두고 가운데 화면만 좌우로 이동합니다. 상단바는 아래로 스크롤할 때 숨겨집니다.

## 실행

`python -m http.server 5173 --bind 127.0.0.1` 실행 후 `http://127.0.0.1:5173/`을 여세요. 설치나 빌드는 필요 없습니다. 탭 전환과 Firebase 로그인은 HTTP/HTTPS 환경을 사용하세요.

홈 `index.html`, 학습 `study.html`, 학교 `school.html`, AI `ai.html`, 플레이 `play.html`, 계정 `account.html`, 로그인 `login.html`, 회원가입 `signup.html`, 비밀번호 재설정 `reset-password.html`로 구성됩니다.

## 연결된 기능

- 이메일 회원가입·로그인, Google 로그인, 로그아웃, 인증 메일, 비밀번호 재설정
- 계정 프로필 자동 생성, 이름·이메일·인증 여부 표시 및 닉네임 수정
- 과목별 공부 시작·종료, 새로고침 후 진행 중인 타이머 복원
- 일·주·월 공부시간, 과목별 통계, 최근 7일 그래프, 연속 학습 일수
- 주간 전체 랭킹 및 검증된 학교 소속이 있는 계정의 학교 랭킹
- 상단바·하단 메뉴 고정, 가운데 내용만 좌우 슬라이드

계정 정보와 학습 데이터는 Firebase Auth·Firestore·서울 리전의 서버 함수에 실제로 연결됩니다. 앱은 통계나 점수를 직접 쓰지 않고 서버에서 계산된 값을 실시간으로 구독합니다. 이메일 계정은 인증 후 학습 기록을 저장할 수 있습니다. Google 로그인 계정은 제공된 인증 상태를 사용합니다.

시간표·급식·AI·카메라·아바타·학교 소속 배정은 아직 실제 서비스와 연결하지 않았습니다. 시험 일정도 미등록 상태로 표시합니다.

사이트 파일은 GitHub로만 배포합니다. Firebase Hosting 배포는 하지 않았습니다. Firebase는 인증·DB·서버 함수에만 사용합니다. GitHub Pages를 이용한다면 브랜치를 `main`, 폴더를 `/ (root)`로 설정할 수 있습니다.

Firebase 프로젝트는 `study-junhyuk1203-20261021`, DB는 `study-data`(Enterprise Native, 서울 `asia-northeast3`)입니다. 상세 구조와 검증 방법은 [Firebase 안내](docs/firebase.md)를 참고하세요.
