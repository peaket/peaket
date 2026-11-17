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

구현 담당 `w9f2-impl`(claude-opus-5-5), 2026-11-17. 시험 파일은 고치지 않았다. 아래 2~4는 시험 담당이 고칠 몫이고, 고치면 제품 코드는 그대로 통과한다(2·3은 기대값에 칸 하나, 4는 0027 몫을 더하는 것).

1. **`holdLimit` 상한(감독 답 반영)**: `seat_hold.hold_limit`은 int4라 적재 변환(`toLedgerHoldEvent`, 적재기도 같은 함수 `ledgerHoldLimitOf`로 한 번 더)은 HELD·FAN의 1 이상 **2,147,483,647 이하** 정수만 싣고 그 밖은 칸을 빼 NULL로 적재한다(사건은 보류하지 않는다, 정본 '틀린 값은 NULL'). 구현이 정한 정본 빈칸으로 seat-hold §6 '1인 한도 되살리기' '원장'과 data.md `seat_hold.hold_limit` 문단에 한 줄씩 적었다. `toSeatEvent`는 상한을 두지 않는다(asyncapi `integer minimum 1`, avsc `long`).
2. **Stream HELD 칸을 정확히 견주는 기존 시험 셋(메모리·Valkey 짝, 정본과 어긋남)**: 정본(seat-hold §6 '1인 한도 되살리기' '사건')대로 팬 홀드 Lua 셋이 HELD 항목에 `holdLimit`을 싣자, 칸 목록을 `toEqual`로 견주는 아래 시험이 칸 하나가 더 있다고 실패한다. 메모리 저장소는 Lua의 쌍둥이(같은 사례를 메모리와 Valkey에 똑같이 돈다)라 같은 칸을 싣게 했다(빼면 Valkey 짝만 어긋나고, 시험을 고친 뒤 메모리 짝이 다시 실패한다).
   - `test/hold-cases.ts` `FR010_ST35_①`의 `row()`(단위 `test/hold-seats.test.ts` [메모리], 통합 `test-int/seat-store.int.test.ts` [Valkey Lua]): `holdLimit: String(i.limit)`이 빠졌다.
   - `test/pin-cases.ts` `heldRow()`(`pin_ST35_`·`pin_ST7_`, 단위 `test/pin.test.ts`, 통합 `test-int/pin.int.test.ts`): 묶기 한도 인자(`holdLimit: String(<묶기 limit>)`)가 빠졌다.
   - 같은 까닭으로 data.md §3 `s:{event:E}:stream`의 HELD 칸 목록에도 `holdLimit`이 없어(계획이 고치지 않은 곳) 이번 정본 커밋에서 더했다. 위 시험 이름의 '칸은 data.md §3대로다'와 맞추려면 기대값에 칸을 더하면 된다.
3. **릴레이 통합의 기대 SeatEvent 도우미(정본과 어긋남)**: `test-int/seat-stream.ts` `expectedSeatEvent()`가 Stream 칸에서 SeatEvent를 만들 때 `holdLimit`을 옮기지 않아, 계획 §6 목록의 `test-int/seat-stream-relay.int.test.ts` 다섯(`ST35_HELD 항목 하나가…`, `여러 항목(좌석 5개, 홀드 셋)…`, `보낼 수 없는 항목…`, `보내기가 확인 전에 실패하면…`, `Kafka를 멈춘 채 틱…`)이 `toEqual`에서 실패한다(받은 값에 `holdLimit: 4`가 더 있다). 도우미가 HELD·FAN이고 칸이 있으면 `holdLimit: Number(f.holdLimit)`을 싣게 고치면 된다. 실패 확인 절의 '통과를 지킨 것'(seat-stream-relay 통합)은 구현 전이라 통과했던 것이다.
4. **마이그레이션 0027을 반영하지 않은 표 모양 단위 시험(시험 몫이 빠짐)**: `test/purchase-schema.test.ts`의 일곱이 0026까지의 목록을 박아 둬 실패한다. `seat_hold` 칸 목록(11 → 12, `hold_limit integer` 널 허용), check 목록과 '같은 이름·같은 식으로 SQL에 있다'(0000만 읽는다. 새 CHECK는 0027의 `ALTER TABLE … ADD CONSTRAINT`), '열이 모두 SQL에 있다'(0002의 ADD COLUMN만 더한다), `_journal.json` 차례(0027 `when` 1794904374507 > 0026), 'SQL 파일은 기록에 있는 것뿐이다', '마지막 스냅샷'(0027_snapshot.json). 0026 묶음이 같은 파일에 더한 꼴(`RELOOK2_TAG`·0026 SQL 시험)로 0027 몫을 더하면 된다. 0027 SQL은 `ALTER TABLE "seat_hold" ADD COLUMN "hold_limit" integer`와 `ADD CONSTRAINT "seat_hold_hold_limit_check" CHECK ("seat_hold"."hold_limit" is null or "seat_hold"."hold_limit" >= 1)` 두 문뿐이다(머리 주석 넉 줄).
5. **흔들림 하나(이 묶음과 무관)**: 첫 통합 돌림에서 `test-int/hold-lifecycle.int.test.ts` `정지 집합 전이 S-T23 > 묶인 좌석·지난 최대 체류는 옮기지 않고 ordered에서만 뺀다`가 한 번 실패했다(moved 1, dropped 1). 시험이 `maxStay`를 호스트 시계 `Date.now() - 1`로 쓰고 Lua는 컨테이너 `TIME`으로 견주어, 두 시계가 1ms 넘게 어긋나면 지나지 않은 것으로 본다. 같은 파일만 다시 돌리면 45개 모두 통과했다. 이 묶음이 바꾼 칸(Stream `holdLimit`)과 닿지 않는다.

