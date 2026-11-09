# tools/web-checks — 화면 빌드 산출물을 실제 브라우저로 보는 검사

빌드한 화면을 Playwright로 열어 보는 검사 둘이다. 시험 ID와 통과 기준은 [docs/frontend.md](../../docs/frontend.md) §5.17이 정본이다(BUILD_ORDER BAS-170).

- **FE-T36 SEED CSS 층 검사**(`seed-css/`): 앱 다섯(웹·파트너·관제·스캐너·포렌식)을 `PEAKET_POC=seed-css`로 운영 빌드하면 탐침 화면(`packages/ds/src/poc/SeedLayerProbe.tsx`)이 함께 묶인다. 첫 화면 HTML이 싣는 CSS로 ① 층 차례 ② SEED 규칙이 SEED 층 안에 있는지 ③ SEED 전체 CSS가 없는지와 크기를 보고, 탐침 화면의 계산된 스타일로 ④ Tailwind 유틸이 SEED 부품을 이기고 Tailwind 초기화가 SEED 부품을 덮지 않는지를 세 엔진에서 본다. PoC 결과는 [seed-css/RESULT.md](seed-css/RESULT.md)다.
- **K5 PoC 5만 석 Canvas**(`seatmap/`, BUILD_ORDER BAS-190): 5만 석 열 단위 좌석맵 파일을 만들어(`layout.mjs`) PoC 페이지가 Worker의 OffscreenCanvas로 풀고 그린다. docs/frontend.md §5.2 예산을 K5 랩 조건(Chromium CPU 4배)에서 보고, 다른 엔진은 기록만 한다. 결과는 [seatmap/RESULT.md](seatmap/RESULT.md)다. CI에서는 돌지 않는다(설계를 고르는 PoC. 결과 측정은 wbs 7.5.2의 FE-T10).
- **대기실 T=0 세 엔진 검사**(`queue-room/`, BUILD_ORDER HOT-347, ADR-0217): 운영 빌드에 출처만 검사용 가짜 API(4011)로 바꾼 대기실 검사 빌드(`node queue-room/build.mjs` → `apps/web/queue-room/dist-check`)를 같은 출처 검사 틀(`lib/same-origin.mjs`, 4130)로 띄워 FE-T3(T=0 두 호출과 대기열 파일 GET의 사전 요청 0)·FE-T15(`AbortSignal.any`가 없는 페이지의 시간 초과·화면 떠남)·FE-T4(폴링 간격·숨긴 탭 최소 간격·200의 `Retry-After` 무시·셔플 고정 지연)와 FE-T6(`tabs.spec.mjs`: 한 문맥의 탭 셋으로 리더 하나·숨긴 뒤 넘김·모두 숨김·방송 끊김·숨긴 채 차례, ADR-0218)을 Chromium·WebKit·Firefox로 본다. 요청은 가짜 API의 검사 기록(`GET /__mock/requests`)으로 센다(Playwright가 가로챈 경로의 사전 요청에 스스로 답해 `page.route`를 쓰지 않는다). 실행: `pnpm run queue-room:build` 뒤 `pnpm run queue-room`.
- **구매 세션 서명기 세 엔진 검사**(`purchase/`, BUILD_ORDER HOT-360 ①, ADR-0221 결정 7): 빌드 없이 `purchase/server.mjs`(4220)가 `packages/api-client/src/purchase` 원본을 Node 타입 지우기로 내준다. Chromium·WebKit·Firefox에서 FE-T7(서버와 같은 시험 벡터 `docs/api/vectors/`, 키 합의 왕복의 MAC을 시험이 node:crypto로 따로 확인, IndexedDB에 둔 추출 불가 키로 다시 연 페이지의 MAC·내보내기 거절, 같은 문맥 두 탭의 동시 쓰기에서 서버가 받은 일련번호 차례)을 본다. `pnpm run purchase`, 기준 판정은 `node lib/docker.mjs purchase`
- **FE-T40 시각 회귀**(`visual/`): 대기실 경량 페이지 셸의 네 상태 × 라이트·다크를 Chromium·WebKit으로 찍어 저장소의 기준 이미지(`visual/__screenshots__/`)와 견준다. React 대기 패널(CMP-015 QueuePanel)은 Storybook 이야기에서 React가 그린 패널 마크업을 셸 화면의 패널 자리에 넣어 같은 기준 이미지(`queue-panel-*`)와 견준다(`queue-panel.spec.mjs`, ADR-0220). 기준 이미지는 셸 시험만 만들고, React 시험은 다시 찍는 실행(`--update-snapshots`)에서 건너뛴다. 셸은 데이터에 이었으므로(ADR-0207) 대기열·공연 공개 요약 호출을 가로채 실제 상태 기계로 네 상태를 만든다. 기준 이미지는 CI와 같은 Playwright 컨테이너(`lib/docker.mjs`의 `IMAGE`, 다이제스트 고정)에서만 찍는다.

