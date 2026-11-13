# BAT-350 GAT-010 heavy gate (2026-11-14, R-554)

## 1. rebase

- 가지: `wave/lane1-BAT-350`
- 기준: `origin/develop` `9c3cba5b`(R-557 웹 예산 hotfix)
- `955cc600`을 `9c3cba5b` 위로 rebase했다. `pnpm-lock.yaml` 충돌은 develop 쪽 잠금 파일을 받은 뒤 `pnpm install`로 BAT-350 의존성(dexie·qrcode·serwist·@serwist/turbopack·esbuild·fake-indexeddb)을 다시 넣어 풀었다. R-554 유지.
- 최종 커밋 해시는 완료 보고에 적는다. 합치기·푸시 없음.

## 2. 브라우저 확인

운영 빌드(`next build` → `node server/start.mjs --port 3100 --inner-port 3101`)에서 새 저장소 상태로 확인했다. 자세한 표는 `docs/review/browser-check/BAT-350.md`에 있다.

- 새 저장소: 키를 만들지 않고 '이 휴대폰을 입장용으로 등록' 안내.
- 등록: keyId `XLBMt79W8SU`, QR 41×41(1,681칸), `privateKey.extractable=false`, `publicKeyJwk.kty=EC`, `registration=LOCAL`.
- 15초 회전: 04:51:37 → 04:51:53, 행렬 해시 변경. 오프라인 05:03:12 → 05:03:28에도 회전.
- QR v1: 서명 대상 40바이트의 머리글자·UUIDv7·keyId·시각이 맞고, 64바이트 서명이 저장 공개키로 검증된다. 93바이트 base45 140자, EC M 41×41 영숫자 모드 행렬이 화면과 일치.
- 서비스 워커: 범위 `/my/tickets`, precache 112개(`/~offline`·`/my/tickets` 포함), `wallet-pages`에 티켓 상세, `/v1/` 캐시 없음.
- 오프라인: 서버를 내린 뒤 새로고침해도 캐시 셸·QR·기기 키가 유지되고 QR이 계속 회전. 오프라인 배너는 `navigator.onLine=false`+`offline` 이벤트로 확인.
- 찾아 고친 것: `NetworkFirst`가 원본/프록시 502를 그대로 반환해 오프라인 진입이 실패했다. `/my/tickets` 문서를 `StaleWhileRevalidate`+`rejectServerErrors`로 바꿨다. 서비스 워커 범위와 `Service-Worker-Allowed`를 `/my/tickets`로 좁혔다.

## 3. 변이(등급 B)

30개를 소스에 잠시 넣고 관련 시험을 돌린 뒤 원문으로 되돌렸다. 결과는 **30/30 잡힘, 놓침 0, 건너뜀 0**이다. 전체 표는 `.cache/bat350-mutations.md`(커밋하지 않음)에 있다.

- QR v1: 버전·티켓 ID·keyId·시각·서명 오프셋, 93바이트 길이, UUIDv7/변형 비트 검사, 머리글자, 빅엔디언
- base45: 알파벳·자리 순서, 3글자/2글자 상한, RFC 9285 표본
- keyId: SPKI SHA-256 앞 8바이트, SHA-1 치환, non-extractable
- 15초: 프레임 번호·지난 판정·프레임 시각
- Dexie: put→add, 빈 키 읽기/지우기, 동기화 시각, 기본 키
- Serwist: `/v1/` 제외, `NetworkOnly`, `/my/tickets` 경로, 범위 `/my/tickets`

## 4. 4관점 리뷰