## 시험 이의 답

시험 담당 `w9f2-test`(claude-opus-5-5), 2026-11-17. 가지 끝 `7eafd96a`에서 2~4를 정본과 견주었다. 셋 다 맞는 이의라 받아들여 `dccf1723`으로 고쳤다.

- **1**(상한 2,147,483,647): 감독 답에 따라 구현이 정한 정본 빈칸이다. 시험 담당이 앞서 낸 int4 범위 이의에 대한 답이라 시험은 바꾸지 않았다.
- **2 받아들임**: seat-hold §6 '1인 한도 되살리기' '사건'과 data.md §3 HELD 칸에 `holdLimit`이 있으니 기대값이 틀렸다. `test/hold-cases.ts` `FR010_ST35_①` `row()`에 `holdLimit: String(i.limit)`을, `test/pin-cases.ts` `heldRow()`에 묶기 한도 인자(기본 4)를 더했다. 메모리 단위와 Valkey 통합 짝에 모두 적용된다.
- **3 받아들임**: asyncapi `SeatEvent.holdLimit`(HELD이고 holdKind FAN)에 맞춰, `test-int/seat-stream.ts` `expectedSeatEvent()`가 칸이 있으면 `Number(f.holdLimit)`을 옮긴다.
- **4 받아들임, 꼴도 바꿈**: `test/purchase-schema.test.ts`에 0027 몫을 더했다. `seat_hold` 칸은 12개, check는 셋이고, 0027 SQL이 두 문뿐이며 스냅샷이 0026에 이어지는지 보는 시험을 하나 더했다. 새 마이그레이션마다 깨지지 않게 다음처럼 바꾸었다.
  - SQL 파일 목록은 `_journal.json`과 견준다.
  - 마지막 스냅샷은 기록의 마지막과 견준다.
  - 기록 차례는 idx가 차례인지, tag가 네 자리 idx로 시작하는지로 본다. 0027까지의 이름 고정 목록은 그대로 둔다.
  - 칸·검사가 SQL에 있는지는 기록의 모든 SQL에서 `ALTER TABLE … ADD COLUMN`·`ADD CONSTRAINT … CHECK`를 찾아 본다.
- **5**(hold-lifecycle `maxStay` 호스트 시계 흔들림): 이 묶음의 범위 밖이라 고치지 않았다. 이번 확인에서는 재현되지 않았다.
- **확인**:
  - purchase 단위: 전체 128파일 4,124개가 통과했다(`--maxWorkers=4`). 기본 일꾼 수로 돌리면 gRPC 대역 단위 몇 개(`payment-confirm`·`payment-deposit`·`grpc-new-payment-pause`)가 돌 때마다 다르게 실패했다. 따로 돌리면 이 변경 전후 모두 통과하므로 부하 흔들림으로 본다.
  - 통합: Docker 잠금 아래에서 seat-store·pin·seat-stream-relay와 §6 목록(sale-policy, seat-hold-ledger, seat-hold-ledger-e2e, seat-rebuild, seat-rebuild-source, hold-lifecycle, purchase-migration) 10파일 394개가 통과했다. 띄운 컨테이너가 남지 않은 것을 보고 잠금을 풀었다.
  - tsc: 새 오류가 없다.

## 리뷰

