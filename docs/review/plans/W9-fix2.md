# W9-fix2 계획·기록(결제·좌석·불변식 작은 고침, 웨이브 9 갈래 1)

- **무엇**: 갈래 1 구간 끝 정리 목록(docs/PROGRESS.md '## 구간 끝 정리 목록(갈래 1)')의 네 줄을 고치는 묶음이다. 소유자 결정(2026-11-17) '정리 목록 가운데 돈·권한·개인정보 작은 고침부터'에 따른다. 검토 기록이고 규범이 아니다. 정본과 다르면 정본이 이긴다.
- **바탕**: 작업 폴더 `D:/ticketpass-w9-fix2`, 가지 `feature/w9-fix2`, 출발점 `origin/develop` `9199a3de`.
- **차례**: 버그 고침이라 재현 시험 먼저다(docs/architecture.md §8.6 4 '모든 시험은 한 번은 실패를 본다'의 '버그 재현 시험은 고치기 전에 먼저 쓴다', ADR-0281 결정 3). 계획 → 시험(고치기 전 트리 `9199a3de` 위에서 실패 확인) → 구현 → 리뷰 → 검증 → 기록. 정방향 묶음이 아니므로 `Batch-Order`를 달지 않는다.
- **등급**: A(돈: 결제사 지정·승인 확정 지연·발권 기한 검사, 좌석: 1인 한도).
- 이 파일은 역할마다 자기 절만 쓴다: 계획(아래), 실패 확인(시험), 시험 이의(구현), 리뷰, 검증, 담당 표·기록(감독). 정리 목록 줄은 감독이 기록 때 지운다.

## 계획

계획 담당 `w9f2-plan`(claude-opus-5-5), 2026-11-17. 시험·제품 코드는 쓰지 않았다. 정본 빈칸은 이 커밋에서 정본에 썼다(아래 7, 모두 '추천 적용 2026-11-17, W9-fix2'). 방향을 바꾸는 결정은 없다(넷 모두 정본이 이미 정한 뜻 — 홀드 Hash `lim`이 예약 한도가 된다, 늦게 온 옛 지정이 새 지정을 덮지 않는다, 실행기는 돌던 호출을 기다린다, 발권 기한은 반영 시각 기준 — 을 지키는 방법이다).

### 1. 범위

| 지적 | 출처(정리 목록 줄) | 이 묶음이 고칠 뜻 |
| --- | --- | --- |
| H | BAT-051(HOT-252, R-535) 'Redis 재구축 뒤 `seat_hold` 원장에 `lim`이 없어…' | 다시 만들기 뒤 홀드 Hash에 `lim`이 없어 판매 예약의 `purchase_quota.limit_count`가 판매 정책 한도가 아니라 회차 설정 한도가 된다 |
| A | BAT-020(PRF-203, R-448) '회차 지정 쓰임새 `AssignEventPg`의 지정 시각에 상한이 없다…' | 아주 먼 미래 지정 시각 하나가 `event_pg_config`에 남아 그 회차의 뒤 지정을 모두 조용히 막는다 |
| G | PRF-181 'payment-svc 종료 유예는 차트 기본 30초라…' | 배포·축소 때마다 돌던 승인 호출(최대 63초)이 30초에 끊겨 결과 모름(UNKNOWN)이 된다 |
| P | PRF-182 '불변식 P4(…)는 `approved_at + 기한`으로 판정해…' | 결과 모름을 늦게 푼 주문(T13)이 반영하자마자 P4 위반으로 세어진다(발권 기한은 반영 시각 기준) |

같은 줄과 이웃 줄의 나머지는 아래 8 '범위 밖'이다.

### 2. 지적별 바른 동작과 정본 근거

