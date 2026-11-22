# 작업 계획: W12-problem-types-2 — CI가 잡은 오류 유형 하나와 게이트웨이 생성물을 맞춘다

- **무엇**: `develop` `693e62c11`에서 CI 검사 두 개가 실패한다. ⑴ 공용 서버 패키지 시험 `PRF192_서비스 코드의 이름 붙은 오류는 모두 목록에 있고 상태 코드와 제목이 같다`가 core-svc의 `sale-suspension-conflict`를 오류 목록에서 찾지 못한다. ⑵ `node tools/ci/gateway-routes.mjs --check`가 게이트웨이 라우트 생성 파일 다섯(`gw-fan`·`gw-ops`·`gw-partner`·`gw-queue`·`gw-scanner`)의 계약 지문(sha256)이 지금 openapi와 다르다고 실패한다. 검토 기록이고 규범이 아니다. 정본과 다르면 정본이 이긴다.
- **바탕**: 작업 폴더 `D:/ticketpass-lane2-sr13`, 가지 `feature/lane3-W12-problem-types-2`, 출발점 `origin/develop` `693e62c11`.
- **정본**: `docs/api/guidelines.md` §2 '`type`·상태 코드·`title`은 한 묶음이다'(한 오류 이름은 늘 같은 상태 코드와 제목, 새 오류 이름은 목록에 먼저 더한다), 오류 목록 `docs/api/openapi.yaml` 맨 위 `x-peaket-problem-types`, 게이트웨이 라우트 생성 규칙 `docs/infra.md` §4.1 '경로별 메서드·한도·게이트웨이 오류'(D-T42), 판매 중지·재개 문장 `docs/features/settlement.md`의 관련 ID 표.
- **등급·차례**: C(계약·생성물 정합), 시험 먼저(`docs/architecture.md` §8.6 5), 짧은 고리.

## 계획

### 1. 틀린 곳 두 군데

| # | 검사 | 지금 | 까닭 |
| --- | --- | --- | --- |
| 1 | `pnpm.cmd --filter @peaket/platform test test/problem-types.test.ts` | 2개 중 **1 실패**(PRF192) | 서비스 코드가 내는 `core-svc sale-suspension-conflict`가 `x-peaket-problem-types`에 없다. 자리는 `services/core-svc/src/modules/catalog/inbound/internal-sale-suspension.controller.ts:39`이고 `{ type: 'sale-suspension-conflict', status: 409, title: '판매 승인 상태와 맞지 않습니다' }`다 |
| 2 | `node tools/ci/gateway-routes.mjs --check` | **5건 다름**, 끝 코드 1 | 다섯 생성 파일 둘째 줄의 `openapi info.version 1.0.0-draft · 계약 sha256 …`이 저장소 `65f89e95…`인데 지금 openapi로 다시 만들면 `8243ca89…`다. W12-identity-problems 등에서 openapi가 바뀐 뒤 생성물을 다시 만들지 않았다 |

### 2. 바른 동작

1. **오류 목록에 한 줄을 더한다.** `docs/api/openapi.yaml`의 `x-peaket-problem-types.types`에서 알파벳 차례상 `sale-setting-locked` 바로 뒤(336·337행 사이)에 `sale-suspension-conflict: { status: 409, title: "판매 승인 상태와 맞지 않습니다" }`를 넣는다. 서비스 코드의 type·status·title과 글자까지 같게 한다.
2. **생성물을 다시 만든다.** `pnpm.cmd --filter @peaket/contracts gen`, `pnpm.cmd --filter @peaket/api-client gen`, `node tools/ci/gateway-routes.mjs --write`를 돌린다. 생성기는 손으로 고치지 않는다. 라우트 생성 파일 다섯은 계약 지문(둘째 줄)만 바뀌어야 하고, 경로·메서드·백엔드·정책의 뜻은 그대로여야 한다. 다섯 파일을 모두 구현 커밋에 넣는다.
3. **정본 문장을 확인한다.** `docs/features/settlement.md`의 관련 ID 표에 `ops→core 판매 중지·재개 … 409 sale-suspension-conflict` 문장이 이미 있다. 새 이름과 같으므로 고치지 않고, 다른 곳에 이 이름을 잘못 적은 문장이 없는지 grep으로 확인한다. 없으면 정본 변경은 없다.
4. **계약 설명은 더하지 않는다.** 이 내부 경로(`POST /internal/v1/events/{eventId}/sale-review-result`)는 게이트웨이를 지나지 않아 openapi 경로에 없다. 그래서 409 응답 설명을 맞출 자리가 없고, 오류 목록 한 줄만 더한다. 새 오류 이름을 만들지 않는다(이미 서비스 코드가 쓰는 이름을 목록에 올리는 일이다).

