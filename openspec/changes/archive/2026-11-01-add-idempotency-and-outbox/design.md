# 설계: 공용 멱등 모듈과 Outbox·폴링 릴레이

## 맥락

정본이 정한 것:

- 멱등 키(docs/api/guidelines.md §4): 따옴표 없는 UUID v4, 없거나 형식이 틀리면 400 `idempotency-key-invalid`. 범위는 부른 계정 × 작업(메서드와 경로 틀). 요청 지문은 메서드·실제 경로·본문 바이트의 SHA-256이고 머리는 넣지 않는다. 같은 범위·같은 키에 지문이 다르면 422 `idempotency-key-reused`, 첫 요청이 처리 중이면 1초 [가정] 기다린 뒤 409 `idempotency-request-in-progress`와 `Retry-After: 1`. PostgreSQL에 키를 두는 작업은 키 행을 넣는 문장에 `SET LOCAL lock_timeout`을 걸어 이 기다림을 묶는다. 처음 커밋한 결과만 같은 상태 코드와 본문으로 돌려주고, 아무것도 바꾸지 않고 끝난 실패는 저장하지 않는다. 보관은 홀드가 7분(Redis), 그 밖은 24시간 [가정].
- 멱등 기록 표(data.md, ADR-0146 결정 1): `idempotency_record(account_ref, operation, idempotency_key, request_hash, result_ref, created_at)`, 기본 키는 앞의 셋, `operation`은 그 서비스 작업 목록으로 `CHECK`, 키와 지문은 대상 행을 바꾸는 같은 트랜잭션에 적고, 24시간 [가정] 뒤 정비 시간에 지운다(`(created_at)` 인덱스). purchase의 `order_idempotency`는 같은 꼴이다.
- Outbox(data.md §4의 7번, ADR-0116): `payload`는 `bytea`(공용 Avro 인코더의 Confluent 형식 바이트), 키는 `msg_key`(UTF-8), 머리는 추적 정보. 보내는 순서 칸 `seq`(DB 시퀀스), Outbox 행은 트랜잭션의 마지막 문장. 리더가 100ms [가정]마다(밀리면 쉬지 않고) 트랜잭션 하나에서 `SELECT … WHERE sent_at IS NULL ORDER BY seq LIMIT 500 FOR UPDATE` → `seq` 순서로 보내고 모든 확인을 기다림 → `sent_at` 적기 → 커밋. `SKIP LOCKED`는 쓰지 않는다. 실패하면 되돌리고 0.1초에서 5초 [가정]까지 늘려 가며 다시 한다. Kafka 보내기 상한 10초, 릴레이 역할 `statement_timeout` 5초·`idle_in_transaction_session_timeout` 30초. 복제 2개, 쿠버네티스 Lease로 하나만 보내고 리더가 멈추면 15초 안 [가정]에 이어받는다. 지표 `outbox_relay_lag_seconds`(두 복제가 5초마다 DB에서 잰다)·`_published_total`·`_errors_total`·`_batch_seconds`·`_is_leader`, 경보는 지연 5초 [가정] 1분 또는 리더 없음 1분이면 SEV2.
- 파티션(data.md §2, ADR-0083·0086·0114): Outbox는 ID(UUIDv7) 범위 일 파티션, 경계는 한국 시각 그날 0시의 유닉스 밀리초를 앞 48비트에 두고 나머지를 0으로 채운 UUID. 기본 키 `id`. 7일 [가정, wbs 0.3.2에서 확정] 앞까지 미리 만들고 일 3개 [가정]보다 적으면 SEV2(`kind` hygiene). 기본 파티션은 두지 않는다. 보내지 않은 행은 부분 인덱스 `(seq) WHERE sent_at IS NULL`. 3일 [가정] 지난 파티션은 정비 시간(04:00~06:00)에 떼어 내 지우고, 보내지 않은 행이 있으면 지우지 않고 SEV2. Drizzle에는 파티션 선언이 없어 손으로 쓴 SQL이다.
- 제어 사건(ADR-0143 결정 3): `control.settings`는 ops-svc Outbox, `control.sessions-terminated`는 identity-svc Outbox로 낸다.
- 시간 의존 로직은 Clock 주입(감독 규칙), 시각은 KST.

## 결정

