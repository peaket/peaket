# 웨이브 6 독립 감사 — TEST(시험·증거)

- 대상: `v0.2.0`(`6bcea3c7`, 2026-11-04)..`develop`(`42697cf7`, 웨이브 5 merge)
- 작업 위치: `D:\ticketpass-audit-ro3` (읽기 전용, 소스 수정 없음)
- 방법: ledger·measurements·커밋 본문을 코드·시험 이름·단언과 직접 대조하고, 표적 시험을 재실행했다. Docker test-int는 감사자 권한 밖이라 실행하지 않고 코드·설정으로만 확인했다.
- 요약: **높음 0, 중간 7, 낮음 4**. 중간은 완성 장부·증거 주장의 빨강(TEST-01·02·05), A급 돈·좌석 경로의 시험 빈틈(TEST-03·04), 권한·개인정보 어댑터의 mock 우회(TEST-06), CI 신호(TEST-07)다.

## 검토 범위

- 완성 장부: `docs/review/ledger/README.md`, 분야별 26개 파일, `docs/review/ledger-notes.md`, `tools/ci/ledger.mjs`. `node tools/ci/ledger.mjs --check` 재실행. `v0.2.0..develop` 커밋이 언급한 67개 묶음에 `--batch <묶음> --require`를 돌려 23개 실패를 확인.
- 측정 기록: `docs/review/measurements/BAT-425-wave3.md`·`BAT-425-wave5.md`, `BAT-465-R584-wave.md`·`BAT-465-remainder-2.md`, `BAT-435-gat170.md`·`BAT-435-gat170-remainder.md`, `BAT-610-wave.md`·`BAT-610-remainder.md`, `BAT-615-wave.md`, `BAT-620-wave.md`를 본문까지 읽고, 나머지는 표·주장 위주로 대조.
- 커밋: 321개 제목, 최근 12개와 웨이브 3~5의 주요 8개 본문. 정합 점검표의 "통과" 표현과 실제 게이트 결과를 대조.
- 시험 코드: `v0.2.0..develop`에서 바뀐 시험 1,168개 경로 중 웨이브 6의 새 시험(Q-T59·R-592·R-583·R-587·R-588·R-584·R-591)을 정독. `skip`·`skipIf`·`ctx.skip` 20건을 전수 확인. `test-int` 37개에서 `Memory` 사용을 확인하고, 고위험 경로가 실제 PostgreSQL/Valkey를 쓰는지 대조.
- CI: `gh run view`로 43649684807(R-590 주장), 43646995400(R-589), 43631752646(R-585), 43605816693(웨이브 2), 43655848810(R-591), 43658247038(R-593), 43660626765(HEAD)와 실패 job 로그를 확인.
- 표적 재실행(합 250건 통과):
  - `pnpm --filter @peaket/purchase-svc exec vitest run test/event-refund-gat130.test.ts test/booking-restriction.test.ts` → 21 통과
  - `pnpm --filter @peaket/queue-svc exec vitest run test/booking-restriction.test.ts` → 2 통과
  - `pnpm --filter @peaket/ops-svc exec vitest run test/payout-approval.test.ts test/event-cancellations.test.ts` → 9 통과
  - `pnpm --filter @peaket/purchase-svc exec vitest run test/order-saga.test.ts test/create-order.test.ts` → 202 통과
  - `pnpm --filter @peaket/core-svc exec vitest run test/export.test.ts test/webhook-dispatcher.test.ts` → 16 통과
- 참고: 이 worktree에는 `@peaket/shuffle`·`@peaket/search-normalize`의 `dist`가 없어 처음 두 실행이 해석 오류로 실패했다. 해당 패키지만 빌드한 뒤 재실행했고, 위 통과 수는 그 결과다.

## 발견

