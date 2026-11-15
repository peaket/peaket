# 웨이브 6 독립 감사 — OPS (운영·마이그레이션·배포)

- 감사자: 독립 감사 에이전트(OPS), 구현 미참여
- 작업 위치: `D:\ticketpass-audit-ro3` (읽기 전용, 코드 수정 없음)
- 대상: `v0.2.0`(`6bcea3c7`)..`develop`(`42697cf7`)
- 기준 시각: 2026-11-15
- 방법: `git diff --name-only v0.2.0..develop`에서 OPS 관련 경로(마이그레이션 182개, `deploy/**`, `.github/**`, `packages/platform`의 outbox·lease·maintenance·retention·keyed-consumer, 서비스별 worker/lease/consumer, ops-svc 감사·지급·회차 취소)를 직접 읽고, 계약(`docs/api/asyncapi.yaml`, `docs/data.md`, 기능 문서)과 코드·SQL을 대조했다. 기존 리뷰·ledger·CI 초록은 근거로 쓰지 않았다.
- 한계: 실제 클러스터·Docker·운영 환경 값이 없어 배포·경보의 실동작은 확인하지 못했다. 전체 시험·빌드는 돌리지 않았다. 동시성 결함은 코드 경로로 확인했고, 재현 시험은 쓰지 않았다(감사자는 코드를 쓰지 않는다).

## 요약

- **높음 1, 중간 7, 낮음 8** (총 16)
- 가장 중요한 것: 2인 확정이 필요한 회차 취소·지급 승인이 **ops-svc 감사 체인에 전혀 남지 않는다**(OPS-01). 이어서 웹훅 발송 워커의 임대·클레임 부재(OPS-02), 지급 승인 상태의 무조건 덮어쓰기(OPS-03), 감사 체크포인트 생성 경합(OPS-04)이 운영·감사 무결성에 직접 영향을 준다.

---

## 발견

### [높음] OPS-01: 회차 취소·지급 승인(2인 확정)이 ops-svc 감사 체인에 남지 않는다
- 영역/배치: ops-svc 감사·회차 취소(R-592, 0011), 지급 승인(R-588, 0009)
- 위치:
  - `services/ops-svc/src/app.module.ts:55`, `:73` — `EventCancellationsModule`·`PayoutsModule`에 `audit: chain`을 넘기지 않는다. 같은 파일에서 `ScannerDevicesModule`만 `audit: chain`을 받는다(`:53`).
  - `services/ops-svc/src/modules/event-cancellations/application/event-cancellations.ts:64-116` — 판정·확정·반려·정지·재개 어디에서도 `AuditChain.append`를 부르지 않는다.
  - `services/ops-svc/src/modules/payouts/application/payout-approvals.ts:88-127` — 지급 승인·반려도 감사 기록이 없다.
  - 계약: `docs/features/transfer-refund.md:400` "회차 취소 판정·확정·작업 진행 | ops-svc 감사 로그", `:233` "모든 정지·재개가 사유와 함께 감사 로그", `:456` R-T22, `:505` "감사 누락 0건"; `docs/features/settlement.md:314-316` "수기 조정·지급 묶음 승인 | ops-svc 감사 로그".
- 증거: `grep -R "audit" services/ops-svc/src/modules/event-cancellations services/ops-svc/src/modules/payouts` → 0건. 두 모듈의 생성자 의존성에도 `AuditChain`이 없다. 반면 `services/ops-svc/src/modules/scanner-devices/scanner-devices.module.ts`는 `audit: chain`을 받아 기기 명령을 감사 체인에 남긴다.
- 왜 문제인가: 수백~수만 건의 환불을 시작하는 2인 확정과, 되돌릴 수 없는 지급 묶음 승인이 "누가 언제 판정·확정했는가" 없이 남는다. 사고 뒤 재구성·분쟁 대응·POL-038 2인 원칙 검증이 불가능하고, 문서가 보증하는 "감사 누락 0건"이 매 건 위반된다. 감사 체인의 `AUDIT_CHECKPOINT`도 이 행위들을 포함하지 못한다.
- 재현/확인: `POST /v1/ops/event-cancellations/{id}/approvals` 또는 `POST /v1/ops/approval-requests/{id}/approvals` 성공 뒤 `GET /v1/ops/audit-checkpoints`/`audit_chain`을 보면 그 행위의 `record_type`이 없다. (코드 대조로 확인)
- 제안 수정: `EventCancellations`·`PayoutApprovals`에 `AuditChain`을 주입하고, 상태 전이와 **같은 트랜잭션**에 `appendAuditIn`으로 `EVENT_CANCELLATION_REQUESTED/JUDGED/APPROVED/PAUSED/RESUMED`, `PAYOUT_APPROVAL_REQUESTED/APPROVED/REJECTED/EXECUTED`를 남긴다. 지급은 `approveBatch`·`executeBatch` 호출 전에 `EXECUTING` 전이와 감사 기록을 한 트랜잭션으로 커밋한다.
- 확신도: 높음

