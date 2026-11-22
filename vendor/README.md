# vendor

세워 두기(카메라) 모드에 쓰는 외부 파일이에요. CDN에서 받지 않고 이 저장소에서 같이 배포해요.
`sw.js`가 처음 쓸 때 받아서 캐시해 두기 때문에 그 뒤로는 오프라인에서도 돌아가요.
경로에 버전이 들어 있어서 파일을 바꿀 때는 폴더 이름과 `sw.js`의 `VENDOR_CACHE`를 같이 바꿔요.

| 폴더 | 무엇 | 출처 | 라이선스 |
|---|---|---|---|
| `mediapipe-1.2.2/vision_bundle.mjs` | MediaPipe Tasks Vision JS | npm `@mediapipe/tasks-vision@1.2.2` | Apache-2.0 (`mediapipe-1.2.2/LICENSE`) |
| `mediapipe-1.2.2/wasm/` | 같은 패키지의 `vision_wasm_internal.js/.wasm` | 위와 같음 | Apache-2.0 |
| `mediapipe-1.2.2/models/blaze_face_short_range.tflite` | 얼굴 감지 모델 | `storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/` | Apache-2.0 (MediaPipe 모델 카드) |
| `mediapipe-1.2.2/models/face_landmarker.task` | 얼굴 랜드마크·눈 감음 점수 모델 (졸면 멈추기) | `storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/` | Apache-2.0 (MediaPipe 모델 카드) |
| `mp4-muxer-5.2.2/mp4-muxer.js` | WebCodecs 출력을 mp4로 묶는 먹서 | npm `mp4-muxer@5.2.2` `build/mp4-muxer.js` | MIT (`mp4-muxer-5.2.2/LICENSE`) |

## vision_bundle.mjs를 고친 곳

원본은 모든 작업(FaceDetector, FaceLandmarker)마다 사용 통계를 1분에 한 번 `https://odml.pa.googleapis.com/v1/log`로 보내요.
끄는 옵션이 없어서 두 군데를 고쳤어요. 나머지는 원본 그대로예요.

1. 통계 전송기(`Ih` 클래스) 생성자에서 1분 타이머를 만들지 않고 처음부터 오류 상태로 둬요. 그러면 기록을 쌓지도 보내지도 않아요.
   - 원본: `this.h=setInterval(()=>{this.flush()},6e4)`
   - 바꾼 것: `this.error=Error("usage logging disabled")`
2. 전송 주소 문자열을 `data:,`로 바꿨어요.

`index.html`의 Content-Security-Policy도 `connect-src`를 이 사이트와 구글 폰트로만 막아 두어서, 위 패치가 빠지더라도 브라우저가 전송을 막아요.
버전을 올릴 때는 새 번들에서 같은 코드를 찾아 똑같이 고쳐야 해요.