1. **멱등 키는 머리 스키마에서 빼고 멱등 모듈만 본다(추천 적용 2026-11-01, BUILD_ORDER FND-080이 고르라고 둔 두 길 가운데).**
   - `@ContractRouteSchema`의 머리 스키마와 `@ContractHeaders`의 Zod 스키마에서 `Idempotency-Key` 칸을 지운다(이름은 대소문자를 가리지 않는다). 계약은 그대로다. 지운 처리기에는 표시를 남겨, `@Idempotent`가 없으면 시작 때 실패한다. 함수 `contractRouteSchema()`를 Fastify에 바로 붙이는 경로는 가드와 멱등 모듈을 지나지 않으므로 키를 남긴다(코드 리뷰 2026-11-01: 늘 지우면 장식자를 빠뜨린 처리기가 키 없는 요청을 받았다).
   - 인증 가드가 신원을 판정한 바로 뒤, 경로 스키마의 붙여 둔 검사 실패를 내기 전에 `@Idempotent`를 단 처리기의 키를 본다. 그래서 두 검사 길 모두 순서가 '익명 401 → 키 400 `idempotency-key-invalid` → 모양 400'으로 같다. Zod 파이프 길의 모양 검사는 가드 뒤 매개변수 단계라 저절로 뒤다.
   - 다른 길(머리 검사보다 먼저 키를 보는 가로채기)을 고르지 않은 이유: Nest의 가로채기는 가드 뒤에 돌아, 가드 안에서 내는 경로 스키마 실패보다 늦다. 머리 스키마에 키를 남기면 두 곳이 같은 머리를 다르게 판정한다.
2. **키 형식(추천 적용).** 머리가 정확히 하나이고, 값이 `xxxxxxxx-xxxx-4xxx-[89ab]xxx-xxxxxxxxxxxx`(16진수, 대소문자 무관)일 때만 받는다. 같은 머리가 둘 이상, 큰따옴표로 감싼 값, 다른 판(v1·v7)의 UUID는 400이다. 저장은 소문자로 맞춘다(같은 UUID를 대소문자로 다르게 보낸 것은 같은 키).
3. **요청 지문(추천 적용).** SHA-256(메서드 + LF + 요청 대상 + LF + 본문 바이트). 요청 대상은 받은 그대로의 경로와 쿼리다(구매 세션 요청 서명의 '경로와 쿼리'와 같다. 쿼리가 다르면 다른 요청이다). 본문 바이트는 플랫폼 해석기가 해석 전에 남긴 원시 바이트이고, 본문이 없으면 빈 바이트다.
4. **원시 본문(추천 적용).** 플랫폼이 `application/json` 해석기를 바이트로 받는 해석기로 바꿔 끼우고(Fastify 기본 JSON 해석기에 문자열로 넘겨 원형 오염 키 거부는 그대로), 해석 전 바이트를 요청에 남긴다. 표시한 경로의 `text/plain` 해석기도 같다. 처리기와 지문·서명 검사는 `rawBodyOf(request)`로 읽는다. 본문 크기 상한은 Fastify 기본(1MiB) 그대로다.
5. **범위와 장식자.** `@Idempotent({ operation })`의 `operation`은 그 서비스 작업 목록의 이름(예: `CREATE_ORDER`)이고 표의 `CHECK`와 같다. `account_ref`는 인증 가드가 판정한 계정 ID다. 공개 역할(`public`)을 허용한 처리기에 단 `@Idempotent`는 계정이 없을 수 있어 시작 때 실패한다(허용 역할 확인과 같은 곳). 처리기는 `@IdempotencyRequest()`로 `{ accountRef, operation, key, requestHash }`를 받아 유스케이스에 넘긴다. 좌석 홀드는 같은 요청 객체를 Redis Lua에 넘긴다(좌석 홀드 단계).
6. **멱등 기록(PostgreSQL, 추천 적용).**
   - 표: `account_ref text`, `operation text`, `idempotency_key uuid`, `request_hash bytea`(32바이트), `result_ref text`(커밋 때 채움), `created_at timestamptz`. 기본 키 `(account_ref, operation, idempotency_key)`, 인덱스 `(created_at)`, `CHECK (operation IN (…))`. 서비스는 `idempotencyRecordTable(작업 목록)`으로 같은 정의를 만든다.
   - `IdempotencyStore.run(tx, 요청, { execute, replay })`: 업무 쓰기와 같은 트랜잭션에서 ① `SET LOCAL lock_timeout = '1s'` ② `INSERT … ON CONFLICT (기본 키) DO UPDATE SET … WHERE created_at <= 보관 경계 RETURNING`(지난 키는 새 요청으로 다시 잡는다) ③ `SET LOCAL lock_timeout TO DEFAULT`(역할 기본값으로 돌린다). 넣었으면 `execute()` → `result_ref`를 적고 값을 돌려준다. 넣지 못했으면 있는 행의 지문을 견줘 다르면 422, 같으면 `replay(result_ref)`.
   - 같은 키의 첫 요청이 아직 커밋하지 않았으면 ②가 그 트랜잭션을 기다린다. 1초 안에 커밋하면 있는 행을 읽어 돌려주고, 되돌리면 이 요청이 새로 처리하며, 1초를 넘기면(`55P03`) 409 `idempotency-request-in-progress`와 `Retry-After: 1`이다. 문장 시간 한도(`57014`, 핫패스 역할 1초·데드라인으로 건 값)가 먼저 끝나도 같은 409다(코드 리뷰 2026-11-01).
   - `execute()`가 던지면 트랜잭션째 되돌아가 키 행도 남지 않는다(아무것도 바꾸지 않은 실패는 저장하지 않는다). 커밋된 행에 `result_ref`가 비어 있으면 처리기 버그이므로 500이다.
   - 시각(`created_at`, 보관 경계)은 주입한 시계로 정한다. 정리는 `deleteExpiredIdempotencyRecords()`가 1만 건 [가정]씩 지운다(정비 잡 일정은 FND-090). 기한 조건을 바깥 DELETE에도 둔다. 지우려던 행을 새 요청이 다시 잡아 커밋하면, 기다린 DELETE가 새 판을 다시 보고 남긴다(코드 리뷰 2026-11-01).