### [중간] OPS-02: 웹훅 발송 워커가 임대·클레임 없이 모든 복제에서 돌아 중복 발송·상태 역행이 가능하다
- 영역/배치: core-svc notify 웹훅 발송(R-588), 배포 복제 2
- 위치:
  - `services/core-svc/src/main.ts:92-96` — `PEAKET_WEBHOOK_WORKER=off`가 아니면 모든 core-svc 파드가 `WebhookWorker`를 켠다. 이 환경 값은 저장소 어디에도 설정돼 있지 않다(`grep -R PEAKET_WEBHOOK_WORKER` → main.ts 두 줄뿐).
  - `services/core-svc/src/modules/notify/application/webhook-worker.ts:1-3` — "리더 한 대만 돌리는 것은 배포 단계의 Lease 몫이다"라고 적었지만 실제 Lease/리더 게이트가 없다.
  - `services/core-svc/src/modules/notify/adapters/db/drizzle-webhook-store.ts:192-202` — `listDueDeliveries`는 `SELECT ... WHERE status IN ('PENDING','RETRYING') AND next_attempt_at <= now LIMIT n`만 한다. `FOR UPDATE SKIP LOCKED`도, `lease_until` 조건도, 임대 쓰기도 없다. `:204-212` `saveDelivery`는 `WHERE id = $1`로만 갱신한다.
  - 계약: `docs/data.md:2721` "워커는 짧은 트랜잭션에서 `FOR UPDATE SKIP LOCKED`로 고른 행에 임대 시각(`lease_until`)을 쓰고 커밋한 뒤 보낸다", `:2801` 같은 SQL, `:2867` "성공·최종 실패 뒤 30일 [가정]에 정비 시간의 묶음 삭제".
- 증거: 코드 대조. 두 파드가 같은 tick에 같은 100행을 고르면 둘 다 같은 `webhook-id`로 전송하고, 둘 다 `attemptCount`를 1로 올려 쓴다. 한쪽이 성공해 `SUCCEEDED`를 쓴 뒤 다른 쪽이 `RETRYING`으로 덮으면 그 행은 다시 전송 대상이 된다(성공한 발송이 다시 나가고, 상태가 성공에서 재시도로 역행). 또 `dispatcher.enqueue`는 `webhookId`를 호출마다 새 `uuidv7`로 만들어(`dispatcher.ts:49`) 내부 입구가 같은 사건을 두 번 넣으면 파트너가 거를 수 없는 **다른 webhook-id** 두 개가 생긴다(현재 운영 호출자는 아직 없다).
- 왜 문제인가: 같은 사건의 HTTP 발송이 두 번 나간다(같은 webhook-id라 표준을 지키는 파트너는 거를 수 있지만, 거르지 않는 파트너는 중복 처리한다). 더 확실한 피해는 발송 원장 상태가 실제와 달라지는 것이다: 성공이 재시도로 뒤집혀 계속 다시 나가고, 운영자는 "실패"로 보고 수동 재발송한다. 30일 보존 정비 작업도 없어 원장이 무한히 자란다.
- 재현/확인: core-svc 2복제에서 같은 `next_attempt_at` 행을 두고 동시에 `processDue`를 부르면 두 번 전송된다(코드 경로). 실제 환경 없이 재현은 못 했다.
- 제안 수정: `webhook_delivery`에 `lease_until`을 더하고 `listDueDeliveries`를 `FOR UPDATE SKIP LOCKED` + 임대 쓰기로 바꾼다. 워커는 리더(Lease) 게이트를 두거나, 최소한 행 단위 임대를 쓴다. `saveDelivery`는 `WHERE id = $1 AND status IN (...)`처럼 이전 상태를 조건에 넣는다. 성공·DEAD 뒤 30일 삭제 정비 일을 `coreMaintenanceTasks`에 넣는다.
- 확신도: 높음

