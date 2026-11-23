# ADR-0360: 관제 SSE 흐름 둘을 알림 표·트리거로 잇고, 팀 위젯 둘을 Module Federation 원격으로 실으며, 관제·파트너 콘솔 보안 헤더를 붙인다(F-03-1, OPS-340)

- **상태**: 채택(2026-11-23, 추천 적용. 기능 F-03-1 계획 `docs/review/plans/F-03-1.md`의 '감독에게'·'정할 것과 추천'을 구현 담당이 정본에 옮겼다. 감독 승인 조건 넷(2026-11-23)을 따랐다). 결정 7(파트너 좁은 기본 정책)은 소유자 결정 2026-11-23("추천대로", 감독 전달)이다.
- **관련**: ADR-0100(결정 1·2·4·6), ADR-0103, ADR-0204(결정 4), ADR-0079(결정 14·16), ADR-0092, ADR-0102, [docs/frontend.md](../frontend.md) §3.10·§4.4.4·§4.4.5·§5.14.1, [docs/features/control-tower.md](../features/control-tower.md) §12·§13, [docs/data.md](../data.md) `ops_push_event`·`ops_presence`, docs/api/openapi.yaml(`/v1/ops/live`·`/v1/ops/events/{eventId}/live`·`/v1/ops/widgets/{widgetKey}`), docs/api/asyncapi.yaml(`sse.ops-live`·`sse.ops-event-live`), BUILD_ORDER F-03-1·OPS-340

## 맥락

- ops-svc의 늘 여는 흐름은 시각(ms)을 id로 쓰고 `audit` 사건·`: ping`을 냈다. 알림 표·접속자 표·위젯 흐름·위젯 조회가 없었다. 콘솔에는 Module Federation이 없고 위젯은 고정 자료를 받았다. 파트너 proxy는 두 경로에만 헤더를 달았다.
- 같은 시각 갈래 4(F-02-1)가 ops-svc `app.module.ts`·`main.ts`·`modules/commands/**`·마이그레이션 0025를 고친다. 이 기능은 그 파일들을 고치지 않는다(계획 '감독에게' 1).
- 새 패키지 의존성을 더하지 않는다(구현 지시). 계획이 적은 `@module-federation/enhanced`는 더하지 않았다.

## 결정