7. **Outbox 표와 쓰기(추천 적용).**
   - 칸: `id uuid`(UUIDv7, 주입한 시계), `seq bigint DEFAULT nextval('outbox_seq')`, `topic text`, `msg_key text`, `payload bytea`, `headers jsonb`(W3C 추적 머리), `sent_at timestamptz`. `PARTITION BY RANGE (id)`, 기본 키 `id`, 부분 인덱스 `(seq) WHERE sent_at IS NULL`. 따로 만든 시각 칸은 두지 않는다(ID의 앞 48비트가 만든 시각이다).
   - `writeOutbox(tx, 시계, 메시지들)`은 한 문장으로 여러 행을 넣고, 지금 추적 문맥을 머리에 싣는다. '트랜잭션의 마지막 문장'은 호출하는 쪽 규칙이다(코드로 막지 못한다. 문서와 코드 검토, V-T28).
8. **일 파티션(추천 적용).**
   - 이름 `outbox_pYYYYMMDD`(한국 시각 날짜). 미리 만들기는 `CREATE TABLE … (LIKE outbox INCLUDING DEFAULTS INCLUDING CONSTRAINTS)` 뒤 `ALTER TABLE outbox ATTACH PARTITION …`로 한다. 부모를 오래 막는 `CREATE TABLE … PARTITION OF` 대신, 부모에는 `SHARE UPDATE EXCLUSIVE`만 거는 붙이기를 쓴다(PostgreSQL 18 문서 §5.12.2.2). 붙일 때 기본 키·부분 인덱스가 저절로 생긴다. 문장마다 `lock_timeout` 2초 [가정].
   - 7일 [가정] 앞까지 미리 만드는 값을 이 단계에서 확정한다(data.md의 'wbs 0.3.2에서 확정'). 첫 파티션도 이 함수가 만든다. 마이그레이션 SQL에 날짜를 박으면 배포 날짜와 어긋나 첫 쓰기가 실패하기 때문이다. 마이그레이션 직후와 매일 정비 잡이 부른다(실행기는 BAS-060, 일정은 FND-090).
   - 지우기는 위 경계로 '그 파티션의 끝이 오늘 0시보다 3일 [가정] 이상 앞'인 파티션만, 정비 시간(04:00~06:00 KST) 안에서만 한다. 보내지 않은 행이 하나라도 있으면 지우지 않고 막힌 목록으로 돌려준다(SEV2). 지울 때는 `DETACH PARTITION … CONCURRENTLY` 뒤 `DROP TABLE`이다(트랜잭션 밖에서 돌고 부모의 쓰기를 막지 않는다). 앞서 끊긴 떼어 내기(`inhdetachpending`)는 `FINALIZE`로 마친다. 떼어 낸 뒤 `DROP`이 실패해 부모 목록에서 빠진 같은 이름 꼴의 표도 찾아 지우고 지표에 센다(코드 리뷰 2026-11-01). 정비 잡은 마이그레이션처럼 PgBouncer를 거치지 않고 직접 붙는다(세션 `SET lock_timeout`을 쓰므로).
   - 지표(릴레이가 5초마다 잰다): `outbox_partitions_ahead_days`(오늘 뒤로 미리 만든 날 수, 3 [가정]보다 적으면 SEV2 hygiene), `outbox_partitions_overdue`(지울 날에서 하루 더 지났는데 남은 파티션 수. 0보다 크면 SEV2. 보내지 않은 행에 막혔거나 정비 잡이 돌지 않았다).
