# 작업 계획: W12-ci-green — develop CI의 mesh 정책과 core-svc 시작 시험 환경을 맞춘다

- **무엇**: `develop` `e3f37f6e8`의 CI 실행 `45025768535`가 두 곳에서 빨간불이다. ⑴ `tools-check`의 `node tools/ci/mesh-policies.mjs --check`가 BAT-011이 더한 ticket-svc `BlockTicketIssuance`를 `deploy/platform/mesh/port-allow.yaml`에서 찾지 못해 생성 파일과 다르다고 실패한다. ⑵ `node`의 core-svc 통합 시험 네 파일(`search-bat166`·`sale-eligibility`·`seatmap-editor`·`seatmap-save`)이 `dist/main.js`를 띄울 때 `PEAKET_NOTIFY_DATABASE_URL`을 주지 않아 시작하지 못한다. ⑵는 W12-core-notify(ADR-0351)가 `main.ts`에 발송기 전용 연결을 필수로 만들면서 이 네 시험의 환경 조립을 고치지 않은 결과이고, BAT-011과 무관하게 그 묶음이 합쳐진 뒤부터 잠복해 있었다. 이 묶음은 둘을 고쳐 `develop` CI를 다시 초록불로 만든다.
- **바탕**: 작업 폴더 `D:/ticketpass-b011-final`, 가지 `feature/lane1-BAT-011-final`, 출발점 `origin/develop` `e3f37f6e8`.
- **정본**: 메시 정책 원천 `deploy/platform/mesh/port-allow.yaml`와 생성기 `tools/ci/mesh-policies.mjs`(ADR-0285, `docs/infra.md` §4.1), ticket 계약 `docs/api/proto/peaket/ticket/v1/ticket.proto`의 `BlockTicketIssuance`(HOT-161), 발송기 전용 DB 역할과 필수 환경 값 `docs/adr/0351-core-notify-sender-dedicated-db-role.md` 결정 2·`services/core-svc/src/main.ts`, 묶음 절차 `docs/architecture.md` §8.6. 이 문서는 검토 기록이고 규범이 아니다. 정본과 다르면 정본이 이긴다.
- **등급·차례**: C(배포 정책·시험 환경), 시험 먼저(`docs/architecture.md` §8.6 5), 짧은 고리.

## 실패 확인

시험 담당 `w12green-test`(deepseek-v4.1-flash), 2026-11-23 00:05 KST. 기준 트리 `e3f37f6e8`(BAT-011 기록 커밋, 계획 커밋 아님)와 CI 실행 `45025768535`의 잡 로그를 함께 봤다.

| 검사 | 결과 | 까닭 |
| --- | --- | --- |
| `node tools/ci/mesh-policies.mjs --check` | **실패 1건** | `deploy/platform/mesh/port-allow.yaml`의 `ticket-svc.ports.grpc.services.peaket.ticket.v1.TicketService.methods`에 `BlockTicketIssuance`가 없어, 생성 파일 `policies.yaml`이 purchase-svc → ticket-svc 이 메서드 허용 줄을 만들지 못했다. BAT-011이 계약·호출 코드는 더했지만 이 원천을 빠뜨렸다 |
| `node --test tools/ci/mesh-policies.test.mjs` | **실패**(같은 까닭) | 시험이 `--check`의 생성 대조를 그대로 부른다. 도구가 만든 파일을 손으로 고치지 않고 원천을 고쳐 `--write`로 다시 만들어야 한다 |
| CI `node` 잡의 core-svc 통합 시험 네 파일 | **4파일 3시험 실패** | 네 파일이 `dist/main.js`를 띄우는 환경에 `PEAKET_NOTIFY_DATABASE_URL`이 없다. `main.ts`가 `PEAKET_NOTIFY_DATABASE_URL이 없다(웹훅 발송기 전용 core_notify 사용자, 비밀 관리에서 넣는다)`로 끝나 `PEAKET_PUBLIC_FILE_DIR` 같은 뒤 환경 값 검사에 닿지도 못했다 |
| 같은 실행의 직전 전체 실행 `45014387044`(`1e63a6404`, BAT-011 이전) | **같은 네 파일 실패** | W12-core-notify가 합쳐진 뒤 `develop`의 비문서 커밋에서 같은 실패가 먼저 났다. BAT-011이 만든 실패가 아니다. 문서만 바꾼 커밋은 `node` 잡을 건너뛰어 초록불로 보였다 |
| `sale-eligibility`의 `시작 파일(main.ts)과 relay 정비 일 조립`(발송기 연결을 준 뒤 다시) | **1 실패** | 발송기 연결을 주자 시작은 지나갔지만, 정비 일 목록 단언이 BAT-455가 더한 알림 정비 넷(`notification-delivery-partitions`·`notification-delivery-purge`·`notification-subscription-expired`·`notification-dedup-purge`)을 모른 채 넷만 기대해 실패했다. 발송기 연결 실패에 가려져 있던 같은 묶음의 시험 결함이다 |