### [중간] OPS-03: 지급 승인 상태를 낙관적 잠금 없이 덮어써 동시 승인 시 DONE이 FAILED로 뒤집힌다
- 영역/배치: ops-svc 지급 승인(R-588, 0009)
- 위치:
  - `services/ops-svc/src/modules/payouts/application/payout-approvals.ts:88-111` — 읽기 → `EXECUTING` 저장 → `payments.approveBatch` → `payments.executeBatch` → `DONE` 저장. 실패하면 `FAILED` 저장.
  - `services/ops-svc/src/modules/payouts/adapters/db/drizzle-store.ts:69-82` — `save`는 `WHERE id = $1`뿐이고 `version`을 조건에 쓰지 않는다(레코드에 `version`은 있지만 검사하지 않음).
  - `services/payment-svc/src/modules/settlement/application/settlements.ts:304-314` — `approveBatch`는 `PENDING_APPROVAL`만 승인하고, 두 번째 호출은 409 `payout-batch-not-approved`.
- 증거: 두 commander가 같은 승인 건을 동시에 누르면 둘 다 `PENDING_APPROVAL`을 읽고 둘 다 요청자≠승인자 검사를 통과한다. 한쪽이 `approveBatch`·`executeBatch`를 끝내 `DONE`을 저장한 뒤, 다른 쪽은 `approveBatch`에서 409를 받아 catch로 가서 `FAILED`를 저장한다. 이 `FAILED` 저장은 성공한 쪽의 `approverId`·`approvedAt`·`executedAt`까지 자기 값으로 덮는다. `FAILED`는 다시 승인 가능 상태라 운영자가 재시도할 수 있지만, payment 쪽 묶음은 이미 `SUBMITTED/COMPLETED`라 `executeBatch`가 409로 끝나 영구 FAILED로 남는다.
- 왜 문제인가: 돈은 나갔는데 관제에는 "실패"로 남고, 승인자·실행 시각이 실제와 달라진다. 지급 대사·감사·재시도 판단이 모두 틀어진다.
- 재현/확인: 코드 경로. 두 요청을 동시에 보내는 시험은 저장소에 없다.
- 제안 수정: `save`에 `and version = $expected`를 넣고 0행이면 `conflict`로 돌려준다. `EXECUTING` 전이는 조건부 1행 갱신으로만 하고, 실행 결과 반영은 `EXECUTING`일 때만 한다. `FAILED` 덮어쓰기는 실행을 시작한 그 요청(승인 ID·approver)만 하게 한다.
- 확신도: 높음

### [중간] OPS-04: 감사 체크포인트 생성이 직렬화되지 않고, 체크포인트 행과 체인 추가가 한 트랜잭션이 아니다
- 영역/배치: ops-svc 감사 체크포인트(R-584·R-568)
- 위치:
  - `services/ops-svc/src/modules/audit/checkpoint.ts:133-175` — `store.head()`로 `fromSeq`를 정하고 `chain.headSeq()`로 `toSeq`를 정한 뒤 `store.create(...)`(별도 트랜잭션)를 하고, 이어서 `chain.append(...)`(또 다른 트랜잭션)를 부른다. 두 읽기와 두 쓰기 사이에 잠금이 없다.
  - `services/ops-svc/migrations/0002_command_execution_audit.sql:30-40` — `audit_checkpoint`에 `from_seq`/`to_seq` 유일 제약이 없다.
  - 호출: `services/ops-svc/src/modules/commands/application/execute-command.ts:19,35` — 명령 실행 전후에 각각 체크포인트를 만든다. ops-svc는 복제 2로 돈다.
- 증거: 두 명령이 동시에 끝나면 두 요청이 같은 `last`·같은 `toSeq`를 읽어 **같은 구간(예: 11..20)을 덮는 체크포인트 두 개**를 만들 수 있다. 또한 `store.create` 성공 뒤 `chain.append`가 실패하면 체크포인트 행은 있는데 `AUDIT_CHECKPOINT_CREATED` 기록은 없는 상태가 된다. `verify`는 그 체크포인트를 검증할 수 있지만 체인에는 흔적이 없어 "체크포인트가 감사 체인에 남았다"는 불변식이 깨진다.
- 왜 문제인가: 감사 체인의 공개 앵커·검증 경로가 겹친 구간과 누락된 체크포인트를 만나면 "어느 체크포인트가 정본인가"를 판정할 수 없다. 감사 무결성의 핵심 경로다.
- 재현/확인: 코드 경로. 동시 실행 시험은 없다.
- 제안 수정: `audit_chain_head` 행을 `FOR UPDATE`로 잡은 한 트랜잭션 안에서 `fromSeq`·`toSeq` 계산, `audit_checkpoint` 삽입, `appendAuditIn`을 모두 끝낸다. `audit_checkpoint(from_seq)` 유일 제약을 더해 겹침을 DB가 막게 한다. 체크포인트 생성은 서비스 리더(Lease)나 DB advisory lock으로 직렬화한다.
- 확신도: 높음