9. **폴링 릴레이(추천 적용).**
   - 리더일 때만 묶음을 돈다. 묶음 하나는 트랜잭션 하나: `SET LOCAL statement_timeout = 5000, idle_in_transaction_session_timeout = 30000` → `SELECT id, seq, topic, msg_key, payload, headers FROM outbox WHERE sent_at IS NULL ORDER BY seq LIMIT 500 FOR UPDATE` → 보내기 포트(`seq` 순서, 모든 확인까지, 10초 상한) → `UPDATE outbox SET sent_at = $시각 WHERE id = ANY($ids)` → 커밋.
   - 묶음이 꽉 차면 바로 다음 묶음, 아니면 100ms [가정] 쉰다. 실패하면 되돌리고(행은 그대로) 0.1·0.2·0.4…5초 [가정]로 늘려 쉬고, 성공하면 처음으로 돌린다.
   - 보내기 포트 `OutboxPublisher.publish(행들, { signal })`: 같은 파티션 안 순서를 지키는 멱등 생산자로 모든 확인을 기다린 뒤 끝난다. Kafka 어댑터는 Kafka 클라이언트·필수 설정을 함께 정하는 FND-090에서 만든다(ADR-0116 결정 3 '구체 설정은 고른 클라이언트로').
   - 두 복제 모두 5초마다 지연(`seq`가 가장 작은 보내지 않은 행의 ID 시각부터 지금까지)과 파티션 지표를 잰다.
10. **Lease(추천 적용).**
   - 쿠버네티스 `coordination.k8s.io/v1` Lease `<서비스>-outbox-relay`, 보유자는 파드 이름. Lease 12초·갱신 한도 8초·다시 시도 2초 [가정]. 리더가 멈추면 늦어도 약 14초 뒤 다른 복제가 잡아 정본의 '15초 안'을 지킨다. 갱신 한도(8초)가 Lease(12초)보다 짧아, 옛 리더는 남이 잡기 전에 스스로 내려온다.
   - 남의 Lease가 끝났는지는 상대가 적은 갱신 시각이 아니라 '그 기록이 마지막으로 바뀐 것을 본 내 단조 시계'로 판정한다(시계가 다른 노드 사이의 차이를 타지 않게, client-go와 같은 방식). 고치기는 `resourceVersion`으로 겨룬다(409면 진 것).
   - 멈출 때 Lease를 놓는다(보유자를 비우고 Lease를 1초로). 바뀐 리더가 앞 묶음을 건너뛰지 않는 것은 결정 9의 `FOR UPDATE`(기다렸다가 다시 본다)가 지킨다.
   - 쉼 함수는 잠이 끝나면 멈춤 신호에 붙인 리스너를 뗀다(반복이 100ms마다 오래 사는 신호로 부르므로, 코드 리뷰 2026-11-01).
   - API 부르기 하나는 전체 2초 [가정] 한도이고, 응답 도중 연결이 끊기면 바로 실패한다(머리를 받은 뒤 끊기면 끝 신호가 오지 않아 반복이 멈췄다, 확인 리뷰 2026-11-01).
   - API 클라이언트는 파드 안 설정(서비스 계정 토큰은 부를 때마다 다시 읽는다, CA 파일)으로 `node:https`를 쓴다. 실제 클러스터 확인은 FND-110(kind)이다.
11. **제어 사건.** 릴레이는 주제를 가리지 않는다. 제어 주제 이름은 상수(`CONTROL_TOPICS`)로 두고, 시험이 제어 사건도 같은 Outbox·릴레이로 순서대로 나가는 것을 본다. 실제로 쓰는 쪽은 PRF-030·OPS-300이다.
12. **서비스 뼈대.** 예시 쓰기 경로(메모 만들기)가 `@Idempotent({ operation: 'CREATE_NOTE' })`이고, 어댑터가 한 트랜잭션에서 멱등 기록 → 메모 → Outbox 순으로 쓴다. 마이그레이션은 `0001_idempotency_record.sql`·`0002_outbox.sql`.

## 위험과 대응

- 키 행의 첫 INSERT가 긴 트랜잭션 뒤에 줄을 서면 처리 중 409가 늘 수 있다 → 기다림 1초 [가정]는 지표(정규 로그 줄의 409 `err.type`)로 보고 BAS-080 부하 시험에서 다시 본다.
- '마지막 문장' 규칙을 어긴 코드는 순서를 뒤집을 수 있다 → V-T28과 코드 검토(ADR-0116 남는 한계).
- 정비 잡이 돌지 않으면 미리 만든 날이 줄어든다 → `outbox_partitions_ahead_days` 경보가 3일 전에 알린다.
