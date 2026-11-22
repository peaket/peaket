# 작업 계획: W12-purchase-fixes(purchase-svc 기존 실패 조사·시험 고침)

- **무엇**: 2026-11-22 감독이 갈래 3에 맡긴 purchase-svc 기존 실패 둘(`GAT080_0014` 마이그레이션 계약 시험, `GAT-110 P3` Outbox)을 실제 PostgreSQL에서 재현하고 원인을 갈랐다. 둘 다 제품 결함이 아니라 시험 기대값·시계 결함이어서 시험만 고쳤다. 함께 맡은 V-T40 재현 여부와 `identity-grpc.int.test.ts`의 실제 gRPC 서버 호출 여부도 확인했다. 검토 기록이고 규범이 아니다. 정본과 다르면 정본이 이긴다.
- **바탕**: 작업 폴더 `D:/ticketpass-lane3`, 가지 `feature/lane3-W12-purchase-fixes`, 출발점 `origin/develop` `e7f15543d`(R-752). Docker 잠금 `bash D:/ticketpass-locks/lock.sh take docker lane3-W12-purchase-fixes`로 잡고 놓았다.
- **등급·차례**: 시험만 묶음(`Batch-Kind: test-only`, 제품 코드·마이그레이션·계약 변경 없음). 순서는 **plan → test → review → verify → record**(impl 없음). 실패 재현 → 원인 분류 → 시험 고침 → 리뷰 → 검증. 커밋 꼬리말은 역할마다 `Role`·`Agent-Session`·`Batch`를 달고, `Batch-Kind: test-only`는 plan 커밋에만 단다.

## 결과 요약

| 조사 대상 | 지금 상태 | 분류 | 한 일 |
| --- | --- | --- | --- |
| `GAT080_0014` purchase 마이그레이션 계약 시험 | 실패 재현(1/88) | 낡은 시험 기대(제품·마이그레이션 정상) | CHECK 이름 둘을 기대 목록에 더함 |
| `GAT-110 P3` `event-refund` Outbox 23514 | 실패 재현(1/37) | 시험의 시계·파티션 결함(제품 정상) | 서비스·저장소·잡기 어댑터에 같은 주입 시계, 그 날 파티션 생성 |
| V-T40 purchase 기존 실패 | 재현되지 않음(51/51·28/28 통과) | 이미 해결(W12-vt40, R-745) | 고치지 않음 |
| `identity-grpc.int.test.ts` 실제 gRPC 서버 호출 | 실제 서버를 부른다(48/48 통과) | 시험 설계상 실제 루프백 gRPC + 짧은 벽시계 마감 | 고치지 않음, 정리 목록 후보로 남김 |

## 실패 확인

고치기 전 트리(출발점 `e7f15543d`)에서 두 파일을 실제 PostgreSQL 18 컨테이너로 돌려 확인했다.

- `purchase-migration.int.test.ts`: 88개 중 1개 실패(87 통과). `order_cancellation` CHECK 기대 6개, 실제 8개 — 0030 `order_cancellation_refund_attempt_check`·0031 `order_cancellation_refund_account_answer_check`가 목록에 없었다.
- `event-refund.int.test.ts`: 37개 중 1개 실패(36 통과). `GAT-110 P3`의 `start`에서 `error: no partition of relation "outbox" found for row`(SQLSTATE 23514), 실패 행 `id`는 실제 오늘(2026-11-22) UUIDv7.
- V-T40: `payment-model.int.test.ts` 51/51·`seat-model.int.test.ts` 28/28 통과 — 실패 없음.
- `identity-grpc.int.test.ts`: 48/48 통과 — 실패 없음.

## 1. `GAT080_0014` — order_cancellation CHECK 목록 8≠6

**재현**: `pnpm --filter @peaket/purchase-svc test:integration test-int/purchase-migration.int.test.ts`
→ 88개 중 1개 실패. `purchase-migration.int.test.ts:107`(고치기 전 `:106`)의 단언.

- 기대(6개): `amounts`·`deduction_gap`·`reason`·`refund_account_case`·`refund_attempts`·`status`
- 실제(8개): 위 6개 + `order_cancellation_refund_account_answer_check`(0031)·`order_cancellation_refund_attempt_check`(0030)

**원인**: 제품 결함이 아니다. BAT-425(지연 환급 계좌 다시 받기, R-716)가 purchase 마이그레이션 0030·0031에서 `order_cancellation`에 CHECK 둘을 더했는데, 이 시험은 목록을 통째로 견주므로 이름을 더해야 한다. 앞서 0029를 더했을 때도 같은 이유로 이 단언을 고친 기록이 있다(BAT-420-rest, R-702). 마이그레이션 계약(0014) 자체는 정상이고, 0030·0031의 제약도 정본(배상·환급 재시도)과 맞는다.