### [중간] TEST-01: 완성 장부의 공식 게이트가 A급 묶음에서 빨갛고, "ledger 통과"는 아무것도 검사하지 않는 보고 명령이다
- 영역/배치: 완성 장부·게이트, BAT-350·BAT-400·BAT-420·BAT-425·BAT-430·BAT-455·BAT-460·BAT-465·BAT-550·BAT-635 등.
- 위치: `docs/review/ledger/README.md:8`, `tools/ci/ledger.mjs:994-997`, `docs/BUILD_ORDER.md:118`, `docs/BUILD_ORDER.md:133`, `docs/BUILD_ORDER.md:141`, `docs/BUILD_ORDER.md:158`.
- 증거:
  - `node tools/ci/ledger.mjs --check`는 "장부가 맞다(항목 3650개, 빈칸 1013, ID만 1158, 미검증 4)"로 통과한다. README는 "완성본은 둘 다 0"이라고 적는다.
  - 커밋이 언급한 67개 묶음에 `--batch <묶음> --require`를 돌린 결과 **23개가 종료 코드 1**이다. 예: BAT-425 자동 14·ID만 113·빈칸 122, BAT-430 73·113·92, BAT-465 7·112·96, BAT-350 27·101·85, BAT-550 46·0·24, BAT-420 7·105·96, BAT-400 80·133·148, BAT-635 19·215·150.
  - R-583(`65b3ea48`) 본문은 "ledger BAT-425 ... 통과"라고 적는다. 같은 배치를 `--require`로 돌리면 실패한다. `--require` 없이 돌리면 빈칸이 있어도 종료 코드 0인 단순 보고라 "통과"가 성립하지 않는다.
  - `docs/BUILD_ORDER.md:118`의 BAT-350 행은 "ledger/trace-check ... 통과"라고 적지만 `--require`는 빈칸 85·ID만 101로 실패한다.
  - 44개 통과 중 6개(BAT-022·026·027·030·036·180)는 **항목 0개**로 통과한다. 게이트가 "전부 덮음"과 "아무것도 선택되지 않음"을 구분하지 못한다.
  - 배치 범위도 일정하지 않다. BAT-450은 `I-T21` 한 항목만, BAT-435는 `O-T37` 8항목만 보는데, 같은 커밋이 O-T20·SESSION_TERMINATED·mTLS·SCR-036을 바꾼다. 반대로 BAT-425·BAT-465는 문서 전체와 ASVS 표를 범위로 잡아 원래 0이 될 수 없다.
- 왜 문제인가: 완성 장부는 웨이브의 완료 판정 근거다. 그 게이트가 돈·좌석·환불을 다루는 A급 묶음에서 빨간데 커밋·BUILD_ORDER는 "통과"로 읽히게 적는다. 남은 빈칸 1013·ID만 1158이 커밋 기록에서 사라지고, 다음 사람이 닫힌 묶음으로 오해한다. 0항목 통과는 "검사했다"는 신호를 거짓으로 만든다.
- 재현/확인:
  - `node tools/ci/ledger.mjs --check` → exit 0, 위 수치.
  - `node tools/ci/ledger.mjs --batch BAT-425 --require` → "장부 확인 실패: 빈칸 122, ID만 113", exit 1.
  - `node tools/ci/ledger.mjs --batch BAT-350 --require` → "장부 확인 실패: 빈칸 85, ID만 101", exit 1.
- 제안 수정: `--batch`의 기본 종료 코드를 `--require`와 같게 만들고, 커밋·BUILD_ORDER에는 `--require` 결과만 "통과"로 쓴다. 배치 범위를 그 묶음이 실제로 닫는 ID 목록으로 좁히고, 항목 0개 선택은 실패로 처리한다.
- 확신도: 높음