### [중간] OPS-05: 내부 공유 토큰이 비면 운영에서도 내부 명령·환불·웹훅 API가 무인증이다(fail-open)
- 영역/배치: 공용 인증(InternalTokenGuard), ops·purchase·core·payment·queue 배포
- 위치:
  - `packages/platform/src/auth.ts:88-95` — `if (!this.expected) return true;`. 토큰이 없으면 검사를 끈다.
  - 각 모듈이 `process.env.PEAKET_INTERNAL_TOKEN`을 그대로 주입한다(예: `services/ops-svc/src/modules/priority/priority.module.ts:30`, `services/purchase-svc/src/modules/refund/refund.module.ts:42`, `services/core-svc/src/modules/notify/notify.module.ts:31`, `services/payment-svc/src/modules/settlement/settlement.module.ts:28`).
  - 시작 검증 없음: `grep -R PEAKET_INTERNAL_TOKEN packages/platform/src` → `auth.ts` 두 줄뿐. `PEAKET_ENV`가 local·ci가 아니면 실패하게 하는 검사가 없다.
  - 차트 기본값: `deploy/charts/peaket-service/values.yaml` `networkPolicy.enabled: false`, `deploy/workloads/ops-svc/values.yaml`에는 `networkPolicy` 자체가 없다. `deploy/workloads/payment-svc/values.yaml`도 `enabled`를 켜지 않는다.
- 증거: `PEAKET_INTERNAL_TOKEN`이 빈 문자열/미설정이면 `/internal/v1/ops/command-events`(명령 생성), `/internal/v1/event-refunds`(일괄 환불 시작), `/internal/v1/notify/webhook-events`·`/internal/v1/notify/trade-events`, `/internal/v1/settlements/*`가 `x-peaket-internal-token` 없이 통과한다. NetworkPolicy도 기본 꺼짐이라 같은 네임스페이스의 어떤 파드든 닿을 수 있다.
- 왜 문제인가: Secret 하나가 빠진 배포가 조용히 "내부 제어 API 전체 공개"가 된다. KILL_SWITCH·SALE_STOP 같은 운영 명령 생성과 대량 환불 시작이 인증 없이 가능하다. 감사 키는 운영에서 없으면 시작 실패로 막는데(`services/ops-svc/src/modules/audit/anchor.ts:105-108`), 내부 토큰만 반대다.
- 재현/확인: `PEAKET_INTERNAL_TOKEN`을 비우고 서비스를 띄운 뒤 헤더 없이 내부 경로를 호출하면 202/200이 온다(단위 시험의 기본 구성도 이 상태다). 실제 운영 값은 저장소에 없어 배포 상태는 확인하지 못했다.
- 제안 수정: `PEAKET_ENV`가 `local|ci|demo`가 아니면 `PEAKET_INTERNAL_TOKEN`이 없을 때 시작 실패. 최소 32바이트 이상인지도 검사한다. 차트 기본값으로 `networkPolicy.enabled: true`와 앱 포트 ingress 제한을 켠다.
- 확신도: 높음(코드), 운영 노출은 중간(값 미확인)

### [중간] OPS-06: 웹훅 발송기가 응답 본문을 상한 없이 읽은 뒤 64KiB를 검사한다
- 영역/배치: core-svc notify 웹훅 발송(R-588)
- 위치: `services/core-svc/src/modules/notify/adapters/https-transport.ts:55-56` — `const text = await res.text(); if (Buffer.byteLength(text) > RESPONSE_CAP_BYTES) throw ...`
- 증거: 주석은 "응답은 64KiB까지만 읽고"라고 하지만 실제로는 `res.text()`가 본문 전체를 메모리에 올린 뒤 크기를 본다. 10초 시간 한도(`TOTAL_TIMEOUT_MS`)는 헤더 수신 뒤 본문 읽기에도 걸리지만, 빠른 속도로 보내는 큰 본문(예: 수 GB)은 10초 안에 메모리를 고갈시킬 수 있다.
- 왜 문제인가: 파트너가 등록한 웹훅 URL 하나로 core-svc 파드를 OOM 시킬 수 있다. core-svc는 팬 트래픽(공연 상세·좌석맵)을 받는 경로라 전면 장애로 번진다. 파트너 계정이 필요한 공격이지만, 웹훅 URL은 파트너가 자유롭게 등록한다.
- 재현/확인: 큰 본문을 즉시 반환하는 HTTPS 서버를 웹훅 URL로 등록하고 발송을 유도한다(코드 경로).
- 제안 수정: `res.body`의 reader로 64KiB까지만 읽고 초과 시 즉시 `cancel()`한다. `content-length`가 상한을 넘으면 본문을 읽지 않고 실패 처리한다.
- 확신도: 높음

