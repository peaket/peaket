# ADR-0361: 관제 원격 위젯을 원격 목록·sha384 무결성으로 한 파일씩 싣고, 켜 둔 동안 안 보이는 위젯의 흐름과 그리기를 멈춘다(F-03-2, OPS-350·OPS-360)

- **상태**: 채택(2026-11-23, 추천 적용. 기능 F-03-2 계획 `docs/review/plans/F-03-2.md`의 '감독에게'·'정할 것과 추천'을 구현 담당이 정본에 옮겼다). 결정 7(공유 싱글턴 목록 좁히기)을 방향 결정으로 보면 소유자 확인이 필요하다. 새 패키지 의존성은 더하지 않았다.
- **관련**: ADR-0079(결정 16·24), ADR-0091(결정 1·3·4), ADR-0092(결정 3), ADR-0100(결정 6), ADR-0360(결정 6·9·10·11·15), [docs/frontend.md](../frontend.md) §3.12·§4.4.5·§4.5·§5.7·§5.8·§5.14.1·§5.16·§6.3, [docs/devops.md](../devops.md) §3.1·§6.6, [docs/security/asvs/frontend.md](../security/asvs/frontend.md) 3.2.3·16.3.3·16.5.2, docs/api/asyncapi.yaml(`RumSample.counters`), BUILD_ORDER F-03-2·OPS-350·OPS-360

## 맥락

- F-03-1(ADR-0360 결정 6)은 webpack 5 내장 Module Federation으로 원격 둘을 붙였지만, 빌드에 박은 주소 둘(`/remotes/<이름>/remoteEntry.js`)을 그대로 믿고 실었다. 무결성·시간 초과·다시 받기·대체 카드의 [다시 시도]·실패 수·원격 목록이 없었다.
- 원격 빌드 하나가 파일 다섯(진입 파일, 위젯 덩어리 둘, 공유 대체본)으로 나와, 진입 파일의 sha384 하나로는 원격 코드 전부를 덮지 못했다(원격 런타임이 따로 받는 덩어리에는 무결성이 없다).
- 위젯 흐름은 1초 묶기만 있었고, 떠난 위젯 10초 유예·숨긴 탭 30초·다시 보일 때 채우기·접기·화면 밖·250ms 묶기·탭 제목 수가 없었다.
- 대시보드 화면 덩어리가 84.1kB(gzip)로 화면 덩어리 예산 80KB [가정](frontend §5.8)를 넘었다. 대부분이 배치별 보드 셋(데스크톱·태블릿·휴대폰)이 한 덩어리에 든 것이었다.
- 새 패키지 의존성을 더하지 않는다(구현 지시). 계획 '감독에게' 4의 후보(`webpack-subresource-integrity`, `@module-federation/enhanced`, `size-limit`)는 쓰지 않는다.

## 결정