### [중간] TEST-02: `--require`가 미검증·다른 단계를 통과로 세어, 검증 0건인 묶음도 초록이 된다
- 영역/배치: 완성 장부 게이트, BAT-620·BAT-202, C-T43·D-T12 ②·P-T39.
- 위치: `tools/ci/ledger.mjs:995-996`, `docs/review/ledger/README.md:10`, `docs/review/ledger/README.md:63-66`, `docs/review/ledger-notes.md:121`.
- 증거:
  - `--require`의 실패 조건은 `status === '빈칸' || status === 'ID만'`뿐이다. `미검증`과 `다른 단계`는 통과로 센다.
  - BAT-620은 범위 항목이 C-T43 하나뿐이고 그 상태가 `미검증`인데 `--batch BAT-620 --require`가 "장부 확인 통과(미검증 1은 따로 센다)"로 exit 0이다.
  - BAT-202도 D-T12 ②가 `미검증`인데 통과한다.
  - C-T43은 core-svc 시험이 이름을 달고 있지만 화면·SEV3 알림·감사 로그가 없어 전체가 `미검증`으로 남았다. P-T39 ①·②·④는 `다른 단계`인데 `ticket-issue.int.test.ts` 등이 이미 이름을 달고 있다(README의 "다시 볼 notes" 4건).
- 왜 문제인가: 미검증을 통과로 세면 "이 묶음의 모든 항목이 미검증"이어도 완료 게이트가 초록이 된다. C-T43처럼 일부는 시험됐고 일부만 막힌 항목은 전체가 미검증으로 남아 시험된 부분까지 장부에서 사라진다. "다른 단계"도 시험이 이미 있는데 통과로 세는 모순을 만든다.
- 재현/확인:
  - `node tools/ci/ledger.mjs --batch BAT-620 --require` → 상태 "미검증 1", "장부 확인 통과", exit 0.
  - `node tools/ci/ledger.mjs --batch BAT-202 --require` → "미검증 1", exit 0.
- 제안 수정: `--require`에 `미검증`·`다른 단계`도 실패로 세는 기본값을 두고, 허용하려면 `--allow-unverified` 같은 명시적 플래그를 쓴다. 최소한 배치 요약에 "검증 N/미검증 M"을 통과 조건으로 표시한다.
- 확신도: 높음

### [중간] TEST-03: R-T9 자동 정지의 "아래 경계"와 실행 중 교차가 시험에 없고, 코드는 기준을 넘긴 뒤 최대 4건을 더 보낸다
- 영역/배치: BAT-425 GAT-130 회차 취소 일괄 환불 자동 정지(R-T9).
- 위치: `docs/features/transfer-refund.md:455`, `docs/review/ledger/transfer-refund.md:28`, `services/purchase-svc/test/event-refund-gat130.test.ts:72-82`, `services/purchase-svc/test-int/event-refund.int.test.ts:217-233`, `services/purchase-svc/src/modules/refund/application/event-refund-service.ts:259`, `:269`.
- 증거:
  - R-T9 판정 기준은 "4.9%·19건은 멈추지 않는다. 5%·20건·서킷 열림은 토스형 몫만 멈추고 ... 멈춘 동안 토스형 새 취소 호출은 0건이다"이다.
  - 단위 시험은 19성공+1실패(20건, 5%)를 **시작 전에** 시드하고 시작 시 멈추는지만 본다. 4.9%, 19연속실패, 실행 중 기준 교차는 없다. test-int도 20건을 미리 시드한다.
  - 코드는 자동 정지 판정을 "결제사 몫마다 5건에 한 번" 다시 본다(`:259` 주석: "기준을 넘긴 뒤 새 호출을 4건 이내로 막는다", `:269`의 `n % 5 === 0`). 20건째 실패로 5%를 넘겨도 21~24건을 더 보낸 뒤 25건째에서야 멈출 수 있다.
- 왜 문제인가: 대량 환불 자동 정지는 결제사 장애 때 돈이 나가는 경로를 막는 안전장치다. 기준을 넘긴 뒤 최대 4건을 더 보내는 것은 "20건이면 멈춘다"와 어긋나고, 그 사이 실패가 더 쌓인다. 테스트가 시작 전 시드만 해서 이 동작과 아래 경계를 전혀 보지 못한다.
- 재현/확인:
  - `pnpm --filter @peaket/purchase-svc exec vitest run test/event-refund-gat130.test.ts test/booking-restriction.test.ts` → 21 통과. 파일 안에 4.9%·19건·중간 교차 단언은 없다.
  - 코드 대조: `event-refund-service.ts:269`가 5건마다만 `#stopReason`을 호출한다.
