# 완성 장부: frontend

`tools/ci/ledger.mjs`가 정본에서 다시 쓴다. 손으로 고치지 않는다(상태·등급·사유는 `docs/review/ledger-notes.md`). 원천: `docs/frontend.md`, `docs/security/asvs/frontend.md`. 전체 개수와 이 도구의 한계는 `docs/review/ledger/README.md`에 있다.

| 등급 | 자동 시험 | ID만 | 측정 | 사람 확인 | 미검증 | 다른 단계 | 없앰 | 해당 없음 | 빈칸 | 합계 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| B | 51 | 46 | 5 | 2 | 0 | 1 | 0 | 22 | 60 | 187 |
| 합계 | 51 | 46 | 5 | 2 | 0 | 1 | 0 | 22 | 60 | 187 |

## docs/frontend.md

| 항목 | 세부 | 제목 | 판정 기준 앞부분 | 상태 | 등급 | 근거 |
| --- | --- | --- | --- | --- | --- | --- |
| FE-T1 | — | 대기실 경량 페이지 예산 | JS ≤ 50KB, CSS < 10KB | 자동 시험 | B | 시험: apps/web/queue-room/test/size-limit.test.mjs |
| FE-T2 | — | 대기실 상태표 | §3.4의 모든 전이 | 빈칸 | B | — |
| FE-T3 | — | T=0 두 호출의 사전 요청 0 | OPTIONS 0, 거절 동작 | 자동 시험 | B | 시험: packages/api-client/test/generated.test.ts, packages/api-client/test/orval-fetch.test.ts 외 2곳 |
| FE-T4 | — | 서버를 지키는 규칙 | §5.9 표의 값. 하한이 있으면 모든 기다림이 하한 이상이고 1.2배 이하로 고르게 퍼진다(0.1배 칸마다 9~11% [가정], 기술 검토 중간-038)… | 자동 시험 | B | 시험: apps/web/queue-room/test/queue-file.test.mjs, apps/web/scripts/mock-api/queue.test.mjs 외 3곳 |
| FE-T5 | — | 재접속 순번 보존 | 순번·앞 인원 유지(NFR-025) | 빈칸 | B | — |
| FE-T6 | — | 여러 탭 | 폴링 리더 하나, 일련번호 역전 0. 리더를 숨기면 1초 [가정] 안에 보이는 탭이 리더가 되어 자기 간격으로 묻는다. 모든 탭이 숨겨지면 묻기가 숨긴 간격마다… | 자동 시험 | B | 시험: apps/web/queue-room/test/tabs.test.mjs, apps/web/queue-room/test/ticket-identity.test.mjs 외 2곳 |
| FE-T7 | — | 구매 세션 서명 | 벡터 일치 | 자동 시험 | B | 시험: packages/api-client/test/purchase-crypto.test.ts, packages/platform/test/purchase-auth.test.ts 외 1곳 |
| FE-T8 | — | 결제 복귀 | 결제 값이 담긴 주소를 바로 지운다, 접수 202 | 사람 확인 | B | 브라우저 확인 · docs/review/browser-check/HOT-356-358.md에서 시뮬레이터 성공과 새로고침을 봤다. 포트원 복귀와 쿠키 없는 첫 요청은 아직 못 봤다 |
| FE-T9 | — | 이진 해독기 경계 | 예외 없이 버리고, 경계 밖 읽기 0 | 다른 단계 | B | 미정 · 이진 해독기 경계는 좌석맵 패키지 단계 몫이다. 시범에서는 서버와의 맞물림 시험만 더했다 |
| FE-T10 | — | 좌석맵 성능과 네트워크 | 첫 그림 1초, INP 200ms, 긴 작업 0, 상태 메시지 처리 p95 2ms [가정]. 힙 감축률(v0 대비 70%)은 보조 숫자로… | 측정 | B | LCH-200 · 좌석맵 성능과 네트워크(측정 캠페인) |
| FE-T11 | — | 좌석 연결 상태 | §3.5 전이, 기계의 모든 전이를 경로가 덮는다, 30초 안에 스스로 회복, 같은 구역 스냅샷 재요청은 동시에 하나 | 자동 시험 | B | 시험: apps/web/src/_pages/seats/model/connection-machine.test.mjs, packages/seatmap/test/connection.test.ts 외 1곳 |
| FE-T12 | — | 돌아갈 주소와 URL 조각 | 모두 첫 화면으로 보내고 조각은 바로 지운다 | 자동 시험 | B | 시험: apps/web/src/_pages/login/model/state.test.mjs, apps/web/src/features/social-login/server/login-routes.test.mjs 외 1곳 |
| FE-T13 | — | 저장소 정리 | §3.12 표대로 | 빈칸 | B | — |
| FE-T14 | — | 월렛 오프라인 | 오프라인 QR, 범위 밖 가로채기 0 | 빈칸 | B | — |
| FE-T15 | — | 미지원 기능 대체 | §1.5 표대로. `AbortSignal.any`가 없어도 호출이 예외 없이 나가고, 시간 초과는 `TimeoutError`, 화면 떠남은… | 자동 시험 | B | 시험: apps/web/queue-room/test/live-net-store.test.mjs, apps/web/scripts/mock-api/queue.test.mjs 외 3곳 |
| FE-T16 | — | 헤더 값과 메서드 | §5.14.1과 같다. 앱 서버 경로와 `/_t/*`의 PUT·DELETE는 405, 정적 경로는 CloudFront가 거절하고, 어느 경로든 TRACE와 허용… | 빈칸 | B | — |
| FE-T17 | — | 원격 위젯 | 그 칸만 대체 카드로 바뀐다 | 빈칸 | B | — |
| FE-T18 | — | 접근성 | 위반 0, 완주 100%, 단축키가 꺼졌거나 입력 칸에 초점이 있을 때 동작 0, 다 가려진 초점 0, 비활성 버튼의 동작 0과 이유 글 연결 100% | 사람 확인 | B | HOT-346 · 화면 낭독기·키보드 완주는 사람이 본다. 이름을 단 자동 시험(axe·목록 구조)은 그 일부다 (이름을 단 시험도 있다) |
| FE-T19 | — | 다국어 | 누락 0, 크기가 같다 | 빈칸 | B | — |
| FE-T20 | — | 스캐너 판정 | p95 150ms, 표대로 | 빈칸 | B | — |
| FE-T21 | — | 운영 묶음 검사 | 0건 | 자동 시험 | B | 시험: tools/web-checks/static/assets.test.mjs |
| FE-T22 | — | 지표 묶음 | 규칙대로 | 자동 시험 | B | 시험: packages/telemetry/test/cleanup.test.ts, packages/telemetry/test/rum.test.ts |
| FE-T23 | — | 관리 계정 유휴 | 갱신 0, 경고 시각 | 빈칸 | B | — |
| FE-T24 | — | 결제 결과 기계 | §3.6 표대로, 기계의 모든 전이를 경로가 덮는다 | 자동 시험 | B | 시험: apps/web/src/_pages/booking-result/model/result-machine.test.mjs |
| FE-T25 | — | 콘솔 덩어리 나눔 | 관제 화면 덩어리 80KB 이하 [가정], 첫 화면 묶음에 늦게 싣는 부분 0 | 빈칸 | B | — |
| FE-T26 | — | 안 보이는 위젯 | 위젯 흐름의 위젯 목록에서 떠난 탭의 위젯은 10초 뒤, 숨긴 탭은 30초 뒤 0. 목록이 바뀔 때 위젯 흐름을 1초 묶어 한 번만 다시 연다. 접은 위젯은… | 빈칸 | B | — |
| FE-T27 | — | 콘솔 장시간·스트림 부하 | 처음 30분 뒤 JS 힙(가비지 수거 뒤)의 시간당 증가 5% [가정] 이하, DOM 노드 수가 늘지 않음, 평상 구간 긴 작업 0, 탭 전환·명령 화면 열기… | 빈칸 | B | — |
| FE-T28 | ① | 관제 SSE 흐름 계약 | ① 빠진 `command`·`alert`가 없다 | 빈칸 | B | — |
| FE-T28 | ② | 관제 SSE 흐름 계약 | ② `reset` 뒤 명령·경보·승인 대기를 REST로 다시 읽는다 | 빈칸 | B | — |
| FE-T28 | ③ | 관제 SSE 흐름 계약 | ③ 35초 뒤 다시 연다(10초 + 0~5초 무작위) | 빈칸 | B | — |
| FE-T28 | ④ | 관제 SSE 흐름 계약 | ④ 토큰을 갱신한 뒤 다시 붙고, 갱신이 401이면 로그인으로 간다 | 빈칸 | B | — |
| FE-T28 | ⑤ | 관제 SSE 흐름 계약 | ⑤ 위젯 흐름만 다시 열고 늘 여는 흐름은 그대로다. 콘솔 번들에 urql·graphql-ws·socket.io-client가 없다 | 빈칸 | B | — |
| FE-T29 | ③ | 관제 Module Federation과 한 앱 기준선 | ③은 두 빌드 모두 셸·경보 패널과 다른 위젯이 그대로여야 한다 | 빈칸 | B | — |
| FE-T30 | — | 서버가 그린 SEED 부품의 스타일과 CSP(ADR-0111) | 세 엔진 모두 계산된 스타일 차이 0, style 속성 위반 보고 0, nonce 없는 `<style>`·인라인 스크립트는 막힘 | 자동 시험 | B | 시험: tools/web-checks/csp/web.spec.mjs |
| FE-T31 | — | 재배치·확대·글자 간격(WCAG 1.4.10·1.4.4·1.4.12… | 예외 영역 밖 가로 스크롤 0, 잘림·겹침 0, 모든 조작 요소에 닿는다 | 빈칸 | B | — |
| FE-T32 | ① | 시계 표본 규칙과 차례 반영 측정(추천 적용 2026-10-28… | ① 보정값이 바뀌지 않는다 | 측정 | B | 구간 측정 · 시범 범위 표의 분류(차례 반영 측정)를 옮겼다. 판정 ①~④는 가짜 시계로 도는 PR 시험으로도 볼 수 있어, 이 영역을 고치는 묶음에서 다시 본다 |
| FE-T32 | ② | 시계 표본 규칙과 차례 반영 측정(추천 적용 2026-10-28… | ② `serverTimeMs`로만 바뀐다 | 측정 | B | 구간 측정 · 시범 범위 표의 분류(차례 반영 측정)를 옮겼다. 판정 ①~④는 가짜 시계로 도는 PR 시험으로도 볼 수 있어, 이 영역을 고치는 묶음에서 다시 본다 |
| FE-T32 | ③ | 시계 표본 규칙과 차례 반영 측정(추천 적용 2026-10-28… | ③ 보정 시계가 흔들리지 않는다 | 측정 | B | 구간 측정 · 시범 범위 표의 분류(차례 반영 측정)를 옮겼다. 판정 ①~④는 가짜 시계로 도는 PR 시험으로도 볼 수 있어, 이 영역을 고치는 묶음에서 다시 본다 |
| FE-T32 | ④ | 시계 표본 규칙과 차례 반영 측정(추천 적용 2026-10-28… | ④ 29분 뒤에는 저장한 보정값을 쓰고, 31분 뒤에는 다음 대기열 API 응답 전까지 `queue_reflect_ms`를 보내지 않는다… | 측정 | B | 구간 측정 · 시범 범위 표의 분류(차례 반영 측정)를 옮겼다. 판정 ①~④는 가짜 시계로 도는 PR 시험으로도 볼 수 있어, 이 영역을 고치는 묶음에서 다시 본다 |
| FE-T33 | ① | 좌석맵 에디터 편집 캔버스(Konva, 추천 적용 2026-10-28… | ① 구역 하나를 5초 끌기 → 끌기·돌리기 중 프레임 시간 p95 16.7ms 가정·50ms 가정, 조작 INP 200ms(NFR-012), 스로틀 없음에서 긴… | 빈칸 | B | — |
| FE-T33 | ② | 좌석맵 에디터 편집 캔버스(Konva, 추천 적용 2026-10-28… | ② 회전 손잡이로 5초 돌리기 → 끌기·돌리기 중 프레임 시간 p95 16.7ms 가정·50ms 가정, 조작 INP 200ms(NFR-012), 스로틀 없음에서… | 빈칸 | B | — |
| FE-T33 | ③ | 좌석맵 에디터 편집 캔버스(Konva, 추천 적용 2026-10-28… | ③ 좌석 다듬기에서 상자로 1,000석 [가정]을 골라 화살표로 옮기기를 CPU 스로틀 없이 한 번, 4배 느린 CPU로 한 번 한다. 장면의 노드 수와… | 빈칸 | B | — |
| FE-T34 | ① | 로그아웃 쿠키 격리(추천 적용 2026-10-28, 기술 검토… | ① 뒤 월렛 입장 키는 기본으로 남는다 | 빈칸 | B | — |
| FE-T34 | ③ | 로그아웃 쿠키 격리(추천 적용 2026-10-28, 기술 검토… | ③ 뒤 관제 출처의 `peaket.console.ui`가 지워지고, | 빈칸 | B | — |
| FE-T35 | — | Cache Components와 nonce 화면 묶음(추천 적용… | `(request)` 경로의 정적 셸 0, nonce 없는 `<script>` 0, CSP 위반 보고 0, `(cached)` 화면은 CDN 캐시 적중… | 자동 시험 | B | 시험: tools/web-checks/csp/theme.spec.mjs, tools/web-checks/csp/web.spec.mjs |
| FE-T36 | ① | SEED CSS 싣기와 층 순서(추천 적용 2026-10-28, 기술… | ① 모두 맞고, 크기는 §5.8 CSS 열 안. 예산을 넘은 경로는 예산을 다시 정하는 wbs 7.5.2까지 잰… | 자동 시험 | B | 시험: tools/web-checks/seed-css/css.spec.mjs |
| FE-T36 | ② | SEED CSS 싣기와 층 순서(추천 적용 2026-10-28, 기술… | ② 모두 맞고, 크기는 §5.8 CSS 열 안. 예산을 넘은 경로는 예산을 다시 정하는 wbs 7.5.2까지 잰… | 자동 시험 | B | 시험: tools/web-checks/seed-css/css.spec.mjs |
| FE-T36 | ③ | SEED CSS 싣기와 층 순서(추천 적용 2026-10-28, 기술… | ③ 모두 맞고, 크기는 §5.8 CSS 열 안. 예산을 넘은 경로는 예산을 다시 정하는 wbs 7.5.2까지 잰… | 자동 시험 | B | 시험: tools/web-checks/seed-css/css.spec.mjs |
| FE-T36 | ④ | SEED CSS 싣기와 층 순서(추천 적용 2026-10-28, 기술… | ④ 모두 맞고, 크기는 §5.8 CSS 열 안. 예산을 넘은 경로는 예산을 다시 정하는 wbs 7.5.2까지 잰… | 자동 시험 | B | 시험: tools/web-checks/seed-css/layers.spec.mjs |
| FE-T37 | — | 찜 오프라인 동기화(추천 적용 2026-10-28, 기술 검토… | 오프라인에서 화면이 바로 바뀌고, 온라인이 된 뒤 백그라운드에서 서버 저장이 끝나 서버 찜 목록이 화면과 같다(공연 둘). 같은 공연의 중복 저장은 0건이다… | 빈칸 | B | — |
| FE-T38 | — | 좌석맵 에디터 가져오기·내보내기와 검사(추천 적용 2026-10-28… | JSON으로 다시 가져온 배치의 구역·좌석 수와 좌표가 내보낸 것과 같고, SVG·CSV 가져오기도 같은 구역·좌석 수를 만든다. 도형 밖 좌석과 겹침은 경고가… | 빈칸 | B | — |
| FE-T39 | — | 관제 Trusted Types 보고 모드 시작 조건(추천 적용… | 덩어리·원격 적재에서 나온 Trusted Types 위반 보고 0, 만든 정책 이름이 모두 `trusted-types` 목록에 있고 이름이 겹치지 않는다… | 빈칸 | B | — |
| FE-T40 | — | 시각 회귀(추천 적용 2026-10-28, 기술 검토 낮음-100) | 픽셀 차이 비율이 문턱 0.1% [가정] 이하. 대기실 셸과 React 대기 화면의 같은 상태 사이도 같은 문턱(§6.3) | 자동 시험 | B | 시험: packages/ds/src/components/QueuePanel/roll.test.mjs, tools/web-checks/visual/ds-stories.spec.mjs 외 2곳 |
| FE-T41 | — | 서식 글 편집기 PoC(추천 적용 2026-10-28, 기술 검토… | CSP·Trusted Types 위반 보고 0(Tiptap은 기본으로 `<style>` 요소를 넣으므로 `injectCSS: false`나 nonce 설정으로… | 자동 시험 | B | 시험: tools/web-checks/rich-text/rich-text.spec.mjs |
| FE-T42 | — | 카운트다운 갱신과 낭독(추천 적용 2026-10-28, 기술 검토… | 보이는 동안 초당 깨어남 2회 이하, 표시 숫자는 늦게 깨어난 바로 다음 표시부터 보정 시계의 남은 초와 같다, 다시 보이면 첫 표시가 맞는 숫자다… | 자동 시험 | B | 시험: apps/web/queue-room/test/countdown.test.mjs |
| FE-T43 | — | 웹 푸시 구독이 로그아웃과 월렛 정리를 넘어 남는지(추천 적용… | 서버 쪽 구독 해제 `DELETE`가 로그아웃 요청보다 먼저 나간다. `/push/` 범위의 서비스 워커 등록과 브라우저의 푸시 구독은 남고, 월렛… | 빈칸 | B | — |
| FE-T44 | — | 토큰 대비 계산(추천 적용 2026-11-04… | 기준 미달 0, 표와 계산값의 차이 0 | 자동 시험 | B | 시험: packages/ds/test/token-rules.test.mjs, packages/ds/test/tokens-canon.test.mjs |
| FE-T45 | ① | 토큰 형식 검사(추천 적용 2026-11-04, 기술 검토… | ① 토큰·그룹 이름에 마침표·중괄호가 없고 `$`로 시작하지 않는지 → 위반 0 | 자동 시험 | B | 시험: packages/ds/test/token-rules.test.mjs |
| FE-T45 | ② | 토큰 형식 검사(추천 적용 2026-11-04, 기술 검토… | ② 모든 토큰에 DTCG 형식(`$type`, 그룹에서 물려받은 것 포함)이 있고 값이 그 형식의 표기(색 `#rrggbb`·`#rrggbbaa`, 치수… | 자동 시험 | B | 시험: packages/ds/test/token-rules.test.mjs |
| FE-T45 | ③ | 토큰 형식 검사(추천 적용 2026-11-04, 기술 검토… | ③ 별칭(`{…}`)이 모두 있는 토큰으로 풀리고 돌지 않는지 → 위반 0 | 자동 시험 | B | 시험: packages/ds/test/token-rules.test.mjs |
| FE-T45 | ④ | 토큰 형식 검사(추천 적용 2026-11-04, 기술 검토… | ④ 확장 키가 `seed`·`override`나 역도메인 `com.peaket.*`인지 → 위반 0 | 자동 시험 | B | 시험: packages/ds/test/token-rules.test.mjs |
| FE-T45 | ⑤ | 토큰 형식 검사(추천 적용 2026-11-04, 기술 검토… | ⑤ `$extensions.seed`가 가리키는 SEED 이름이 붙인 `@seed-design/css` 판의 변수(`--seed-*`)나 중단점에 있는지 →… | 자동 시험 | B | 시험: packages/ds/test/token-rules.test.mjs |
| FE-T45 | ⑥ | 토큰 형식 검사(추천 적용 2026-11-04, 기술 검토… | ⑥ 중단점 값이 `@seed-design/css/breakpoints`와 같은지 → 위반 0 | 자동 시험 | B | 시험: packages/ds/test/token-rules.test.mjs |
| FE-T45 | ⑦ | 토큰 형식 검사(추천 적용 2026-11-04, 기술 검토… | ⑦ 토큰 빌드가 SEED 색 변수를 덮을 때 쓰는 라이트·다크 선택자가 SEED base의 색 모드 선택자를 모두 담는지(피켓이 더한 `.pk.dark`는… | 자동 시험 | B | 시험: packages/ds/test/token-rules.test.mjs |

## docs/security/asvs/frontend.md

| 항목 | 세부 | 제목 | 판정 기준 앞부분 | 상태 | 등급 | 근거 |
| --- | --- | --- | --- | --- | --- | --- |
| v5.0.0-1.1.1 | — | L2 | 입력은 그 형식으로 인코딩된 데이터가 기대될 때만 정규 형식으로 한 번만 디코딩(이스케이프 해제 포함)하고, 검증·정화 같은 다음 처리보다 먼저 한다. | ID만 | B | 다른 곳 시험: services/core-svc/test-int/seatmap-import.int.test.ts, services/core-svc/test/seatmap-parse.test.ts 외 1곳 (영역:… |
| v5.0.0-1.1.2 | — | L2 | 출력 인코딩·이스케이프는 그 값을 쓰는 해석기 바로 앞의 마지막 단계에서 하거나 해석기가 직접 한다. | 빈칸 | B | 영역: apps/console-host, apps/partner, apps/scanner, apps/web |
| v5.0.0-1.2.1 | — | L1 | HTTP 응답·HTML·XML 출력은 문맥(HTML 요소·속성·주석, CSS, HTTP 헤더)에 맞게 인코딩해 메시지·문서 구조가 바뀌지 않게 한다. | 자동 시험 | B | 시험: apps/web/src/_pages/event-detail/model/detail.test.mjs, apps/web/src/_pages/search/model/search.test.mjs 외 1곳 |
| v5.0.0-1.2.2 | — | L1 | URL을 동적으로 만들 때 신뢰하지 않는 값을 문맥에 맞게 인코딩하고 안전한 프로토콜만 허용한다(`javascript:`·`data:` 금지). | 자동 시험 | B | 시험: apps/web/queue-room/test/preload.test.mjs, packages/api-client/test/policy.test.ts |
| v5.0.0-1.2.3 | — | L1 | JavaScript·JSON을 동적으로 만들 때 인코딩·이스케이프해 구조가 바뀌지 않게 한다. | 자동 시험 | B | 시험: apps/web/src/_pages/event-detail/model/detail.test.mjs |
| v5.0.0-1.2.4 | — | L1 | 데이터 조회·DB 쿼리는 파라미터 쿼리, ORM 등으로 SQL 등 DB 주입을 막는다(저장 프로시저 포함). | 해당 없음 | B | 해당 없음: 브라우저 코드와 BFF에 데이터베이스 질의가 없다. 서버 질의는 기능 표가 판정한다 |
| v5.0.0-1.2.5 | — | L1 | OS 명령 주입을 막고 OS 호출은 파라미터화하거나 명령줄 인코딩을 쓴다. | 해당 없음 | B | 해당 없음: 앱과 BFF가 운영체제 명령을 부르지 않는다 |
| v5.0.0-1.2.6 | — | L2 | LDAP 주입을 막는다. | 해당 없음 | B | 해당 없음: LDAP을 쓰지 않는다 |
| v5.0.0-1.2.7 | — | L2 | XPath 주입을 쿼리 파라미터화·사전 컴파일로 막는다. | 해당 없음 | B | 해당 없음: XPath를 쓰지 않는다 |
| v5.0.0-1.2.8 | — | L2 | LaTeX 처리기를 안전하게 설정하고(`--shell-escape` 금지) 명령 허용 목록을 쓴다. | 해당 없음 | B | 해당 없음: LaTeX을 쓰지 않는다 |
| v5.0.0-1.2.9 | — | L2 | 정규식의 특수 문자를 이스케이프해 메타 문자로 해석되지 않게 한다. | 빈칸 | B | 영역: apps/console-host, apps/forensics, apps/partner, apps/scanner, apps/web, apps/widgets, packages/api-client… |
| v5.0.0-1.3.1 | — | L1 | WYSIWYG 편집기 등에서 오는 신뢰하지 않는 HTML 입력은 모두 잘 알려진 안전한 HTML 정화 라이브러리나 프레임워크 기능으로 정화한다. | ID만 | B | 다른 곳 시험: services/core-svc/test/production-description.http.test.ts (영역: apps/web) |
| v5.0.0-1.3.2 | — | L1 | `eval()` 같은 동적 코드 실행을 피하고, 불가피하면 사용자 입력을 실행 전에 정화한다. | 빈칸 | B | 영역: apps/console-host, apps/forensics, apps/partner, apps/scanner, apps/web, apps/widgets, packages/api-client… |
| v5.0.0-1.3.3 | — | L2 | 위험할 수 있는 문맥에 넘기는 데이터는 그 문맥에 안전한 문자만 허용하고 너무 긴 입력을 자르는 등 미리 정화한다. | ID만 | B | 다른 곳 시험: services/purchase-svc/test/hold-seats.test.ts, services/purchase-svc/test/http.test.ts 외 2곳 (영역:… |
| v5.0.0-1.3.4 | — | L2 | 사용자가 준 SVG는 애플리케이션에 안전한 태그·속성만 담도록 검증하거나 정화한다(`script`·`foreignObject` 제외). | ID만 | B | 다른 곳 시험: services/core-svc/test-int/seatmap-import.int.test.ts, services/core-svc/test/seatmap-parse.test.ts 외 1곳 (영역:… |
| v5.0.0-1.3.5 | — | L2 | 사용자가 넣은 Markdown·CSS·XSL·BBCode 같은 스크립트·표현식 템플릿 내용을 정화하거나 끈다. | ID만 | B | 다른 곳 시험: services/core-svc/test-int/seatmap-import.int.test.ts, services/core-svc/test/seatmap-parse.test.ts (영역:… |
| v5.0.0-1.3.6 | — | L2 | 다른 서비스를 부르는 데 쓰기 전에 신뢰하지 않는 값을 프로토콜·도메인·경로·포트 허용 목록과 대조하고 위험할 수 있는 문자를 정화해 SSRF를 막는다. | ID만 | B | 다른 곳 시험: services/core-svc/test-int/production-image.int.test.ts, services/core-svc/test-int/seatmap-import.int.test.ts… |
| v5.0.0-1.3.7 | — | L2 | 신뢰하지 않는 입력으로 템플릿을 만들지 않아 템플릿 주입을 막고, 불가피하면 템플릿에 넣는 신뢰하지 않는 입력을 정화하거나 엄격히 검증한다. | 빈칸 | B | 영역: apps/console-host, apps/forensics, apps/partner, apps/scanner, apps/web, apps/widgets, packages/api-client… |
| v5.0.0-1.3.8 | — | L2 | JNDI 조회에 넣기 전에 입력을 정화하고 JNDI를 안전하게 설정한다. | 해당 없음 | B | 해당 없음: Java를 쓰지 않는다 |
| v5.0.0-1.3.9 | — | L2 | memcache로 보내기 전에 내용을 정화한다. | 해당 없음 | B | 해당 없음: memcache를 쓰지 않는다 |
| v5.0.0-1.3.10 | — | L2 | 예상과 다르거나 악의적으로 해석될 수 있는 형식 문자열은 처리 전에 정화한다. | 빈칸 | B | 영역: apps/console-host, apps/forensics, apps/partner, apps/scanner, apps/web, apps/widgets, packages/api-client… |
| v5.0.0-1.3.11 | — | L2 | 메일 시스템에 넘기기 전에 사용자 입력을 정화해 SMTP·IMAP 주입을 막는다. | 해당 없음 | B | 해당 없음: 앱과 BFF가 메일을 보내지 않는다(알림은 core-svc notify가 보낸다, support.md) |
| v5.0.0-1.4.1 | — | L2 | 메모리 안전한 문자열·메모리 복사·포인터 연산으로 스택·버퍼·힙 오버플로를 찾아내거나 막는다. | 해당 없음 | B | 해당 없음: 관리되는 언어(TypeScript)만 쓴다. 스캐너의 WebAssembly 디코더는 검증된 라이브러리의 버전을 고정해 의존성으로 관리한다(15.1.2) |
| v5.0.0-1.4.2 | — | L2 | 부호·범위·입력 검증으로 정수 오버플로를 막는다. | ID만 | B | 다른 곳 시험: services/core-svc/test-int/production-image.int.test.ts, services/core-svc/test/media-rules.test.ts 외 3곳 (영역:… |
| v5.0.0-1.4.3 | — | L2 | 할당한 메모리와 자원을 해제하고 해제된 참조를 지워 use-after-free를 막는다. | 해당 없음 | B | 해당 없음: 관리되는 언어만 쓴다 |
| v5.0.0-1.5.1 | — | L1 | XML 파서를 제한적으로 설정하고 외부 엔터티 해석 같은 위험 기능을 꺼 XXE를 막는다. | 해당 없음 | B | 해당 없음: 브라우저 코드가 XML을 파싱하지 않는다. 좌석맵 SVG 가져오기의 서버 파서는 좌석 추적 표 1.5.1이 판정한다 |
| v5.0.0-1.5.2 | — | L2 | 신뢰하지 않는 데이터의 역직렬화는 허용 객체 타입 목록 등으로 안전하게 처리하고, 안전하지 않다고 알려진 방식은 쓰지 않는다. | ID만 | B | 다른 곳 시험: services/core-svc/test-int/seatmap-import.int.test.ts, services/core-svc/test/seatmap-parse.test.ts 외 2곳 (영역:… |
| v5.0.0-2.2.2 | — | L1 | 입력 검증을 신뢰할 수 있는 서비스 계층에서 강제하고 클라이언트 검증에 의존하지 않는다. | ID만 | B | 다른 곳 시험: services/purchase-svc/test/hold-seats.test.ts, services/purchase-svc/test/http.test.ts (영역: apps/console-host… |
| v5.0.0-3.2.1 | — | L1 | API 응답·사용자가 올린 파일 등이 잘못된 문맥(HTML 등)으로 그려지지 않게 한다(`Sec-Fetch-*`, CSP sandbox… | ID만 | B | 다른 곳 시험: services/admission-ctrl/test/result-files.test.ts, services/purchase-svc/test/snapshot-http.test.ts 외 2곳 (영역:… |
| v5.0.0-3.2.2 | — | L1 | HTML이 아니라 글로 보일 내용은 `textContent` 같은 안전한 렌더링 함수로 다룬다. | 자동 시험 | B | 시험: apps/web/src/_pages/shuffle-proof/model/proof-view.test.mjs |
| v5.0.0-3.3.1 | — | L1 | 쿠키에 `Secure`를 두고, `__Host-`를 쓰지 않으면 이름에 `__Secure-` 접두사를 붙인다. | 자동 시험 | B | 시험: apps/web/src/features/social-login/server/login-routes.test.mjs |
| v5.0.0-3.3.2 | — | L2 | 쿠키마다 목적에 맞는 `SameSite`를 둬 CSRF 같은 공격 노출을 줄인다. | ID만 | B | 다른 곳 시험: services/queue-svc/test/edge-first-visit-function.test.ts (영역: apps/console-host, apps/forensics… |
| v5.0.0-3.3.3 | — | L2 | 다른 호스트와 공유하도록 설계한 쿠키가 아니면 이름에 `__Host-` 접두사를 쓴다. | 자동 시험 | B | 시험: apps/web/src/features/social-login/server/login-routes.test.mjs |
| v5.0.0-3.3.4 | — | L2 | 스크립트가 읽을 필요 없는 쿠키(세션 토큰 등)는 `HttpOnly`이고 그 값은 `Set-Cookie`로만 보낸다. | 자동 시험 | B | 시험: apps/web/src/features/social-login/server/login-routes.test.mjs |
| v5.0.0-3.4.1 | — | L1 | 모든 응답에 HSTS를 둔다(최대 기간 1년 이상, L2부터 하위 도메인 포함). | ID만 | B | 다른 곳 시험: services/v0-monolith/test/gateway-http-rules.test.ts, services/v0-monolith/test/gateway-server.test.ts (영역:… |
| v5.0.0-3.4.2 | — | L1 | CORS `Access-Control-Allow-Origin`은 고정 값으로 두거나 요청의 `Origin`을 신뢰 출처 허용 목록과 대조해 정하고, `*`을… | ID만 | B | 다른 곳 시험: services/queue-svc/test/state-http.test.ts (영역: apps/console-host, apps/forensics, apps/partner, apps/scanner… |
| v5.0.0-3.4.3 | — | L2 | HTTP 응답에 CSP를 둬 브라우저가 신뢰한 콘텐츠·자원만 싣고 실행하게 하고, 최소한 `object-src 'none'`·`base-uri 'none'`과… | 자동 시험 | B | 시험: apps/web/server/csp-hash-server.test.mjs, apps/web/src/_app/security/page-headers.test.mjs 외 2곳 |
| v5.0.0-3.4.4 | — | L2 | 모든 응답에 `X-Content-Type-Options: nosniff`를 둔다. | ID만 | B | 다른 곳 시험: services/v0-monolith/test-int/seat.int.test.ts, services/v0-monolith/test/gateway-http-rules.test.ts 외 1곳 (영역:… |
| v5.0.0-3.4.5 | — | L2 | 리퍼러 정책을 둬 URL 경로·쿼리 같은 기술적 민감 데이터가 `Referer` 헤더로 제3자 서비스에 새지 않게 한다. | ID만 | B | 다른 곳 시험: packages/config/headers/headers.test.mjs (영역: apps/console-host, apps/forensics, apps/partner, apps/scanner… |
| v5.0.0-3.4.6 | — | L2 | 모든 HTTP 응답에 CSP `frame-ancestors`를 둬 기본적으로 끼워 넣을 수 없게 하고, 필요한 자원만 끼워 넣기를… | 자동 시험 | B | 시험: apps/web/src/_app/security/page-headers.test.mjs |
| v5.0.0-3.5.1 | — | L1 | CORS 사전 요청에 기대지 않는다면 민감 기능 요청이 애플리케이션에서 왔는지 확인한다(위조 방지 토큰, safelisted가 아닌 헤더 요구 등). | 자동 시험 | B | 시험: apps/web/scripts/local-fan-gateway.test.mjs, apps/web/src/features/social-login/server/login-routes.test.mjs |
| v5.0.0-3.5.2 | — | L1 | CORS 사전 요청에 기댄다면 사전 요청을 일으키지 않는 요청으로 그 기능을 부를 수 없게 한다(`Origin`·`Content-Type` 확인 등). | ID만 | B | 다른 곳 시험: packages/platform/test/content-type.test.ts, services/queue-svc/test/admission.test.ts 외 2곳 (영역:… |
| v5.0.0-3.5.3 | — | L1 | 민감 기능은 GET·HEAD·OPTIONS 같은 안전 메서드가 아닌 POST·PUT·PATCH·DELETE 같은 메서드로 부르거나, `Sec-Fetch-*`… | ID만 | B | 다른 곳 시험: services/queue-svc/test/leave-http.test.ts, services/queue-svc/test/shuffle-proof.test.ts 외 1곳 (영역:… |
| v5.0.0-3.5.4 | — | L2 | 서로 다른 애플리케이션을 다른 호스트 이름에 둬 동일 출처 정책의 제한을 쓴다. | 빈칸 | B | 영역: apps/console-host, apps/partner, apps/scanner |
| v5.0.0-3.5.5 | — | L2 | `postMessage`로 받은 메시지는 출처를 믿을 수 없거나 형식이 틀리면 버린다. | 자동 시험 | B | 시험: apps/web/src/features/identity-verify/flow.test.mjs |
| v5.0.0-3.7.1 | — | L2 | 지원이 끝났거나 안전하지 않은 클라이언트 기술(플러그인, Flash 등)을 쓰지 않는다. | 빈칸 | B | 영역: apps/console-host, apps/forensics, apps/partner, apps/scanner, apps/web, apps/widgets, packages/api-client… |
| v5.0.0-3.7.2 | — | L2 | 애플리케이션이 통제하지 않는 다른 호스트로 자동 이동시킬 때는 허용 목록에 있는 곳으로만 보낸다. | 자동 시험 | B | 시험: apps/web/src/_pages/login/model/state.test.mjs, apps/web/src/features/identity-verify/flow.test.mjs 외 1곳 |
| v5.0.0-3.1.1 | — | L3 | 앱이 쓰는 브라우저가 지원해야 할 보안 기능(HTTPS, HSTS, CSP 등)과, 없을 때 앱이 어떻게 동작해야 하는지(경고, 차단)를 문서에 적는다. | 빈칸 | B | 영역: apps/console-host, apps/forensics, apps/partner, apps/scanner, apps/web, apps/widgets, packages/api-client… |
| v5.0.0-3.2.3 | — | L3 | DOM clobbering을 피한다(명시적 변수 선언, 엄격한 타입 검사, document 객체에 전역 값을 두지 않음, 이름 공간 격리). | 빈칸 | B | 영역: apps/console-host, apps/forensics, apps/partner, apps/scanner, apps/web, apps/widgets, packages/api-client… |
| v5.0.0-3.4.7 | — | L3 | CSP가 위반 보고 위치를 정한다. | ID만 | B | 다른 곳 시험: packages/config/headers/headers.test.mjs (영역: apps/console-host, apps/forensics, apps/partner, apps/scanner… |
| v5.0.0-3.4.8 | — | L3 | 문서를 그리는 응답에 COOP `same-origin`이나 `same-origin-allow-popups`를 둔다. | ID만 | B | 다른 곳 시험: packages/config/headers/headers.test.mjs (영역: apps/console-host, apps/forensics, apps/partner, apps/scanner… |
| v5.0.0-3.5.6 | — | L3 | JSONP 기능을 어디에서도 켜지 않는다. | 빈칸 | B | 영역: apps/console-host, apps/forensics, apps/partner, apps/scanner, apps/web, apps/widgets, packages/api-client… |
| v5.0.0-3.5.7 | — | L3 | 인가가 필요한 데이터를 JavaScript 파일 같은 스크립트 응답에 넣지 않는다. | 빈칸 | B | 영역: apps/console-host, apps/forensics, apps/partner, apps/scanner, apps/web, apps/widgets, packages/api-client… |
| v5.0.0-3.6.1 | — | L3 | 외부에 둔 클라이언트 자산은 정적이고 버전이 붙은 자원을 SRI로 검증할 때만 쓰고, 안 되면 자원마다 보안 결정으로 문서에 남긴다. | 빈칸 | B | 영역: apps/widgets |
| v5.0.0-3.7.5 | — | L3 | 브라우저가 기대한 보안 기능을 지원하지 않으면 문서대로(경고, 차단) 동작한다. | 빈칸 | B | 영역: apps/console-host, apps/forensics, apps/partner, apps/scanner, apps/web, apps/widgets, packages/api-client… |
| v5.0.0-13.4.7 | — | L3 | 웹 계층은 정한 확장자 파일만 내보내 정보·설정·소스 코드 유출을 막는다. | 자동 시험 | B | 시험: apps/web/scripts/hide-source-maps.test.mjs, tools/web-checks/csp/web.spec.mjs 외 1곳 |
| v5.0.0-4.1.1 | — | L1 | 본문이 있는 모든 HTTP 응답에 실제 내용과 맞는 `Content-Type`을 두고, 텍스트·XML처럼 IANA 미디어 타입이 정하는 경우 안전한 문자… | ID만 | B | 다른 곳 시험: services/purchase-svc/test/http.test.ts, services/v0-monolith/test-int/queue.int.test.ts (영역:… |
| v5.0.0-4.1.2 | — | L2 | 브라우저로 직접 여는 사용자 화면만 HTTP에서 HTTPS로 자동 리디렉션하고, 그 밖의 서비스·엔드포인트는 리디렉션하지 않는다. | 빈칸 | B | 영역: apps/console-host, apps/forensics, apps/partner, apps/scanner, apps/web, apps/widgets, packages/api-client… |
| v5.0.0-4.1.3 | — | L2 | 로드밸런서·프록시·BFF 같은 중간 계층이 넣어 애플리케이션이 쓰는 헤더(`X-Real-IP`·`X-Forwarded-*`·`X-User-ID` 등)는 최종… | ID만 | B | 다른 곳 시험: services/v0-monolith/test/gateway-config.test.ts, services/v0-monolith/test/gateway-http-rules.test.ts 외 4곳… |
| v5.0.0-4.2.1 | — | L2 | 로드밸런서·방화벽 등 모든 구성요소가 HTTP 버전에 맞게 메시지 경계를 정해 요청 밀반입을 막는다(HTTP/1.x는 `Transfer-Encoding`이… | 해당 없음 | B | 해당 없음: 브라우저 코드 범위 밖이다. 앱 서버 앞단인 CloudFront와 Envoy(요청을 받아 안쪽 서비스로 넘기는 프록시 서버)의 경계 처리 공통 설정은 settlement.md의 같은 행이 판정한다 |
| v5.0.0-4.3.1 | — | L2 | 허용 쿼리 목록, 깊이·개수 제한, 쿼리 비용 분석 가운데 하나 이상으로 비싼 중첩 쿼리에 의한 GraphQL·데이터 계층 표현식 서비스 거부를 막는다. | 해당 없음 | B | 해당 없음: 관제 콘솔은 GraphQL을 쓰지 않는다(REST와 SSE, 2026-10-28 ADR-0100). 위젯 조회는 위젯 키별 REST 경로라 임의 쿼리를 받지 않는다 |
| v5.0.0-4.3.2 | — | L2 | GraphQL을 외부에 공개하는 경우가 아니면 운영 환경에서 인트로스펙션을 끈다. | 해당 없음 | B | 해당 없음: GraphQL을 쓰지 않는다(ADR-0100). 콘솔의 타입은 openapi에서 orval로 만든다(docs/frontend.md §4.6) |
| v5.0.0-4.4.1 | — | L1 | 모든 WebSocket 연결에 WSS를 쓴다. | ID만 | B | 다른 곳 시험: packages/seatmap/test/connection.test.ts, services/v0-monolith/test/gateway-http-rules.test.ts 외 1곳 (영역:… |
| v5.0.0-4.4.2 | — | L2 | WebSocket 첫 HTTP 핸드셰이크에서 `Origin`을 허용 출처 목록과 대조한다. | ID만 | B | 다른 곳 시험: services/v0-monolith/test-int/seat-review.int.test.ts, services/v0-monolith/test-int/seat.int.test.ts (영역:… |
| v5.0.0-4.4.3 | — | L2 | 표준 세션 관리를 쓸 수 없으면 세션 관리 요구사항을 따르는 전용 토큰을 쓴다. | 빈칸 | B | 영역: apps/console-host, apps/forensics, apps/partner, apps/scanner, apps/web, apps/widgets, packages/api-client… |
| v5.0.0-4.4.4 | — | L2 | 전용 WebSocket 세션 토큰은 인증된 HTTPS 세션으로 처음 받거나 검증한다. | 빈칸 | B | 영역: apps/console-host, apps/forensics, apps/partner, apps/scanner, apps/web, apps/widgets, packages/api-client… |
| v5.0.0-11.1.1 | — | L2 | NIST SP 800-57 같은 키 관리 표준을 따르는 키 관리 정책과 키 수명 주기를 문서로 두고, 키를 필요 이상의 주체와 공유하지 않는다(공유 비밀은 두… | 빈칸 | B | 영역: apps/console-host, apps/forensics, apps/partner, apps/scanner, apps/web, apps/widgets, packages/api-client… |
| v5.0.0-11.1.2 | — | L2 | 애플리케이션이 쓰는 모든 암호 키·알고리즘·인증서의 암호 목록을 만들어 정기적으로 갱신하고, 키마다 쓸 수 있는 곳과 없는 곳, 보호할 수 있는 데이터와 없는… | 빈칸 | B | 영역: apps/console-host, apps/forensics, apps/partner, apps/scanner, apps/web, apps/widgets, packages/api-client… |
| v5.0.0-11.2.1 | — | L2 | 업계에서 검증된 암호 구현(라이브러리, 하드웨어 가속 구현)을 쓴다. | 자동 시험 | B | 시험: packages/api-client/test/purchase-crypto.test.ts |
| v5.0.0-11.2.2 | — | L2 | 난수·인증 암호화·MAC·해시 알고리즘, 키 길이, 라운드, 암호와 운용 모드를 언제든 바꿀 수 있고 키·비밀번호 교체와 데이터 재암호화도 할 수 있게… | 자동 시험 | B | 시험: packages/api-client/test/purchase-crypto.test.ts |
| v5.0.0-11.2.3 | — | L2 | 모든 암호 기본 요소가 최소 128비트 보안 강도를 갖는다. | 자동 시험 | B | 시험: packages/api-client/test/purchase-crypto.test.ts |
| v5.0.0-11.3.1 | — | L1 | ECB 같은 안전하지 않은 블록 모드와 PKCS#1 v1.5 같은 약한 패딩을 쓰지 않는다. | 해당 없음 | B | 해당 없음: 브라우저에서 대칭 암호화를 하지 않는다(서명·MAC·키 합의만 한다) |
| v5.0.0-11.3.2 | — | L1 | AES-GCM처럼 승인된 암호와 운용 모드만 쓴다. | 해당 없음 | B | 해당 없음: 같은 이유 |
| v5.0.0-11.3.3 | — | L2 | 암호화한 데이터를 인증 암호화(또는 승인된 암호와 MAC의 조합)로 무단 변경에서 보호한다. | 해당 없음 | B | 해당 없음: 같은 이유. 구매 세션 요청은 암호화하지 않고, MAC으로 키를 가졌다는 것(소지)만 증명한다(본문 기밀성은 TLS가 지킨다, ADR-0050 결정 8) |
| v5.0.0-11.4.1 | — | L1 | 서명·HMAC·KDF·난수 생성 등 일반 암호 용도에는 승인된 해시 함수만 쓰고 MD5 같은 금지 함수는 쓰지 않는다. | 자동 시험 | B | 시험: packages/api-client/test/purchase-crypto.test.ts |
| v5.0.0-11.4.2 | — | L2 | 비밀번호는 현재 권고 파라미터를 적용한 승인된 비밀번호 해시 함수로 저장한다. | 해당 없음 | B | 해당 없음: 브라우저는 비밀번호를 해시하지 않는다(관리 계정 비밀번호는 서버가 다룬다, auth.md) |
| v5.0.0-11.4.3 | — | L2 | 서명·데이터 인증·무결성에 쓰는 해시는 충돌 저항성과 알맞은 출력 길이를 갖추고, 출력은 충돌 저항이 필요하면 256비트 이상, 제2 역상 저항만 필요하면… | 자동 시험 | B | 시험: packages/api-client/test/purchase-crypto.test.ts |
| v5.0.0-11.4.4 | — | L2 | 비밀번호에서 비밀 키를 만들 때 키 스트레칭 파라미터가 있는 승인된 KDF를 쓰고, 그 파라미터는 무차별 대입으로 키가 뚫리지 않게 보안과 성능을 맞춰 정한다. | 해당 없음 | B | 해당 없음: 비밀번호에서 키를 만들지 않는다 |
| v5.0.0-11.5.1 | — | L2 | 추측되면 안 되는 모든 난수와 문자열은 CSPRNG로 만들고 128비트 이상의 엔트로피를 갖는다(UUID는 이 조건을 만족하지 않는다). | ID만 | B | 다른 곳 시험: services/payment-svc/test/pg-selection.test.ts, services/payment-svc/test/simulator-gateway.test.ts 외 5곳 (영역:… |
| v5.0.0-11.6.1 | — | L2 | 키 생성·시드 생성과 디지털 서명 생성·검증에는 승인된 알고리즘과 운용 모드만 쓰고, 알려진 공격에 약한 키(페르마 인수분해에 약한 RSA 키 등)를 만들지… | 자동 시험 | B | 시험: packages/api-client/test/purchase-crypto.test.ts |
| v5.0.0-13.4.1 | — | L1 | 배포물에 `.git`·`.svn` 같은 소스 관리 메타데이터가 없거나, 있어도 외부와 애플리케이션 모두 접근할 수 없다. | 자동 시험 | B | 시험: tools/web-checks/static/assets.test.mjs |
| v5.0.0-13.4.2 | — | L2 | 운영 환경의 모든 구성요소에서 디버그 모드를 끈다. | ID만 | B | 다른 곳 시험: packages/platform/test/problem.test.ts, services/pg-simulator/test/simulator.test.ts (영역: apps/console-host… |
| v5.0.0-13.4.3 | — | L2 | 의도한 경우가 아니면 웹 서버가 디렉터리 목록을 보여 주지 않는다. | 빈칸 | B | 영역: apps/console-host, apps/forensics, apps/partner, apps/scanner, apps/web, apps/widgets, packages/api-client… |
| v5.0.0-13.4.4 | — | L2 | 운영 환경에서 HTTP TRACE 메서드를 지원하지 않는다. | 빈칸 | B | 영역: apps/console-host, apps/forensics, apps/partner, apps/scanner, apps/web, apps/widgets, packages/api-client… |
| v5.0.0-13.4.5 | — | L2 | 내부 API 문서와 모니터링 엔드포인트는 의도한 경우가 아니면 노출하지 않는다. | ID만 | B | 다른 곳 시험: packages/platform/test/metrics.test.ts, services/pg-simulator/test/simulator.test.ts 외 2곳 (영역:… |
| v5.0.0-14.2.1 | — | L1 | 민감 데이터는 HTTP 본문이나 헤더로만 서버에 보내고 URL·쿼리 문자열에 넣지 않는다. | 자동 시험 | B | 시험: apps/web/src/features/identity-verify/flow.test.mjs, apps/web/src/features/identity-verify/server/return-post.test.m… |
| v5.0.0-14.2.2 | — | L2 | 민감 데이터가 로드밸런서·애플리케이션 캐시 같은 서버 구성요소에 캐시되지 않게 하거나 사용 뒤 안전하게 지운다. | 빈칸 | B | 영역: apps/console-host, apps/forensics, apps/partner, apps/scanner, apps/web, apps/widgets, packages/api-client… |
| v5.0.0-14.2.3 | — | L2 | 정의된 민감 데이터를 신뢰하지 않는 제3자(사용자 추적 도구 등)에게 보내지 않는다. | ID만 | B | 다른 곳 시험: packages/platform/test/telemetry.test.ts, services/payment-svc/test/portone-gateway.test.ts 외 1곳 (영역:… |
| v5.0.0-14.2.4 | — | L2 | 보호 등급 문서에 정한 대로 암호화, 무결성 검증, 보존, 로그 기록 방식과 로그 속 민감 데이터 접근 통제, 개인정보 보호 기술을 구현한다. | ID만 | B | 다른 곳 시험: loadtest/e2e/v0-rehearsal.e2e.mjs, packages/platform/test-int/held-events.int.test.ts 외 14곳 (영역:… |
| v5.0.0-14.3.1 | — | L1 | 클라이언트나 세션이 끝나면 브라우저 DOM 같은 클라이언트 저장소에서 인증 뒤 받은 데이터를 지우고, 서버에 연결되지 않을 때도 클라이언트가 스스로 지울 수… | 빈칸 | B | 영역: apps/console-host, apps/forensics, apps/partner, apps/scanner, apps/web, apps/widgets, packages/api-client… |
| v5.0.0-14.3.2 | — | L2 | 민감 데이터가 브라우저에 캐시되지 않게 `Cache-Control: no-store` 등 캐시 방지 헤더를 둔다. | ID만 | B | 다른 곳 시험: services/identity-svc/test-int/fan-account.int.test.ts, services/identity-svc/test/fan-account-http.test.ts 외… |
| v5.0.0-14.3.3 | — | L2 | 브라우저 저장소(localStorage, sessionStorage, IndexedDB, 쿠키)에 세션 토큰 말고는 민감 데이터를 두지 않는다. | 빈칸 | B | 영역: apps/console-host, apps/forensics, apps/partner, apps/scanner, apps/web, apps/widgets, packages/api-client… |
| v5.0.0-15.1.1 | — | L1 | 취약한 서드파티 구성요소와 라이브러리 갱신의 위험 기반 조치 기한을 문서에 정한다. | 빈칸 | B | 영역: apps/console-host, apps/forensics, apps/partner, apps/scanner, apps/web, apps/widgets, packages/api-client… |
| v5.0.0-15.1.2 | — | L2 | 모든 서드파티 라이브러리의 목록(SBOM)을 유지하고, 미리 정한 믿을 수 있고 계속 관리되는 저장소에서 오는지 확인한다. | 자동 시험 | B | 시험: tools/web-checks/static/assets.test.mjs |
| v5.0.0-15.1.3 | — | L2 | 시간이 오래 걸리거나 자원을 많이 쓰는 기능을 문서에 밝히고, 그 남용으로 가용성을 잃지 않는 방법과 응답 만들기가 호출자의 시간 초과보다 길어지지 않게 하는… | ID만 | B | 다른 곳 시험: services/core-svc/test-int/seatmap-import.int.test.ts, services/payment-svc/test-int/payment-call-guard.int.tes… |
| v5.0.0-15.2.1 | — | L1 | 문서에 정한 갱신·조치 기한을 넘긴 구성요소가 없다. | 빈칸 | B | 영역: apps/console-host, apps/forensics, apps/partner, apps/scanner, apps/web, apps/widgets, packages/api-client… |
| v5.0.0-15.2.2 | — | L2 | 시간이 오래 걸리거나 자원을 많이 쓰는 기능에 문서대로 가용성 방어를 구현한다. | ID만 | B | 다른 곳 시험: packages/platform/test-int/maintenance.int.test.ts, packages/platform/test/circuit-breaker.test.ts 외 6곳 (영역:… |
| v5.0.0-15.2.3 | — | L2 | 운영 환경에는 필요한 기능만 두고 시험 코드·예제·개발 기능을 노출하지 않는다. | 빈칸 | B | 영역: apps/console-host, apps/forensics, apps/partner, apps/scanner, apps/web, apps/widgets, packages/api-client… |
| v5.0.0-15.3.1 | — | L1 | 데이터 객체에서 필요한 필드만 돌려준다. | ID만 | B | 다른 곳 시험: services/payment-svc/test-int/payment-new-pause.int.test.ts, services/payment-svc/test/payment-grpc.test.ts 외… |
| v5.0.0-15.3.2 | — | L2 | 백엔드가 외부 URL을 부를 때 의도하지 않은 리디렉션을 따라가지 않는다. | ID만 | B | 다른 곳 시험: packages/platform/test/telemetry.test.ts, services/payment-svc/test/portone-gateway.test.ts 외 1곳 (영역:… |
| v5.0.0-15.3.3 | — | L2 | 컨트롤러·액션마다 허용 필드를 제한해 대량 할당 공격을 막는다. | ID만 | B | 다른 곳 시험: packages/platform/test/request-checks.test.ts, services/purchase-svc/test/accept-http.test.ts 외 2곳 (영역:… |
| v5.0.0-15.3.4 | — | L2 | 모든 프록시·미들웨어가 사용자의 원래 IP를 최종 사용자가 조작할 수 없는 신뢰 필드로 넘기고, 애플리케이션·웹 서버는 그 값을 로그와 레이트 리밋 같은 보안… | 빈칸 | B | 영역: apps/console-host, apps/forensics, apps/partner, apps/scanner, apps/web, apps/widgets, packages/api-client… |
| v5.0.0-15.3.5 | — | L2 | 변수 타입을 확인하고 엄격한 동등·비교 연산을 써서 타입 혼동을 막는다. | ID만 | B | 다른 곳 시험: services/purchase-svc/test/hold-seats.test.ts, services/purchase-svc/test/http.test.ts (영역: apps/console-host… |
| v5.0.0-15.3.6 | — | L2 | 프로토타입 오염을 막도록 JavaScript를 작성한다(객체 리터럴 대신 `Set`·`Map` 등). | ID만 | B | 다른 곳 시험: packages/api-client/test/policy.test.ts, packages/validation/test/validation.test.ts 외 2곳 (영역: function… |
| v5.0.0-15.3.7 | — | L2 | HTTP 파라미터 오염 공격을 막는다. | ID만 | B | 다른 곳 시험: packages/platform/test/request-checks.test.ts, services/purchase-svc/test/read-seat-snapshot.test.ts 외 1곳 (영역:… |
| v5.0.0-15.1.4 | — | L3 | 위험 구성 요소로 보는 서드파티 라이브러리를 문서에서 드러낸다. | 빈칸 | B | 영역: apps/console-host, apps/forensics, apps/partner, apps/scanner, apps/web, apps/widgets, packages/api-client… |
| v5.0.0-15.2.4 | — | L3 | 서드파티 구성 요소와 모든 전이 의존성이 기대한 저장소에서 오고 의존성 혼동 위험이 없게 한다. | 자동 시험 | B | 시험: tools/ci/check-trust-exceptions.test.mjs |
| v5.0.0-16.1.1 | — | L2 | 기술 스택의 계층마다 어떤 이벤트를 어떤 형식으로 기록하는지, 로그를 어디에 두고 어디에 쓰는지, 접근을 어떻게 통제하는지, 얼마나 보관하는지를 적은 로그… | ID만 | B | 다른 곳 시험: services/core-svc/test-int/seatmap-import.int.test.ts (영역: apps/console-host, apps/forensics, apps/partner… |
| v5.0.0-16.2.1 | — | L2 | 로그 항목에 언제, 어디서, 누가, 무엇을 같은 조사용 메타데이터를 넣는다. | ID만 | B | 다른 곳 시험: packages/platform/test/request-log.test.ts, services/core-svc/test-int/production-image.int.test.ts (영역:… |
| v5.0.0-16.2.2 | — | L2 | 로그 구성요소의 시각을 동기화하고 UTC 또는 시간대 오프셋을 쓴다. | 빈칸 | B | 영역: apps/console-host, apps/forensics, apps/partner, apps/scanner, apps/web, apps/widgets, packages/api-client… |
| v5.0.0-16.2.3 | — | L2 | 로그 목록에 적힌 파일과 서비스로만 로그를 저장·전송한다. | 빈칸 | B | 영역: apps/console-host, apps/forensics, apps/partner, apps/scanner, apps/web, apps/widgets, packages/api-client… |
| v5.0.0-16.2.4 | — | L2 | 쓰고 있는 로그 처리기가 로그를 읽고 서로 연관 지을 수 있게 하고, 되도록 공통 로그 형식을 쓴다. | 빈칸 | B | 영역: apps/console-host, apps/forensics, apps/partner, apps/scanner, apps/web, apps/widgets, packages/api-client… |
| v5.0.0-16.2.5 | — | L2 | 민감 데이터는 보호 등급에 따라 로그에 남긴다(자격 증명·결제 정보는 남기지 않고, 일부는 해시·마스킹). | ID만 | B | 다른 곳 시험: loadtest/test/before090.test.mjs, loadtest/test/lib.test.mjs 외 76곳 (영역: apps/console-host, apps/forensics… |
| v5.0.0-16.3.1 | — | L2 | 성공·실패를 포함한 모든 인증 작업을 기록하고, 인증 방식이나 쓴 인증 요소 같은 메타데이터도 남긴다. | 해당 없음 | B | 해당 없음: 인증 기록은 서버가 남긴다(docs/features/identity.md §9) |
| v5.0.0-16.3.2 | — | L2 | 실패한 인가 시도를 기록하고, L3는 민감 데이터 접근을 포함한 모든 인가 결정을 그 데이터는 빼고 기록한다. | 해당 없음 | B | 해당 없음: 인가 판단과 기록은 서버가 한다 |
| v5.0.0-16.3.3 | — | L2 | 문서화한 보안 이벤트와 보안 통제를 우회하려는 시도를 기록한다. | ID만 | B | 다른 곳 시험: services/core-svc/test-int/production-image.int.test.ts, services/core-svc/test-int/seatmap-import.int.test.ts… |
| v5.0.0-16.3.4 | — | L2 | 예상하지 못한 오류와 보안 통제 실패를 기록한다. | ID만 | B | 다른 곳 시험: packages/platform/test/redis.test.ts, packages/platform/test/request-log.test.ts 외 53곳 (영역: apps/console-host… |
| v5.0.0-16.4.1 | — | L2 | 모든 로그 구성요소가 로그 주입을 막도록 데이터를 인코딩한다. | ID만 | B | 다른 곳 시험: packages/platform/test/request-log.test.ts, services/core-svc/test-int/seatmap-import.int.test.ts 외 1곳 (영역:… |
| v5.0.0-16.4.2 | — | L2 | 로그를 권한 없는 접근과 수정에서 보호한다. | 해당 없음 | B | 해당 없음: 저장한 뒤의 보호는 관측 스택(지표·로그·요청 기록으로 시스템 안을 들여다보는 도구 묶음)이 맡는다(delivery.md 같은 행) |
| v5.0.0-16.4.3 | — | L2 | 로그를 분석·탐지·경보용으로 논리적으로 분리된 시스템에 안전하게 보낸다. | 빈칸 | B | 영역: apps/console-host, apps/forensics, apps/partner, apps/scanner, apps/web, apps/widgets, packages/api-client… |
| v5.0.0-16.5.1 | — | L2 | 예상하지 못한 오류나 보안상 민감한 오류에는 일반 메시지를 돌려주고 내부 정보를 드러내지 않는다. | ID만 | B | 다른 곳 시험: packages/platform/test/problem.test.ts (영역: apps/console-host, apps/forensics, apps/partner, apps/scanner… |
| v5.0.0-16.5.2 | — | L2 | 외부 자원 접근이 실패해도 안전하게 동작한다. | ID만 | B | 다른 곳 시험: packages/platform/test-int/kafka.int.test.ts, packages/platform/test-int/outbox.int.test.ts 외 84곳 (영역:… |
| v5.0.0-16.5.3 | — | L2 | 예외가 나도 안전하게 실패하고, 검증 오류가 있는데도 거래를 처리하는 fail-open을 막는다. | ID만 | B | 다른 곳 시험: packages/platform/test/circuit-breaker.test.ts, services/core-svc/test-int/production-image.int.test.ts 외 69곳… |