1. **적재기는 호스트 자체 적재기를 넓힌다.** 정본 §4.5의 '런타임 플러그인 `createScript`·`loadEntryError`·`errorLoadRemote`'(`@module-federation/enhanced`의 이름)와 같은 순서를 `apps/console-host/src/shared/lib/remotes/remote-loader.ts` 한 곳이 한다: 같은 출처 `/remotes.json` 읽기 → 항목 검사(`@peaket/console-contract` `parseRemoteList`) → 계약 판 확인(다르면 받지 않는다) → `integrity`·`crossorigin="anonymous"`를 붙인 `<script>`를 Trusted Types 정책 `peaket-remote`로 넣기(시간 초과 5초 [가정]) → 실패하면 한 번 다시 → 또 실패하면 `RemoteLoadError{remote, reason}`(그 칸만 대체 카드). 원격 노출 모듈을 실은 뒤 위젯 정보의 `contractMajor`도 다시 본다. 같은 원격의 동시 요청은 하나로 묶고, 실패하면 적재·목록 기억을 지워 [다시 시도]가 목록부터 새로 받는다.
2. **원격은 한 파일이다(PoC 통과).** 원격 빌드에 webpack 내장 `optimize.LimitChunkCountPlugin({ maxChunks: 1 })`을 걸어 `remoteEntry.js` 하나에 노출 모듈·위젯 덩어리까지 넣는다(원격마다 gzip 4.7~4.9kB). 그러면 원격의 공유 모듈 소비가 진입 덩어리 안의 동기 소비가 되어, 호스트가 내놓은 공유 모듈이 첫 덩어리(`eager`)가 아니면 webpack이 'Shared module is not available for eager consumption'으로 멈춘다. 그래서 호스트는 원격이 가져가는 공유 모듈(react·react/jsx-runtime·계약 패키지)을 `eager`로 내놓는다. 이 셋은 어차피 첫 화면에 실리므로 첫 화면 전체 양은 같고, 진입 HTML이 싣는 `main` 파일만 커진다.
3. **경로·sha·목록**: 원격은 `dist/remotes/<이름>/<sha>/remoteEntry.js`(숨김 소스 맵은 `dist/remotes/<이름>/maps/` 아래, 올리지 않는다)로 나가고, 빌드 뒤 `apps/console-host/scripts/remotes-manifest.mjs`가 그 바이트의 sha384를 계산해 `dist/remotes.json`(`[{name, sha, entry, integrity, contractMajor}]`)을 쓴다. sha는 `PEAKET_REMOTE_SHA` → `GITHUB_SHA` → 커밋(원격 폴더·계약 패키지에 커밋 안 한 변경이 없을 때) → 원천 파일 내용의 sha256 차례로 고른 앞 12자다(같은 경로에 다른 바이트가 나가지 않게 한다. Docker 빌드처럼 `.git`이 없으면 내용 해시다). 원격 파일은 경로가 판마다 달라 오래 캐시하고(`immutable`), `remotes.json`과 화면 HTML만 매번 확인한다(미리보기 서버·로컬 데모 nginx). 목록 형식은 `name` 케밥 표기·호스트가 아는 이름, `sha` 소문자 16진 7~40자, `integrity` `sha384-`+base64 64자, `contractMajor` 1 이상의 정수, `entry`는 정확히 `/remotes/<name>/<sha>/remoteEntry.js`이고 칸은 이 다섯뿐이다. 틀린 항목·같은 이름 둘은 그 원격만 `list`로 실패하고 나머지는 싣는다. `peaket-remote`는 읽은 목록의 정식 주소(같은 출처 경로 그대로, 쿼리·조각·점 경로 없음)만 통과시킨다(빌드에 박은 주소는 없앴다).
4. **개발 서버도 같은 길이다.** 개발 서버 미들웨어가 메모리에 빌드한 원격 바이트로 그 순간의 sha384를 계산해 `/remotes.json`을 내준다. 무결성을 끄는 개발 전용 갈래는 두지 않는다.
5. **다시 받기와 실패 수**: 진입 파일 실패(무결성·네트워크·시간 초과·컨테이너 없음)는 한 번 다시 받는다. 판 불일치·목록 거절·정책 거절은 다시 받지 않는다. 늦게 온 응답은 무시한다(칸은 이미 대체 카드이고, 무결성을 거쳐 실행된 컨테이너는 다음 [다시 시도]가 그대로 쓴다). 수 `remote_load_failed_total{remote, reason}`은 한 적재가 마지막에 실패했을 때 한 번 세고(처음 실패 뒤 다시 받아 성공하면 세지 않는다), 같은 출처 `/_t/rum`의 브라우저 지표 묶음(계약 `RumSample` 판 2, `app` console, `route` `/dashboard`) `counters`에 싣는다. 첫 실패 뒤 1초 [가정] 묶어 보내고 화면을 숨길 때·떠날 때 남은 것을 보낸다(fetch keepalive·쿠키 없음·Referer 없음, keepalive를 모르면 sendBeacon). `reason`은 `list`·`contract`·`policy`·`integrity`·`network`·`timeout`·`container`이고 asyncapi `counters`의 이름·라벨 열거에 더했다. 브라우저는 스크립트 오류 사건에 까닭을 싣지 않아, 같은 출처 자원 시간 기록에 응답(2xx 상태, 상태 칸 `responseStatus`가 없는 브라우저는 받은 본문 바이트 `encodedBodySize`)이 있으면 `integrity`, 없거나 2xx가 아니면 `network`로 가른다(머리 바이트까지 세는 `transferSize`는 본문 없는 404도 0보다 커서 보지 않는다, 2026-11-23 시험 T8 WebKit). strictVersion 공유 싱글턴 판이 맞지 않는 오류('Unsatisfied version')는 `contract`다.
6. **미리 받기(PoC의 답)**: 대시보드를 처음 그린 뒤(경로 lazy가 다 풀려 navigation이 idle) 2초 [가정]에 명령 화면(SCR-030) 덩어리를 webpack 매직 주석 `webpackFetchPriority: "low"`로 받고, 그다음 원격을 **같은 적재기**(낮은 우선순위, 스크립트 `fetchpriority="low"`)로 미리 싣는다. 미리 싣기도 목록·판·정책·무결성 확인을 그대로 거치므로 ADR-0091 결정 1의 '거치지 않으면 원격은 미리 받지 않는다'에 걸리지 않는다. 지금 원격 둘은 T=0·판매 중 탭의 위젯이라 '다음 단계 탭의 원격'은 두 원격 모두다. 메뉴(`nav` 안 링크)에 포인터가 올라가거나 초점이 가면 그 화면의 경로 lazy를 미리 부른다(`src/shared/lib/preload.ts`).
7. **공유 싱글턴 목록 좁히기**: 정본 §4.5의 일곱(react·react-dom·zustand·chart.js·`@peaket/ds`·`@peaket/telemetry`·`@peaket/console-contract`)은 '원격이 쓸 수 있는 상한'으로 두고, 호스트는 원격이 실제로 가져오는 것만 공유로 선언한다(지금 react·react/jsx-runtime·react-dom·`@peaket/console-contract`). 공유 모듈은 쓰는 부품만 골라 싣지 못해 `@peaket/ds` 같은 패키지를 공유하면 패키지 전체가 한 덩어리로 실려서다. 원격은 대체본 없이(`import: false`) 호스트 것만 쓴다(원격 산출물에 react·계약 패키지 사본이 없다, `remotes-manifest.mjs --check`가 본다). 계약 패키지만 `strictVersion`이고 범위는 `^<CONTRACT_MAJOR>.0.0`이다. 그래서 계약 패키지 판(package.json `version`)의 큰 수를 `CONTRACT_MAJOR`와 같게 둔다(1.0.0). 원격이 새 공유 모듈(예 처음 그래프를 그리는 위젯의 `chart.js`)을 가져오는 기능이 그 이름을 호스트 공유와 원격 린트 허용에 함께 더한다.
8. **접기는 호스트가 맡는다.** 위젯 머리의 [접기]와 접힌 줄 누르기가 바뀐 값을 알리도록 `WidgetProps`에 선택 콜백 `onCollapsedChange?(collapsed)`를 더했다(판 1 안에서 더한 선택 칸이라 계약 판은 그대로다). 호스트가 `collapsed`를 바꿔 다시 넘기고 접은 위젯 이름을 이 브라우저에만 남긴다(`peaket.console.ui`의 `collapsed`, frontend §3.12). 접어도 구독은 그대로다.
9. **구독 수명(OPS-360)**: 호스트 `WidgetStreams`(`src/shared/api/live/widget-stream.ts`)가 마지막 구독자가 떠난 키를 10초 [가정] 목록에 남기고(그 사이 다시 오면 흐름을 다시 열지 않는다), 10초에 빼며 바뀐 목록으로 1초 [가정] 묶어 한 번만 다시 연다(떠난 뒤 11초에 새 흐름). 브라우저 탭을 숨긴 지 30초 [가정]에 위젯 키를 모두 빼 흐름을 닫고(구독자는 멈춤으로 남긴다), 다시 보이면 바로 다시 열고 키마다 위젯 조회(최근 15분 [가정] `from`·`to`)를 한 번 불러 같은 구독자에게 넘긴다(조회 값과 흐름 값의 모양이 같다, ADR-0360 결정 10). 회차를 바꾸면 유예 중인 키를 버리고 바로 다시 연다. 늘 여는 흐름은 숨겨도 그대로다. 자리마다 만드는 통로(`createSlotServices`)는 흐름 값을 250ms [가정]에 한 번(처음 값은 바로, 그 사이 값은 마지막 것만) 넘기고, 자리가 화면 밖이면(`IntersectionObserver`) 넘기지 않고 마지막 값만 들고 있다가 보이면 한 번 넘긴다. 탭을 숨긴 동안 걸린 SEV1·SEV2 경보나 내 승인 대기가 있으면 탭 제목 앞에 `(SEV1 1 · 승인 1) `을 붙인다(없는 것은 빼고, 없으면 붙이지 않는다).
10. **대시보드 덩어리 줄이기**: 보드 셋의 상태 값(`valsD`·`valsT`·`valsM`과 상태 열거)을 `vals-d.ts`·`vals-t.ts`·`vals-m.ts`로 떼고, 페이지는 그 값만 바로 가져오며 보드 그림은 배치에 맞는 것만 늦게 싣는다(`scr-029-d`·`-t`·`-m`). 처음 대시보드로 갈 때 더 받는 JS가 84.1kB에서 데스크톱 36.2kB(`scr-029` 3.6kB + `scr-029-d` 32.6kB, gzip -9, 2026-11-23)가 됐다. 예산(80KB [가정])은 그대로다. 퍼블리싱 고정 자료 위젯은 실제 값 화면에서도 원천이 붙기 전 위젯 일곱을 그려야 해(ADR-0360 RV-04) 보드 덩어리에 남긴다. 대시보드 틀을 첫 화면 묶음에 두는 규칙(§5.7)은 그대로다.
11. **그래프 상한**: `@peaket/ds` `TimeSeriesChart`에 선택 속성 `realtime: { series, now, windowMs? }`를 더했다. 이 방식은 x축 `linear`(밀리초, 눈금 `Intl.DateTimeFormat`), `parsing: false`, `normalized: true`, `animation: false`, 축 최소·최대, `Decimation` `min-max`로 그리고 값이 바뀌면 그래프를 새로 만들지 않고 `chart.update('none')`로 고친다(`realtime.ts` `realtimeChartOptions`). 들고 있는 양은 `RingSeries`(한 선 900점 [가정] 고리 버퍼)·`RingChartData`(한 장 6선 [가정], 넘으면 먼저 들어온 선을 버린다)가 지키고, 그리는 쪽도 앞 6선·선마다 뒤 900점만 그린다. 글자 눈금 방식(파트너 분당 판매)은 그대로다. 실제 값으로 잇는 위젯 둘은 화면 설계에 그래프가 없어, 이 방식을 화면에서 처음 쓰는 것은 그래프 위젯의 원천 기능이다.
12. **공용 원격 빌드 워크플로**: `.github/workflows/build-remote.yml`(재사용, 입력 `remote`)이 설치 → 원격 폴더 린트 → 그 원격만 빌드(`--config-name remote-<이름>`) → `remotes-manifest.mjs --remote <이름> --check`(한 파일·gzip 80KB [가정]·공유 싱글턴 사본 없음, `node:zlib`)와 sha384 목록 조각(`dist/remotes-<이름>.json`) → 산출물 올리기를 한다. `ci-web.yml`의 `remotes` 잡이 원격 둘로 부르고, 원격 폴더·계약 패키지·이 워크플로가 바뀌면 web 범위가 켜진다(`tools/ci/changes.mjs`). 크기 도구는 size-limit 대신 `node:zlib`이다(새 개발 의존을 더하지 않는다, frontend §5.8 관제 줄 도구 칸을 고쳤다). 콘솔 버킷(S3) 올리기와 운영 `remotes.json`의 GitOps 원본 자리는 구간 5다(클라우드 계정이 없다).
13. **원격 폴더 린트**: 뿌리 `eslint.config.mjs`의 `REMOTE_WIDGET_RULES`가 `apps/widgets/*/src`에서 `fetch`·`WebSocket`·`EventSource`·`XMLHttpRequest`·`localStorage`·`sessionStorage`·`indexedDB`(와 `BroadcastChannel`·`Worker`·`SharedWorker`)를 전역 이름이나 `window.`·`globalThis.`로 쓰는 것, `window`·`globalThis`·`self`·`document`에 값을 두는 것(대입·`delete`·`Object.assign`·`Object.defineProperty`·`Reflect.set`), `@peaket/console-contract` 밖의 `@peaket/*` 가져오기(동적 가져오기 포함)를 막는다(ESLint 내장 규칙만, ASVS 3.2.3).