- 제안 수정: 4.9%(100건 중 4실패)·19연속실패·20건째 1실패 뒤 21~24건 호출 0을 단언하는 시험을 더한다. 판정 주기를 매 건 또는 임계 근처 매 건으로 바꾸거나, 최대 4건 지연을 정본에 명시한다.
- 확신도: 높음

### [중간] TEST-04: S-T37 ⑤ "결제 완료 → USED"가 시험에 없고, 실패 복귀만 시험된다
- 영역/배치: BAT-430 GAT-135 우선 구매 보류(S-T37 ⑤).
- 위치: `docs/review/ledger/seat-hold.md:127`, `services/purchase-svc/test/order-saga.test.ts:579`, `services/purchase-svc/test/create-order.test.ts:913`, `services/purchase-svc/src/modules/booking/adapters/db/drizzle-orders.ts:259-264`.
- 증거:
  - S-T37 ⑤ 기준은 "실패 뒤 권리는 OFFERED 그대로이고 좌석이 PRIORITY로 돌아가며, 다시 사서 결제를 마치면 USED"다. ledger는 자동 시험으로 표시한다.
  - `order-saga.test.ts:579`는 "결제 실패는 ... PRIORITY 보류로 되돌린다"만 본다. `create-order.test.ts:913`의 `USED`는 "이미 USED인 권리는 거절" 부정 경로다.
  - 실제 전이는 `drizzle-orders.ts:259-264`의 `APPROVED` 전이에서 `priority_grant.status='USED'`로 쓴다. 이 SQL을 단언하는 시험이 없다. `payment-result-e2e.int.test.ts`는 priority 주문을 만들지 않고, `priority-hold.int.test.ts`는 Lua만 본다. `markUsed`는 정의만 있고 호출되지 않는다.
- 왜 문제인가: 우선 구매 권리는 돈을 낸 팬의 권리다. 결제 성공 뒤 USED로 끝나지 않으면 같은 권리로 다시 살 수 있어 중복 판매가 되고, 반대로 실패 때 USED가 되면 권리를 잃는다. A급 전이의 성공 경로가 비어 있다.
- 재현/확인:
  - `pnpm --filter @peaket/purchase-svc exec vitest run test/order-saga.test.ts test/create-order.test.ts` → 202 통과. 그러나 USED 전이 단언은 없다.
  - `git grep -n "USED" -- services/purchase-svc/test*` → 위 두 곳뿐(부정 경로·무효 권리).
- 제안 수정: 실제 PostgreSQL test-int에서 priority 주문 → APPROVED 사건 → `priority_grant.status='USED'`·`used_order_id`를 단언한다. 메모리 어댑터에도 같은 전이를 넣어 단위 시험으로 고정한다.
- 확신도: 높음

### [중간] TEST-05: J-T3·J-T9가 자동 시험이라고 적혀 있지만 25억 경계·감사 로그·중복 지급 묶음이 시험에 없다
- 영역/배치: BAT-610 지급 묶음 2인 승인·포트원 지급(J-T3·J-T9).
- 위치: `docs/review/ledger/settlement.md:17`, `:23`, `docs/features/settlement.md:414`, `:420`, `services/ops-svc/test/payout-approval.test.ts:99-114`, `:152-157`, `docs/review/measurements/BAT-610-remainder.md:55`, `services/payment-svc/src/modules/settlement/application/settlements.ts:229`.
- 증거:
  - J-T3 기준은 "요청자와 같은 사람이 승인하면 403, 승인 전 결제사 요청 0, 합계 25억 원 묶음도 승인 업무에 금액이 그대로 저장되고 승인 화면·감사 로그·결제사 요청 합계가 같은 금액"이다.
  - `payout-approval.test.ts`는 24,920,000 고정 fake로 요청자/역할/재인증/실행만 본다. 25억 금액, 감사 로그, 결제사 요청 합계 비교가 없다.
  - J-T9 기준은 "수기 정산건 아이디 중복 생성이 없다 / 지급일에 포트원 일괄 지급 실행 건이 생기고 기록 뒤 PAID"다. `payout-approval.test.ts:152-157`은 승인 전 포트원 실행이 409인지만 본다. `settlements.ts:229`의 `payout-batch-exists`(중복 묶음 409)를 부르는 시험이 없다.
  - `BAT-610-remainder.md:55`는 "승인 업무 감사 체인 미연결(승인 행만 남고 ops 감사 체인에는 안 들어감)"을 중간으로 적는다. ledger는 J-T3를 자동 시험으로 표시한다.