### 3. 손댈 파일

- 계약: `docs/api/openapi.yaml`(`x-peaket-problem-types` 한 줄).
- 생성물: `packages/contracts/src/gen/`(바뀔 것이 없을 수 있다), `packages/api-client/src/gen/problem-types.ts`(type union과 `PROBLEM_TYPES` 표 두 줄). `deploy/gateways/gw-fan.routes.yaml`·`gw-ops.routes.yaml`·`gw-partner.routes.yaml`·`gw-queue.routes.yaml`·`gw-scanner.routes.yaml`(계약 지문 줄).
- 시험: 새 시험 파일을 만들지 않는다. 이미 있는 PRF192가 이 어긋남을 잡고, core-svc 통합 시험 `sale-suspension.int.test.ts` 263·266행이 409의 type이 `…/sale-suspension-conflict`임을 이미 단언한다(새 openapi 이름과 같다). 게이트웨이 생성물은 `gateway-routes --check`와 `tools/ci/gateway-routes.test.mjs`의 D-T42 ①②가 잡는다. 시험 담당은 구현 전 트리에서 이 셋이 실패하는 것을 확인해 계획 '실패 확인'에 적는다.
- 정본: 바꾸지 않는다(2의 3).

### 4. 시험과 게이트(시험 담당이 구현 전에 실패를 본다)

| 시험 | 자리 | 단언 |
| --- | --- | --- |
| PRF192(기존) | `packages/platform/test/problem-types.test.ts` | 서비스 코드의 모든 이름 붙은 오류가 목록에 있고 status·title이 같다. 구현 전에는 `core-svc sale-suspension-conflict`가 빠져 실패하고, 구현 뒤에는 통과한다. 시험 파일은 고치지 않는다 |
| `S-T?` 판매 중지·재개 409(기존) | `services/core-svc/test-int/sale-suspension.int.test.ts` 263·266행 | 초안 공연에 중지·재개를 보내면 409이고 `type`이 `https://peaket.example/problems/sale-suspension-conflict`다. Docker가 필요하다 |
| D-T42 ①②(기존) | `tools/ci/gateway-routes.test.mjs` | 저장소의 생성 파일이 지금 openapi와 원천으로 다시 만든 것과 같다. 구현 전에는 다섯 파일의 지문이 달라 실패하고, `--write` 뒤에는 통과한다 |
| 생성물 대조 | `contracts gen:check`·`api-client gen:check` | 생성물이 계약과 같다 |

### 5. 틀린 구현 표본(검증 담당용)

| # | 틀린 구현 | 잡을 시험·검사 |
| --- | --- | --- |
| S1 | openapi 목록에서 `sale-suspension-conflict` 줄을 빼고 생성물만 둔다 | PRF192(실패: `core-svc sale-suspension-conflict`) |
| S2 | 게이트웨이 생성 파일 하나(예 `gw-fan.routes.yaml`)를 옛 지문으로 되돌린다 | `gateway-routes.mjs --check`(실패: 그 파일이 다름), D-T42 ①② |

### 6. 범위 밖

- **다른 오류 이름**: PRF192가 이미 통과하는 이름은 건드리지 않는다. 이 묶음은 `sale-suspension-conflict` 한 줄만 더한다.
- **내부 경로의 계약 문서화**: `POST /internal/v1/events/{eventId}/sale-review-result`를 openapi에 새로 적는 일은 내부 경로 정리 묶음 몫이다. 지금은 오류 목록 정합만 본다.
- **라우트 원천·정책**: `deploy/gateways/routes/`의 원천과 메시 정책은 바꾸지 않는다. `--write`는 openapi 지문만 갱신한다.
- **장부·단계**: 새 시험 ID가 없고 BUILD_ORDER 단계·wbs 상태 변화도 없다. 기록만 R-767로 남긴다.

## 실패 확인

시험 담당 `w12pt2-test`(deepseek-v4.1-flash), 2026-11-22 16:49 KST. 기준 트리 `17626ee26`(계획 커밋)에서 구현 없이 돌렸다.

