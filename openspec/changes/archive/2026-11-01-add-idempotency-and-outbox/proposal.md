# 제안: 공용 멱등 모듈과 Outbox·폴링 릴레이(wbs 0.3.2 ②, BUILD_ORDER FND-080)

## Why

FND-070까지 서비스 템플릿(`packages/platform`)은 요청 검사·인증 가드·DB 설정을 갖췄다. 그러나 쓰기 요청을 '한 번만' 처리하고 그 결과를 Kafka로 '잃지 않고 순서대로' 내보내는 공용 부품이 아직 없다. 첫 쓰기 서비스(purchase·payment·ticket·core·ops·identity)가 생기기 전에 다음이 있어야 서비스마다 다르게 짜지 않는다.

- 공용 멱등 모듈(docs/api/guidelines.md §4, ADR-0146 결정 1, 기술 검토 중간-046): `Idempotency-Key` 형식 검사(400 `idempotency-key-invalid`), 계정 × 작업 범위, 요청 지문(메서드·실제 경로·본문 바이트의 SHA-256), 같은 키 다른 본문 422 `idempotency-key-reused`, 처리 중 1초 [가정] 기다린 뒤 409 `idempotency-request-in-progress`, 커밋한 결과만 다시 돌려주기, 24시간 [가정] 보관과 정리.
- FND-070이 넘긴 두 가지: 머리 검사(`@ContractHeaders`·경로 스키마)가 멱등 키를 먼저 보아 `about:blank` 400을 내는 순서, 요청 지문과 구매 세션 요청 서명(`X-Purchase-Mac`)에 쓸 원시 본문 바이트(서비스 템플릿은 NestJS 본문 해석기를 껐다, R-223).
- Outbox와 운영 기준 폴링 릴레이(ADR-0116): `seq` 순서, `FOR UPDATE`(`SKIP LOCKED` 없이), 쿠버네티스 Lease로 리더 하나, 실패 때 0.1~5초 [가정] 늘려 다시 보내기, 지표 다섯(`outbox_relay_*`).
- Outbox 일 파티션(UUIDv7 ID 범위, 한국 시각 하루), 7일 [가정] 앞까지 미리 만들기, 3일 [가정] 지난 파티션 지우기와 보내지 않은 행이 남으면 지우지 않기(ADR-0083·0114·0116, data.md §2·§4의 7번).
- 제어 사건(`control.settings`, `control.sessions-terminated`)도 같은 Outbox로 낸다(ADR-0143 결정 3).

## What Changes

- **원시 본문**: 플랫폼 본문 해석기(JSON, 표시한 경로의 `text/plain`)가 해석 전 바이트를 요청에 남긴다(`rawBodyOf()`).
- **멱등 모듈**: 처리기 장식자 `@Idempotent({ operation })`와 매개변수 장식자 `@IdempotencyRequest()`. 인증 가드가 신원을 판정한 바로 뒤, 경로 스키마의 붙여 둔 검사 실패보다 먼저 키를 본다. 두 검사 길의 머리 스키마에서는 `Idempotency-Key`를 뺀다. 공개 경로에 단 멱등 장식자는 시작 실패다.
- **멱등 기록(PostgreSQL)**: `idempotency_record` 표 정의(Drizzle)와 `IdempotencyStore.run(tx, 요청, { execute, replay })`. 키 행은 업무 쓰기와 같은 트랜잭션의 첫 쓰기이고, 키 행을 넣는 문장만 `lock_timeout` 1초 [가정]로 묶는다. 정비용 나눠 지우기 함수.
- **Outbox**: 파티션 부모 표 SQL(서비스 템플릿 마이그레이션), `writeOutbox(tx, 시계, 메시지들)`(UUIDv7 ID, 추적 머리), 일 파티션 미리 만들기·지우기 함수.
- **폴링 릴레이와 Lease**: `OutboxRelay`(묶음 500 [가정], 100ms [가정], 지표), 보내기 포트 `OutboxPublisher`(Kafka 어댑터는 클라이언트를 고르는 단계로 넘김), `LeaseElector`와 쿠버네티스 Lease API 클라이언트.
- **서비스 뼈대**: 예시 쓰기 경로가 멱등 장식자·멱등 기록·Outbox를 한 트랜잭션에서 쓴다.

## Impact

- 정본: docs/api/guidelines.md §4, docs/data.md(§2 파티션 규칙·서비스마다 둔 멱등 기록 표, §4의 7번), docs/observability.md §3(서비스 템플릿 운영 확인 표)·§5, docs/security/asvs/delivery.md(13.1.3·16.5.2)·payment.md(2.3.4), docs/verification.md(V-T28), docs/adr/0116 상태 줄.
- ID: ADR-0026·0083·0114·0116·0143·0146, 기술 검토 중간-046, NFR-005·NFR-006, 시험 V-T28(로컬 부분), WBS 0.3.2.
- 코드: packages/platform(새 모듈 넷과 요청 검사·인증 가드 고침, template/), CI는 그대로(`test:integration`이 새 시험을 함께 돈다).
- 넘김: Kafka 보내기 어댑터(멱등 생산자·`acks=all`·`message.timeout.ms` 10초)는 FND-090, 실제 쿠버네티스 Lease 확인(kind)은 FND-110, 정비 잡 일정(정비 시간 04:00~06:00)과 마이그레이션 직후 파티션 만들기는 FND-090·BAS-060, 제어 사건을 실제로 쓰는 쪽은 PRF-030(`control.sessions-terminated`)·OPS-300(`control.settings`), 공용 Avro 인코더(`payload` 바이트)는 BAS-030, 홀드의 Redis 멱등(같은 요청 객체를 Lua에 넘김)은 좌석 홀드 단계.