### [중간] OPS-07: 회차 취소 확정이 외부 환불 시작 뒤에 저장되고, 상태 전이에 낙관적 잠금이 없다
- 영역/배치: ops-svc 회차 취소(R-592, 0011)
- 위치:
  - `services/ops-svc/src/modules/event-cancellations/application/event-cancellations.ts:73-84` — `refunds.start(...)`를 먼저 호출하고, 그 결과로 `store.save(next)`를 한다.
  - `services/ops-svc/src/modules/event-cancellations/adapters/db/drizzle-store.ts:73-80` — `save`는 `WHERE request_id = $1`뿐이고 `version` 조건이 없다(레코드에 `version`은 있음).
  - `:86-96` — `reject`는 읽은 상태가 JUDGED면 REQUESTED로 되돌린다.
  - `:80` — `job.state`가 `PAUSED`여도 상태를 `RUNNING`으로 적는다(COMPLETED/REFUND_WINDOW만 따로 처리).
- 증거: 두 요청이 겹치면 ① 승인과 반려가 동시에 읽고, 승인이 환불을 시작한 뒤 반려가 `REQUESTED`로 덮어써 관제는 "판정 대기"인데 환불은 실제로 도는 상태가 된다. ② `refunds.start` 성공 뒤 `store.save`가 실패하면 요청은 JUDGED로 남고 환불은 진행된다. 이후 판정을 다시 하면 `fault`가 바뀌고, 같은 `requestId`로 다시 시작할 때 purchase-svc가 `CONFLICT`(판정이 다름)를 내 승인이 영구히 막힌다. ③ 자동 정지로 purchase가 PAUSED가 되어도 ops는 RUNNING으로 표시한다.
- 왜 문제인가: 수만 건 환불 작업의 상태가 실제와 어긋나 운영자가 잘못된 판단(재판정·재승인·중지)을 한다. 2인 확정의 "누가 확정했는가"도 덮어써질 수 있다.
- 재현/확인: 코드 경로. 동시 승인/반려 시험은 없다.
- 제안 수정: `save`에 `and version = $expected`를 넣고, 상태 전이를 조건부 갱신으로만 한다. `approve`는 `PENDING_APPROVAL`/`EXECUTING` 전이를 먼저 커밋한 뒤 환불을 시작하고, 시작 결과는 `EXECUTING`일 때만 반영한다. `job.state`를 그대로 매핑한다(PAUSED→PAUSED).
- 확신도: 높음

### [중간] OPS-08: 리더 Lease에 create 권한이 없어, Lease 객체가 지워지면 릴레이·정비·Outbox 파티션 생성이 영구히 멈춘다
- 영역/배치: 배포 차트 `peaket-service`, Outbox 릴레이 리더 election
- 위치:
  - `deploy/charts/peaket-service/templates/outbox-relay.yaml:23-31` — Role verbs가 `["get","update"]`뿐이고 `create`가 없다. Lease는 차트가 `spec: {}`로 미리 만든다(`:1-10`).
  - `deploy/charts/peaket-service/templates/leader-lease.yaml:17-25` — 서비스 파드용 Role도 `get`·`update`만.
  - `packages/platform/src/lease.ts:92-97` — Lease가 없으면 `api.create`를 부른다. RBAC에 create가 없으므로 403 → `step()`이 예외를 삼켜 `ok=false` → 영원히 리더가 될 수 없다.
- 증거: Lease 객체를 지우면(수동 삭제, 네임스페이스 정리, 다른 도구의 `delete leases`) 릴레이는 재시작해도 리더가 되지 못한다. 리더가 없으면 `startOutboxRelayProcess`의 정비도 돌지 않아 `ensureOutboxPartitions`가 멈춘다. Outbox는 일 파티션 범위가 7일 앞까지만 만들어져 있으므로, 그 뒤에는 **모든 서비스의 Outbox INSERT가 "no partition of relation found"로 실패**해 주문·결제 커밋 자체가 막힌다.
- 왜 문제인가: 단일 객체 삭제가 7일 뒤 전 서비스 쓰기 장애로 번지는 복구 불가능한(재배포 전까지) 연쇄 장애다. 차트가 Lease를 만들지만, 만든 뒤의 삭제·드리프트를 스스로 복구하지 못한다.
- 재현/확인: `kubectl delete lease <서비스>-outbox-relay` 뒤 릴레이 로그에서 `Lease 만들기 실패: HTTP 403`이 반복되고 `outbox_relay_is_leader`가 0으로 남는다(클러스터 없이 코드·RBAC 대조).
- 제안 수정: Role에 `create`를 추가하되 `resourceNames`가 아니라 이름 고정 Lease만 만들도록 admission/ValidatingAdmissionPolicy로 좁히거나, 릴레이 시작 시 Lease가 없으면 자기 이름의 Lease를 만들 수 있는 별도 Role(create만, 이름은 고정)을 준다. 최소한 Lease 부재를 SEV2 경보로 올리고, `ensureOutboxPartitions`를 릴레이 리더와 분리해 서비스 시작 시에도 한 번 돌린다.
- 확신도: 높음(메커니즘), 발생 가능성은 낮음