- 왜 문제인가: 지급 승인은 돈이 나가는 A급 경로다. 25억은 int 상한과 맞닿은 금액이고, 중복 지급 묶음은 이중 지급로 이어질 수 있다. 감사 체인 미연결은 승인 기록의 변조 탐지를 약하게 한다. ledger의 "자동 시험"이 이 빈틈을 덮는다.
- 재현/확인:
  - `pnpm --filter @peaket/ops-svc exec vitest run test/payout-approval.test.ts test/event-cancellations.test.ts` → 9 통과. 25억·감사 로그·중복 묶음 단언은 없다.
  - `git grep -n "payout-batch-exists" -- services/*/test*` → 0건.
- 제안 수정: 25억 금액의 승인·화면·감사 로그·PG 합계 시험, 같은 payoutDate의 두 번째 `createPayoutBatch` 409 시험, 승인·실행을 ops 감사 체인에 넣고 체인 검증 시험을 더한다.
- 확신도: 높음

### [중간] TEST-06: BOOKER_EXPORT 실제 재인증 어댑터가 시험되지 않고, 시험은 아무 토큰이나 통과시키는 fake를 쓴다
- 영역/배치: BAT-610 예매자 명단 내보내기(I-T53·J-T26), 개인정보 대량 내보내기.
- 위치: `services/core-svc/test/export.test.ts:22-27`, `services/core-svc/src/modules/export/adapters/sources.ts:32-34`, `docs/review/ledger/identity.md:101-105`.
- 증거:
  - `export.test.ts`의 `TestReauth`는 토큰이 비어 있지 않으면 통과하고 factors를 항상 `['password','totp','passkey']`로 돌려준다.
  - 실제 `JwksBookersReauth`는 `verifyReauth(act: 'BOOKER_EXPORT')`와 `factors.includes('passkey')`를 검사하고, 계정 불일치는 `attendee-exports.ts:95`가 막는다. 이 어댑터를 부르는 시험이 없다.
  - ledger I-T53 ②는 `export.test.ts`를 근거로 자동 시험이다.
- 왜 문제인가: 예매자 명단은 이름·전화번호를 대량으로 내보내는 개인정보 경로다. act가 다르거나 passkey 없는 재인증 토큰을 거절하는지가 시험되지 않으면, 어댑터 배선이 바뀌어도 게이트가 초록으로 남는다. `TestReauth`가 실제 검증을 통째로 우회한다.
- 재현/확인:
  - `pnpm --filter @peaket/core-svc exec vitest run test/export.test.ts test/webhook-dispatcher.test.ts` → 16 통과. `JwksBookersReauth`를 부르는 시험은 0건(`git grep` 결과 소스뿐).
- 제안 수정: 실제 JWKS·서명 토큰으로 `JwksBookersReauth`를 시험한다: act 불일치 403, passkey 없음 403, 계정 불일치 403, 정상 통과. `UnavailableBookersReauth` 403도 함께.
- 확신도: 높음