리뷰 담당 `w9f2-review`(claude-opus-5-5), 2026-11-17. 가지 끝 `84adc074`를 `git diff origin/develop...HEAD`로 봤다. 코드·시험은 고치지 않았다. 직접 돌린 것은 Docker 없이 되는 것뿐이다: purchase 단위 7파일 294개(seat-event·seat-stream-relay·rebuild-memory·rebuild-plan·rebuild-orders-plan·seat-rebuilder·purchase-schema), payment 단위 `pg-sub-provider` 36개, `node --test tools/local/chart.test.mjs`의 PRF181 시험, `node tools/ci/avro-schema.mjs`(22개 파일 통과), `packages/contracts`의 `gen:check`(생성물이 계약과 같다). 모두 통과했다. 통합 시험은 구현·시험 담당의 보고를 믿었다.

### 지적별 판정

| 지적 | 판정 | 본 것 |
| --- | --- | --- |
| H(HOT-252) | **고쳐짐** | ① 한도는 팬 홀드에만 실린다: 홀드·자동 배정·묶기 Lua 셋의 HELD `XADD`에만 `holdLimit`(각 Lua의 한도 인자 ARGV 5·5·4, Hash `lim`에 쓰는 값과 같은 인자)이 붙고, 우선 구매 보류·RELEASED·EXPIRED 항목은 그대로다. `toSeatEvent`(`seat-event.ts` `holdLimitOfField`)와 `toLedgerHoldEvent`(`ledgerHoldLimitOf`)가 HELD·FAN이 아니면 한 번 더 뺀다. ② 원장 적재는 덮지 않는다: `on conflict … set held_at = coalesce(seat_hold.held_at, excluded.held_at), hold_limit = coalesce(seat_hold.hold_limit, excluded.hold_limit)`이고 `where`는 둘 가운데 빈 칸이 있을 때만이다. 끝 사건이 먼저 넣은 행은 뒤 HELD가 채운다. 틀린 값(0·소수·글·int4 상한 초과)은 칸만 NULL이고 사건은 적재된다(보류 없음). ③ 다시 만들기는 세 길 모두 되살린다: 원장 홀드(`held`, `fanLimitOf`), 판매 좌석(대조한 원장 행 `mine`, K3 갈래와 원장 갈래 둘 다), K1 묶인 주문(`pinnedRowOf`가 고른 HELD 행의 `hold_limit`). 우선 구매 보류 원장 행의 값은 쓰지 않는다. Saga 쪽 `ORDER_HOLD_LUA`는 좌석마다 `lim`이 다르면 NOT_FOUND이고 없는 좌석은 건너뛰므로, 한 홀드의 좌석 일부만 NULL인 옛 행이 섞여도 막히지 않는다. ④ Lua 인자 검사: 다시 만들기 좌석 Lua 열째 칸은 빈 글이거나 `^[1-9]%d*$`이고 15자리 이하일 때만 받고, 한 좌석만 틀려도 아무것도 쓰지 않는다(`rebuild-lua.ts:186~188`). TS 쪽 `assertRebuildSeats`가 같은 범위(1 ~ 999,999,999,999,999)를 먼저 본다. ⑤ Avro: 끝에 더한 `["null","long"]`·`default: null`이라 하위 호환이다. 검사 도구와 `gen:check`가 통과한다(생성물 `seatEvent.zod.ts`는 `zod.int().min(1).optional()`). 릴레이는 JSON 부호기(`jsonTradeEventCodec`)라 지금 Avro 부호화 몫은 없다. 다른 `trade.seats` 소비자(queue-svc)는 `type`이 있는 SeatEvent를 건너뛴다. ⑥ 마이그레이션 0027은 칸 하나와 CHECK 하나다. 스냅샷은 0026에 이어지고(`prevId`가 0026 `id`), 0026과의 차이는 `hold_limit` 칸과 `seat_hold_hold_limit_check`뿐이다. journal `when` 1794904374507(2026-11-17T08:32:54Z)은 0026(04:50:01Z)보다 늦다 |
| A(PRF-203) | **고쳐짐** | 시계는 생성자에서 받는 payment-svc 시계(`AssignEventPgDeps.clock`, 필수)이고 `updatedAtMs > clock.now() + 300_000`이면 `PaymentInputError('updated_at')`다. 그래서 +5분 정각은 받고 +1ms는 거절한다(A1이 둘 다 본다). 검사는 0 이상 안전한 정수 검사 바로 뒤, `subProviderConflict`와 `store.assignEvent`보다 앞이다(A1의 '하위 결제사 규칙에 걸리는 입력이어도 `updated_at`' 줄). 운영 조립은 아직 없어(OPS-290) 시계를 빠뜨린 조립은 생길 곳이 없고, 생겨도 형 검사가 막는다 |
| G(PRF-181) | **부분**(서비스 파드는 고쳐짐, 근거 숫자와 합본은 아래 R1·R2) | 서비스 파드: 차트 템플릿이 `service.terminationGracePeriodSeconds`를 쓰고 preStop `sleep`은 차트 기본 5초 그대로다. 종료 유예는 preStop을 포함해 센다. SIGTERM 뒤 `start.ts` close가 준비 상태를 내리고 gRPC 포트를 닫으면서 실행기 `stop()`이 돌던 행(호출과 그 뒤 쓰기)을 기다린다. 릴레이 Deployment는 `outboxRelay.terminationGracePeriodSeconds` 기본 30초 그대로이고 G1이 본다. 다만 90초의 근거로 적은 '승인 호출 한 번 63초'는 코드의 실행기 한도와 다르다(R1). 합본 90초는 split 모드에서 효과가 없다(R2) |
| P(PRF-182) | **고쳐짐** | `LEFT JOIN LATERAL`이 `seq > last_wait`이고 `to_status = 'APPROVED'`인 사건을 `seq` 차례로 하나만 고른다. 그래서 마지막 입금 대기 뒤 첫 승인 반영(T9·T13·T16 가운데 하나)을 잡고, 뒤의 T19(APPROVED→APPROVED)는 고르지 않는다. purchase의 APPROVED로 가는 전이는 T9(RESERVED)·T13(UNKNOWN)·T16(AWAITING_DEPOSIT)·T19뿐이다(`order.ts:57~67`). `from_status`가 NULL이거나 사건이 없으면 `CASE`의 ELSE로 가 T9 규칙(승인 시각)이다. 결과 모름에서 입금 대기로 간 뒤(T14) 입금된 주문은 `last_wait`가 T14 행이고 첫 승인 반영이 T16이라 반영 시각 기준이다(purchase `approvalIssueDueAtMs`와 같다). 거짓 양성: `from_status`가 빈 옛 행의 T13은 승인 시각으로 재어 위반으로 셀 수 있다(운영 자료가 없어 실제로는 없다). 거짓 음성: 아래 R3(아주 작음). 큐 행 갈래(`issue_due_at < as_of`)는 바뀌지 않았다 |