### [낮음] OPS-09: 웹훅 발송 원장·ops 보류 사건의 보존 정비가 없다
- 영역/배치: core-svc notify, ops-svc consumer
- 위치: `services/core-svc/src/maintenance-tasks.ts:20-38`(정비 일 목록에 webhook 없음), `services/ops-svc/src/main.ts`(릴레이·정비 프로세스 없음), `services/ops-svc/migrations/0005_held_event.sql`
- 증거: `docs/data.md:2867`은 `webhook_delivery`를 성공·최종 실패 뒤 30일 [가정]에 지운다고 한다. `platformMaintenanceTasks`의 `held-events-delete`는 릴레이 프로세스에서만 도는데 ops-svc에는 릴레이가 없어 ops DB의 `held_event`가 계속 쌓인다.
- 왜 문제인가: 개인정보·운영 데이터가 기한 없이 남고, 테이블·인덱스가 무한히 자란다.
- 제안 수정: core-svc 정비에 `webhook_delivery` 30일 삭제를 추가하고, ops-svc에 작은 정비 프로세스(또는 릴레이)를 두어 `held_event`를 지운다.
- 확신도: 높음

### [낮음] OPS-10: `merch_order` 스키마가 정본 `docs/data.md`와 다르고 PII 보존 경로가 없다
- 영역/배치: core-svc shop·export(0016)
- 위치: `services/core-svc/migrations/0016_merch_export.sql:14-31`, `services/core-svc/src/modules/shop/domain/merch.ts:21-33` vs `docs/data.md:1600-1616`, `:2898`
- 증거: 구현은 `buyer_name`·`buyer_phone`·`status(PENDING/PAID/CANCELLED/REFUNDED)`·`ordered_at`이고, 정본은 `account_id`·`fulfillment`·`status(CREATED/AWAITING_DEPOSIT/…)`·`recipient_name`·`recipient_phone`·`delivery_address`·`pickup_slot_id`다. `retention.merch_order_recipient`(5년) 정비도 없다.
- 왜 문제인가: 배송지·수령인 PII를 담는 표의 모양과 보존 계획이 문서와 어긋나 후속 구현·파기 작업이 잘못된 칸을 대상으로 삼는다.
- 제안 수정: 정본에 맞춰 칸을 정리하거나, 이번 몫의 축소 모델을 `docs/data.md`에 명시하고 보존 작업을 후속 항목으로 등록한다.
- 확신도: 높음

### [낮음] OPS-11: `asyncapi.yaml`의 `ops.command-events` 설명이 "Kafka 어댑터 미부착"으로 낡았다
- 영역/배치: 계약 문서
- 위치: `docs/api/asyncapi.yaml:105-111`
- 증거: 설명은 "첫 몫(BAT-465 R-568)은 Kafka 어댑터를 아직 붙이지 않았고, 같은 모양을 내부 HTTP로 받는다"고 하지만, `services/ops-svc/src/main.ts:103-121`과 `services/ops-svc/src/consumers/start.ts`가 실제 Kafka 소비자를 붙였다.
- 왜 문제인가: 계약 독자가 Kafka 경로가 없다고 오해해 운영·시험 범위를 잘못 잡는다.
- 제안 수정: 설명을 "Kafka 소비자와 HTTP 호환 경로가 같은 처리기를 쓴다"로 고친다.
- 확신도: 높음

### [낮음] OPS-12: ops-svc 마이그레이션 번호에 0008·0010이 없다
- 영역/배치: ops-svc migrations
- 위치: `services/ops-svc/migrations/` (0007 다음 0009, 0009 다음 0011)
- 증거: `git log --all -- services/ops-svc/migrations/0008* services/ops-svc/migrations/0010*` → 이력 없음. 건너뛴 번호가 삭제된 적도 없다.
- 왜 문제인가: 적용 자체는 이름 순서라 문제없지만, "삭제된 마이그레이션이 있는가"를 감사·리뷰에서 매번 의심하게 만든다.
- 제안 수정: 다음 마이그레이션부터 연속 번호를 쓰고, `docs/data.md`/README에 번호 규칙을 적는다.
- 확신도: 높음

