# ADR-0351: core-svc 웹훅 발송기를 전용 DB 역할 core_notify로 옮긴다(2026-11-22)

- **상태**: 채택(2026-11-22, 감독 결정. W12-core-rls2 계획 §13.1이 넘긴 일을 갈래 3의 W12-core-notify가 계획하며 정했다. 방향 '발송기 전용 그룹 역할을 만들고, 발송기가 실제로 쓰는 표·명령·칸만 주며, 배포는 두 번에 나눈다'는 감독 지시이고 세부 권한·정책·연결 값은 이 묶음 계획 담당의 추천 적용이다)
- **관련**: [ADR-0338](0338-core-webhook-endpoint-merch-order-write-grants.md) 결정 1·2와 '결과', [ADR-0241](0241-core-svc-partner-row-security.md) 결정 1·4·6·7, [ADR-0053](0053-crypto-hardening-pseudonyms-webhooks-stores-runbook-audit.md) 결정 4, [ADR-0109](0109-delivery-jobs-in-postgres-drop-bullmq-cache-redis-key-classes-noeviction.md), [docs/devops.md](../devops.md) §7.1, [docs/security/authz-matrix.md](../security/authz-matrix.md) §5.3·§7, [docs/features/notify.md](../features/notify.md) §9·§13, [docs/data.md](../data.md) `webhook_endpoint`·`webhook_delivery`, [docs/review/plans/W12-core-notify.md](../review/plans/W12-core-notify.md), W12-core-rls2 계획 §13.1
- **관련 ID**: AZ-T19, FR-024, FR-025, ASVS v5.0.0-8.2.3, ASVS v5.0.0-8.4.1, ASVS v5.0.0-13.2.2

## 맥락

- core-svc는 DB 역할을 경로마다 나눈다(ADR-0241 결정 1). 팬 경로 `core_app`, 파트너 경로 `core_partner`, 관제 `core_ops`다. 그런데 파트너 웹훅을 보내는 발송기(`services/core-svc/src/main.ts`의 `WebhookWorker`, 내부 입구 `POST /internal/v1/notify/webhook-events`)는 `core_app` 풀로 붙는다.
- 0042(ADR-0338 결정 1)가 `core_app`의 `webhook_endpoint` 고치기를 세 칸·켜진 끝점 끄기로 좁혔지만, 두 가지 위험이 남았다.
  1. `webhook_delivery`는 0042가 바꾸지 않았다. `core_app`에 표 단위 `INSERT, UPDATE`(0016 77행)와 조건 없는 정책 `webhook_delivery_app_all`(0016 105행)이 있다. 팬 경로 쿼리 하나로 아무 끝점·아무 본문의 발송 행을 넣으면 발송기가 그 파트너 비밀로 서명해 보낸다(가짜 주문 확정·지급 완료).
  2. `core_app`은 여전히 모든 끝점의 주소·지금 비밀·옛 비밀을 읽고, 켜진 끝점을 `FAILING`으로 끌 수 있다(가용성). notify.md §13의 '발송 워커의 서비스 계정만 비밀을 읽는다'와 다르다.
- 발송기가 실제로 쓰는 것은 좁다. 끝점 읽기(모든 칸), 끝점 끄기(세 칸·켜짐→`FAILING`), 원장 넣기(표 객체의 칸), 원장 집기(모든 칸을 돌려받고 `lease_until`만 씀), 원장 저장(일곱 칸), DEAD 세기·마지막 성공 읽기다.

## 결정

1. **역할**: core-svc 마이그레이션 0043이 로그인할 수 없는 그룹 역할 `core_notify`를 만든다(`NOLOGIN NOSUPERUSER NOBYPASSRLS`). 표 소유자가 아니고, `core_app`·`core_partner`·`core_ops`·`core_maintenance`·`core_search`를 겸하지 않는다(겸하면 시작 확인이 막는다).
2. **연결**: 발송기와 내부 입구는 `PEAKET_NOTIFY_DATABASE_URL`의 풀(`core-svc-notify`, 최대 4개 [가정])로만 붙는다. 값이 없으면 `main.ts`가 시작하지 않는다. `PEAKET_DATABASE_URL`로 조용히 되돌아가지 않는다. `NotifyModule`의 `NOTIFY_APP_STORE`와 `main.ts`의 `WebhookWorker`가 같은 풀을 쓴다. `AppModule.register`의 database 갈래는 `notifyDatabase`를 필수로 받아, 시험·개발 조립이라도 빠뜨리면 컴파일되지 않는다.
3. **권한은 코드가 쓰는 만큼만**:
   - `webhook_endpoint`: `SELECT`(발송기가 모든 칸을 읽는다)와 `UPDATE ("status", "disabled_reason", "version")`. 정책 `webhook_endpoint_notify_read`(FOR SELECT, `true`)와 `webhook_endpoint_notify_disable`(FOR UPDATE, USING `status = 'ACTIVE'`, WITH CHECK `status = 'DISABLED' AND disabled_reason = 'FAILING'`). 끝점 넣기·지우기·TRUNCATE는 주지 않는다.
   - `webhook_delivery`: `SELECT, INSERT`(발송기가 행을 만들고 집은 행의 모든 칸을 돌려받는다)와 `UPDATE ("status", "attempt_count", "last_http_status", "last_error", "next_attempt_at", "finished_at", "lease_until")`. `payload`·`endpoint_id`·`webhook_id`·`event_type`·`created_at`은 고치지 못한다. 정책 `webhook_delivery_notify_read`(FOR SELECT, `true`), `webhook_delivery_notify_insert`(FOR INSERT, `true`), `webhook_delivery_notify_update`(FOR UPDATE, USING `status IN ('PENDING', 'RETRYING')`, WITH CHECK `status IN ('PENDING', 'RETRYING', 'SUCCEEDED', 'DEAD')`). 끝난 행을 되돌리지 못하고, 지금 도는 행만 결과로 바꾼다. 지우기·TRUNCATE는 주지 않는다.
   - 스키마 `public`의 `USAGE`만 주고, 0004의 기본 권한(`ALTER DEFAULT PRIVILEGES … GRANT SELECT … TO core_app`)은 `core_notify`에 적용되지 않는다. 그래서 뒤에 만드는 표가 저절로 열리지 않는다.
   - `FORCE ROW LEVEL SECURITY`는 걸지 않는다(마이그레이션·시드는 소유자로 돈다, ADR-0241 결정 6).