## 검토한 대안

| 대안 | 낫다 | 걸린다 | 판단 |
| --- | --- | --- | --- |
| `webpack-subresource-integrity`로 원격 덩어리마다 해시 | 원격을 여러 덩어리로 둘 수 있다 | 새 의존성(지시가 막음). 원격이 작아 나눌 이득이 거의 없다 | 쓰지 않는다 |
| `@module-federation/enhanced` 런타임 플러그인 | 정본 §4.5의 이름 그대로 | 새 의존성. 자체 적재기로 같은 순서가 된다 | 쓰지 않는다(ADR-0360 대안 표의 '다시 본다'에 대한 답) |
| 원격 덩어리를 호스트가 받아 해시를 본 뒤 실행 | 모든 덩어리 확인 | 실행하려면 blob·문자열 스크립트가 필요해 CSP `script-src 'self'`·Trusted Types와 맞지 않는다 | 쓰지 않는다 |
| 원격 공유 모듈을 eager 없이 두고 원격을 여러 파일로 | 호스트 첫 파일이 작다 | 진입 파일 sha384가 위젯 덩어리를 덮지 못한다 | 쓰지 않는다 |
| 무결성 실패를 `fetch(…, { integrity })`로 다시 받아 까닭을 가르기 | 까닭이 정확하다 | 요청이 더 생겨 '한 번 다시'의 요청 수가 흐려지고 같은 바이트를 두 번 받는다 | 쓰지 않는다(자원 시간 기록 추정) |
| 개발 서버에서 무결성 끄기 | 다시 빌드가 단순하다 | 운영과 다른 길이 생긴다 | 쓰지 않는다 |
| size-limit을 console-host 개발 의존으로 | 정본 도구 칸 그대로 | 잠금 파일 변경, 같은 gzip 크기를 `node:zlib`로 잰다 | 쓰지 않는다 |
| 대시보드 고정 자료 위젯을 `?state=` 미리보기에서만 싣기 | 실제 값 화면 덩어리가 더 작다 | 원천이 붙기 전 위젯 일곱을 실제 값 화면이 그린다(ADR-0360 RV-04) | 배치별 보드 나누기만 한다 |

