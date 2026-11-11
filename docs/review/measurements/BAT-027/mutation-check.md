# BAT-027 계측 시험의 작은 틀린 구현 검사(2026-11-11)

B등급 묶음이므로 계측 시험이 잘못된 구현을 잡는지 두 가지 변이로 확인했다. 변이는 잠시 넣고 시험을 돌린 뒤 되돌렸다(커밋에 남기지 않는다).

## 1. 계측 결과 호출 제거

- 바꾼 곳: `services/purchase-svc/src/modules/inventory/application/hold-seats.ts`의 `execute` catch에서 `this.hotPath?.outcome(holdOutcomeOf(err));` 한 줄을 뺐다.
- 돌린 시험: `pnpm --filter @peaket/purchase-svc exec vitest run test/hold-seats.test.ts -t "BAT027"`
- 결과: **실패**. `hot_path_outcomes_total{service="purchase-svc",outcome="conflict"} 1`이 없어 `BAT027_ 성공과 409 경합을 각각 outcome으로 세고...`가 깨졌다.
- 되돌림: 같은 줄을 복구하고 같은 시험을 다시 돌려 통과를 확인했다.

## 2. 구간 이름 바꾸기

- 바꾼 곳: `services/purchase-svc/src/modules/booking/application/get-payment-status.ts`의 `read` 도우미 구간 이름을 `payment.status.read`에서 `payment.status.total`로 바꿨다(형은 그대로라 컴파일은 통과한다).
- 돌린 시험: `pnpm --filter @peaket/purchase-svc exec vitest run test/get-payment-status.test.ts -t "BAT027"`
- 결과: **실패**. `hot_path_stage_seconds_count{service="purchase-svc",stage="payment.status.read"} 2`가 없고 `payment.status.total` 관측 수가 3이 되어 `BAT027_ 기다린 요청은 read·wait·total 구간과 ok 결과를 남긴다`가 깨졌다.
- 되돌림: `payment.status.read`로 복구하고 같은 시험을 다시 돌려 통과를 확인했다.

## 되돌린 뒤 확인

- `pnpm --filter @peaket/purchase-svc exec vitest run test/hold-seats.test.ts test/get-payment-status.test.ts -t "BAT027"` → 2 files, 2 tests passed(167 skipped).
- `pnpm --filter @peaket/platform exec vitest run test/hot-path.test.ts` → 4 tests passed.
- `git diff`에 변이 흔적이 없다.