| 검사 | 결과 | 까닭 |
| --- | --- | --- |
| `pnpm.cmd --filter @peaket/platform test test/problem-types.test.ts` | 2개 중 **1 실패**(PRF192), 1 통과 | `missing`이 `[ 'core-svc sale-suspension-conflict' ]`다. 상태 코드·제목 대조에는 닿지 않았다 |
| `node tools/ci/gateway-routes.mjs --check` | **5건 다름**, 끝 코드 1 | 저장소 지문 `65f89e95…`, 지금 openapi로 만든 지문 `8243ca89…`. 다섯 파일 모두 둘째 줄만 다르다 |
| `node --test tools/ci/gateway-routes.test.mjs` | D-T42 ①② **1 실패** | 같은 까닭. 저장소 생성 파일이 지금 openapi와 원천으로 다시 만든 것과 다르다 |

- core-svc 409 단언은 `services/core-svc/test-int/sale-suspension.int.test.ts` 263·266행이 `{ type: 'https://peaket.example/problems/sale-suspension-conflict' }`를 이미 단언한다. 이 이름은 계획이 더할 목록 줄과 같아 시험 파일을 고칠 필요가 없다. 이 시험은 openapi를 읽지 않으므로 구현 전에도 통과한다(구현 뒤 회귀 확인만 한다).
- 실패가 구현을 요구하는 방향으로 먼저 섰다. 새 시험 파일은 만들지 않았다(계획 3).

## 구현 메모

구현 담당 `w12pt2-impl`(deepseek-v4.1-flash), 2026-11-22 16:50~16:53 KST.

- **계약**: `x-peaket-problem-types`의 `sale-setting-locked` 뒤에 `sale-suspension-conflict: { status: 409, title: "판매 승인 상태와 맞지 않습니다" }`를 더했다. 서비스 코드(`internal-sale-suspension.controller.ts:39`)와 status·title이 글자까지 같다.
- **생성물**: `contracts gen`은 바뀐 것이 없고(생성물이 이 목록을 쓰지 않는다), `api-client gen`이 `problem-types.ts`의 union과 `PROBLEM_TYPES` 표에 두 줄을 더했다. `gateway-routes --write`가 다섯 생성 파일의 둘째 줄 계약 지문만 `65f89e95…`에서 `4850cf22…`로 바꿨다. 경로·메서드·백엔드·필터는 그대로다(`git diff` 1줄씩).
- **구현 중 드러난 셋째 어긋남**: 목록 줄을 더하니 PRF192가 `missing` 단언을 지나 제목 단언으로 넘어가, BAT-455 알림 코드가 남긴 제목 불일치 두 개를 보고했다. `fan-notify.controller.ts:56`의 `invalid-query` 제목 `eventIds는 50개까지입니다`와 `internal-notify-identity.controller.ts:38`의 `invalid-body` 제목 `identity 사건 모양이 올바르지 않습니다`다. 표준 제목(`목록 조건이 올바르지 않습니다`·`요청 본문이 올바르지 않습니다`)으로 바꾸고 구체 사유는 `detail`로 내렸다. 새 type은 만들지 않았다(guidelines §2). 첫 실패 확인 때는 `missing` 단언이 먼저 서 이 둘이 보이지 않았다.
- **게이트**: platform PRF192 2/2, `gateway-routes --check` 0, `gateway-routes.test.mjs` 41/41, `contracts gen:check` 같음, `api-client gen:check` 같음·`api-client test` 116/116, core 알림 시험 3파일 11/11, typecheck 4패키지(의존 포함 10 tasks), `pnpm lint` 0.

## 리뷰

리뷰 담당 `w12pt2-review`(deepseek-v4.1-flash), 2026-11-22 16:56 KST. 받은 것은 `git diff origin/develop..7819c5523`(계획·시험·구현)과 이 계획 파일이다. 코드·계약·생성물·정본을 대조했고 PRF192 2/2, `gateway-routes --check` 0, `gateway-routes.test.mjs` 41/41을 다시 돌렸다. 코드는 고치지 않았다.

결과: **막는 지적 0**, 중간 1·낮음 2(남은 위험).