## 결과와 남는 한계

- 원격 적재 실패는 그 칸만 대체 카드이고 [다시 시도]가 그 칸만 다시 싣는다. 실패 수를 Prometheus 지표로 바꾸는 게이트웨이 수집기는 아직 없다(구간 5).
- 무결성·네트워크 까닭 가르기는 자원 시간 기록 추정이다. 상태 칸이 없는 브라우저(WebKit)에서 본문이 있는 오류 응답(예 nginx 404 쪽)은 `integrity`로 센다. 자원 시간 기록 버퍼(브라우저 기본 250개)가 가득 차거나 브라우저가 실패한 요청을 기록하지 않으면 `network`로 센다.
- 원격 빌드의 webpack Trusted Types 정책(`peaket-webpack-<원격>`)은 한 파일이라 덩어리를 받지 않아 만들어지지 않는다. 이름은 `trusted-types` 목록에 그대로 둔다(원격이 다시 덩어리를 나누면 쓴다).
- 호스트가 공유 모듈을 eager로 내놓아 진입 HTML이 싣는 `main` 파일이 커졌다(gzip 3.5kB → 7.5kB, 첫 화면 전체 양은 같다).
- 접은 위젯 수와 [모두 펼치기] 줄(d5 §7.2 '접은 위젯')은 실제 값 화면에 아직 없다(보드 줄은 퍼블리싱 상태다). 태블릿·휴대폰 보드는 실제 값 원격 자리를 그리지 않는다(ADR-0360과 같다).
- 숨긴 탭에서 멈출 주기 조회 위젯(`refresh: { pollMs }`)은 지금 없다. 처음 그런 위젯이 생기면 같은 숨김 신호(`setLiveHidden`)로 멈춘다.
- 원격 위젯의 판정 시험(FE-T17·FE-T25·FE-T26·FE-T39)은 시험 담당이 쓴다. F-03-1의 화면 검사(`tools/web-checks/console-csp/console.spec.mjs`)는 옛 원격 경로(`/remotes/<이름>/remoteEntry.js`)와 위젯 덩어리 파일을 기다려 새 꼴로 바꿔야 한다.
- 되돌릴 조건: 원격이 커져 한 파일이 원격 예산(80KB [가정])을 넘거나 늦게 싣기 이득이 생기면, 원격 덩어리마다 무결성을 거는 길(결정 2의 대안)을 새 ADR로 다시 본다.
