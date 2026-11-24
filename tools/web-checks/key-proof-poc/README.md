# key-proof-poc — GAT-030 키 증명 PC 측정

F-05-1 gate의 GAT-030 가운데 PC 몫이다. 월렛이 지금 그리는 QR v1(93바이트·base45 140자)과 서버 서명 증명 110바이트 [가정]를 붙인 판(203바이트·305자)을 같은 화면 크기(390×844 화면의 90%, 351px)로 그려, 흐림·기울임·밝기 다섯 단계에서 스캐너가 쓰는 디코더로 1,000번씩 읽어 인식 시간 p50·p95와 실패율을 잰다. 결과 기록은 [docs/review/measurements/F-05-1-key-proof-poc.md](../../../docs/review/measurements/F-05-1-key-proof-poc.md)다.

## 실행

`tools/web-checks`는 뿌리와 따로 둔 작업 공간이다. 먼저 그 폴더에서 의존성을 받는다.

```bash
cd tools/web-checks
pnpm install --frozen-lockfile
node key-proof-poc/run.mjs                    # 1,000번 × 10칸, 워밍업 100번
node key-proof-poc/run.mjs --iterations 20 --warmup 5   # 하네스만 빠르게 확인
```

- 원자료: `reports/key-proof-poc.json`(git 무시). 표준 출력은 Markdown 표와 판정이다.
- 브라우저: Playwright Chromium. Windows Chromium·Chrome·Edge에는 `BarcodeDetector`(Shape Detection API)가 없어, 스캐너 어댑터(`apps/scanner/src/storage/decoder.ts`)를 만들지 못하면 **zxing-wasm 대체**로 잰다. 결과 JSON의 `environment.decoder.useDetector`가 거짓이면 그 실행은 스캐너 판과 같은 디코더가 아니다.
- `--headed`를 주면 브라우저 창을 띄운다.

## 구성

| 파일 | 하는 일 |
| --- | --- |
| `fixtures.mjs` | 월렛의 `qr-v1.ts`·`qr-matrix.ts`를 그대로 가져와 QR 두 판을 만든다. 증명 110바이트의 칸과 고정 대역 서명은 이 파일에 있다 |
| `levels.mjs` | 열화 단계 다섯, 백분위·요약, PC 판정 규칙(§9의 [가정]) |
| `page-runtime.js` | 브라우저 쪽: QR을 화면 폭 90%의 CSS 그리드로 그리고, 캡처한 카드에 캔버스 흐림·회전·밝기를 걸어 디코딩한다 |
| `run.mjs` | 실행기. 화면 390×844·deviceScaleFactor 1, 카드만 캡처, 판마다 5단계 × 1,000번, JSON·Markdown 출력 |
| `poc.test.mjs` | 도구 시험(길이·base45·같은 입력 같은 결과·판정 규칙). `node --test key-proof-poc/poc.test.mjs` |

## [가정]과 한계

- 증명 110바이트는 ADR-0051 결정 7의 "{티켓 ID, keyId, 공개키, 유효 기간, 서명}"을 이렇게 배치한 것이다: 형식 버전(1) ‖ keyId(8) ‖ 압축 공개키(33) ‖ 유효 기한(4) ‖ 서명(64). 티켓 ID는 QR v1 안에 있고 서명 대상에 들어간다. 실제 규격을 확정할 때 달라질 수 있다.
- 서명 64바이트는 디코딩 밀도만 재기 위한 고정 대역이다. 서명 검증은 이 측정 범위가 아니다.
- 흐림·기울임·밝기 값은 실제 카메라를 재서 고른 값이 아니라 [가정]이다. 원근 왜곡·초점 흔들림·화면 눈부심·센서 잡음·움직임은 넣지 않았다.
- 열화 다섯 단계는 함께 움직인다(흐림이 커지면 기울임도 커지고 밝기는 낮아진다). 어느 요인이 먼저 한계인지는 가리지 못한다.
- Windows Chromium에 `BarcodeDetector`가 없어 실제 측정은 zxing-wasm 3.1.7로 했다. 스캐너 판(BarcodeDetector)과 같은 디코더가 아니므로 절대 시간은 스캐너 기기로 옮겨 읽지 않는다. 두 QR 판의 상대 비교만 쓴다.
- QR은 카메라 영상이 아니라 브라우저가 그린 화면을 캡처한 것이다. 그래도 모듈 픽셀·조용한 여백·안티에일리어싱은 실제 월렛 화면과 같다.

## 더한 의존성

`tools/web-checks/package.json`에만 더했다(뿌리 작업 공간은 건드리지 않는다): `qrcode` 1.5.4(월렛과 같은 판), `zxing-wasm` 3.1.7(대체 디코더).
