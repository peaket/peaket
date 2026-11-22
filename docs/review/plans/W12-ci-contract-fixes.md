# 작업 계획: W12-ci-contract-fixes — CI가 잡은 ticket-svc 오류 여덟과 데모 출처 검사를 맞춘다

- **무엇**: `develop` `b918960c6`에서 CI 검사 두 개가 실패한다. ⑴ 공용 서버 패키지 시험 `PRF192_서비스 코드의 이름 붙은 오류는 모두 목록에 있고 상태 코드와 제목이 같다`가 ticket-svc가 내는 이름 여덟(`recipient-not-found`·`transfer-closed`·`reoffer-not-allowed`·`ticket-ended`·`transfer-expired`·`transfer-not-offered`·`payer-holds`·`entry-recorded`)을 계약의 오류 목록에서 찾지 못한다. 여덟은 BAT-410이 ticket-svc에 양도·돌려주기를 넣으며 더한 이름이다(2026-11-22). ⑵ `node --test tools/local/demo-images.test.mjs`의 `DS-04 오버레이의 출처는 포트를 포함한다`가 `identity-svc.yaml`의 `PEAKET_STAFF_INVITATION_URL https://www.peaket.example:18441/staff/invitations`를 `demoOrigins`에 없다고 실패한다. 이 값은 경로가 붙은 URL이라 출처(origin)는 맞는데 글자까지 같은 값만 찾는 검사가 틀렸다. 검토 기록이고 규범이 아니다. 정본과 다르면 정본이 이긴다.
- **바탕**: 작업 폴더 `D:/ticketpass-lane2-sr13`, 가지 `feature/lane3-W12-ci-contract-fixes`, 출발점 `origin/develop` `b918960c6`.
- **정본**: `docs/api/guidelines.md` §2 '`type`·상태 코드·`title`은 한 묶음이다'(한 오류 이름은 늘 같은 상태 코드와 제목, 새 오류 이름은 목록에 먼저 더한다), 오류 목록 `docs/api/openapi.yaml` 맨 위 `x-peaket-problem-types`, 게이트웨이 라우트 생성 규칙 `docs/infra.md` §4.1 '경로별 메서드·한도·게이트웨이 오류'(D-T42), 로컬 데모 출처 `docs/review/plans/BAT-087.md` §6 DS-04·`tools/local/demo-objects.mjs`의 `demoOrigins`.
- **등급·차례**: C(계약·생성물·시험 정합), 시험 먼저(`docs/architecture.md` §8.6 5), 짧은 고리.

## 계획

### 1. 지금 실패하는 둘

| # | 검사 | 지금 | 까닭 |
| --- | --- | --- | --- |
| 1 | `pnpm.cmd --filter @peaket/platform test test/problem-types.test.ts` | 2개 중 **1 실패**(PRF192) | `missing`이 ticket-svc 여덟 이름이다. 자리는 `services/ticket-svc/src/modules/ticket/inbound/transfers.controller.ts`의 `problem()`이고, 오류 목록에 이름이 없어 상태·제목 대조에는 닿지도 못했다 |
| 2 | `node --test tools/local/demo-images.test.mjs` | 14개 중 **1 실패**(DS-04) | `identity-svc.yaml`의 `PEAKET_STAFF_INVITATION_URL`이 `https://www.peaket.example:18441/staff/invitations`인데, 검사는 값 전체가 `demoOrigins()` 값과 글자까지 같아야 한다고 본다. 출처 `https://www.peaket.example:18441`는 `demoOrigins().www`와 같다 |

### 2. 바른 동작