뿌리 작업 공간과 따로 둔 작업 공간이다(자기 `pnpm-lock.yaml`, 보안 설정은 뿌리와 같다, docs/devops.md §4.4). 검사할 앱은 뿌리 작업 공간에서 빌드한다.

```bash
cd tools/web-checks
pnpm install --frozen-lockfile
pnpm test                                   # 검사기·서버·정본 읽기 단위 시험(node --test)
node seed-css/build.mjs                     # 앱 다섯 PoC 빌드(뿌리 작업 공간에 의존성이 있어야 한다)
pnpm run seed-css                           # FE-T36(서버는 설정이 띄운다). 크기 표: node seed-css/report.mjs
pnpm --filter @peaket/queue-room build      # (뿌리에서) 대기실 셸 빌드
node lib/docker.mjs visual                  # FE-T40을 컨테이너에서. 기준 이미지를 바꿀 때만 --update-snapshots
node lib/docker.mjs seatmap                 # K5 PoC를 컨테이너의 세 엔진으로(이 PC Chromium만: pnpm exec playwright test -c playwright.seatmap.config.mjs)
node lib/docker.mjs rich-text               # FE-T41을 컨테이너의 세 엔진으로(파트너 PoC 서버 4122를 이 PC에서 먼저, rich-text/RESULT.md)
node lib/docker.mjs purchase                # FE-T7 구매 세션 서명기를 컨테이너의 세 엔진으로(이 PC: PEAKET_FIREFOX=system pnpm run purchase)
```

- 이 PC(Windows)의 Firefox는 Playwright 1.64.1 판이 side-by-side 구성 오류(`mozglue` 어셈블리를 찾지 못함)로 뜨지 않는다(2026-11-04). 길이 둘이다.
  - ① CI와 같은 판: `node seed-css/serve-all.mjs`로 서버를 띄워 두고 `node lib/docker.mjs layers`처럼 컨테이너 안 세 엔진이 `host.docker.internal`의 서버를 보게 한다.
  - ② 설치한 정식 Firefox: `PEAKET_FIREFOX=system`을 주면 Firefox 프로젝트가 정식 Firefox를 WebDriver BiDi(표준 원격 조종)로 띄운다(`lib/firefox.mjs`, 2026-11-05). Playwright 1.64.1의 BiDi는 다크 모드 흉내(`colorScheme`)와 보낸 요청의 본문(`postData`)을 주지 않아, 그 단언만 건너뛰고 시험에 까닭을 남긴다.
  - 결과를 적을 때는 어느 길로 쟀는지 적는다. Docker 디스크가 차서 컨테이너를 못 띄울 때도 ②로 본다.