**고침**: `services/purchase-svc/test-int/purchase-migration.int.test.ts:105~107` — 주석에 0030·0031이 더한 제약을 적고, 기대 배열에 두 이름을 알파벳 순서로 넣었다. 목록을 통째로 견주는 방식은 그대로 두어 몰래 생긴 CHECK를 계속 잡는다.

## 2. `GAT-110 P3` — Outbox 넣기 23514(no partition of relation "outbox")

**재현**: `pnpm --filter @peaket/purchase-svc test:integration test-int/event-refund.int.test.ts -t "GAT-110 P3"`
→ 37개 중 1개 실패. 고치기 전에는 `event-refund.int.test.ts:1047`의 `svc(0).start(...)`에서 곧바로 실패했다.

- 실제 오류: `error: no partition of relation "outbox" found for row`(SQLSTATE 23514), 실패한 행의 `id`는 실제 오늘(2026-11-22)의 UUIDv7.
- 이 파일은 `beforeAll`에서 파티션을 만들지 않고, BAT-420 절의 `beforeAll`에서만 `ensureOutboxPartitions(db, fakeClock({ now: NOW }))`(NOW = 2026-11-14)로 2026-11-14~11-21 파티션을 만든다.
- P3 시험은 `nowMs`로만 가짜 시각(C = 2026-12-04)을 쓰고, `DrizzleEventRefundStore`·`DrizzleEventRefundClaims`는 기본 `systemClock`을 썼다. 그래서 Outbox ID는 실제 오늘 날짜로 만들어지고, 그 날 파티션이 없어 23514가 났다.

**원인**: 제품 결함이 아니다. 시험이 가짜 시각과 실제 시계를 섞은 결함이다. 2026-11-14~11-21 사이에 돌면 우연히 통과하고, 11-22부터는 날짜가 바뀌어 항상 실패하는 시간 폭탄이다.

**고침**: `services/purchase-svc/test-int/event-refund.int.test.ts`
- `scopedStore(requestId, clock = systemClock)`로 시계를 받게 하고, P3에서 `const clock: Clock = { now: () => now, monotonicMs: () => now - C }`를 만든다.
- `ensureOutboxPartitions(db, clock)`로 C가 든 한국 시각 날(2026-12-04)의 파티션을 만든다.
- P3의 `store`와 `claims`에 같은 clock을 준다(`DrizzleEventRefundClaims(db, clock)` 포함). 잡기 어댑터도 Outbox를 쓰므로 저장소만 고치면 같은 실패가 남는다.

## 3. V-T40 purchase 기존 실패 — 지금은 재현되지 않는다

- `pnpm --filter @peaket/purchase-svc test:integration test-int/payment-model.int.test.ts` → **51/51 통과**(292.81초).
- `pnpm --filter @peaket/purchase-svc test:integration test-int/seat-model.int.test.ts` → **28/28 통과**(115.44초).
- W12-vt40(R-745, `3d635d07e`·`d8383dca1`)가 끊긴 판 멈추기와 집중 경합 허용 순서를 고쳐 `origin/develop`에 이미 들어와 있다. 갈래 3이 따로 고칠 것은 없다.
- 참고: payment-model 첫 실행은 51/51 통과였는데 프로세스 끝 코드가 1이었고, 같은 명령 재실행은 0이었다. 시험 실패는 아니며 재현되지 않았다. 종료 코드 흔들림 후보로만 남긴다.

## 4. `identity-grpc.int.test.ts` — 실제 gRPC 서버를 부른다

- 파일 머리 주석(`:5~8`)과 코드가 그렇다. `beforeAll`(`:72~80`)에서 실제 `@grpc/grpc-js` `Server`를 `127.0.0.1:0`에 띄우고, 계약 설명자 `@peaket/contracts/proto`의 `identityV1Identity`를 실어 `GetVerificationStatus`·`ComputeContactRef`를 붙인다. 클라이언트(`GrpcIdentityRecheck`·`GrpcContactRefs`)는 그 주소로 진짜 gRPC 호출을 한다.
- 서버 답은 시험이 정하지만, 전송·채널·데드라인은 실제다. 주석대로 gRPC 데드라인이 벽시계라 가짜 시계를 쓰지 않는다.
- 짧은 마감: 재확인 기본 150ms(`:115`), 연락처 참조 50ms(`:257~271`). 파일만 돌리면 48/48 통과(2.75초)했지만, 통합 전체를 몰아 돌릴 때 `previousPid` 단언(`:143~147`)이 가끔 실패한다는 기록이 있다(`docs/lanes/lane3-cleanup.md:70`). 콜드 스타트(채널 준비)가 150ms를 넘기면 `DEADLINE_EXCEEDED` → `FAILED deadline`이 되어 단언이 깨지는 것으로 본다.
- 이 묶음에서는 고치지 않는다. 제안: `beforeAll`에서 같은 주소로 `waitForReady`/한 번 미리 부르기로 채널을 데우거나, 데드라인을 시험 설정으로 빼 CI 부하에서도 결정적으로 만든다. 정리 목록에 올릴 후보다.