1. **오류 목록에 여덟 줄을 더한다.** 서비스 코드의 `ProblemError` 인자와 status·title을 글자까지 같게 적고, 목록의 알파벳 차례 자리에 넣는다. 자리는 아래 표와 같다.

   | 이름 | status | title | 넣을 자리(지금 파일) |
   | --- | --- | --- | --- |
   | `entry-recorded` | 409 | `입장 기록이 있어 돌려줄 수 없습니다` | `entry-started` 앞(124행) |
   | `payer-holds` | 409 | `이미 결제자가 보유한 티켓입니다` | `payout-approval-conflict` 앞(177행) |
   | `recipient-not-found` | 404 | `받을 수 있는 회원을 찾지 못했습니다` | `reauth-step-invalid`(308행)와 `refresh-token-invalid`(309행) 사이 |
   | `reoffer-not-allowed` | 409 | `받은 티켓은 다시 양도할 수 없습니다. 결제자에게 돌려주세요` | `refund-rejected`(311행)와 `report-limited`(312행) 사이 |
   | `ticket-ended` | 409 | `이미 끝난 티켓입니다` | `too-many-requests` 앞(378행) |
   | `transfer-closed` | 409 | `양도 마감(공연 시작 2시간 전)이 지났습니다` | `transfer-locked` 앞(379행) |
   | `transfer-expired` | 409 | `양도 요청 기한이 지났습니다` | `transfer-closed` 바로 뒤 |
   | `transfer-not-offered` | 409 | `진행 중인 양도 요청이 아닙니다` | `transfer-not-allowed`(381행) 뒤 |

   - 여덟 이름은 모두 `transfers.controller.ts` 한 곳에서만 나온다(다른 서비스·platform에 같은 이름의 다른 상태·제목이 없다, grep 0건).
   - 새 오류 이름을 만들지 않는다. 이미 서비스 코드가 쓰는 이름을 목록에 올리는 일이다.

2. **생성물을 다시 만든다.** `pnpm.cmd --filter @peaket/contracts gen`, `pnpm.cmd --filter @peaket/api-client gen`, `node tools/ci/gateway-routes.mjs --write`를 돌린다. 생성기는 손으로 고치지 않는다. 오류 목록이 바뀌면 api-client의 `problem-types.ts`(type union과 `PROBLEM_TYPES` 표)가 바뀌고, 게이트웨이 라우트 생성 파일 다섯은 둘째 줄 계약 지문(sha256)만 바뀌어야 한다. contracts 생성물은 이 목록을 쓰지 않아 바뀌지 않을 수 있다.

3. **데모 출처 검사는 값이 아니라 출처를 견준다.** `tools/local/demo-images.test.mjs`의 DS-04에서 `https://`로 시작하는 `*_ORIGIN`·`*_URL` 값을 `new URL(value).origin`으로 줄여 `demoOrigins()` 값 집합에 있는지 본다.
   - 포트 검사(`:18\d{3}(?:\/|$)`)는 값 전체에 그대로 둔다(경로가 붙어도 포트가 없으면 실패).
   - `_URL`이면서 `svc.cluster.local`인 값은 지금처럼 건너뛴다(클러스터 안 주소).
   - 다른 호스트의 출처는 `origin`이 집합에 없어 여전히 실패한다. 경로만 다른 같은 출처는 통과한다(의도).
   - `new URL`이 던지는 값은 `assert.fail`로 그 값과 함께 실패시킨다(조용히 건너뛰지 않는다).

### 3. 손댈 파일

| # | 파일 | 바꿀 것 |
| --- | --- | --- |
| 1 | `docs/api/openapi.yaml` | `x-peaket-problem-types.types`에 여덟 줄(§2의 1) |
| 2 | `packages/api-client/src/gen/problem-types.ts` | `gen`이 다시 만든 union·표(손으로 고치지 않는다) |
| 3 | `deploy/gateways/gw-fan.routes.yaml`·`gw-ops.routes.yaml`·`gw-partner.routes.yaml`·`gw-queue.routes.yaml`·`gw-scanner.routes.yaml` | `--write`가 다시 만든 둘째 줄 계약 지문 |
| 4 | `packages/contracts/src/gen/` | `gen`이 바꾼 것이 있으면 함께(없을 수 있다) |
| 5 | `tools/local/demo-images.test.mjs` | DS-04의 출처 비교(시험 쪽 커밋) |

- 정본 문장은 고치지 않는다. `docs/api/guidelines.md` §2가 이미 '한 이름 한 상태·제목'과 '목록에 먼저 더한다'를 정하고 있고, openapi 목록이 그 목록 자체다. BAT-087 계획 §6 DS-04도 '포트 붙은 출처'를 말하므로 경로가 붙은 URL을 출처로 보는 것이 맞다.

### 4. 시험과 게이트