- **시험 쪽 고침 하나**: core-svc 통합 시험 환경 조립 네 곳에 발송기 전용 로그인 주소를 더한다. 제품 코드와 시험 단언은 바꾸지 않는다. 고치기 전 실패는 위 표에 남긴다.
- **mesh 쪽 고침 하나**: `port-allow.yaml`에 메서드 한 줄을 더하고 생성기를 돌린다. 생성 파일은 손으로 고치지 않는다.

## 계획

### 1. mesh 정책 원천에 발권 막기 메서드를 더한다

1. `deploy/platform/mesh/port-allow.yaml`의 ticket-svc `TicketService.methods`에 `BlockTicketIssuance: [purchase-svc]`를 더한다. 알파벳 차례대로 `CancelTickets` 앞이다.
2. `node tools/ci/mesh-policies.mjs --write`로 `deploy/platform/mesh/policies.yaml`과 `meshless-networkpolicies.yaml`을 다시 만든다. ticket-svc는 메시 밖(meshless)이라 NetworkPolicy 쪽은 바뀌지 않을 수 있다. 바뀐 생성 파일은 함께 커밋한다.
3. 생성 파일을 손으로 고치지 않는다. `--check`가 원천·라우트·proto와 같은지 다시 본다.

### 2. core-svc 시작 시험에 발송기 전용 연결을 준다

1. `services/core-svc/test-int/roles.ts`에 `ensureNotifyLogin(admin, pg)`를 더한다. `ensureSearchLogin`과 같은 꼴로, `core_notify` 그룹 역할에 붙은 로그인 사용자(`core_notify_login`, `NOBYPASSRLS NOSUPERUSER`)를 한 번만 만들고 그 주소를 돌려준다. 0043 마이그레이션이 만든 역할을 쓴다.
2. `dist/main.js`를 띄우는 네 시험의 환경 조립에 `PEAKET_NOTIFY_DATABASE_URL: await ensureNotifyLogin(admin, pg)`를 더한다: `test-int/search-bat166.int.test.ts`, `test-int/sale-eligibility.int.test.ts`, `test-int/seatmap-editor.int.test.ts`, `test-int/seatmap-save.int.test.ts`.
3. `test-int/startup-db-role.int.test.ts`는 이미 `core_notify_login`을 직접 만들고 AZ-T19 ④를 본다. 그 파일은 바꾸지 않는다. `ensureNotifyLogin`은 그 파일과 같은 역할·비밀번호를 쓰되, 여러 번 불러도 한 번만 만든다.
4. `sale-eligibility`의 정비 일 목록 단언에 BAT-455가 더한 알림 정비 넷을 더한다. `CORE_MAINTENANCE_TASK_NAMES`와 `maintenance-tasks.ts`가 내는 차례 그대로다.
5. 제품 코드(`src/main.ts`)와 시작 확인 규칙은 바꾸지 않는다. 시험이 운영 시작 파일의 필수 값과 정비 일 목록을 빠뜨린 것을 채우는 일이다.

