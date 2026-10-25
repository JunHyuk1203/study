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

## 해결되지 않았다는 후속 보고와 C6 변경

사용자가 사파리 27.2에서 여전히 같은 오류라고 보고했다. 앞선 수정으로 실제 기기 문제가 해결됐다고 확인되지 않았다. 원시 실패 메시지를 아직 받지 못했으므로 메모리·네트워크·저장소 중 어느 원인이라고 확정하지 않는다.

- iOS는 초기화 때 자세·손 보조 모델을 생성하지 않고 원거리 얼굴용 추가 모델도 생성하지 않는다. 얼굴·본인 확인·휴대폰 모델과 기존 정지 조건은 유지한다. 대신 손 기반 학습 동작 보조와 추가 원거리 얼굴 확대 검출은 이 모드에서 제공하지 않는다. 손이 없어도 전체 화면·타일 휴대폰 탐색은 계속한다.
- 초기화를 영상 파일·얼굴·자세·손·계산 백엔드·휴대폰·본인 확인·캔버스 단계로 분리해 Worker가 진행 단계를 전달한다.
- 최종 실패 안내에는 `C6-FACE-CANVAS`, `C6-PHONE-NETWORK`, `C6-IDENTITY-STORAGE` 같은 코드를 표시한다. 이는 메시지 기반 진단 분류이며 실제 원인에 대한 확정 판정은 아니다. 개발 감지 패널에는 길이를 제한한 원시 오류 문구를 텍스트로 표시해 기기에서 읽고 선택할 수 있다. 영상이나 얼굴 특징값은 포함하지 않는다.
- 캐시 버전은 `20261025-6`으로 올렸다. 구버전 HTML 캐시 구분을 위해 `study.html?camera=20261025-6` 진입 링크를 사용한다. 같은 일반 오류가 반복되더라도 새 코드가 보이는지로 빌드를 구분할 수 있다.
- iPhone UA의 실제 브라우저 모델 검사에서 자세·손 추론 0, 얼굴·본인 확인·폰 초기화, 휴대폰 12개 관측의 확정을 확인했다. 첫 폰 결과 547ms, 이후 약 363~378ms였으며 실제 iPhone의 성능 측정으로 보고하지 않는다.
- 카메라 테스트 114개 통과. 전체 테스트 277개 중 274개 통과이며 이전 서버 오류 문구 테스트 3건만 실패한다. 실제 사용자 기기의 오류 해결은 아직 확인되지 않았다.
- 데스크톱 종합 검사도 종료 코드 0. `--ios-profile --diagnostic-ui-only` 검사에서는 390px 화면에 단계 코드와 원시 오류 문구가 표시되고 텍스트 선택이 가능하며 가로 넘침이 없음을 확인했다.