1. **알림 표 쓰기는 DB 트리거다.** 마이그레이션 0028이 `ops_push_event`(seq 시퀀스, kind, event_id, roles, body, created_at)·`ops_presence`와 트리거 둘을 만든다. `ops_command` 행이 생기거나 state가 바뀌면 `command` 한 줄, 승인 대기(PENDING_APPROVAL·REVERT_PENDING)면 `approval` 한 줄을 더 쓴다. 경보는 지금 코드의 경보 표 `ops_alert`(data.md의 `ops_alert_record` 자리)에 행이 생기거나 `resolved_at`이 바뀌면 `alert` 한 줄을 쓴다. 트리거라 원래 기록과 같은 트랜잭션이고 되돌리면 함께 없어진다. 본문은 참조값과 상태만 싣고, 운영자마다의 화면 모양(명령 목록 한 줄, canApprove)은 흐름을 내는 파드가 명령 저장소로 다시 읽어 만든다. 1시간 지난 행은 live 모듈의 정비 반복(1분 [가정])이 지운다.
2. **순번의 빈 번호**: 순번은 커밋 차례와 다를 수 있고 되돌린 트랜잭션은 번호를 남긴다. 파드의 읽기는 빈 번호에서 멈추고 2초 [가정] 뒤에도 비면 건너뛴다. 다시 붙기 판정은 시퀀스의 마지막 값보다 크면 `invalid`, 창(1시간) 안 가장 오래된 행보다 앞이면 `too-old`다. `reset`의 id는 지금 순번이라 다음 다시 붙기는 그 뒤부터다. Last-Event-ID가 없으면 첫 덩이에 지금 순번을 id로만 둔다(사건 전에 끊겨도 빠지지 않는다). **(2026-11-23 리뷰 반영 RV-01·RV-02)** '지금 순번'은 시퀀스 값이 아니라 커밋된 마지막 번호이고, 파드의 연결이 0이 되어 읽기를 멈추면 버렸다가 다음 연결 때 다시 잡는다. 2초 [가정]를 넘겨 건너뛴 번호는 1시간 [가정] 동안 읽을 때마다 같은 문장으로 다시 보고, 늦게 커밋되면 늦게라도 보내며(정규 로그 `ops-live-gap-skipped`를 남긴다), 그 늦은 행을 받았는지 모르는 다시 붙기 커서는 그 행 앞부터 다시 보낸다.
3. **메모리 조립(단위 시험·`memory: true`)**은 트리거 대신 명령 저장소를 훑어 같은 모양의 행을 쌓는다. 경보는 싣지 않는다(DB 조립이 싣는다). `LiveModule.register(feed)` 호출 모양은 그대로이고, 모듈이 전역 `DATABASE`를 있으면 받아 DB 길을 고른다.
4. **받는 사람**: `command`·`alert`는 viewer·operator·commander(명령 목록 REST와 같다). `approval`은 operator·commander 가운데 그 명령을 승인할 수 있는 사람(`canApproveOf`, 요청자 ≠ 승인자)에게만 간다. CS 역할은 늘 여는 흐름을 열 수 있지만 위 사건을 받지 않는다.
5. **흐름 닫기**: 액세스 토큰 만료는 gw-ops JWT 정책이 `exp`를 내부 머리 `X-User-Token-Exp`로 넣고(바깥 요청의 같은 머리는 `x-user-` 앞부분 지우기가 먼저 지운다) ops-svc가 그 시각과 '연 시각 + 15분' 가운데 이른 쪽에 닫는다. 세션 종료는 5초 [가정]마다 platform 종료 세션 목록을 본다. 읽지 않아 쌓인 양(소켓 `writableLength`)이 1MiB [가정]를 넘으면 닫는다. 닫힌 까닭(`token-expired`·`session-ended`·`backpressure`·`client`)은 정규 로그 `ops-live-closed`로 남긴다. 계획의 `x-peaket-token-exp`는 지우기 규칙이 따로 필요해 `X-User-Token-Exp`로 바꿨다.
6. **Module Federation은 webpack 5 내장 `ModuleFederationPlugin`으로 한다.** 호스트는 공유 싱글턴(react·react-dom·react/jsx-runtime)만 선언하고, 원격 둘은 실행 중에 `/remotes/<이름>/remoteEntry.js`를 받아 컨테이너를 잇는다(동적 원격). 진입 파일 주소는 Trusted Types 정책 `peaket-remote`로만 `<script>`에 넣고, 정책은 빌드에 박은 원격 둘의 주소만 통과시킨다(계획 '감독에게' 6 (가)). webpack `output.trustedTypes` 이름은 호스트 `peaket-webpack-host`, 원격 `peaket-webpack-queue`·`peaket-webpack-purchase`다. 경계: 이 기능은 정책 이름과 고정 목록, F-03-2(OPS-350)는 목록 원천(`remotes.json`)·sha384 무결성·계약 주판·대체 카드다. `@module-federation/enhanced` 런타임 플러그인이 필요해지면 F-03-2가 의존성 추가와 함께 정한다.
7. **파트너 Trusted Types(ADR-0204 결정 4가 넘긴 것, 소유자 결정 2026-11-23)**: 루트 레이아웃이 `<head>` 맨 앞에 같은 출처 파일 `/trusted-types-default.js`(요청 nonce, SHA-384 무결성)로 **좁은 `default` 정책**을 만든다. 같은 출처 `/_next/static/` 아래 `.js` 주소의 `createScriptURL`만 통과시키고, 목록 밖 주소는 값을 주지 않아 위반으로 남으며, `createHTML`·`createScript`는 정의하지 않는다. 보고 모드 목록은 실제로 만드는 이름만 `peaket peaket-paste nextjs default`다(Next.js 16 빌드는 Turbopack이라 `nextjs#bundler`를 만들지 않는다). proxy는 정적 자산·`/_next` 밖 모든 화면 경로로 넓히고 `PAGE_HEADERS.partner`·Reporting-Endpoints·`Cache-Control: private, no-store`를 단다. 루트 레이아웃이 요청 nonce를 읽어 모든 화면이 요청 때 그려진다. 막는 모드로 바꾸는 것은 이 결정에 없다(§5.14.1 '30일 위반 없음').
8. **관제 헤더 붙이는 곳**: 개발 서버는 묶음 C CSP와 Trusted Types를 보고 모드로(eval 소스 맵·HMR), 미리보기 서버(`apps/console-host/scripts/preview-server.mjs`)와 로컬 데모 nginx는 `staticAppHeaders('console')` 그대로(CSP 막는 모드, Trusted Types 보고 모드). 운영 CloudFront 정책은 구간 5(HOT-450)다.
9. **팀 위젯 범위와 위젯 키**: 원천이 지금 있는 둘만 실제 값으로 잇는다. `queue-admission-rate.summary`(admission-ctrl 지표)·`purchase-pg-status.summary`(payment-svc 지표), 원천은 클러스터 안 Prometheus(`PEAKET_PROMETHEUS_URL`, 없으면 늘 `source-unavailable`)다. 파드마다 (회차, 키)별로 1초 [가정]에 한 번 계산해 나눠 준다. 나머지 일곱 위젯은 원천 기능이 ops-svc live 모듈의 `WidgetSource` 포트(`keys`, `read(key, { eventId, nowMs, range? })`, 실패는 `WidgetSourceUnavailable`)에 어댑터를 더한다. 갈래 1 OPS-160 실시간 표도 이 포트로 붙는다. 값은 숫자·상태만 싣고 화면 글자는 위젯 팀이 만든다.
10. **계약 꼴**: 위젯 조회 응답은 `oneOf`로 묶으면 계약 깨짐 검사(oasdiff `response-body-one-of-added`)에 걸린다. 그래서 `OpsWidgetValue`는 `type: object`에 공통 네 칸(widgetKey·source·at·eventId)과 `error`를 두고, 키별 모양은 스키마 이름(`OpsWidgetQueueAdmissionRateSummary`·`OpsWidgetPurchasePgStatusSummary`·`OpsWidgetUnavailable`)으로 가리킨다. 서버는 키별 모양으로 좁혀 낸다. `widgetKey` 경로 매개변수에 열거를 달지 않고 모르는 키는 404(조회)·422(흐름)다. 늘 여는 흐름에 선택 쿼리 `screen`(접속자 화면)을 더했다. asyncapi `OpsApproval`·`OpsReset` 본문을 정했다.
11. **브라우저 쪽 흐름은 EventSource 대신 fetch 스트림으로 읽는다.** EventSource는 주석 줄(`: hb`)을 알려 주지 않아 35초 무소식 감시를 할 수 없고, 다시 열 때 0~5초 무작위와 `Last-Event-ID` 머리를 넣을 수 없다. 해석은 표준 event stream 규칙 그대로이고 `credentials: 'include'`로 쿠키를 싣는다(gw-ops CORS가 이미 `Last-Event-ID`를 허용한다). 탭마다 늘 여는 흐름 하나와 위젯 흐름 하나다. 서버가 닫거나 401이면 토큰을 갱신한 뒤(1초 + 0~5초) 다시 열고, 갱신이 401이면 `/login`으로 간다. 보이는 위젯 키 목록이 바뀌면 1초 묶어 위젯 흐름만 다시 연다.
12. **로컬 실제 서버 길**: 콘솔 개발·미리보기 서버가 `PEAKET_OPS_PROXY_TARGET`(루프백 http만, local·ci만)이면 같은 출처 `/v1/ops/`를 ops-svc로 넘기고(SSE 그대로), `PEAKET_OPS_DEV_IDENTITY`가 있으면 신원 머리를 싣는다(gw-ops JWT 바꾸기 대역). 바깥 요청의 신원·게이트웨이 머리는 늘 지운다.
13. **명령 화면(SCR-030)**은 자기 EventSource를 열지 않고 호스트의 늘 여는 흐름을 함께 쓴다. `audit` 사건은 없앴고(계약에 없다), 감사 탭은 명령이 끝 상태(SUCCEEDED·FAILED·REVERTED)가 된 `command` 사건에서 체크포인트를 다시 읽는다.
14. **접속자**: `accountRef`는 관리 계정 ID(명령 목록의 `requestedBy.adminAccountId`와 같은 참조)다. 연결이 닫혀도 행을 지우지 않아 45초 안에 빠진다. 회차별로 모은 값이 지난번과 같으면 다시 보내지 않고, 새로 붙은 연결에는 바로 한 번 보낸다.
15. **콘솔 파일 자리**: 화면 층 규칙(pages가 app을 가져오지 못한다) 때문에 호스트 저장소·흐름·원격 적재기를 `src/shared/model/live-host.ts`·`src/shared/api/live/`·`src/shared/lib/remotes/`에 둔다. 원격 빌드는 지금 호스트 webpack 설정의 다중 컴파일러(호스트·queue·purchase)이고, 팀 저장소별 원격 빌드 공용 워크플로는 F-03-2다.

