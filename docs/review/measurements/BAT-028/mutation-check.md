# BAT-028 틀린 구현 검사(2026-11-11)

A등급 묶음이므로 A(HTTP 구간) 1개, B(세션 재사용) 경계·되돌림 2개를 일부러 틀리게 바꿔 시험이 잡는지 봤다. 변이는 잠시 넣고 돌린 뒤 되돌렸다(커밋에 남기지 않는다).

## A. HTTP 문제 변환 구간 이름 바꾸기

- 바꾼 곳: `packages/platform/src/problem-filter.ts`의 `hotPath.start('http.problem')`을 `'http.auth'`로 바꿨다(형은 그대로라 컴파일은 통과한다).
- 돌린 시험: `pnpm --filter @peaket/platform exec vitest run test/hot-path.test.ts -t "BAT028"`
- 결과: **실패**. `hot_path_stage_seconds_count{stage="http.problem"}`이 없어 `BAT028_ HTTP 입구·인증·처리기·문제 변환·로그·응답 구간을 남긴다`가 깨졌다.
- 되돌림: `http.problem`으로 복구하고 같은 시험을 다시 돌려 5건 통과를 확인했다.

## B-1. 최대 체류 경계 검사 제거

- 바꾼 곳: `services/purchase-svc/src/modules/inventory/application/hold-seats.ts`의 `if (!session || session.accountId !== c.accountId || (session.maxStayUntilMs !== undefined && this.clock.now() >= session.maxStayUntilMs))`에서 `maxStayUntilMs` 항을 뺐다.
- 돌린 시험: `pnpm --filter @peaket/purchase-svc exec vitest run test/hold-seats.test.ts -t "BAT028_최대체류경계"`
- 결과: **실패**. `NOW`에 만료되는 세션을 넘겼는데 홀드가 성공해 `BAT028_최대체류경계는_넘긴_세션에서도_다시_본다`가 깨졌다(에러가 아니라 `null`이 돌아왔다).
- 되돌림: 경계 항을 복구하고 같은 시험을 다시 돌려 통과를 확인했다.

## B-2. 세션 재사용을 끄는 되돌림

- 바꾼 곳: `HoldSeats`의 `let session = c.session; if (session === undefined) { ...get... }`을 항상 `sessions.get`을 부르는 꼴로 바꿨다(넘어온 세션을 무시).
- 돌린 시험: `pnpm --filter @peaket/purchase-svc exec vitest run test/hold-seats.test.ts -t "BAT028_인증이_읽은"`
- 결과: **실패**. `sessions.get` 호출 수가 0이어야 하는데 1이 되어 `BAT028_인증이_읽은_세션을_넘기면_sessions.get을_부르지_않고_같은_홀드를_한다`가 깨졌다.
- 되돌림: 재사용 분기를 복구하고 같은 시험을 다시 돌려 통과를 확인했다.

## 되돌린 뒤 확인

- `pnpm --filter @peaket/platform exec vitest run test/hot-path.test.ts` → 5 passed.
- `pnpm --filter @peaket/purchase-svc exec vitest run test/hold-seats.test.ts test/http.test.ts -t "BAT028"` → 5 passed(171 skipped).
- `git diff`에 변이 흔적이 없다.