## 리뷰

2026-11-22, `lane3-w12purchase-review`(시험 담당과 다른 세션). **막는 지적 없음.**

- **0030·0031 CHECK 이름 근거**: `services/purchase-svc/migrations/0030_compensation_and_refund_attempt.sql:31`의 `order_cancellation_refund_attempt_check`, `0031_refund_account_idempotency.sql:4`의 `order_cancellation_refund_account_answer_check`와 시험 기대 이름이 같다. BAT-425(지연 환급 계좌 다시 받기)가 더한 제약이고, GAT080_0014가 보는 0014 계약 자체는 바뀌지 않았다.
- **P3 시계 주입이 제품 기본 시계를 바꾸지 않는가**: 제품 기본은 그대로 `systemClock`이다(`drizzle-event-refund-store.ts:100`, `drizzle-event-refund-claims.ts:24`). 시험이 생성자에 명시 시계를 넘길 뿐이라 제품 동작 변화가 없다. `git diff e7f15543d..HEAD -- services/purchase-svc/src services/purchase-svc/migrations`가 비어 있음을 확인했다.
- **CHECK 목록 통째 비교 유지**: `purchase-migration.int.test.ts:107`이 여전히 `toEqual`로 8개 이름을 전부 견준다. 새 CHECK가 몰래 생기면 계속 잡는다.
- **identity-grpc 흔들림은 후속**: 이 묶음에서 고치지 않고 `docs/lanes/lane3-cleanup.md`의 기존 줄에 원인 후보(실제 루프백 gRPC + 재확인 150ms·연락처 50ms 벽시계 마감)만 덧붙였다. 채널 데우기·데드라인 설정화는 후속 정리 목록 몫으로 남긴다.
- **시험만 묶음 조건**: test 커밋이 시험 파일 둘만 바꿨고, 제품·마이그레이션·계약 변경이 없다. 되돌릴 지적 없음.

## 검증

검증 예정: `purchase-migration.int.test.ts`·`event-refund.int.test.ts` 재실행, `typecheck`, V-T40 두 파일과 `identity-grpc.int` 재확인. 검증 커밋에서 결과 표를 채운다.

## 담당 표

| 역할 | 세션 ID | 모델 | 시작 | 끝 |
| --- | --- | --- | --- | --- |
| plan | lane3-w12purchase-plan | deepseek-v4.1-flash | 2026-11-22T09:50+09:00 | 2026-11-22T10:25+09:00 |
| test | lane3-w12purchase-test | deepseek-v4.1-flash | 2026-11-22T10:25+09:00 | 2026-11-22T10:45+09:00 |
| review | lane3-w12purchase-review | deepseek-v4.1-flash | 2026-11-22T10:50+09:00 | 2026-11-22T11:00+09:00 |
| verify | lane3-w12purchase-verify | deepseek-v4.1-flash | 2026-11-22T11:00+09:00 | 2026-11-22T11:10+09:00 |

## 감독에게

1. **Docker 잠금 도우미와 WSL**: 이 PC의 `bash`는 WSL bash라 `lock.sh` 안의 `D:/ticketpass-locks/...` 경로를 못 찾는다(`who`는 늘 '비어 있음', `take`는 늘 '잠김'). `C:\Program Files\Git\bin\bash.exe /d/ticketpass-locks/lock.sh ...`로 실행해야 잠금이 맞는다. 다른 갈래 담당이 같은 실수를 하면 잠금 없이 컨테이너를 띄울 수 있으니 지시문에 경로를 적는 것이 좋다.
2. **identity-grpc 정리 목록**: 위 4의 제안(채널 데우기 또는 데드라인 설정화)을 `docs/lanes/lane3-cleanup.md`에 올릴지 정해 달라. 시험은 실제 gRPC를 보므로 가짜 서버로 바꾸는 것은 답이 아니다.
3. **V-T40**: R-745로 이미 해결되어 이 묶음에서 할 일이 없다. 감독 메모의 'V-T40 purchase 기존 실패'는 낡은 항목으로 본다.
