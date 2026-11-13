# 측정: R-562 웹 첫 JS·월렛 Lighthouse

- 날짜: 2026-11-14
- 가지: `fix/wallet-budget-2026-11-14`(기준 `origin/develop` `399f073c`)
- 명령:
  - `pnpm --filter @peaket/web build`
  - `pnpm run budgets` (`tools/web-checks`)
- 정본 예산: `docs/frontend.md` §5.8. 수치는 바꾸지 않았다. 한도는 기존 기준선 + 1kB(§5.8 `js.spec.mjs`)다.

## 첫 화면 JS(gzip, kB)

| 경로 | 전 | 후 | 한도 | 판정 |
| --- | ---: | ---: | ---: | --- |
| `/` | 177.8 | **175.6** | 175.7 | 통과 |
| `/my/tickets` | 208.1 | **161.6** | 161.6 | 통과(경계) |

## 월렛 Lighthouse(모바일 기본, 3회 중앙값)

| 지표 | 전 | 후 | 한도 | 판정 |
| --- | ---: | ---: | ---: | --- |
| CLS | 0.129 | **0.042** | 0.1 | 통과 |
| LCP | — | **4,809ms** | 7,255ms | 통과 |
| TBT | — | **32ms** | 200ms | 통과 |

- 회차: LCP 4,809.7 / 4,510.7 / 4,809.3ms, CLS 0.0423 / 0.0426 / 0.0421, TBT 32 / 28.5 / 35.5ms
- `pnpm run budgets`: **24/24 통과**
- 웹 단위: 833 통과. typecheck·lint·doc-check·records `--check` 통과.

## 원인과 조치

- `RootDocument`의 정적 `SerwistProvider`가 모든 경로 첫 JS에 들어갔다. 루트에서 빼고 월렛 화면이 마운트된 뒤 `import('@serwist/turbopack/react')`로 등록한다.
- `DeviceQr`·`qrcode`·Dexie·오프라인 배너가 월렛 첫 묶음에 있었다. `import()`와 상태 로딩으로 빼고, 첫 HTML에는 같은 높이(400px)의 등록 안내를 그려 LCP를 앞당겼다.
- QR 로딩 카드·등록 안내 카드·QR 상태의 높이가 달라 CLS가 났다. `DeviceQr`의 모든 상태를 400px로 맞추고, 오프라인 배너 자리를 40px로 고정했다.
- 서비스 워커가 동적 QR 조각을 모르면 첫 방문 뒤 오프라인 새로고침에서 빠진다. 워커 등록 뒤 받은 스크립트를 `CACHE_URLS`로 캐시한다.
- 인앱 브라우저 UA 판별과 프로덕션 미리보기 전환기는 필요할 때만 싣는다.