| 지적 | 지금 | 바른 동작 | 정본 |
| --- | --- | --- | --- |
| H | 홀드·자동 배정·묶기 Lua가 Hash에 `lim`을 쓰지만 Stream HELD에는 싣지 않아 원장 `seat_hold`에 칸이 없고, `REBUILD_SEATS_LUA`가 `lim` 없이 Hash를 다시 쓴다. Saga `reserveStep`(`order-saga.ts:245~250`)은 없으면 회차 한도로 본다 | Lua 셋이 HELD 항목에 `holdLimit`(= Hash `lim`)을 싣고 릴레이가 SeatEvent `holdLimit`으로 낸다 → 적재가 `seat_hold.hold_limit`에 쓴다(끝 사건이 먼저 넣은 행은 뒤 HELD가 채우고 이미 있는 값은 덮지 않음, 틀린 값은 NULL로 적재) → 다시 만들기가 되살리는 홀드(원장 홀드·묶인 주문 K1)와 대조 원장 행이 있는 판매 좌석에 `lim`을 쓴다. NULL이면 지금처럼 회차 한도. 우선 구매 보류(PRIORITY)·RELEASED·EXPIRED는 싣지 않는다 | seat-hold §6 '1인 한도 되살리기'(새), data `seat_hold.hold_limit`(ERD·'다시 만들기 표와 원장 칸'), asyncapi·avsc `SeatEvent.holdLimit`, avro README §6 |
| A | `updatedAtMs`가 0 이상 안전한 정수면 받는다(`assign-event-pg.ts:37`) | 지정 시각 ≤ payment-svc 시계의 지금 + 5분 [가정](경계 포함). 넘으면 `PaymentInputError('updated_at')`이고 저장소를 부르지 않는다 | payment §2.2 '회차 지정(명령 12의 쓰임새)' |
| G | `deploy/charts/peaket-service/values.yaml:42`의 기본 30초를 payment-svc도 쓴다. 합본 `deploy/envs/local/v1-bundle.yaml:44`는 60초 | payment-svc 서비스 파드와 payment-svc를 담은 합본 파드는 90초 [가정](preStop 5 + 연결 3 + 읽기 60 + 결과 쓰기·닫기 여유 약 20). payment-svc 릴레이 파드는 30초 그대로 | devops §6.4 '일반 서비스', payment §2 '승인 실행기의 첫 구현' '잡기' 끝 문장 |
| P | `p4_issue_deadline_exceeded.sql`이 늘 `approved_at + issue_deadline` | 마지막 입금 대기 뒤 첫 주문 `APPROVED` 사건의 `from_status`가 `UNKNOWN`(T13)·`AWAITING_DEPOSIT`(T16)이면 기준 = greatest(`approved_at`, 그 사건 `occurred_at`), 그 밖(T9, 빈 값 포함)이면 `approved_at`. 기한 = 기준 + `issue_deadline`(비교는 지금처럼 `>`). purchase-svc `approvalIssueDueAtMs`(`payment-result.ts:276`)와 같은 규칙. 큐 행 갈래(`issue_due_at < as_of`)는 그대로 | verification §2.5 '판정'·'검사기', payment §2 '승인 트랜잭션'·'입금 확인의 첫 구현' |

### 3. 손댈 파일·인터페이스(구현 담당)