| 관점 | 높음 | 중간 | 낮음 | 처리 |
| --- | --- | --- | --- | --- |
| 보안 | 0 | 2 | 2 | **중간: 서비스 워커 범위가 `/`로 너무 넓었다.** `/my/tickets`로 좁혔다. **중간: `Service-Worker-Allowed: /`가 필요한 범위보다 넓었다.** `/my/tickets`로 좁혔다. API `/v1/*`는 NetworkOnly라 캐시에 없다. 낮음: 기기 개인키는 `extractable=false`지만 IndexedDB에 남고 같은 출처 XSS는 서명을 부를 수 있다(기존 한계, CSP·텍스트 렌더링이 방어선), `@swc/core` 허용 목록 추가 |
| 정합 | 1 | 1 | 2 | **높음: 원본/프록시 502 때 `NetworkFirst`가 캐시 셸 대신 502를 반환해 오프라인 진입이 실패했다.** `StaleWhileRevalidate`+`rejectServerErrors`로 고쳤다. 중간: 런타임 캐시(`wallet-pages`·`wallet-assets`)에 판 번호가 없어 새 빌드의 옛 셸·청크가 섞일 수 있다(문서화·후속). 낮음: `wallet-dev` revision, EC M 기본값 |
| 시험 | 0 | 0 | 2 | 단위 833·ds 71·변이 30/30·브라우저 확인. 낮음: `pwa-config.test.mjs`의 `NetworkFirst` 금지가 다소 뻣뻣함, Dexie 시험은 가짜 개인키 객체를 쓴다(실제 CryptoKey는 브라우저 확인) |
| 운영 | 0 | 3 | 3 | 중간: `skipWaiting`·`clientsClaim`이 true라 새 판이 티켓 화면에 바로 적용될 수 있다(docs/frontend.md §2.7 후속). 중간: `v.noKey` 미리보기의 '등록' 버튼은 키를 만들지 않고 기본 상태로만 이동한다(실제 등록은 `DeviceQr`). 중간: `OfflineBanner`는 서버만 내려간 상태를 오프라인으로 보지 않는다. 낮음: `/~offline` 직접 탐색은 범위 밖, `resetAndRegister`는 LOCAL 키를 확인 없이 지운다, precache가 앱 전체 자산 2.4MB를 담는다 |

**높음 1(고침), 중간 6(2 고침, 4 문서화·후속), 낮음 9(0 고침, 9 후속).**

## 5. CI 로컬 등가

- apps/web 단위: **833건** 통과(새 QR v1 5건·clock 6건·Dexie 1건·PWA 배선 3건 포함).
- packages/ds 단위: **71건**, 토큰 check 통과.
- typecheck: apps/web·packages/ds 통과.
- lint: 뿌리 eslint 전체 통과.
- doc-check: 오류 0, 기존 경고 4.
- ledger: `--check` 통과(O-T13 자동 시험, O-T32·O-T33 다른 단계).
- trace-check: **O-T13 통과**(시험 5개 대조).
- records `--check`: 통과(기존 경고 R-374·R-473·R-545·R-550·R-557).
- contracts `gen:check`: 통과, contracts 시험 41건.
- api-client 시험: **113건** 통과.
- `next build`: 통과. `/serwist/sw.js`가 정적 경로로 만들어지고 109개 precache 항목을 확인했다.

## 6. 남은 문제

- ticket-svc `POST /v1/tickets/{ticketId}/device-keys`와 `device_key` 표가 없어 공개키 등록·폐기·스캐너 keyId 대조가 이어지지 않는다. 키는 `LOCAL`이고 서버 등록은 `NEXT_PUBLIC_WALLET_DEVICE_KEY_REGISTRATION=1`일 때만 시도한다.
- 새 판 적용(`skipWaiting`)·런타임 캐시 판 번호·새 판 안내.
- 데스크톱 안내의 '그래도 이 기기에 등록', `v.noKey` 미리보기 버튼.
- iOS 홈 화면 앱 저장소 유지 PoC(wbs 5.1.3·5.1.4), QR 오류 정정 수준 PoC.
- 서버 등록 뒤 키 폐기·재발급·양도·부스 흐름.

## 7. 정리

- 로컬 서버(3100·3101)를 내렸고, 확인에 쓴 브라우저 탭을 모두 닫았다.
- 변이 흔적은 커밋에 남기지 않았다. `.cache/bat350-mutations.md`는 커밋하지 않는다.