### [낮음] OPS-13: core-svc drizzle 메타 스냅샷 0009–0013이 없다
- 영역/배치: core-svc migrations/meta
- 위치: `services/core-svc/migrations/meta/` — `0008` 다음 `0014`
- 증거: journal에는 idx 9~13이 있지만 `0009_snapshot.json`~`0013_snapshot.json`이 없다. `0014` 스냅샷에는 0009~0013의 표가 모두 들어 있어 `drizzle-kit generate`는 마지막 스냅샷(0016)을 기준으로 동작하므로 당장 생성이 깨지지는 않는다(코드 확인: `preparePrevSnapshot`이 정렬된 마지막 파일을 읽는다). 다만 이력 추적과 `drizzle-kit up`/수동 복원이 불가능하다.
- 왜 문제인가: 마이그레이션 이력의 재현성이 깨진다.
- 제안 수정: 누락 스냅샷을 복원하거나, 손으로 만든 마이그레이션임을 README에 적고 `generate` 기준 스냅샷을 0016으로 고정한다.
- 확신도: 높음(파일 부재), 영향은 낮음

### [낮음] OPS-14: schema-registry Job RBAC이 네임스페이스의 모든 ConfigMap을 고칠 수 있다
- 영역/배치: 배포 차트 `schema-registry-job.yaml`
- 위치: `deploy/charts/peaket-service/templates/schema-registry-job.yaml:29-37`
- 증거: Role이 `resources: ["configmaps"]`에 `resourceNames` 없이 `get/create/update/patch`를 준다. 등록 Job은 `schema-ids` 하나만 쓰면 된다.
- 왜 문제인가: 등록 도구 이미지가 침해되면 서비스 설정 ConfigMap까지 바꿀 수 있다(ASVS 13.2.2 최소 권한).
- 제안 수정: `resourceNames: ["schema-ids", "<name>-schema-topics"]`로 좁힌다(create는 이름 고정이 어려우면 사전 생성 + update만).
- 확신도: 높음

### [낮음] OPS-15: 지급 승인 API의 역할 계약이 코드와 어긋난다
- 영역/배치: ops-svc payouts
- 위치: `services/ops-svc/src/modules/payouts/inbound/payouts.controller.ts:121-123`(`@Roles(['commander','cs_lead'])`) vs `services/ops-svc/src/modules/payouts/application/payout-approvals.ts:94`(`actor.role !== 'commander'`면 403)
- 증거: `cs_lead`는 엔드포인트에 들어오지만 애플리케이션에서 항상 403 `approval-role-required`다.
- 왜 문제인가: 권한표·계약과 실제 허용이 다르다. `cs_lead`에게 열어 줄 생각이었다면 기능이 빠진 것이고, 아니면 계약이 틀렸다.
- 제안 수정: 둘 중 하나로 맞춘다. `cs_lead`를 허용하려면 앱 검사를 `commander|cs_lead`로, 아니면 컨트롤러 역할에서 뺀다.
- 확신도: 높음

### [낮음] OPS-16: `docs/features/settlement.md`의 "지급 묶음 목록 경로 없음"이 구현과 어긋난다
- 영역/배치: 문서
- 위치: `docs/features/settlement.md:354` vs `services/ops-svc/src/modules/payouts/inbound/payouts.controller.ts:79-96`(`GET /v1/ops/payout-batches` 구현됨)
- 증거: 문서는 "openapi에 아직 없다 … GET /v1/ops/payout-batches로 더한다 [가정]"이라고 하지만 코드·openapi에 이미 있다.
- 왜 문제인가: 문서를 읽은 화면·시험 담당이 없는 경로로 안다.
- 제안 수정: 구현 상태 문단을 갱신한다.
- 확신도: 높음

---

## 확인했으나 결함으로 보지 않은 것

