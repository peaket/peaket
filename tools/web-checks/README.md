# tools/web-checks — 화면 빌드 산출물을 실제 브라우저로 보는 검사

빌드한 화면을 Playwright로 열어 보는 검사 둘이다. 시험 ID와 통과 기준은 [docs/frontend.md](../../docs/frontend.md) §5.17이 정본이다(BUILD_ORDER BAS-170).

- **FE-T36 SEED CSS 층 검사**(`seed-css/`): 앱 다섯(웹·파트너·관제·스캐너·포렌식)을 `PEAKET_POC=seed-css`로 운영 빌드하면 탐침 화면(`packages/ds/src/poc/SeedLayerProbe.tsx`)이 함께 묶인다. 첫 화면 HTML이 싣는 CSS로 ① 층 차례 ② SEED 규칙이 SEED 층 안에 있는지 ③ SEED 전체 CSS가 없는지와 크기를 보고, 탐침 화면의 계산된 스타일로 ④ Tailwind 유틸이 SEED 부품을 이기고 Tailwind 초기화가 SEED 부품을 덮지 않는지를 세 엔진에서 본다. PoC 결과는 [seed-css/RESULT.md](seed-css/RESULT.md)다.
- **K5 PoC 5만 석 Canvas**(`seatmap/`, BUILD_ORDER BAS-190): 5만 석 열 단위 좌석맵 파일을 만들어(`layout.mjs`) PoC 페이지가 Worker의 OffscreenCanvas로 풀고 그린다. docs/frontend.md §5.2 예산을 K5 랩 조건(Chromium CPU 4배)에서 보고, 다른 엔진은 기록만 한다. 결과는 [seatmap/RESULT.md](seatmap/RESULT.md)다. CI에서는 돌지 않는다(설계를 고르는 PoC. 결과 측정은 wbs 7.5.2의 FE-T10).
- **FE-T40 시각 회귀**(`visual/`): 대기실 경량 페이지 셸의 네 상태 × 라이트·다크를 Chromium·WebKit으로 찍어 저장소의 기준 이미지(`visual/__screenshots__/`)와 견준다. 기준 이미지는 CI와 같은 Playwright 컨테이너(`lib/docker.mjs`의 `IMAGE`, 다이제스트 고정)에서만 찍는다.

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
```

- 이 PC(Windows)의 Firefox는 Playwright 1.64.1 판이 side-by-side 구성 오류로 뜨지 않는다(2026-11-04). 그때는 `node seed-css/serve-all.mjs`로 서버를 띄워 두고 `node lib/docker.mjs layers`로 컨테이너 안 세 엔진이 `host.docker.internal`의 서버를 보게 한다.
- 시각 회귀 설정은 리눅스가 아니면 멈춘다(그리기가 달라 늘 실패한다). 연습으로만 돌릴 때는 `PEAKET_VISUAL_ANY_OS=1`.
- 기준 이미지를 바꾸면 PR에서 그림 차이를 보고 승인한다(FE-T40). 토큰이나 `@peaket/ds`를 바꾼 PR은 CI 화면 잡의 `visual`이 반드시 돈다(docs/devops.md §3.1 `ci-web.yml`).
- 크기는 docs/frontend.md §5.8 CSS 열의 예산(kB = 1,000바이트)과 견준다. 예산을 넘은 경로는 [seed-css/css-baseline.json](seed-css/css-baseline.json)의 값 + 0.5kB를 넘지 않게만 막는다. 줄면 그 값을 낮춘다.

| 파일 | 하는 일 |
| --- | --- |
| `seed-css/check-css.mjs` | CSS 층 검사기(층 이름과 규칙마다 든 층 읽기, ①②③, gzip 크기, 크기 한도) |
| `seed-css/apps.mjs` | 앱 다섯의 포트·탐침·경로와 §5.8 경로 묶음 이름, 서버 명령, 스타일시트 링크 뽑기 |
| `seed-css/build.mjs`·`serve-all.mjs`·`report.mjs` | PoC 빌드, 서버 다섯 띄우기, 크기 표(`--baseline`이면 기준선 다시 쓰기) |
| `seed-css/css.spec.mjs`·`layers.spec.mjs` | FE-T36 ①②③·크기(브라우저 없이), ④(세 엔진) |
| `visual/queue-room.spec.mjs` | FE-T40 대기실 셸 |
| `lib/canon.mjs` | 정본에서 읽는 값(§5.8 CSS 예산, tokens.json 의미 색) |
| `lib/serve.mjs` | 의존성 없는 정적 서버(대기실 배포 흉내 `--preset queue-room`, 단일 페이지 대체) |
| `lib/docker.mjs` | 판을 고정한 Playwright 컨테이너에서 검사 돌리기 |