## 손댈 파일

| # | 파일 | 바꿀 것 |
| --- | --- | --- |
| 1 | `deploy/platform/mesh/port-allow.yaml` | ticket-svc `TicketService.methods`에 `BlockTicketIssuance: [purchase-svc]` |
| 2 | `deploy/platform/mesh/policies.yaml` | `mesh-policies --write`가 다시 만든 purchase-svc → ticket-svc 허용 줄(손으로 고치지 않는다) |
| 3 | `deploy/platform/mesh/meshless-networkpolicies.yaml` | `--write`가 바꾼 것이 있으면 함께(없을 수 있다) |
| 4 | `services/core-svc/test-int/roles.ts` | `ensureNotifyLogin` 도우미 |
| 5 | `services/core-svc/test-int/search-bat166.int.test.ts` | `PEAKET_NOTIFY_DATABASE_URL` 환경 값 |
| 6 | `services/core-svc/test-int/sale-eligibility.int.test.ts` | `PEAKET_NOTIFY_DATABASE_URL` 환경 값, 정비 일 목록 단언에 알림 정비 넷 |
| 7 | `services/core-svc/test-int/seatmap-editor.int.test.ts` | 같음 |
| 8 | `services/core-svc/test-int/seatmap-save.int.test.ts` | 같음 |

- 정본 문서와 계약(`docs/api/proto`)은 고치지 않는다. 계약은 BAT-011이 이미 맞췄고, 이 묶음은 배포 정책 원천과 시험 환경만 따라잡는다.

## 시험과 게이트

| 시험·검사 | 자리 | 단언 |
| --- | --- | --- |
| mesh 생성 대조(기존) | `tools/ci/mesh-policies.test.mjs`, `node tools/ci/mesh-policies.mjs --check` | 원천·라우트·proto로 다시 만든 생성 파일이 저장소와 같다. 구현 전에는 `BlockTicketIssuance` 한 줄이 모자라 실패하고, 원천을 고쳐 `--write`하면 통과한다 |
| 시작 파일 환경(기존) | `services/core-svc/test-int/seatmap-save.int.test.ts`의 `PEAKET_PUBLIC_FILE_DIR이 없으면 뜨지 않고, …` | 발송기 연결을 준 뒤에는 `PEAKET_PUBLIC_FILE_DIR` 검사까지 닿아 그 값이 없을 때 그 이름을 출력한다. 고치기 전에는 `PEAKET_NOTIFY_DATABASE_URL`에서 멈춘다 |
| 시작 파일 환경(기존) | `search-bat166`·`sale-eligibility`·`seatmap-editor`의 `시작 파일(main.ts) 조립` | 발송기 연결을 준 운영 시작 파일이 `/ready` 200까지 뜨고 원래 단언을 그대로 통과한다 |
| 정비 일 목록(기존) | `sale-eligibility`의 `시작 파일(main.ts)과 relay 정비 일 조립` | `coreMaintenanceTasks`가 내는 이름·주기가 `CORE_MAINTENANCE_TASK_NAMES`와 같다. 알림 정비 넷을 더한 뒤 통과한다 |
| core-svc typecheck | `pnpm --filter @peaket/core-svc typecheck` | 새 도우미와 네 시험의 타입이 맞는다 |
| 회귀 | `pnpm --filter @peaket/core-svc test:integration test-int/startup-db-role.int.test.ts` | AZ-T5·AZ-T19 ④가 그대로 통과한다. 새 도우미가 0043 역할을 올바로 쓴다 |
| 역할·기록 | `node tools/ci/roles-check.mjs`·`node tools/ci/records.mjs --check` | plan → test → impl → review → verify 차례와 기록 표가 맞는다 |