4. **시작 확인**: `assertDatabaseRole(notifyDatabase, 'core_notify')`를 다른 연결과 같은 자리에서 부른다. 슈퍼유저·표 소유자·다른 서비스 역할 겸함·역할 아님을 시작에서 막는다(ADR-0241 결정 7과 같은 꼴).
5. **배포를 두 번에 나눈다**: 이 배포(N)는 역할·권한·정책·연결·시작 확인·코드 전환만 한다. `core_app`의 두 표 권한과 정책 넷(`webhook_endpoint_app_read`·`webhook_endpoint_app_disable`·`webhook_delivery_app_read`·`webhook_delivery_app_all`)은 건드리지 않는다. 이 코드가 모든 파드에 깔린 뒤 다음 배포(N+1)의 첫 core-svc 마이그레이션이 그것을 거둔다.
   - 까닭: devops.md §7.1 2·3. 카나리·되돌리기 동안 N-1 파드가 같은 DB를 쓰고, N-1 파드는 발송기를 `core_app`으로 돌린다. 같은 배포에서 `core_app` 권한을 거두면 N-1 발송기가 42501로 멈춘다.
   - 그때까지 위 문단의 위험은 남는다. 이 묶음은 새 길을 먼저 내고 옛 길을 다음 배포에서 닫는 '확장 → 축소'다.
6. **정본 반영**: authz-matrix §5.3은 `core_notify`의 권한·정책과 두 번 나눔을, §7 AZ-T19는 시험을, data.md는 `webhook_endpoint`·`webhook_delivery`의 발송기 역할을, notify.md §13은 발송 워커의 DB 역할을 적는다.
7. **시험**: AZ-T19 ①~⑧. 실제 PostgreSQL 18에서 ①~③·⑤~⑧을 `core_notify` 로그인으로 보고, ④는 빌드한 `dist/main.js` 프로세스로 본다.

## 결과

- 발송기 코드가 쓰는 8개 저장소 메서드가 `core_notify`로 그대로 돈다. 팬 경로 코드는 발송기 풀을 받지 못한다.
- `core_notify`는 다른 표를 읽거나 쓰지 못하고, 끝점의 비밀·주소·구독·판매자·끝점 ID를 고치지 못하며, 끝난 원장 행을 되돌리지 못한다.
- 잘못된 주소(없음·다른 역할·슈퍼유저·소유자·역할 겸함)는 요청이 아니라 시작에서 멈춘다.
- 남는 한계: 다음 배포 전까지 `core_app`이 두 표에 닿는다(결정 5). 발송기 역할은 설계상 모든 끝점의 비밀을 읽는다(서명에 필요). 이는 '발송 워커의 서비스 계정만 비밀을 읽는다'는 정본과 같은 뜻이고, 이제 팬 경로 역할이 아니라 발송기 역할만 읽는다.

## 다른 선택지

| 안 | 고르지 않은 까닭 |
| --- | --- |
| 발송기를 별도 프로세스(`core-webhook-dispatcher`)로 띄운다 | 배포 단위·서비스 계정·지표·종료 차례가 늘고, 지금 발송기는 core-svc 주기 작업이다. DB 역할을 나누는 것만으로 이 묶음의 위험(사칭·원장 조작·비밀 읽기)을 닫는다 |
| 정의자 권한 함수로 원장 넣기·상태 바꾸기를 감싼다 | 함수를 부르지 않는 문장(이전 판·잘못된 코드)을 막지 못하고, 도메인 규칙을 SQL에 두 곳으로 옮긴다. 정책·칸 권한이 문장 자체를 막는다 |
| `core_app`의 권한을 이 마이그레이션에서 바로 거둔다 | N-1 파드의 발송기가 42501로 멈춘다(결정 5, devops §7.1) |
| `core_notify`에게 `core_app`을 물려준다(`GRANT core_app TO core_notify`) | 두 역할의 정책이 OR로 합쳐져 0042의 좁힌 권한이 무력해지고, 시작 확인의 '다른 역할 겸함' 검사에도 걸린다 |
| 원장 INSERT도 칸 단위로 좁힌다 | 발송기가 행을 만들 때 쓰는 칸이 표 객체의 칸 전부(식별·본문 포함)이고, 발송기의 정당한 일이 새 사건 행 만들기다. 사칭은 역할 분리로 막고, 만든 뒤 바꾸는 길은 칸 권한으로 막는다 |
| `webhook_delivery` UPDATE 정책을 조건 없이 둔다 | 끝난 행을 `PENDING`으로 되돌려 다시 보내는 길이 남는다(위험 ②) |
| `FORCE ROW LEVEL SECURITY` | 마이그레이션·시드가 소유자 권한에 기대어 조용히 0건이 된다(ADR-0241과 같은 까닭) |