| 지적 | 제품 코드 | 인터페이스 |
| --- | --- | --- |
| H | purchase `src/modules/inventory/adapters/hold-lua.ts`·`auto-hold-lua.ts`·`pin-lua.ts`(HELD `XADD`에 `'holdLimit', <lim ARGV>`), `domain/seat-event.ts`(`toSeatEvent`가 `holdLimit`을 옮김, `LedgerHoldEvent.holdLimit?`, `toLedgerHoldEvent`는 HELD·FAN의 1 이상 안전한 정수만 싣고 그 밖은 뺌, 던지지 않음), `adapters/db/drizzle-seat-hold-ledger.ts`(HELD 넣기에 `hold_limit`, 충돌 때 `hold_limit = coalesce(seat_hold.hold_limit, excluded.hold_limit)`), `adapters/db/drizzle-seat-rebuild.ts`(`holds`·`saleHolds`·`ledgerRows`가 `hold_limit`을 읽음), `domain/rebuild.ts`(되살릴 좌석에 한도), `adapters/rebuild-lua.ts`(좌석 열째 칸 = `lim`, `''`이면 쓰지 않음, 빈 글도 `^[1-9][0-9]{0,14}$`도 아니면 `PEAKET_REBUILD_ARGS`), `adapters/memory-seat-store.ts`(같은 계약), `adapters/db/schema.ts`, 새 마이그레이션 | `RebuildHold.holdLimit: number \| null`, `RebuildLedgerRow.holdLimit: number \| null`, 되살릴 좌석(`RebuildSeat`)에 `holdLimit?: number`. SeatEvent 메시지 형에 `holdLimit?: number`. `packages/contracts` 다시 만들기(`gen`, `gen:check`) |
| A | payment `src/modules/payment/application/assign-event-pg.ts` | `export const EVENT_PG_ASSIGN_MAX_SKEW_MS = 300_000`(5분 [가정]). `AssignEventPgDeps.clock: Pick<Clock, 'now'>`(필수). 검사: `updatedAtMs > clock.now() + EVENT_PG_ASSIGN_MAX_SKEW_MS`이면 `PaymentInputError('updated_at')`(하위 결제사 규칙보다 앞, 저장소 호출 0). 지금 부르는 곳 넷(단위 `test/pg-sub-provider.test.ts` 97·106·118줄, 통합 `test-int/payment-sub-provider.int.test.ts` 148줄)은 시험 담당이 시계를 넘기게 고친다. 운영 조립은 아직 없다(OPS-290) |
| G | `deploy/workloads/payment-svc/values.yaml`(`service.terminationGracePeriodSeconds: 90`, 까닭 주석), `deploy/envs/local/v1-bundle.yaml`(60 → 90) | 없음. 릴레이(`relay.terminationGracePeriodSeconds`)는 차트 기본 30 그대로 |
| P | invariant-checker `sql/p4_issue_deadline_exceeded.sql`, `src/tables.ts`(purchase `order_event` 칸에 `from_status`), `sql/tables.sql`(임시 표 칸), `src/invariants.ts`(P4 설명 글만, 필요하면) | P4 결과 `detail`에 기준 시각(`base_at=…`)을 더한다. P3은 바꾸지 않는다(`from_status`를 읽지 않음) |

**마이그레이션**: purchase-svc 하나 — `seat_hold`에 `hold_limit integer`(빈 값 허용)와 `CHECK (hold_limit IS NULL OR hold_limit >= 1)`. 파티션 부모에 `ALTER TABLE … ADD COLUMN`·`ADD CONSTRAINT`(있는 파티션에 퍼지고 `ensureMonthlyPartitions`의 `LIKE`가 새 파티션에 옮긴다). 옛 행은 채우지 않는다. 번호는 감독이 정한다(지금 끝은 `0026_relook2_cs_failure_reopen`). payment-svc·invariant-checker는 필요 없다(invariant-checker는 임시 표).

**계약**: asyncapi·avsc는 이 커밋이 바꿨다(끝에 더한 선택 칸, 하위 호환). `packages/contracts`의 생성 코드는 구현 담당이 다시 만든다(`gen:check`가 지금은 다시 만들 몫이 있다고 실패한다).

### 4. 재현 시험(시험 담당이 고치기 전에 먼저 쓴다)

시험 이름은 범위 ID(`HOT-252`·`PRF-203`·`PRF-181`·`PRF-182`)로 시작한다. '구현 전'은 `9199a3de`에서 예상하는 결과다.