| 시험·검사 | 자리 | 단언 |
| --- | --- | --- |
| PRF192(기존) | `packages/platform/test/problem-types.test.ts` | 서비스 코드의 모든 이름 붙은 오류가 목록에 있고 status·title이 같다. 구현 전에는 여덟이 `missing`으로 실패하고, 여덟 줄을 더하면 통과한다. 시험 파일은 고치지 않는다 |
| DS-04(고침) | `tools/local/demo-images.test.mjs` | 오버레이의 `https://` 출처 값의 `origin`이 `demoOrigins()`에 있다. 포트와 `svc.cluster.local` 예외는 그대로. 다른 호스트는 실패 |
| D-T42 ①②(기존) | `tools/ci/gateway-routes.test.mjs` | 저장소의 생성 파일이 지금 openapi와 원천으로 다시 만든 것과 같다. 구현 전에는 지문이 달라 실패하고 `--write` 뒤 통과 |
| 생성물 대조 | `contracts gen:check`·`api-client gen:check` | 생성물이 계약과 같다 |
| 회귀 | `node --test tools/local/demo-objects.test.mjs` | 같은 폴더의 오브젝트 시험이 출처·오버레이를 함께 보므로 깨지지 않아야 한다 |
| ticket 단위(영향) | `pnpm.cmd --filter @peaket/ticket-svc test` | 양도·돌려주기 시험이 그대로 통과한다(제품 코드는 바꾸지 않는다) |

- 시험 쪽 커밋은 DS-04 고침 하나다. PRF192는 기존 시험이 이미 잡고 있어 새 단언이 필요 없다.

### 5. 틀린 구현 표본(검증 담당용)

| # | 틀린 구현 | 잡을 검사 |
| --- | --- | --- |
| S1 | openapi 목록에서 여덟 줄 가운데 하나(예 `transfer-expired`)를 뺀다 | PRF192(실패: `ticket-svc transfer-expired`) |
| S2 | `deploy/envs/local/demo/identity-svc.yaml`의 `PEAKET_STAFF_INVITATION_URL` 호스트를 `www.peaket.example.evil`로 바꾼다(경로·포트는 그대로) | `node --test tools/local/demo-images.test.mjs` DS-04(실패: 출처가 `demoOrigins`에 없음) |

### 6. 넘기는 것

- **계약 깨짐 검사(`docs/api/breaking/openapi-ignore.txt`)는 이 묶음에서 고치지 않는다.** 오류 목록에 이름을 더하는 변경이 계약 깨짐 검사에 걸릴 수 있으나, 예외 목록 수정은 소유자 승인 대기다. 이 묶음은 목록 파일을 건드리지 않고, 승인 뒤 별도 묶음이 판단한다.
- **다른 오류 이름**: PRF192가 이미 통과하는 이름은 건드리지 않는다. 여덟 줄만 더한다.
- **ticket-svc 제품 코드**: 바꾸지 않는다. 코드가 정본(계약)보다 먼저 앞서 나간 상태를 계약 쪽에서 따라잡는 일이다.
- **장부·단계**: 새 시험 ID가 없고 BUILD_ORDER 단계·wbs 상태 변화도 없다. 기록만 R-772로 남긴다.

## 실패 확인

시험 담당 `w12ccf-test`(deepseek-v4.1-flash), 2026-11-22 19:17 KST. 기준 트리 `5fdf09000`(계획 커밋)에서 구현 없이 돌렸다.

| 검사 | 결과 | 까닭 |
| --- | --- | --- |
| `pnpm.cmd --filter @peaket/platform test test/problem-types.test.ts` | 2개 중 **1 실패**(PRF192), 1 통과 | `missing`이 `ticket-svc recipient-not-found`·`transfer-closed`·`reoffer-not-allowed`·`ticket-ended`·`transfer-expired`·`transfer-not-offered`·`payer-holds`·`entry-recorded` 여덟이다. 상태 코드·제목 대조에는 닿지 않았다 |
| `node --test tools/local/demo-images.test.mjs` | 14개 중 **1 실패**(DS-04) | `identity-svc.yaml의 PEAKET_STAFF_INVITATION_URL https://www.peaket.example:18441/staff/invitations가 demoOrigins에 없다`. 값 전체를 글자까지 견주는 검사가 경로 붙은 URL을 거절했다 |
| `node tools/ci/gateway-routes.mjs --check` | **통과**(끝 코드 0) | 지금 openapi와 생성 파일 지문이 같다. 오류 목록 여덟 줄을 더하면 지문이 바뀌므로 구현 때 `--write`가 필요하다(§2의 2) |
| `node --test tools/ci/gateway-routes.test.mjs` | **41/41 통과** | 같은 까닭(아직 계약이 바뀌지 않았다). 구현 때 다시 돈다 |