- **스캐너 신선도 2분**: `SCANNER_FRESHNESS_ALERT_MS = 2 * 60_000`은 코드 주석 "2시간"과 달라 보이지만, 정본 `docs/features/offline-gate.md:342`(O-T20)가 "2분이 지난 뒤"이므로 상수는 맞고 주석이 틀린 것이다(낮음, 보고서에는 넣지 않음).
- **지급 묶음 중복 실행**: `payout_batch_key` 부분 유일 인덱스와 `payout_ref_key` 유일 인덱스가 동시 생성·중복 지급을 DB에서 막는다(`services/payment-svc/migrations/0015_settlement.sql`). OPS-03은 "지급 자체의 중복"이 아니라 "ops 상태 기록"의 결함이다.
- **회차 취소 환불 중복**: `StartEventRefund`가 `requestId` 멱등이고, 티켓별 `cancellationId`가 결제 취소 멱등키다. 리더가 겹쳐도 돈이 두 번 나가지는 않는다.
- **Outbox 파티션 삭제 중 미발송 행**: `dropExpiredOutboxPartitions`가 detach 전에 미발송 행을 확인하고, detach 후 drop 실패 표도 다시 찾는다(`packages/platform/src/outbox.ts:152-181`). detach 진행 중 삽입되는 행의 이론적 창은 있으나, 3일 이상 릴레이가 밀린 상태(이미 SEV2)에서만 생기므로 별도 발견으로 올리지 않았다.
- **Lease election 알고리즘**: `packages/platform/src/lease.ts`는 client-go와 같은 `resourceVersion`·관측 시각 방식이고, 갱신 한도(8초) < Lease(12초)로 자기 강등이 먼저 일어난다. 로직 자체는 정본과 맞다.
- **알림 규칙·Alertmanager 부재**: `deploy/local/observability.yaml`에는 규칙·Alertmanager가 없지만, `docs/observability.md:230`이 "경보 규칙은 운영 관측 스택에서 더한다(wbs 4.1.1·4.1.2·4.2.1)"로 명시적 후속이다. 계약 위반으로 보지 않았다.
- **Kafka 토픽 프로비저닝**: `tools/local/v1-objects.mjs`의 `V1_KAFKA_TOPICS`에 `ops.command-events`가 없지만, v1 번들에 ops-svc가 없어 로컬 시험 범위 밖이다. 운영 토픽 생성은 저장소 밖(MSK)이라 확인 불가로 남긴다.

## 검토 범위(증거)

- 마이그레이션: core 0000–0016, identity 0004–0032, ops 0000–0011, payment 0000–0016, purchase 0000–0020, ticket 0000–0006의 새 파일 전부와 journal/snapshot 체인. `CONCURRENTLY`·`CREATE EXTENSION`·트랜잭션 밖 DDL 없음.
- RLS/권한: core 0004(partner/app), 0012(ops), 0016(merch/export/webhook)의 `ENABLE ROW LEVEL SECURITY`, 정책, 칼럼 단위 GRANT, `ALTER DEFAULT PRIVILEGES`, `SECURITY DEFINER` 함수(`public_open_times`의 `search_path` 고정), 시작 시 `assertDatabaseRole`(core main/relay).
- 인덱스: 새 부분 유일 인덱스(`payout_batch_key`, `payout_ref_key`, `sale_control_*`, `event_cancellation_request_active_key`, `priority_grant_offered_seat_key`, `scanner_session_device_active_key`)와 쿼리 조건 대조. `ON CONFLICT ... WHERE scope='EVENT'`가 부분 인덱스와 맞음.
- 워커/임대: outbox relay, maintenance runner, keyed consumer, ticket issue/void runner, event refund loop, payment confirm/unknown resolver, entry pause judge, queue withdrawn due/mirror lease, admission rb35, core webhook worker, ops consumer.
- Kafka: outbox publisher(topic별 묶음, acks, trace headers), consumer group/commit/held/backoff, `ops.command-events` 소비자, broadcast.
- 배포/비밀: 차트 Deployment/Service/NetworkPolicy/Lease/OutboxRelay/SchemaRegistry, `deploy/envs/local/*`, `deploy/local/*`, `build-image.yml`(digest·cosign·SBOM·provenance), `gitleaks`/Trivy 구성.
- 보존/파티션: outbox 일 파티션 생성·삭제, `retention.ts`, `maintenance.ts`, payment webhook/reconciliation 정비, core/ops 정비 일.
- 감사: ops audit chain(`appendAuditIn`의 head 행 잠금), checkpoint 생성·검증, 앵커 서명 환경 검증.

## 권고 순서

1. OPS-01(감사 누락) — 배포 전. 2인 확정 업무의 감사 기록은 법·계약 요구다.
2. OPS-02·OPS-03·OPS-07(동시성·중복) — 웨이브 안. 돈·파트너 사건의 상태 무결성.
3. OPS-04(체크포인트 경합) — 웨이브 안. 감사 체인의 정본성.
4. OPS-05·OPS-06(비밀 fail-open·응답 상한) — 웨이브 안. 배포 설정 한 줄로 막을 수 있는 것부터.
5. OPS-08(Lease create) — 다음 배포 전. 발생 확률은 낮지만 결과가 전 서비스 쓰기 정지다.
6. 나머지 낮음 — 후속 기록.