| # | 시험 | 종류·파일 | 단언 | 구현 전 |
| --- | --- | --- | --- | --- |
| H1 | `HOT-252 판매 정책 한도 2로 잡은 홀드를 다시 만든 뒤 예약 한도도 2다` | 통합 purchase `test-int/sale-policy.int.test.ts`(실제 PostgreSQL·Valkey, 'BAT051_ 홀드 때 쓴 lim 2…' 옆) | 회차 한도 4, 정책 한도 2로 두 좌석 홀드 → 적재(HELD 사건을 적재기에 직접 넘김) → 좌석 Redis 회차 키 지움 → 다시 만들기 → `HGET lim` = `'2'` → 예약 뒤 `purchase_quota.limit_count` = 2, 같은 계정 한 좌석 더 예약은 `QUOTA_EXCEEDED` | 실패(`lim` 없음, 한도 4) |
| H2 | `HOT-252 원장 적재는 HELD의 holdLimit을 hold_limit에 쓰고 끝 사건이 먼저 온 행은 뒤 HELD가 채운다` | 통합 purchase `test-int/seat-hold-ledger.int.test.ts` | HELD(3) → 3. EXPIRED 먼저(행 NULL) → 같은 토큰 HELD(3) → 3. 같은 HELD를 값 5로 다시 → 3 그대로. 칸 없음 → NULL. `holdLimit` 0·2.5·`'2'`(글)·-1 → NULL이고 행은 들어감(보류 0) | 실패(칸 없음) |
| H3 | `HOT-252 다시 만들기는 원장 홀드·묶인 주문의 홀드에 hold_limit을 lim으로 쓰고 빈 값이면 쓰지 않는다` | 통합 purchase `test-int/seat-rebuild.int.test.ts` + 단위 `test/rebuild-memory.test.ts` | 원장 홀드(2), K1 묶인 주문 홀드(3), 빈 값 홀드, 판매 좌석(대조 행 4) → Hash `lim` `'2'`·`'3'`·없음·`'4'`. 메모리 저장소도 같다 | 실패 |
| H4 | `HOT-252 다시 만들기 좌석 Lua는 열째 칸이 빈 글이나 1 이상 10진 정수가 아니면 아무것도 쓰지 않는다` | 통합 purchase `test-int/seat-rebuild.int.test.ts`(실제 Valkey) | `'0'`·`'x'`·`'01'` → `PEAKET_REBUILD_ARGS`, 비트·Hash 0 | 실패(지금은 예비 칸이라 무엇이든 받음) |
| H5 | `HOT-252 팬 홀드 Lua 셋은 HELD 항목에 holdLimit을 싣고 우선 구매 보류는 싣지 않는다` | 통합 purchase `test-int/hold-lifecycle.int.test.ts`(`XRANGE`) | 홀드·자동 배정·묶기의 빈 좌석 HELD 항목 `holdLimit` = 그 Lua의 한도 인자, 우선 구매 보류 HELD·RELEASED·EXPIRED에는 칸 없음 | 실패 |
| H6 | `HOT-252 Stream 릴레이는 holdLimit을 SeatEvent로 옮기고 적재 변환은 HELD·FAN의 1 이상 정수만 싣는다` | 단위 purchase `test/seat-event.test.ts`·`test/seat-stream-relay.test.ts` | `toSeatEvent` `'2'` → 2, 없음 → 칸 없음. `toLedgerHoldEvent`: HELD·FAN 2 → 2, PRIORITY·RELEASED에 값이 와도 뺌, 0·소수·글 → 뺌(던지지 않음) | 실패 |
| H7 | `HOT-252 마이그레이션: seat_hold.hold_limit과 CHECK` | 통합 purchase `test-int/purchase-migration.int.test.ts` | 칸이 있고 0 넣기 거절, NULL 받음, 새로 만든 월 파티션에도 칸 | 실패 |
| A1 | `PRF-203 회차 지정 시각이 지금 + 5분을 넘으면 입력 오류이고 표를 바꾸지 않는다` | 단위 payment `test/pg-sub-provider.test.ts`(가짜 시계 T) | T + 300,000 → written true. T + 300,001·9999-12-31T23:59:59.999Z·8.64e15 → `PaymentInputError` field `updated_at`, `store.assignEvent` 호출 0, 하위 결제사 규칙에 걸리는 입력이어도 `updated_at`이 먼저 | 실패(받음) |
| A2 | `PRF-203 먼 미래 지정이 거절되어 뒤의 바른 지정이 그대로 쓰인다` | 통합 payment `test-int/payment-sub-provider.int.test.ts`(실제 PostgreSQL) | 지정(T, TOSS) → 지정(9999년, PORTONE) 거절 → 지정(T + 1,000, PORTONE) written true, 행 `pg_primary` PORTONE | 실패(9999년 행이 남아 뒤 지정 written false) |
| G1 | `PRF181_payment-svc 서비스 파드 종료 유예는 90초이고 preStop + 승인 호출 한 번보다 길며 릴레이는 30초다` | 렌더 `tools/local/chart.test.mjs`(payment-svc 값 파일로 렌더) | Deployment `payment-svc` `terminationGracePeriodSeconds` = 90 ≥ preStop 5 + 63 + 20, 릴레이 Deployment 30. `deploy/envs/local/v1-bundle.yaml`로 렌더한 합본도 90 | 실패(30·60) |
| P1 | `PRF-182 P4 결과 모름을 늦게 푼 주문(T13)의 발권 기한은 반영 시각 + 30분이다` | 통합 `services/invariant-checker/test-int/invariants.int.test.ts` | `approved_at` T, `RESERVED→UNKNOWN` T+1초, `UNKNOWN→APPROVED` T+40분, `CONFIRMED` T+55분 → P4 0건. 경계: `CONFIRMED`이 반영 + 30분 정각이면 0건, + 30분 + 1ms면 1건. 끝나지 않고 `as_of` = 반영 + 29분이면 0건, + 31분이면 1건 | 실패(1건) |
| P2 | `PRF-182 P4 입금 대기에서 온 승인(T16)도 반영 시각 기준이다` | 같은 파일 | `AWAITING_DEPOSIT→APPROVED` 반영이 `approved_at` + 20분, `CONFIRMED`이 반영 + 25분 → 0건 | 실패 |
| P3 | `PRF-182 P4 바로 승인(T9)은 지금처럼 결제사 승인 시각 기준이다` | 같은 파일 | `RESERVED→APPROVED` 반영 T+50초, `CONFIRMED` T+30분+10초 → 1건(반영 기준이면 0건이 된다) | 통과(이미 있는 동작, 아래 표본 M-P1로 한 번 실패를 본다) |

