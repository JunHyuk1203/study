# iOS 카메라 엔진 초기화 수정

## 확인한 경로와 수정

- MediaPipe 0.10.21의 Safari 기본 캔버스 선택은 Worker에서도 `document.createElement`로 들어갈 수 있다. Worker에는 `document`가 없다. Face/Pose/Hand와 얼굴 확대 모델에 각각 명시적인 OffscreenCanvas를 전달해 이 분기를 건너뛴다. [동일한 MediaPipe 이슈](https://github.com/google-ai-edge/mediapipe/issues/5292).
- 사용하던 ONNX Runtime 1.22.0 `ort.min.js`는 CPU 세션에서도 JSEP WASM을 선택하며 WebKit의 큰 메모리 사용 문제가 보고돼 있다. 사용자 기기의 메모리 실패를 직접 확인한 것은 아니지만, 불필요한 이 경로를 제거하기 위해 `ort.wasm.min.js`와 일치하는 WASM 파일만 로드한다. 단일 스레드, 중첩 proxy Worker 비활성화를 명시한다. [ONNX Runtime 보고](https://github.com/microsoft/onnxruntime/issues/33516).
- iPhone/iPod/iPad와 데스크톱 형태 UA의 iPadOS(`MacIntel` + 터치)를 감지해 처음부터 YOLOv10n을 선택한다. YOLOv10s를 먼저 할당했다가 재시도하지 않는다. 초기화 대기는 iOS에서 120초, 기존 데스크톱에서 60초다.
- Worker 캔버스를 제공하지 않는 브라우저는 모델을 여러 번 로드하지 않고 지원되지 않는 브라우저임을 안내한다. 모델·폰 확정 기준을 낮추거나 인식 없이 학습 시간을 적립하지 않는다.
- 초기화 오류에는 세부 단계와 로컬 stack을 포함해 진단할 수 있게 했다. 원본 카메라 영상은 저장·외부 전송하지 않는다.

## 검증

- 카메라 관련 Node 테스트 112개 통과. iPhone Safari/Chrome UA, iPadOS UA, Mac 구분, 최초 경량 선택, 120초 대기, 지원되지 않는 브라우저의 명시적 안내, 모델별 별도 캔버스 전달을 포함한다.
- `node scripts/test-camera-browser.mjs --ios-profile --models-only --phone-fixture --phone-sequence`: 종료 코드 0. Chromium에 iPhone/Safari UA를 적용한 실제 MediaPipe·TensorFlow·ONNX·경량 YOLO 초기화와 12프레임 폰 확정이 통과했다. 물리 iPhone 검증으로 취급하지 않는다.
- `node scripts/test-camera-browser.mjs --webkit --runtime-only`: 종료 코드 0. 실제 WebKit Worker에서 CPU 전용 WASM으로 검증된 YOLOv10n 가중치를 로드하고 `[1,300,6]` 출력을 얻은 뒤 세션을 해제했다. 추론은 694ms였다.
- Windows용 WebKit 테스트 포트에는 페이지와 Worker의 OffscreenCanvas가 없었다. 따라서 `--webkit --models-only`의 전체 MediaPipe 실행은 검증할 수 없었다. 이 제한을 실제 iOS의 지원 범위나 전체 파이프라인 성공으로 바꾸어 보고하지 않는다.
- 기존 Edge 종합 검사도 종료 코드 0. 표준/경량 모델, 가상 카메라의 등록 대기·백그라운드 복귀·종료 정리, 390px/1280px 화면을 통과했다.
- 전체 단위 테스트 275개 중 272개 통과. 기존 서버 연결 오류 문구 기대값 테스트 3건만 실패한다. 카메라 관련 테스트는 모두 통과했고 공유 모듈 중복 검사와 공백 검사도 통과했다. 런타임 캐시 버전은 `20261025-5`다.

실제 iOS 버전·기기·브라우저의 재확인은 필요하다. Safari 16.4는 OffscreenCanvas의 2D 지원만 도입했으므로 캔버스 API 존재만으로 모든 구버전의 MediaPipe 호환성을 보장하지 않는다. [Apple Safari 16.4 릴리스 노트](https://developer.apple.com/documentation/safari-release-notes/safari-16_4-release-notes).