### [중간] TEST-07: develop HEAD의 마지막 web 실행은 빨갛고(LCP 7972ms > 7255ms), 이후 초록 CI는 web을 건너뛴다
- 영역/배치: CI 신호, BAT-435 R-591(mTLS PoC·SCR-036)와 웨이브 4 마감.
- 위치: CI run `43655848810`(head `ce9ee2c0`), `docs/review/measurements/BAT-435-gat170-remainder.md`, `docs/BUILD_ORDER.md:135`.
- 증거:
  - `gh run view 43655848810` → `failure`, head `ce9ee2c0`. `web / budgets` job 실패: `Error: 월렛 LCP 7972ms > 한도 7255ms` (Expected <= 7255, Received 7971.9378).
  - 이후 `91247f68`(43658247038)·`42697cf7`(43660626765)는 success지만 `web` job이 **skipped**다. 즉 develop HEAD의 마지막 web 실행은 빨갛고, 초록 CI는 web을 돌리지 않았다.
  - R-591 커밋 본문은 "heavy gate 통과"라고 적고, BAT-435 측정 보고서도 CI 빨강을 적지 않는다. R-590의 "CI 43649684807 초록"은 `a0ac4689`(R-589)로 R-591 이전이다.
  - R-589는 월렛 TBT 219.5/203.5를 낮췄다고 하지만, 이번에는 LCP가 한도 +10%로 다시 빨갛다.
- 왜 문제인가: "CI 초록"이 web/스캐너 변경을 검증하지 않는다. 월렛 예산은 TBT에 이어 LCP로 두 번째 flaky 빨강이고, path filter 때문에 이후 초록이 이를 가린다. 웨이브의 마지막 web-affecting 커밋이 빨간 채로 develop에 남아 있다.
- 재현/확인:
  - `gh run view 43655848810 --json conclusion,headSha` → failure, ce9ee2c0.
  - `gh run view --job 132,634,114,764 --log` → 월렛 LCP 7971.9378 > 7255. (12자리 작업 ID는 자릿수 구분 쉼표로 적는다)
  - `gh run view 43660626765 --json jobs` → `web` skipped.
- 제안 수정: web 변경이 없는 커밋에서도 budgets를 주기적으로 돌리거나, perf 게이트를 재시도·중앙값·러너 고정으로 안정화한다. 마지막 web 실행이 빨간 동안 "CI 초록"을 쓰지 말고, R-591 heavy gate 기록에 CI 빨강을 적는다.
- 확신도: 높음

### [낮음] TEST-08: R-593이 "Q-T59는 자동 시험"이라고 적지만 ledger는 Q-T59 ①~⑦을 모두 ID만으로 센다
- 영역/배치: BAT-465 Q-T59 예매 제한 집행 쓰기 경로.
- 위치: `docs/review/ledger/queue-admission.md:147-153`, `docs/review/measurements/BAT-465-remainder-2.md:36`, `services/ops-svc/test-int/immutable-anchor.int.test.ts:14`.
- 증거:
  - ledger Q-T59 ①~⑦은 모두 `ID만`이다. `--batch BAT-465 --require`도 빈칸 96·ID만 112로 실패한다.
  - R-593 커밋 본문은 "ledger BAT-465는 자동 시험 7·ID만 112·빈칸 96(배치 전체, Q-T59는 자동 시험)"이라 적고, measurement도 "Q-T59는 자동 시험으로 바뀜"이라 적는다.
  - `immutable-anchor.int.test.ts`의 describe 이름이 "Q-T59 외부 불변 앵커 경계"다. 내용은 S3 Object Lock·OpenTimestamps 앵커라 Q-T59(예매 제한)와 무관하지만, 이름 때문에 ledger의 Q-T59 근거로 잡힌다.
- 왜 문제인가: A급 예매 제한 집행의 증거가 무관한 앵커 시험을 가리키고, 커밋 본문이 장부 상태와 반대다. 다음 사람이 Q-T59를 닫았다고 오해할 수 있다.
- 재현/확인: `node tools/ci/ledger.mjs --batch BAT-465 --require` → 빈칸 96·ID만 112, exit 1. `docs/review/ledger/queue-admission.md:147-153` 전부 `ID만`.
- 제안 수정: 앵커 시험의 describe 이름을 실제 ID로 바꾸고, Q-T59 시험 이름에 Q-T59 ①~⑦을 달거나 ledger-notes에 상태를 적는다. 커밋 본문의 "자동 시험"을 "ID만 7"로 고친다.
- 확신도: 높음