- 리눅스 Docker Engine에서는 `host.docker.internal`이 다리 주소라 127.0.0.1에 붙은 정적 서버에 닿지 않는다. `node seed-css/serve-all.mjs --host 0.0.0.0`(또는 `PEAKET_SERVE_HOST=0.0.0.0`)으로 띄운다(Docker Desktop은 기본값으로 닿는다). 서버를 끌 때(Ctrl+C) 셸 아래 서버까지 끈다(Windows `taskkill /T /F`, 그 밖은 프로세스 묶음).
- 성능 예산 기록의 표: `node budgets/report.mjs [--reports <폴더>]`(첫 JS·Lighthouse, Markdown을 표준 출력으로).
- 시각 회귀 설정은 리눅스가 아니면 멈춘다(그리기가 달라 늘 실패한다). 연습으로만 돌릴 때는 `PEAKET_VISUAL_ANY_OS=1`.
- 기준 이미지를 바꾸면 PR에서 그림 차이를 보고 승인한다(FE-T40). 토큰이나 `@peaket/ds`를 바꾼 PR은 CI 화면 잡의 `visual`이 반드시 돈다(docs/devops.md §3.1 `ci-web.yml`).
- 크기는 docs/frontend.md §5.8 CSS 열의 예산(kB = 1,000바이트)과 견준다. 예산을 넘은 경로는 [seed-css/css-baseline.json](seed-css/css-baseline.json)의 값 + 0.5kB를 넘지 않게만 막는다. 줄면 그 값을 낮춘다.

| 파일 | 하는 일 |
| --- | --- |
| `seed-css/check-css.mjs` | CSS 층 검사기(층 이름과 규칙마다 든 층 읽기, ①②③, gzip 크기, 크기 한도) |
| `seed-css/apps.mjs` | 앱 다섯의 포트·탐침·경로와 §5.8 경로 묶음 이름, 서버 명령, 스타일시트 링크 뽑기. 소비자 웹 서버는 계약 모양 가짜 API(`MOCK_API`, 127.0.0.1:4010, ADR-0199 결정 2)를 서버 쪽 원본으로 부르고(홈 피드·공연 상세, HOT-311), 설정들이 가짜 API를 먼저 띄운다 |
| `seed-css/build.mjs`·`serve-all.mjs`·`report.mjs` | PoC 빌드, 서버 다섯 띄우기, 크기 표(`--baseline`이면 기준선 다시 쓰기) |
| `seed-css/css.spec.mjs`·`layers.spec.mjs` | FE-T36 ①②③·크기(브라우저 없이), ④(세 엔진) |
| `visual/queue-room.spec.mjs` | FE-T40 대기실 셸 |
| `purchase/server.mjs`·`purchase/signer.spec.mjs` | FE-T7 구매 세션 서명기 세 엔진(원본을 타입만 지워 내는 서버, 받은 일련번호 차례를 적는 `/sink`) |
| `lib/canon.mjs` | 정본에서 읽는 값(§5.8 CSS 예산, tokens.json 의미 색) |
| `lib/serve.mjs` | 의존성 없는 정적 서버(대기실 배포 흉내 `--preset queue-room`, 단일 페이지 대체, 붙을 주소 `--host`·`PEAKET_SERVE_HOST`, 미리 압축한 `<파일>.br` 전송, `--cache-control`) |
| `lib/docker.mjs` | 판을 고정한 Playwright 컨테이너에서 검사 돌리기(pnpm 판은 이 패키지 `packageManager`에서 읽는다) |
| `lib/firefox.mjs` | 설정들의 Firefox 프로젝트 값(기본은 Playwright 판, `PEAKET_FIREFOX=system`이면 설치한 정식 Firefox를 BiDi로, BiDi 한계 판정) |
| `budgets/report.mjs` | 성능 예산 기록(`reports/sizes-js/`·`reports/lighthouse/`)을 Markdown 표로 |
| `seatmap/judge.mjs` | K5 PoC 판정 어림(CPU 느리게 하기가 걸리지 않는 Worker 몫에 배수 곱하기) |