- 기존 시험 `P4 승인 뒤 30분 안에…`·`P4 P-T36 ④_…`(같은 파일 286·321줄)은 시드 도우미 `event`(55줄)가 `from_status`를 비워 두므로 T9 규칙으로 그대로 통과해야 한다(고치지 않는다). P1·P2는 `from_status`를 받는 도우미를 더해 쓴다. `from_status`가 빈 값이면 T9로 본다(2의 P 줄 '그 밖').
- P3은 구현 전에도 통과하는 대조 시험이다(정본 §8.6 4: 까닭을 적고 틀린 구현 검사로 한 번 실패를 본다).

### 5. 틀린 구현 표본(검증 담당이 넣을 것)

| # | 틀린 구현 | 잡는 시험 |
| --- | --- | --- |
| M-H1 | 적재가 `holdLimit`을 버린다(늘 NULL) | H2, H1 |
| M-H2 | 끝 사건이 먼저 넣은 행에 뒤 HELD가 `hold_limit`을 채우지 않는다 / 이미 있는 값을 덮는다 | H2 |
| M-H3 | 틀린 `holdLimit`이면 사건째 던져 보류한다 | H2(보류 0), H6 |
| M-H4 | 다시 만들기가 원장 홀드에만 `lim`을 쓰고 묶인 주문(K1) 되살리기에서 빠뜨린다 | H3 |
| M-H5 | 다시 만들기 Lua가 열째 칸을 받고도 Hash에 쓰지 않는다 / 검사하지 않는다 | H3, H4 |
| M-H6 | 자동 배정 Lua만 HELD 항목에 `holdLimit`을 빠뜨린다 / 릴레이가 SeatEvent로 옮기지 않는다 | H5, H6 |
| M-A1 | 상한 비교 `>`를 `>=`로(정확히 지금 + 5분을 거절) | A1 경계 |
| M-A2 | 상한을 '9999년 끝'으로만 묶는다 | A1(9999년 줄), A2 |
| M-A3 | 저장소를 부른 뒤에 시각을 검사한다 / 하위 결제사 규칙 뒤로 검사를 옮긴다 | A1(호출 0, `updated_at` 먼저) |
| M-G1 | 종료 유예를 릴레이 값에만 넣는다 / 합본을 빠뜨린다 | G1 |
| M-P1 | P4가 모든 전이에 greatest(승인, 반영)를 쓴다 | P3 |
| M-P2 | 반영 시각으로 `UNKNOWN` 진입 사건 시각을 쓴다 / T16을 빠뜨린다 / 기한 비교 `>`를 `>=`로 | P1, P2, P1 경계 |

- 자주 놓친 결함 대 본 것: 경계(지금 + 5분 정각·+1ms, 반영 + 30분 정각·+1ms), 목록 밖 값(`holdLimit` 0·소수·글·PRIORITY·끝 사건, 9999년·8.64e15), 차례가 바뀐 도착(끝 사건이 HELD보다 먼저), 겹친 길은 하나씩(Lua 셋, 원장 홀드·K1·판매 좌석, T9·T13·T16), 이미 있는 동작의 대조(P3), 시작 조립(AssignEventPg 시계는 생성자 필수).

### 6. 돌릴 시험(Docker는 감독이 잠금을 잡은 때만)