### [낮음] TEST-09: 웨이브 6 변이 보고는 재실행·대조 가능한 산출물이 없다
- 영역/배치: 변이 보고, BAT-425·BAT-435·BAT-465·BAT-610.
- 위치: `docs/review/measurements/BAT-425-wave5.md:44`, `BAT-435-gat170-remainder.md:48`, `BAT-465-remainder-2.md:56`, `BAT-610-remainder.md:40-49`; `docs/review/measurements/BAT-027/mutation-check.md`, `BAT-028/mutation-check.md`.
- 증거:
  - 저장소에 남은 변이 결과 파일은 BAT-027·BAT-028 두 개뿐이다. 웨이브 6은 BAT-425가 범주만("event-cancellations 판정/확정/반려/정지, compensation ...") 적고, BAT-435는 결과 표를 `.cache/bat435-mtls-mutations.md`에 두고 커밋하지 않았다고 밝힌다. BAT-465는 6개 변이 이름이 있고, BAT-610은 M-01~M-26 표가 있다.
  - BAT-610은 "처음 M-13은 시험이 코드 상수를 그대로 써서 살아남았고, 시험 값을 49로 고정해 다시 잡았다"고 적는다. 상수를 그대로 쓰는 시험이 변이를 살리는 패턴이 실제로 나왔다.
- 왜 문제인가: "변이 30/30"은 시험의 구멍을 찾는 핵심 증거인데, 재실행·대조가 불가능하면 CI 초록과 다를 바 없다. 특히 상수를 그대로 쓰는 시험이 살아남는 패턴은 BAT-610에서 실제로 나왔다.
- 재현/확인: `git ls-files | Select-String "mutation|mutant"` → BAT-027/028 결과 파일만. `docs/review/measurements/BAT-435-gat170-remainder.md:48`의 `.cache` 파일은 저장소에 없다.
- 제안 수정: 변이 실행기(또는 최소한 변이 목록·적용 파일·결과를 담은 커밋되는 표)를 저장소에 두고, 각 묶음의 heavy gate 기록에 결과 파일 경로를 남긴다.
- 확신도: 높음

### [낮음] TEST-10: S-T30 ①~④는 시험이 있는데 장부가 세지 못하고, README의 경고는 실제 시험 이름과 다르다
- 영역/배치: 좌석 홀드 좌석 ID 검사(S-T30).
- 위치: `docs/review/ledger/README.md:70-76`, `:84`, `docs/features/seat-hold.md:555`, `services/purchase-svc/test/hold-seats.test.ts:425`, `docs/review/pilot-purchase-path-coverage.md:39`.
- 증거:
  - 정본 `seat-hold.md:555`은 시나리오 칸에 ①~④, 판정 칸에 ⑤만 동그라미 번호가 있다. ledger는 `S-T30 ⑤`만 자동 시험으로 센다.
  - 실제 시험은 `hold-seats.test.ts:425`의 `ST30_①~⑤ ...` 한 건으로 ①~⑤를 모두 본다. README의 "정본에 없는 ID" 목록은 `S-T30 ①~④`라고 적지만 실제 이름은 `ST30_①~⑤`다.
  - pilot 표는 S-T30을 "자동 시험 통과 8건"으로 적는다.
- 왜 문제인가: 시험은 있는데 장부가 ①~④를 못 세고, README의 경고가 실제 이름과 달라 다음 사람이 시험을 다시 찾아야 한다. A급 좌석 ID 검사가 "⑤만 자동"으로 보인다.
- 재현/확인: `docs/review/ledger/seat-hold.md:81`에 S-T30 ⑤ 한 행만. `hold-seats.test.ts:425`에 ①~⑤ 한 시험.
- 제안 수정: 정본 표의 판정 칸을 ①~⑤로 나누고, 시험 이름을 `S-T30 ①~⑤`로 맞춘다. README의 자동 목록은 실제 이름을 확인해 고친다.
- 확신도: 높음