- **시험 쪽 고침 하나**: DS-04를 `new URL(value).origin` 비교로 바꾸고, 경로만 다른 같은 출처는 통과하고 다른 호스트(`https://www.peaket.example.evil:18441/...`)는 거절하는 읽는 법 단언을 더했다. 바꾼 뒤 이 파일은 **14/14 통과**한다. 고치기 전 실패는 위 표에 남긴다.
- PRF192는 기존 시험이 이미 여덟을 잡고 있어 파일을 고치지 않았다. 구현 전 실패가 구현을 요구하는 방향으로 먼저 섰다.
- `node --test tools/local/demo-objects.test.mjs`는 이 시험 커밋을 건드리지 않았고, 고치기 전에도 통과한다(회귀는 검증에서 다시 본다).

## 구현 메모

구현 담당 `w12ccf-impl`(deepseek-v4.1-flash), 2026-11-22 19:17~19:23 KST.

- **계약**: `docs/api/openapi.yaml`의 `x-peaket-problem-types.types`에 여덟 줄을 §2의 1 표 자리에 더했다. status·title은 `transfers.controller.ts`의 `ProblemError` 인자와 글자까지 같다.
- **구현 중 드러난 제목 어긋남 여섯**: `missing` 단언을 지나자 PRF192가 기존 목록 항목 여섯의 제목 불일치를 보고했다. `ticket-svc`의 같은 처리기가 공용 type에 이 서비스만의 제목을 싣고 있었다: `dependency-unavailable`(잠시 후 다시 시도해 주세요), `entry-started`(입장이 시작되어 바꿀 수 없습니다), `invalid-body`(요청이 올바르지 않습니다), `reauth-unavailable`(재인증을 확인하지 못했습니다), `transfer-locked`(부정 예매 조사가…), `transfer-pending`(이미 진행 중인…). 같은 type을 다른 서비스(payment·purchase·queue·ops·platform)는 목록의 표준 제목으로 내므로 목록을 바꾸면 그쪽이 깨진다. 그래서 `transfers.controller.ts`의 제목 여섯을 목록의 표준 제목으로 맞추고, 사유가 필요한 둘(`transfer-locked`·`transfer-pending`)은 구체 문장을 `detail`로 내렸다. 새 type은 만들지 않았다(guidelines §2).
- **생성물**: `contracts gen`은 바뀐 것이 없다(생성물이 이 목록을 쓰지 않는다). `api-client gen`이 `problem-types.ts`의 union과 `PROBLEM_TYPES` 표에 여덟 이름씩(16줄)을 더했다. `gateway-routes --write`가 다섯 생성 파일의 둘째 줄 계약 지문만 바꿨다(경로·메서드·정책 불변).
- **게이트(이 커밋에서 돈 것)**: platform PRF192 2/2, demo-images 14/14, `gateway-routes --check` 0, ticket-svc 단위 235/235, ticket-svc typecheck 0.

## 리뷰

리뷰 담당 `w12ccf-review`(deepseek-v4.1-flash), 2026-11-22 19:23 KST. 받은 것은 `git diff origin/develop..6c1976172`(계획·시험·구현)과 이 계획 파일이다. 코드·계약·생성물·정본을 대조했고, PRF192 2/2, demo-images·demo-objects 30/30, `gateway-routes --check` 0, `gateway-routes.test.mjs` 41/41, contracts `gen:check` 같음·48/48, api-client `gen:check` 같음·116/116을 다시 돌렸다. 코드는 고치지 않았다.

결과: **막는 지적 0**, 낮음 1(남은 위험).

| 번호 | 심각도 | 위치 | 근거 | 고칠 방향 |
| --- | --- | --- | --- | --- |
| RV-01 | 낮음(남은 위험) | `services/ticket-svc/src/modules/ticket/inbound/transfers.controller.ts:54`, `docs/api/openapi.yaml`의 `transfer-pending` | `transfer-pending`은 원래 취소 흐름(purchase-svc)의 '양도 요청을 철회한 뒤 취소할 수 있습니다'로 목록에 들어갔는데, ticket-svc는 양도 요청을 새로 만들 때 같은 type을 '이미 진행 중인 양도 요청이 있습니다' 뜻으로 쓴다. 한 type 한 제목(guidelines §2)을 지키려고 제목을 목록 쪽으로 맞추고 사유를 `detail`로 내렸으나, 새 양도 요청을 만들려는 팬에게는 제목 문구가 취소 맥락이라 어색하다. 시험·CI를 막지는 않는다 | 후속 묶음에서 새 type(예 `transfer-exists`)으로 나누거나 `transfer-pending`의 표준 제목을 양쪽에 맞는 중립 문구로 바꾼다(그때 purchase-svc 코드·화면 문구·계약을 함께 본다) |