```
cd D:/ticketpass-w9-fix2/services/purchase-svc && node_modules/.bin/vitest run --config vitest.integration.config.mjs test-int/sale-policy.int.test.ts test-int/seat-hold-ledger.int.test.ts test-int/seat-hold-ledger-e2e.int.test.ts test-int/seat-rebuild.int.test.ts test-int/seat-rebuild-source.int.test.ts test-int/hold-lifecycle.int.test.ts test-int/seat-stream-relay.int.test.ts test-int/purchase-migration.int.test.ts
cd D:/ticketpass-w9-fix2/services/payment-svc && node_modules/.bin/vitest run --config vitest.integration.config.mjs test-int/payment-sub-provider.int.test.ts
cd D:/ticketpass-w9-fix2/services/invariant-checker && node_modules/.bin/vitest run --config vitest.integration.config.mjs test-int/invariants.int.test.ts
```

Docker 없이: purchase 단위 `test/seat-event.test.ts`·`test/seat-stream-relay.test.ts`·`test/rebuild-memory.test.ts`·`test/rebuild-plan.test.ts`·`test/seat-rebuilder.test.ts`, payment 단위 `test/pg-sub-provider.test.ts`, `node --test tools/local/chart.test.mjs`, `node tools/ci/avro-schema.mjs`, `packages/contracts`의 `gen:check`, 바꾼 패키지마다 `tsc --noEmit`.

### 7. 정본 빈칸과 정한 것(이 커밋에서 정본에 씀)

| 빈칸 | 정한 것 | 고르지 않은 안과 까닭 | 정본 위치 |
| --- | --- | --- | --- |
| H: `lim`을 원장에 남기는 길 | 사건 SeatEvent `holdLimit`(HELD·FAN, 끝에 더한 선택 칸) → `seat_hold.hold_limit` → 다시 만들기 `lim` | 다시 만들 때 판매 정책을 다시 평가하기: 입장 토큰 `lst`·명단을 다시 만들기가 모른다. 결제 접수 때 주문 행에 한도 적기: 접수 전에 되살린 홀드는 여전히 없다 | seat-hold §6, data, asyncapi, avsc, avro README §6 |
| H: 틀린 `holdLimit` | 칸을 빼고(NULL) 사건은 적재 | 보류: 한도 값 하나 때문에 원장에 홀드가 없으면 다시 만들기가 그 좌석을 빈 좌석으로 돌린다(`hold_id` 칸과 같은 판단) | seat-hold §6 '원장' |
| A: 지정 시각 상한 | payment-svc 시계의 지금 + 5분 [가정], 경계 포함 | '9999년 끝'(정리 목록 줄의 안): 9999년 값 하나가 같은 막힘을 만든다. 지금 + 0: 시계 어긋남으로 바른 지정을 거절한다 | payment §2.2 |
| G: 종료 유예 값 | 승인 실행기를 도는 파드 90초 [가정](5 + 3 + 60 + 약 20), 릴레이 30초 | 80초(정리 목록의 하한): 결과 쓰기 문장과 풀 닫기 여유가 12초뿐이다. 120초: 축소·롤링이 더 늦고 얻는 것이 없다 | devops §6.4, payment §2 '잡기' |
| P: P4 기준 시각 | T9 승인 시각, T13·T16 max(승인, 반영), 반영 = 마지막 입금 대기 뒤 첫 `APPROVED` 사건 | 모든 전이에 max: T9에서 최대 약 81초(ADR-0266) 늦은 위반을 놓친다. 결제 사건 `RESOLVED` 시각(P3의 꼴): purchase 반영보다 일러 거짓 위반이 남고 T16에는 `RESOLVED`가 없다 | verification §2.5 '판정'·'검사기' |

- 쉬운 말: '다시 만들기'는 좌석 Redis가 통째로 사라진 뒤 DB 기록으로 좌석 상태를 다시 채우는 일, '종료 유예'는 쿠버네티스가 파드에 끝내라고 알린 뒤 강제로 끄기까지 기다리는 시간, '반영 시각'은 purchase-svc가 결제 결과를 주문에 적은 시각이다.

### 8. 범위 밖(정리 목록에 그대로 둔다)