- Docker가 필요한 통합 시험은 Docker 잠금을 잡고 돌린다. 잠금이 비어 있지 않으면 기다린다.
- 네 파일 전체를 돌리면 오래 걸리므로, 고친 시험은 `-t`로 해당 시험 이름만 먼저 돌리고 마지막에 네 파일을 한 번에 돌린다.

## 틀린 구현 표본(검증 담당용)

| # | 틀린 구현 | 잡을 검사 |
| --- | --- | --- |
| S1 | `port-allow.yaml`에서 `BlockTicketIssuance` 줄을 빼고 생성 파일은 그대로 둔다 | `mesh-policies --check` 실패(생성 파일과 원천이 다름) |
| S2 | `seatmap-save` 시험의 환경에서 `PEAKET_NOTIFY_DATABASE_URL`을 빼거나 `core_app_login` 주소로 바꾼다 | 그 시험이 `PEAKET_NOTIFY_DATABASE_URL이 없다` 또는 `DB 사용자가 core_notify 역할이 아니다`로 실패 |
| S3 | `services/core-svc/src/maintenance-tasks.ts`에서 `notification-dedup-purge` 한 줄을 지운다 | `sale-eligibility`의 정비 일 목록 시험이 `notification-dedup-purge`가 빠졌다고 실패 |

## 넘기는 것

- **W12-core-notify의 남은 위험**: RV-02(`webhook_delivery` INSERT 정책 true)와 `core_app`의 두 표 권한 회수는 이 묶음에서 하지 않는다. 이 묶음은 시작 시험 환경만 맞춘다.
- **BAT-011 제품 코드**: 바꾸지 않는다. mesh 원천 한 줄과 생성물만 따라잡는다.
- **새 시험 ID·단계**: 만들지 않는다. BUILD_ORDER 단계·wbs 상태 변화도 없다. 기록만 R-774로 남긴다.
- **CI 재실행**: 푸시 뒤 실행을 보고, 이 묶음 밖의 실패가 또 나오면 그 묶음 담당에게 넘긴다.

## 리뷰

리뷰 담당 `w12green-review`(deepseek-v4.1-flash), 2026-11-23 00:17 KST. 받은 것은 `git diff origin/develop..a94973be8`(계획·시험·구현)과 이 계획 파일이다. 코드·생성물·정본을 대조하고 `mesh-policies --check`, `mesh-policies.test.mjs` 14/14, core-svc typecheck, 네 통합 시험 파일 98/98, `startup-db-role` 2/2를 다시 돌렸다. 코드는 고치지 않았다.

결과: **막는 지적 0, 낮음 0**.

### 확인한 것(지적 아님)

- **mesh 원천과 생성물**: `port-allow.yaml`의 `BlockTicketIssuance: [purchase-svc]`가 알파벳 차례(`CancelTickets` 앞)에 있고, `policies.yaml`의 purchase-svc → `/peaket.ticket.v1.TicketService/BlockTicketIssuance` 허용 줄이 생성기 결과와 같다. `meshless-networkpolicies.yaml`은 바뀌지 않았고 `--check`가 통과한다.
- **부르는 쪽**: 운영 코드에서 `BlockTicketIssuance`를 부르는 곳은 purchase-svc의 발권 막기 어댑터 하나다(ticket-svc 시험 대역 제외). 다른 서비스에 허용을 열지 않은 것이 맞다.
- **발송기 연결**: `ensureNotifyLogin`은 0043이 만든 `core_notify` 그룹 역할에 `NOBYPASSRLS NOSUPERUSER` 로그인을 붙이고, `ensureSearchLogin`과 같은 꼴로 한 번만 만든다. 네 시험은 `PEAKET_SEARCH_DATABASE_URL` 옆에서 같은 `admin`·`pg`로 주소를 받는다. `main.ts`와 시작 확인 규칙은 바뀌지 않았다.
- **정비 일 목록**: `sale-eligibility`의 새 기대값 여덟이 `CORE_MAINTENANCE_TASK_NAMES`와 `maintenance-tasks.ts`가 내는 차례·주기(`notification-delivery-partitions` daily, `notification-delivery-purge` window, `notification-subscription-expired` daily, `notification-dedup-purge` daily)와 같다. 알림 정비 넷은 `o.shop`·`o.opsDatabase`와 무관하게 항상 붙으므로 이 시험의 조립에서도 안정적이다.
- **시험·구현 분리**: 시험 커밋 `930e0b79f`는 `test-int/`와 계획 파일만, 구현 커밋 `a94973be8`은 `deploy/platform/mesh/`만 바꿨다. 구현 커밋이 시험 파일을 건드리지 않았다.
- **중복 도우미(고려함)**: `ensureNotifyLogin`이 `ensureSearchLogin`과 같은 일곱 줄 꼴을 되풀이한다. 두 역할의 마이그레이션·이름이 달라 지금은 각자 두는 편이 읽기 쉽고, 공통화는 세 번째 역할이 생길 때 한다.

