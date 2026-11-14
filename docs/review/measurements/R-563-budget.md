# 측정: R-563 월렛 LCP 회귀(CI `web / budgets`)

- 날짜: 2026-11-14
- 가지: `fix/wallet-lcp-2026-11-14`(기준 `origin/develop` `12a832bc`)
- 명령:
  - `pnpm --filter @peaket/web build`
  - `PEAKET_WEB_CHECKS_HOST=host.docker.internal PEAKET_WEB_CHECKS_SERVERS=external pnpm exec playwright test -c playwright.budgets.config.mjs` (Playwright 1.64.1 컨테이너, `tools/web-checks/lib/docker.mjs`와 같은 이미지)
- 정본 예산: `docs/frontend.md` §5.8. 수치는 바꾸지 않았다.

## 문제

R-562를 합친 `12a832bc`의 CI 43523177652 `web / budgets`가 월렛 Lighthouse LCP로 빨갰다.

| 실행 | 월렛 LCP(3회 중앙값) | 한도 |
| --- | ---: | ---: |
| attempt 1 | 10,562ms | 7,255ms |
| attempt 2 | 10,691ms(10,691 / 11,088 / 10,298) | 7,255ms |

다른 주소는 기준선과 비슷했다(홈 6,326ms, 공연 상세 6,171ms, 결제 8,615ms, 좌석 9,480ms). 월렛만 84% 느려졌다. `web / ds`의 CMP-019 바깥 클릭 한 건은 재실행에서 통과한 플레이크다.

## 원인

1. R-562가 QR을 `import()`로 늦게 싣고 첫 HTML에는 글자만 있는 등록 안내 카드를 그렸다. 컨테이너 Chromium에서 그 `<p class="t-sm muted">`가 첫 LCP(10,430px²)였는데, 하이드레이션·글꼴 교체·실제 `DeviceQr` 카드 교체가 겹치는 약 8초에 같은 자리의 글자가 10,780px²로 다시 그려져 LCP가 8초로 밀렸다. 로컬 Windows Chromium은 글꼴·줄바꿈이 달라 이 갱신이 없어 4.8초로 보였다.
2. R-562가 넣은 `CACHE_URLS`가 월렛을 열 때마다 성능 자원의 `.js` 100여 개를 서비스 워커에 다시 캐시했다. 두 번째·세 번째 Lighthouse 실행에서 이 백그라운드 다운로드가 LCP 이미지와 네트워크를 다퉈 3회 중앙값이 8,042ms까지 올라갔다.

## 고친 것

- `Wallet.tsx`에 서버가 먼저 그리는 `DeviceQrFallback`을 두고, `DeviceQrLazy`에 `fallback` prop으로 넘겼다. QR 모양 뼈대 그림 `public/wallet-qr-skeleton.png`(312×156, 894B)과 실제 no-key 문구를 첫 HTML에 넣는다. 그림이 48,672px²로 가장 큰 LCP 후보라, 뒤에 글자가 바뀌어도 LCP가 8초로 갱신되지 않는다.
- `MyTicketsPage`에 `<link rel="preload" as="image" href="/wallet-qr-skeleton.png" fetchPriority="high">`, 그림에도 `fetchPriority="high"`를 붙였다.
- fallback을 클라이언트 번들에서 빼려고 서버 컴포넌트의 `ReactNode` prop으로 넘겼다. `/my/tickets` 첫 JS가 161.6kB 경계를 넘지 않게 하기 위해서다.
- `OfflineBanner`의 `CACHE_URLS` 메시지를 걷어냈다. 서비스 워커 precache manifest가 이미 118개 URL(청크 102개)을 캐시하므로 오프라인 새로고침은 그대로 동작한다(브라우저 확인 R-563).

## 결과

### 첫 JS(gzip, kB)

| 경로 | 전 | 후 | 한도 | 판정 |
| --- | ---: | ---: | ---: | --- |
| `/my/tickets` | 161.6 | **161.4** | 161.6 | 통과 |

### 월렛 Lighthouse(컨테이너, 3회 중앙값)

| 지표 | 전(CI) | 후 | 한도 | 판정 |
| --- | ---: | ---: | ---: | --- |
| LCP | 10,691ms | **6,236ms** | 7,255ms | 통과 |
| CLS | 0.042 | **0.042** | 0.1 | 통과 |
| TBT | 97ms | **74.5ms** | 200ms | 통과 |

- 후 3회: LCP 4,508.5 / 6,236.3 / 7,892.9ms, CLS 0.0421, TBT 44.5 / 74.5 / 90ms
- 컨테이너 전체 `playwright.budgets.config.mjs`: **24/24 통과**
- 첫 JS 검사: `web /my/tickets` 161.4kB로 통과

## 확인

- 웹 단위 **833 통과**(계약 `dist`를 다시 빌드한 뒤. 처음에는 오래된 `packages/contracts/dist` 때문에 mock-api 이미지 시험 1건이 실패했다).
- `tsc --noEmit`·`eslint`·`records --check`·`contracts gen:check`·api-client 113 통과.
- doc-check: 바꾼 문서에는 오류가 없다. 작업 폴더의 소유자 미추적 파일 `miro_dom_texts.json`(2건)·`video_details.json`(1건)의 12자리 숫자 오류 3건과 기존 경고 11건이 남는다(CI 깨끗한 체크아웃에는 없다).
- 브라우저 확인: 첫 HTML에 preload·뼈대 그림·no-key 문구가 있고, no-key 카드가 뜨며, 서비스 워커가 `/my/tickets` 범위에서 active·controlled이고, 오프라인 새로고침에서도 월렛·no-key·오프라인 배너가 남고 페이지 오류가 0이다. `docs/review/browser-check/R-563.md`.