### 확인한 것(지적 아님)

- **여덟 type**: `docs/api/openapi.yaml`의 새 여덟 줄이 `transfers.controller.ts`의 `ProblemError` 인자와 status·title 글자까지 같다. `entry-recorded`(409)·`transfer-closed`(409)·`reoffer-not-allowed`(409) 등 모두 서비스 코드가 내는 값 그대로이고, 같은 이름을 다른 서비스·platform이 다른 값으로 내는 곳은 grep 0건이다.
- **드러난 제목 여섯**: `dependency-unavailable`·`entry-started`·`invalid-body`·`reauth-unavailable`·`transfer-locked`·`transfer-pending`의 ticket-svc 제목을 목록의 표준 제목으로 맞췄다. 같은 type을 쓰는 payment·purchase·queue·ops·platform은 이미 표준 제목이라 목록을 바꾸지 않은 판단이 맞다. `transfer-locked`·`transfer-pending`의 구체 사유는 `detail`에 남아 정보가 사라지지 않는다. ticket-svc 단위 235/235가 통과한다.
- **출처 비교가 느슨해지지 않았는지**: DS-04는 ⑴ 포트 검사(`:18\d{3}(?:\/|$)`)를 값 전체에 그대로 두고 ⑵ `_URL`+`svc.cluster.local` 예외도 그대로 두며 ⑶ `new URL(value).origin`이 `demoOrigins()` 집합에 있는지 본다. 시험 안에 경로만 다른 같은 출처는 통과하고 `https://www.peaket.example.evil:18441/...`은 거절하는 단언을 넣어 비교의 뜻을 고정했다. 경로·쿼리가 달라도 같은 출처면 통과하는 것이 이 고침의 의도다.
- **생성물**: `contracts gen`은 바뀐 것이 없고, `api-client`는 union·표에 여덟 이름씩(16줄)만, 게이트웨이 다섯 파일은 둘째 줄 계약 지문 하나씩만 바뀌었다. 경로·메서드·백엔드·정책은 한 줄도 바뀌지 않았다(`git diff`로 확인). 두 패키지 `gen:check`가 같고 손으로 고친 생성물은 없다.
- **시험·구현 분리**: 시험 커밋 `c1e6ac6f1`은 `tools/local/demo-images.test.mjs`와 계획 파일만, 구현 커밋 `6c1976172`은 시험 파일을 건드리지 않았다. 구현 전 실패(PRF192 missing 여덟, DS-04 값 불일치)를 계획 '실패 확인'에 남겼다.
- **정본**: `docs/api/guidelines.md` §2의 '한 이름 한 상태·제목'과 BAT-087 계획 §6 DS-04의 '포트 붙은 출처'에 맞다. 정본 문장을 새로 쓰거나 바꿀 필요가 없었다.
- **계약 깨짐**: `docs/api/breaking/openapi-ignore.txt`를 건드리지 않았다(소유자 승인 대기). 이 묶음의 판정은 승인 뒤 별도 묶음 몫이다.

## 검증

## 담당 표

| 역할 | 세션 ID | 모델 | 시작 | 끝 |
| --- | --- | --- | --- | --- |
| plan | w12ccf-plan | deepseek-v4.1-flash | 2026-11-22T19:10:00+09:00 | 2026-11-22T19:16:00+09:00 |
| test | w12ccf-test | deepseek-v4.1-flash | 2026-11-22T19:16:00+09:00 | 2026-11-22T19:20:00+09:00 |
| impl | w12ccf-impl | deepseek-v4.1-flash | 2026-11-22T19:17:00+09:00 | 2026-11-22T19:23:00+09:00 |
| review | w12ccf-review | deepseek-v4.1-flash | 2026-11-22T19:23:00+09:00 | 2026-11-22T19:28:00+09:00 |
