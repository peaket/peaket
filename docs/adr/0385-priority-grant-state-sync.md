# ADR-0385: 우선 구매 권리 상태 대조와 q:prio의 USED·EXPIRED 계약(2026-11-24)

- **상태**: 채택(2026-11-24). 기능 F-05-3(현장 입장, A등급, BUILD_ORDER GAT-135)의 구현 결정 묶음이다. 정본은 [docs/features/seat-hold.md](../features/seat-hold.md) §4·§5·§6, [docs/features/queue-admission.md](../features/queue-admission.md) §6, [docs/data.md](../data.md) `priority_grant`·`q:prio`·`s:{event:E}:prio`, [docs/api/proto/peaket/queue/v1/queue.proto](../api/proto/peaket/queue/v1/queue.proto), ADR-0171, POL-046 ⑦이다. 값은 정본에 두고 여기서는 자리만 가리킨다.
- **관련**: [docs/architecture.md](../architecture.md) §8.6, 계획 `docs/review/plans/F-05-3.md`, `docs/review/plans/BAT-430.md` A12~A14
- **관련 ID**: GAT-135, Q-T62, S-T37, ASVS v5.0.0-2.3.3·2.3.4·8.2.2·16.5.2

## 맥락

- BAT-430이 우선 구매 권리의 원본(purchase-svc `priority_grant`)과 대기열 사본(queue-svc `q:prio:{account}:E`), PRIORITY 보류(`s:{event:E}:prio`), 만료 반복, 결제 실패 복귀, 우선 주문을 만들었다. 남은 것은 사본과 원본의 상태가 어긋나는 경우다.
- 지금 `q:prio` 사본은 `OFFERED`·`WITHDRAWN`만 받는다. 운영자 회수는 ops-svc가 purchase-svc 회수 뒤 queue-svc에 `WITHDRAWN`을 보내지만, queue-svc가 잠깐 죽으면 사본이 만료 전까지 `OFFERED`로 남는다. 만료 반복은 좌석 Redis를 먼저 풀고 purchase DB를 나중에 바꾸므로, DB 쓰기가 실패하면 권리가 `OFFERED`로 남는다(다음 틱이 다시 볼 좌석이 이미 없다).
- 결제를 마친 권리는 purchase-svc가 `USED`로 끝내고 그 권리의 홀드·주문을 409로 막는다. `q:prio` 사본은 `OFFERED`로 남아도 입장은 됐다(`docs/data.md` `q:prio`의 "OFFERED여도"). `docs/features/queue-admission.md` §6은 "이미 산 것"도 404라고 적어 두 문서가 어긋난다.
- PRIORITY 보류를 일반 홀드로 바꾸는 정본 문장과 R-587 구현(PRIORITY 유지 + `pin`·`ordered`)이 다르다. 변환은 결제 실패·회수·만료 경로를 다시 설계해야 한다.

## 결정

### 1. purchase-svc의 상태 대조(`PriorityGrantSync`)

- purchase-svc에 30초 [가정] 주기의 작은 대조를 둔다. 한 틱은 ① `expireDue`로 `priority_grant`의 `status='OFFERED' AND active_order_id IS NULL AND expires_at <= now` 행을 `EXPIRED`(version+1)로 바꾸고 ② `listSyncable`로 `expires_at > now`인 `OFFERED`·`USED`·`WITHDRAWN` 행을 읽어 queue-svc `SetPriorityGrant`로 다시 보낸다.
- `EXPIRED` 사본은 보내지 않는다. 사본의 TTL이 권리 만료와 같아 그때 키가 사라지기 때문이다. 다만 queue-svc 계약은 `EXPIRED`를 받아 두어 조기 만료·계약 대칭을 맞춘다.
- 목록은 `(updated_at, id)` 키셋 커서로 이어 읽는다. 한 틱에 100개 [가정]을 보내고, 페이지가 100개보다 작으면 커서를 처음으로 되돌린다. 일시 실패한 행에서는 커서를 그 앞에 두어 다음 틱에 그 행부터 다시 보내고, 계약·데이터 결함(INVALID_ARGUMENT) 행은 커서를 넘겨 다시 보내지 않는다. 새 표·칸은 만들지 않는다(마이그레이션 없음).
- 보내기 실패(`UNAVAILABLE`·`DEADLINE_EXCEEDED` 등)는 `failed`로 세고 다음 틱에 다시 한다. `INVALID_ARGUMENT`는 계약·데이터 결함이라 `invalid`로 따로 세고 같은 값을 다시 보내지 않는다. DB 오류는 `expire` 지표로 남기고 다음 틱에 다시 한다.
- 대조는 주문·결제 트랜잭션 안에서 네트워크를 부르지 않는다. `markUsed`는 주문 트랜잭션 안에서 이미 `USED`이므로 대조가 늦어도 주문은 purchase-svc가 막는다. 대조 주기 30초 [가정] 동안 `q:prio`가 `OFFERED`일 수 있는 창은 purchase-svc의 409가 받친다.