## 검증

검증 담당 `w12green-verify`(deepseek-v4.1-flash), 2026-11-23 00:18~00:24 KST. 계획·시험·구현·리뷰에 관여하지 않았다. 기준 커밋 `b395db9b9`(리뷰까지).

### 게이트

| 검사 | 결과 |
| --- | --- |
| `node tools/ci/mesh-policies.mjs --check` | 생성 파일 2개가 원천·라우트·proto와 같다(끝 코드 0) |
| `node --test tools/ci/mesh-policies.test.mjs` | **14/14 통과**(MG-10 포함) |
| `pnpm --filter @peaket/core-svc typecheck` | 통과(끝 코드 0) |
| `pnpm --filter @peaket/core-svc test:integration` — `search-bat166`·`sale-eligibility`·`seatmap-editor`·`seatmap-save`·`startup-db-role` | **5파일 100/100 통과** |
| `pnpm lint` | 통과(출력 없음) |
| `python -I -X utf8 tools/doc-check/check_all.py` | **오류 0, 경고 4**(기존 api 셋 + mermaid 건너뜀) |
| `node tools/ci/roles-check.mjs --base origin/develop --head HEAD` | 검증 커밋 뒤 HEAD에서 통과(plan → test → impl → review → verify, 담당 표·꼬리말 맞음) |
| `node tools/ci/records.mjs --check` | 기록 표가 맞다(기존 경고만) |

- Docker가 필요한 통합 시험은 잠금(`w12green-verify`)을 잡고 돌린 뒤 놓았다.
- 다섯 파일 밖의 core-svc 통합 시험은 이 묶음이 바꾸지 않아 돌리지 않았다. `node` 잡이 다시 도는 것은 푸시 뒤 CI에서 본다.

### 틀린 구현 표본

| # | 넣은 틀린 구현 | 잡은 검사(결과) |
| --- | --- | --- |
| S1 | `port-allow.yaml`에서 `BlockTicketIssuance` 줄을 뺀다 | `mesh-policies --check` **실패**: "proto 메서드 …를 부르는 쪽이 없다". 줄을 되돌리니 끝 코드 0 |
| S2 | `seatmap-save` 시험의 `PEAKET_NOTIFY_DATABASE_URL`을 `core_app_login` 주소로 바꾼다 | 그 시험 **실패**: 운영 시작 파일이 `core_notify`가 아닌 로그인을 거부해 `/ready`가 뜨지 않았다(`DB 사용자가 core_notify 역할이 아니다`). 되돌리니 1/1 통과 |
| S3 | `src/maintenance-tasks.ts`에서 `notification-dedup-purge` 한 줄을 지운다 | `sale-eligibility` 정비 일 목록 시험 **실패**: 기대한 `notification-dedup-purge`가 실제 목록에 없다. 되돌리고 다시 빌드하니 1/1 통과 |