## 검토한 대안

| 대안 | 낫다 | 걸린다 | 판단 |
| --- | --- | --- | --- |
| 명령 쓰기 객체에 `push()`를 더함(트리거 대신) | 트리거 없이 코드로 보인다 | 갈래 4가 고치는 commands 모듈과 부딪친다 | 쓰지 않는다 |
| `@module-federation/enhanced` + `createScript` 플러그인 | 정본 판과 같고 무결성 플러그인을 바로 쓴다 | 새 의존성(지시가 막음) | F-03-2가 다시 본다 |
| EventSource 그대로 | 브라우저 내장 | 35초 감시·무작위·Last-Event-ID 머리를 못 한다 | 쓰지 않는다 |
| 위젯 응답 `oneOf` | 생성 타입이 키별로 갈린다 | 계약 깨짐 검사 실패(예외는 소유자 승인) | 쓰지 않는다 |
| 파트너 넓은 `default`(HTML 해석까지 통과) | 위반이 바로 0 | ADR-0204가 버렸다 | 쓰지 않는다 |

## 결과와 남는 한계

- 메모리 조립에는 경보 사건이 없다. 경보 흐름은 DB 조립·통합 시험이 본다.
- 결제사 위젯의 승인률·승인 호출 p99·결제 확정 p99, 입장 위젯의 곧 입장 대기 p99는 원천 지표가 없어 '—'다.
- 닫힘 까닭 지표(`reason` 이름표)는 main.ts의 서비스 레지스트리 연결이 필요해 이번에는 로그만 남긴다(F-02-1 합친 뒤 붙인다).
- 퍼블리싱 화면(`?state=`)은 위젯 패키지를 호스트 묶음으로 그대로 그린다(대시보드 덩어리에 든다). 실제 값 화면만 원격을 싣는다.
- 실제 값 화면에서 원천이 붙기 전인 위젯 일곱은 고정 자료를 그리되 '원천 연결 전' 배지와 `data-source="pending"`을 단다(2026-11-23 리뷰 반영 RV-04, docs/frontend.md §5.7). 태블릿·휴대폰 보드는 아직 실제 값 화면을 따로 그리지 않는다.
- reset 뒤 경보 다시 읽기(FE-T28 ②의 경보 몫)는 경보 목록 REST가 계약에 없어 이 기능에서 하지 않고 F-03-3(경보 패널)이 경보 목록 REST와 함께 한다(2026-11-23 리뷰 반영 RV-03). 이 기능은 승인 대기만 다시 읽는다.
- 다시 붙기의 늦은 행 되돌려 보내기는 파드마다의 기록이라, 늦게 커밋될 때 읽기를 멈춰 있던 다른 파드나 늦은 커밋 뒤 새로 뜬 파드(배포 중)로 다시 붙으면 그 행은 흐름으로 오지 않고 같은 대상의 다음 사건·REST로만 맞춰진다. 경보는 목록 REST가 없어 그 경보의 다음 변화까지 화면에 없다(경보 목록 REST와 함께 F-03-3에서 닫는다, 2026-11-23 재리뷰 R-03).
- 되돌릴 조건: ADR-0100의 되돌릴 조건과 같다. 빈 번호 기다림 때문에 알림 p99가 1초 [가정]를 넘으면 기다림을 줄이거나 커밋 순서를 지키는 읽기(xmin 기준)로 바꾼다.