- HOT-252의 다른 줄 셋: core-svc 내부 판매 설정 경로의 호출자 제한(NetworkPolicy, wbs 0.4.4), `lst`와 구매 세션 jti 묶기, `payment-model` V-T40 흔들림.
- PRF-203의 다른 줄 셋: 하위 결제사 불일치 SEV2 로그와 관측 표 쓰기 차례, `pgProvider` 값 검사·중복 로그 집합 상한, 시뮬레이터의 하위 결제사 다시 찾기·채널 표 시작 옵션.
- PRF-181 같은 줄의 나머지: 원장 읽기가 계속 실패하는 행의 100ms 다시 잡기 로그. 취소 어댑터의 JSON `code` 없는 4xx는 이미 고쳐져 있다(토스형 `adapters/pg/toss-shaped.ts` `cancel`이 `!code`면 UNKNOWN, PRF-184 `94136c3e`, 포트원 `portone-gateway.ts` `cancel`도 `!code`면 UNKNOWN). 감독이 정리 목록에서 지울 때 확인만 한다. PRF-181의 '시험 빈 곳' 줄.
- PRF-182의 '시험 빈 곳' 줄.
- payment-svc 릴레이 파드의 종료 유예(대사 호출, 끊겨도 돈·상태가 틀리지 않는다)와 운영 환경 값 파일(아직 없음).

## 실패 확인

시험 담당 `w9f2-test`(claude-opus-5-5), 2026-11-17. 시험 커밋 `4e3afad7`을 고치기 전 제품 코드(`aca1ac72`, 정본·계획만 바뀐 트리) 위에서 돌렸다. Docker 잠금을 잡고 §6의 통합 명령 셋을 그대로 돌린 뒤 띄운 컨테이너가 남지 않은 것을 보고 잠금을 풀었다.

| # | 시험(파일) | 결과 | 까닭 |
| --- | --- | --- | --- |
| H1 | `HOT-252 판매 정책 한도 2로 잡은 홀드를 다시 만든 뒤 예약 한도도 2다`(sale-policy 통합) | 실패 | 다시 만든 홀드 Hash에 `lim`이 없다(`'null'`, 기대 `'2'`) |
| H2 | `HOT-252 원장 적재는 HELD의 holdLimit을 …`(seat-hold-ledger 통합) | 실패 | `hold_limit` 칸이 없다(마이그레이션 없음). 칸만 임시로 더해 보면 HELD(3)가 NULL로 남는다 |
| H3 | `HOT-252 다시 만들기는 원장 홀드·묶인 주문의 홀드에 …`(seat-rebuild 통합, rebuild-orders-plan·rebuild-memory 단위) | 실패 셋 | 통합은 칸 없음(칸만 임시로 더하면 `lim` 넷 모두 없음, 기대 `'2'·'3'·없음·'4'`), planRebuild는 HELD·SOLD 좌석에 `holdLimit`이 없고, 메모리 writeSeats는 `lim`을 쓰지 않는다 |
| H4 | `HOT-252 다시 만들기 좌석 Lua는 열째 칸이 …`(seat-rebuild 통합) | 실패 | 열째 칸 `'0'`을 받아 `['OK', 2]`로 쓴다(예비 칸이라 검사가 없다) |
| H5 | `HOT-252 팬 홀드 Lua 셋은 HELD 항목에 holdLimit을 …`(hold-lifecycle 통합) | 실패 | 홀드 Lua HELD 항목에 `holdLimit`이 없다(기대 `'3'`) |
| H6 | `HOT-252 Stream 릴레이는 holdLimit을 …`(seat-event 단위 둘, seat-stream-relay 단위 하나) | 실패 셋 | `toSeatEvent`·`toLedgerHoldEvent`가 `holdLimit`을 옮기지 않고, 릴레이가 부호기에 넘기는 SeatEvent에도 없다 |
| H7 | `HOT-252 마이그레이션: 0027 seat_hold.hold_limit과 CHECK`(purchase-migration 통합) | 실패 | 저널에 `0027_` 마이그레이션이 없다 |
| A1 | `PRF-203 회차 지정 시각이 지금 + 5분을 넘으면 …`(pg-sub-provider 단위) | 실패 | 지금 + 5분 + 1ms를 받아 `written: true`다 |
| A2 | `PRF-203 먼 미래 지정이 거절되어 …`(payment-sub-provider 통합) | 실패 | 9999년 지정을 받아 `written: true`다 |
| G1 | `PRF181_payment-svc 서비스 파드 종료 유예는 90초이고 …`(chart.test.mjs) | 실패 | payment-svc Deployment가 차트 기본 30초다 |
| P1 | `PRF-182 P4 결과 모름을 늦게 푼 주문(T13)의 …`(invariants 통합) | 실패 | 승인 + 30분으로 재어 넷 모두 위반(기대는 반영 + 30분 + 1ms인 한 건) |
| P2 | `PRF-182 P4 입금 대기에서 온 승인(T16)도 …`(invariants 통합) | 실패 | 반영 + 25분 발권이 승인 + 30분을 넘어 위반 한 건(기대 0) |
| P3 | `PRF-182 P4 바로 승인(T9)은 …`(invariants 통합) | 처음부터 통과(대조) | 이미 있는 동작이다. M-P1(모든 전이에 greatest(승인, 첫 APPROVED 반영))을 `p4_issue_deadline_exceeded.sql`에 손으로 넣자 실패(위반 0건, 기대 1건)했고 `git checkout`으로 되돌렸다 |