### [낮음] TEST-11: 배상 송금 fake의 멱등이 같은 ID·다른 금액을 거절하지 않고, 그 부정 경로 시험이 없다
- 영역/배치: BAT-425 GAT-130 배상 송금(CompensationTransfer).
- 위치: `services/payment-svc/test/compensation-transfer.test.ts:12-18`, `services/payment-svc/src/modules/compensation/adapters/fake-compensation-transfer.ts:18-19`.
- 증거:
  - 시험은 같은 compensationId·같은 입력을 두 번 보내 같은 레코드를 받는 것만 본다.
  - fake는 compensationId가 있으면 금액·주문·계좌가 달라도 기존 레코드를 그대로 돌려준다. 같은 ID에 다른 금액을 보내는 시험이 없다.
- 왜 문제인가: 배상 송금의 멱등 키는 compensationId다. 같은 키에 다른 금액을 보내면 409/422로 거절해야 하는데, 지금은 옛 금액을 성공처럼 돌려준다. 실제 지급대행 어댑터가 이 계약을 따라가면 운영자가 금액을 고쳐 다시 보냈을 때 옛 금액이 나간 것으로 믿을 수 있다.
- 재현/확인: `services/payment-svc/test/compensation-transfer.test.ts` 정독 — 다른 금액 재요청 단언 없음. fake 소스 18-19행이 기존 레코드를 반환. (같은 파일은 표적 실행 대상에 넣지 않았고, 정적 대조로 확인했다.)
- 제안 수정: fake와 실제 어댑터 계약에 `compensationId`+`amount`/`orderId` 지문 대조를 넣고, 불일치 409 시험을 더한다.
- 확신도: 중간

## 참고: 문제 없음으로 확인한 것

- **skip**: 저장소 전체에서 `skip`·`skipIf`·`ctx.skip` 20건을 확인했다. 웨이브 6의 새 시험에는 skip이 없다. `payment-reconciliation.int.test.ts`의 P-T32 측정, `measure-auto-s19-s20`·`measure-purchase-verify`는 환경 변수 opt-in 측정이고, P-T32의 판정 시험은 실제 PostgreSQL로 따로 돈다. `payment-model.int.test.ts`의 `ctx.skip()` 3건은 무작위 실행이 0회일 때의 커버리지 자기 점검이며, 집중 시험은 별도로 돈다.
- **test-int 실제 인프라**: `Memory`를 쓰는 test-int 37개를 확인했다. 고위험 경로(Q-T59·P-T49·S-T37·정산·상품·웹훅·스캐너 근무)는 실제 PostgreSQL 18/Valkey 8.1을 쓴다. `Memory`는 외부 서비스(S3/OTS 앵커, purchase-svc gRPC 시작기)의 fake이거나 gRPC 클라이언트 시험의 스텁 서버다. 다만 TEST-05·TEST-06처럼 fake가 권한·돈 경로의 실제 어댑터를 대신하는 경우는 따로 적었다.
- **상수를 그대로 쓰는 시험**: BAT-610-remainder가 M-13에서 상수 재사용으로 변이가 살아남은 사례를 찾아 49로 고정해 다시 잡았다. 웨이브 6의 새 시험은 대부분 경계 리터럴(5%·20건·500만 원·25억 등)을 직접 쓴다. 다만 25억은 아예 시험에 없다(TEST-05).
- **CI 주장의 정확성**: R-585의 docs-check 빨강, R-589의 budgets 빨강, R-590의 43649684807 초록, 웨이브 2의 43605816693 초록은 `gh run view`와 일치한다. 문제는 R-591의 빨강이 기록에서 빠지고 이후 초록이 web을 skip한 것이다(TEST-07).