### 새 지적

| # | 등급 | 파일:줄 | 내용 | 고칠 방향 |
| --- | --- | --- | --- | --- |
| R1 | 중간 | `deploy/workloads/payment-svc/values.yaml:7~10`, `deploy/envs/local/v1-bundle.yaml:43~46`, `docs/devops.md:532`, `tools/local/chart.test.mjs:489~491` | 90초 근거의 '승인 호출 한 번 = 연결 3 + 읽기 60 = 63초'가 코드와 맞지 않는다. 실행기는 승인 호출을 `CONFIRM_CALL_GUARD_MS` 72초로 감싸고(`services/payment-svc/src/modules/payment/domain/confirm-runner.ts:42`, 어댑터 시간 합 상한 `CONFIRM_CALL_BUDGET_MS` 70초 = 읽기 60 + 뒤따르는 조회, `payment-gateway.ts:252~255`), 그 뒤 쓰기(`finish`)는 문장 한도 5초 × 최대 3번 + 쉬기 0.5초다. 그래서 보통 경우 5 + 72 + 1 ≈ 78초로 여유가 적힌 20초가 아니라 약 12초이고, 쓰기를 다시 하는 경우 5 + 72 + 15.5 ≈ 92.5초로 90초를 넘는다(넘으면 임대 잔해 ②가 UNKNOWN으로 맞추므로 돈은 틀리지 않고 확정만 늦다). G1의 상수도 63초로 견주어 이 차이를 잡지 못한다 | 근거를 '5 + 실행기 한도 72 + 쓰기·닫기 여유 약 13'으로 고치거나, 다시 하기까지 덮으려면 값을 100초 [가정]로 올린다. G1은 상수를 손으로 적지 말고 `CONFIRM_CALL_GUARD_MS`에서 읽거나 같은 값으로 맞춘다 |
| R2 | 중간 | `services/bundle/src/main.ts:46~51`(`stopChild`), `:55`(주석 '60초'), `deploy/envs/local/v1-bundle.yaml:36·46` | v1 합본은 `PEAKET_BUNDLE_MODE: split`이라 payment-svc가 자식 프로세스로 돈다. 합본 시작 파일은 SIGTERM에 자식마다 SIGTERM을 보내고 **5초 뒤 SIGKILL**한다(자식은 hold → purchase → payment 차례로 하나씩). 그래서 종료 유예를 90초로 올려도 payment-svc 자식은 SIGTERM 뒤 5초 안에 죽고, 돌던 승인 호출은 PRF-181이 고치려던 그대로 끊겨 UNKNOWN이 된다. single 모드였어도 서비스를 뒤에서부터 차례로 닫아 payment-svc(목록 맨 앞)가 가장 늦게 닫히므로, 다른 셋의 닫기 시간만큼 payment-svc의 몫이 줄어든다. G1은 Deployment의 값만 보므로 이것을 잡지 못한다 | payment-svc 자식의 SIGKILL 대기를 실행기 한도 이상(예 80초)으로 두거나 자식을 함께 닫는다(병렬). 주석의 '60초'도 고친다. 합본 값 90초가 그 대기 + 다른 자식 닫기를 덮는지 다시 센다. 고치지 않을 거면 계획 §1 G 줄과 v1-bundle 주석에서 '합본도 승인 호출을 기다린다'는 말을 빼고 정리 목록에 남긴다 |
| R3 | 낮음 | `services/invariant-checker/sql/p4_issue_deadline_exceeded.sql:12`, `services/purchase-svc/src/modules/booking/application/apply-payment-result.ts:202`, `adapters/db/drizzle-orders.ts:253` | P4의 반영 시각은 `order_event.occurred_at`이고, 이것은 `transition()` 안에서 다시 읽은 시계 값이다. purchase가 큐 행 기한에 쓰는 `appliedAtMs`는 트랜잭션 전에 읽은 `clock.now()`라, SQL의 기준 시각이 잠금 대기·문장 시간만큼(보통 수 ms, 길어야 문장 한도) 늦다. 그만큼 위반을 덜 셀 수 있다(아주 작은 거짓 음성) | 이번에 고치지 않아도 된다. 정본 '같은 규칙'이라는 말 옆에 '반영 시각은 주문 사건 시각(수 ms 차이)'이라고 적어 두면 충분하다 |
| R4 | 정보 | `hold-lua.ts:291·349`, `auto-hold-lua.ts:138·259`, `pin-lua.ts:172·237` | 팬 홀드 Lua 셋은 한도 인자의 모양을 보지 않고 Stream `holdLimit`에 그대로 싣는다(이 묶음 전부터 Hash `lim`에도 그대로 썼다). 부르는 쪽이 판매 정책 결과(1 ~ 회차 한도)만 넘기고(`hold-seats.ts:639~665`, `pin.ts:106`), 받는 쪽 둘(`holdLimitOfField`, `ledgerHoldLimitOf`)이 틀린 값을 빼므로 지금 결함은 아니다 | 없음 |