| 번호 | 심각도 | 위치 | 근거 | 고칠 방향 |
| --- | --- | --- | --- | --- |
| RV-01 | 중간(남은 위험) | `services/core-svc/src/modules/notify/inbound/fan-notify.controller.ts:39`, `internal-notify-identity.controller.ts:47`, `application/dispatcher.ts:36`, `application/webhooks.ts:31`·`domain/webhook.ts:91~98` | 아직 `title: e.message`처럼 변수 제목을 공용 type에 싣는 자리가 남아 한 이름이 여러 제목을 낸다(예 `not-found`에 `회차를 찾을 수 없습니다`, `sale-ended`에 `판매가 끝났습니다`, `webhook-url-not-allowed`에 여섯 가지 사유). guidelines §2에 어긋나지만 PRF192는 제목이 글자 그대로인 객체만 읽어 보지 못한다. BAT-455에서 들어온 기존 어긋남이고 이 묶음이 만든 것이 아니다 | 후속 묶음에서 표준 제목 + `detail`로 모으고, PRF192가 변수 제목 자리도 보도록 넓힌다. 이번에 넓히면 알림 오류 문구·시험이 함께 흔들려 범위를 넘는다 |
| RV-02 | 낮음(남은 위험) | `docs/api/openapi.yaml` `x-peaket-problem-types` | `sale-suspension-conflict`를 내는 `POST /internal/v1/events/{eventId}/sale-review-result`는 게이트웨이를 지나지 않아 openapi 경로에 없다. 그래서 목록 줄만 있고 응답 설명은 없다. `docs/features/settlement.md:381`이 409 이름과 뜻을 적고 있어 지금은 추적된다 | 내부 경로를 계약에 적는 묶음이 생기면 409 설명도 함께 적는다 |
| RV-03 | 낮음(남은 위험) | `services/core-svc/src/modules/notify/inbound/fan-notify.controller.ts:56`, `internal-notify-identity.controller.ts:38` | 구현 중 드러난 두 제목을 표준으로 바꿔 알림 400 응답의 `title`이 달라진다. 화면·시험·문서에서 옛 제목을 찾는 곳은 grep 0건이고 `detail`에 같은 사유가 남아 뜻은 그대로다. 소비자가 title을 문구로 쓰면 문구가 바뀐다 | 기록에 '의도한 문구 변경'으로 남긴다. 소비 화면은 오류 문구 키를 type에서 고르므로 영향이 없다 |

### 확인한 것(지적 아님)

- **한 이름 한 상태·제목**: 새 `sale-suspension-conflict`는 서비스 코드·openapi 목록·api-client 생성 표가 모두 409 `판매 승인 상태와 맞지 않습니다`로 글자까지 같다. 목록에 중복이 없고(354개), 알파벳 차례(`sale-setting-locked` 뒤)에 들어갔다.
- **생성물**: `contracts gen`은 바뀐 것이 없고(이 목록을 쓰지 않는다), `api-client`는 union과 표 두 줄만 바뀌었다. 두 패키지 `gen:check`가 같다. 손으로 고친 생성물은 없다.
- **라우트 의미 불변**: 다섯 생성 파일의 차이는 둘째 줄 계약 지문 하나씩(`65f89e95…`→`4850cf22…`)뿐이다. 경로·메서드·백엔드·필터·정책은 한 줄도 바뀌지 않았다(`git diff`로 확인). `gateway-routes --check` 0, D-T42 41/41.
- **정본**: `docs/features/settlement.md:381`의 `409 sale-suspension-conflict` 문장이 새 목록 이름과 같아 고치지 않았다. 다른 곳에 이 이름을 다르게 적은 문장은 grep 0건이다.
- **숨은 두 제목**: `invalid-body`·`invalid-query`의 표준 제목(openapi 157·158행)과 글자까지 같고, 사유는 고정 글자 `detail`로 내려 요청 값이 새지 않는다. BAT-455 알림 시험 3파일 11/11이 통과한다.
- **시험·구현 분리**: 시험 커밋은 계획만, 구현 커밋은 시험 파일을 건드리지 않았다. `git diff --check`에 공백 오류가 없다.

## 검증

## 담당 표

| 역할 | 세션 ID | 모델 | 시작 | 끝 |
| --- | --- | --- | --- | --- |
| plan | w12pt2-plan | deepseek-v4.1-flash | 2026-11-22T16:47:00+09:00 | 2026-11-22T16:55:00+09:00 |
| test | w12pt2-test | deepseek-v4.1-flash | 2026-11-22T16:55:00+09:00 | 2026-11-22T17:00:00+09:00 |
| impl | w12pt2-impl | deepseek-v4.1-flash | 2026-11-22T17:00:00+09:00 | 2026-11-22T17:08:00+09:00 |
| review | w12pt2-review | deepseek-v4.1-flash | 2026-11-22T17:08:00+09:00 | 2026-11-22T17:15:00+09:00 |
| verify | w12pt2-verify | deepseek-v4.1-flash | 2026-11-22T17:15:00+09:00 | 2026-11-22T17:30:00+09:00 |