- **수**: 새 시험 17개(계획 13항목. H3은 통합·planRebuild·메모리 셋, H6은 toSeatEvent·toLedgerHoldEvent·릴레이 셋으로 나눔) 가운데 16개가 실패, P3 하나가 처음부터 통과(위 표본으로 한 번 실패를 봄). 단위 6개 모두 실패(purchase 5, payment 1), 렌더 1개 실패, 통합 10개 가운데 9개 실패(purchase 6, payment 1, invariant-checker 2)와 P3 통과.
- **기존 시험 고침이라 함께 실패하는 것**: 계획 §3의 인터페이스(`RebuildHold.holdLimit`·`RebuildLedgerRow.holdLimit: number | null`)에 맞춰 seat-rebuild-source 통합 넷(holds 둘, saleHolds, ledgerRows)의 기대값에 `holdLimit`을 넣었다. 칸이 없어 실패하고, 칸만 임시로 더해도 읽기가 `holdLimit`을 주지 않아 실패한다. purchase-migration `check 제약 이름이 schema.ts와 같게 DB에 있다`는 목록에 `seat_hold_hold_limit_check`를 더해 실패한다(제약 이름은 정본에 없어 PostgreSQL 기본 이름 꼴로 정했다).
- **통과를 지킨 것**: AssignEventPg 기존 호출 넷(단위 셋, 통합 하나)은 시계를 넘겨 그대로 통과한다. §6의 나머지 파일(seat-hold-ledger-e2e, seat-stream-relay 통합)과 단위 rebuild-plan·seat-rebuilder는 통과한다(원장 도우미에 `holdLimit: null` 기본값).
- **틀린 구현 하나 더 본 것**: G1은 서비스 값 파일만 90으로 고친 꼴(M-G1의 '합본을 빠뜨림')을 손으로 넣어 합본 줄에서 실패(60 ≠ 90)하는 것을 보고 되돌렸다.
- **contracts 생성물**: 생성물이 없어 컴파일되지 않는 시험은 없다. seat-event 단위의 `SeatEvent.safeParse`는 지금 생성물(모르는 칸을 버림)과 다시 만든 생성물 모두에서 통과한다.
- **빈 뼈대**: `AssignEventPgDeps.clock`(필수), `SeatEventMessage.holdLimit?`, `LedgerHoldEvent.holdLimit?`, `RebuildSeat` 두 갈래의 `holdLimit?`, `RebuildHold.holdLimit?`·`RebuildLedgerRow.holdLimit?`(계획은 필수 칸이지만 제품 코드가 컴파일되게 선택 칸으로 둠. 구현 담당이 필수로 바꾼다). 동작은 없다. `tsc --noEmit`은 payment-svc·invariant-checker·purchase-svc 모두 이 변경으로 생긴 오류가 없다(purchase-svc는 이 작업 폴더에 `@peaket/shuffle` 빌드가 없어 queue-svc 쪽 기존 오류만 난다).

## 시험 이의

(구현 담당이 쓴다)

## 리뷰

(리뷰 담당이 쓴다)

## 검증

(검증 담당이 쓴다)

## 담당 표

(감독이 쓴다)