### 2. q:prio의 네 상태

- queue.proto `PriorityGrantState`에 `USED=3`·`EXPIRED=4`를 더한다. 기존 `OFFERED=1`·`WITHDRAWN=2`는 바꾸지 않는다(하위 호환).
- queue-svc는 네 상태를 사본에 저장하고 읽는다. 입장 확정은 `state='OFFERED'`이고 `now < expiresAt`일 때만 통과한다. `USED`·`EXPIRED`·`WITHDRAWN`은 모두 같은 404 `priority-grant-not-found`다.
- 판 번호가 사본보다 클 때만 바뀐다. 늦게 도착한 낮은 판(예: USED v2 뒤 OFFERED v1)은 무시한다. 사본 TTL은 권리 만료와 같다.

### 3. A12: PRIORITY 보류를 유지한다

- prio 토큰으로 그 좌석을 홀드해도 PRIORITY 보류를 일반 홀드로 바꾸지 않는다. `pin`·`ordered` 표시로 주문·결제 실패 복귀·회수·만료를 같은 뜻으로 이룬다(R-587 구현 유지). 정본 `docs/features/seat-hold.md` §5의 변환 문장을 현재 구현에 맞게 고치고, wbs 5.3.6의 '남은 것'에서 변환을 뺀다.
- 변환을 택하지 않은 까닭: PRIORITY→FAN을 바꾸면 결제 실패 복귀(`RESTORE_PRIORITY_LUA`)·회수·만료가 같은 좌석을 두 번 바꾸는 경로를 다시 설계해야 하고, 얻는 행동이 `pin`·`ordered`와 같다.

### 4. 호출 경로와 배포

- purchase-svc는 queue-svc의 기존 `PriorityGrantService.SetPriorityGrant` gRPC를 부른다. 새 환경 값 `PEAKET_QUEUE_GRPC_ADDR` [가정]을 쓰고, 없으면 local·ci만 경고 한 줄로 대조를 끄고 그 밖은 시작 실패다([docs/devops.md](../devops.md) §4.4의 비밀·환경 값 규칙).
- 배포는 queue-svc를 먼저 올린다. 새 purchase-svc가 옛 queue-svc에 `USED`·`EXPIRED`를 보내면 `INVALID_ARGUMENT`로 `invalid` 지표에 쌓이고, queue-svc가 올라오면 다음 틱에 맞춰진다. 데이터는 잃지 않는다.

### 5. 화면과 A12의 남은 몫

- 이 기능은 서버만 한다. SCR-042 [[ 우선 구매하기 ]] → queue-room `priorityGrantId` 왕복은 동결 뒤 몫으로 넘기고 `docs/lanes/lane2-cleanup.md`에 적는다. `apps/web`은 고치지 않는다.

## 결과

- 좋아지는 점: 운영자 회수가 queue-svc 장애로 실패해도 사본이 다음 틱에 `WITHDRAWN`이 된다. 만료 DB 쓰기가 실패해도 권리가 `OFFERED`로 남지 않는다. 결제를 마친 권리는 `USED` 사본으로 입장도 404가 되어 `queue-admission` §6과 맞는다. 판 번호 가드로 늦은 대조가 최신 상태를 되돌리지 않는다.
- 잃는 점: purchase-svc에 30초 주기 SELECT·UPDATE와 gRPC 호출이 하나 더 든다(부정 예매 권리는 드물어 작다). 대조가 늦으면 최대 한 틱(30초 [가정]) 동안 `q:prio`가 옛 상태일 수 있다. 그동안에도 purchase-svc가 주문을 409로 막아 돈·좌석 피해는 없다.
- 버린 안: purchase-svc가 회수·만료 트랜잭션 안에서 queue-svc를 동기 호출(주문·결제 경로에 외부 장애를 넣음), 새 Kafka 토픽·Outbox(2일 몫에 계약·소비자·생성물이 너무 큼), queue-svc가 입장 때 purchase-svc에 묻기(사본의 뜻이 없어짐), PRIORITY→FAN 변환(위 §3).