### 시험 경계

- 구현 커밋 넷(`88101dd6`·`06430c55`·`dda57742`·`c5f7e808`)은 시험 파일을 건드리지 않았다. 구현 담당의 문서 커밋 `7eafd96a`은 정본(data·seat-hold)과 계획만 바꿨다.
- 시험 커밋 `4e3afad7`이 건드린 제품 코드는 셋이고 모두 빈 뼈대다: `assign-event-pg.ts`의 `clock` 칸과 import, `rebuild.ts`의 `holdLimit?` 칸 넷(형만), `seat-event.ts`의 `holdLimit?` 칸 둘. 동작은 없다. 시험 커밋 `dccf1723`은 시험 파일 넷만 바꿨다.

### 합쳐도 되는지

- **돈·좌석 핵심(H·A·P)은 합쳐도 된다.** 바른 동작, 경계, 차례가 바뀐 도착, 겹친 길(Lua 셋, 원장 홀드·판매 좌석·K1, T9·T13·T16)을 코드와 시험에서 모두 확인했다.
- **G는 R1·R2를 이 묶음에서 고친 뒤에 합치기를 권한다.** 둘 다 돈을 틀리게 하지는 않는다(끊긴 호출은 임대 잔해가 UNKNOWN으로 맞추고 조회로 확정된다). 다만 R2 때문에 이 묶음이 합본에 대해 말한 고침이 실제로는 듣지 않고, R1 때문에 정본의 근거 숫자가 틀려 있다. 고치는 데 손이 적다(문서·시험 상수, 합본 자식 SIGKILL 대기). 감독이 이번에 고치지 않기로 하면 R1·R2를 정리 목록(갈래 1)에 옮기고 G 줄을 '서비스 파드만'으로 좁혀 합친다.
- R3·R4는 합치기를 막지 않는다.

## 검증

(검증 담당이 쓴다)

## 담당 표

(감독이 쓴다)