- 넣은 수 3, 잡힌 수 3, 놓친 수 0. 표본마다 `git checkout --`로 되돌렸고 `git status --short`에 제품·시험 파일 차이가 없었다.
- S2에서 시작 파일이 거부한 것은 의도한 방어다. 시험은 그 거부를 `PEAKET_PUBLIC_FILE_DIR` 검사가 아니라 `/ready` 기다림에서 잡았다.

### 남은 위험

- **CI 재실행**: 이 묶음은 로컬 게이트를 통과했지만 `develop` 푸시 뒤 `tools-check`·`node` 잡이 실제로 초록불인지는 아직 모른다. 푸시 뒤 실행을 확인한다.
- **다른 잠복 실패**: `node` 잡에는 이 묶음이 건드리지 않은 다른 서비스 시험도 있다. 발송기 연결 실패에 가려져 있던 실패가 더 있으면 그 묶음 담당에게 넘긴다.
- **W12-core-notify RV-02**: `webhook_delivery` INSERT 정책 true와 `core_app` 권한 회수는 이 묶음 밖이다.

## 기록

- R-774. `develop` `e3f37f6e8`의 CI 실행 `45025768535`에서 `tools-check`의 mesh 생성 대조와 `node`의 core-svc 시작 시험 네 파일이 실패하던 것을 고쳤다. ⑴ BAT-011이 더한 ticket-svc `BlockTicketIssuance`를 `deploy/platform/mesh/port-allow.yaml`의 `TicketService.methods`에 purchase-svc 호출자로 더하고 `mesh-policies --write`로 `policies.yaml`을 다시 만들었다. ⑵ W12-core-notify(ADR-0351) 뒤로 `main.ts`가 요구하는 `PEAKET_NOTIFY_DATABASE_URL`을 core-svc 시작 시험 네 파일이 주지 않아, `core_notify` 그룹 역할의 로그인을 만드는 `ensureNotifyLogin`을 `test-int/roles.ts`에 더하고 네 곳에 연결했다. ⑶ 같은 실패에 가려져 있던 `sale-eligibility`의 정비 일 목록 단언에 BAT-455의 알림 정비 넷을 더했다.
  - ⑵는 BAT-011이 만든 실패가 아니라 W12-core-notify가 합쳐진 뒤 `develop`의 비문서 커밋에서 먼저 나던 실패다(직전 실행 `45014387044`). 문서만 바꾼 커밋이 `node` 잡을 건너뛰어 초록불로 보였다.
  - 게이트: `mesh-policies --check` 0, MG-10 14/14, core-svc typecheck 0, 영향 다섯 파일 100/100, lint 0, doc-check 오류 0·경고 4, roles-check 통과, 틀린 구현 표본 3/3.
  - 남은 위험: 푸시 뒤 `develop` CI 재실행 결과는 아직 모른다. `node` 잡의 다른 잠복 실패가 더 있으면 그 묶음 담당에게 넘긴다. W12-core-notify RV-02(`webhook_delivery` INSERT 정책 true·`core_app` 권한 회수)는 이 묶음 밖이다. BUILD_ORDER 단계·wbs 상태 변화는 없다.

## 담당 표

| 역할 | 세션 ID | 모델 | 시작 | 끝 |
| --- | --- | --- | --- | --- |
| plan | w12green-plan | deepseek-v4.1-flash | 2026-11-23T00:02:00+09:00 | 2026-11-23T00:08:00+09:00 |
| test | w12green-test | deepseek-v4.1-flash | 2026-11-23T00:08:00+09:00 | 2026-11-23T00:13:00+09:00 |
| impl | w12green-impl | deepseek-v4.1-flash | 2026-11-23T00:13:00+09:00 | 2026-11-23T00:14:00+09:00 |
| review | w12green-review | deepseek-v4.1-flash | 2026-11-23T00:14:00+09:00 | 2026-11-23T00:18:00+09:00 |
| verify | w12green-verify | deepseek-v4.1-flash | 2026-11-23T00:18:00+09:00 | 2026-11-23T00:24:00+09:00 |
