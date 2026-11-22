# 작업 계획: W12-core-notify(웹훅 발송기를 전용 DB 역할 core_notify로 옮긴다)

- **무엇**: core-svc의 파트너 웹훅 발송기(사건을 파트너 주소로 서명해 보내는 주기 작업과 내부 입구)가 지금 팬 경로 DB 역할 `core_app`으로 붙는다. 그래서 팬 경로 쿼리 하나로 ① 아무 끝점·아무 본문의 발송 행을 넣으면 발송기가 그 파트너 비밀로 서명해 보낸다(사칭) ② 발송 원장의 상태를 고쳐 진짜 사건을 DEAD로 만들거나 끝난 행을 PENDING으로 되돌린다 ③ 모든 끝점의 주소·비밀을 읽고 켜진 끝점을 `FAILING`으로 끈다. 이 묶음은 발송기 전용 그룹 역할 `core_notify`(로그인 불가·`NOBYPASSRLS`)와 그 역할이 실제로 쓰는 표·명령·칸만 주고, 발송기를 `PEAKET_NOTIFY_DATABASE_URL` 연결로 옮긴다. 검증 기록이고 규범이 아니다. 정본은 `docs/`를 따르고 정본을 고친다.
- **바탕**: 작업 폴더 `D:/ticketpass-lane3`, 가지 `feature/lane3-W12-core-notify`, 출발점 `origin/develop` `9b7ed40ff`(R-755). 설계 출발점은 W12-core-rls2 계획 §13.1(발송 원장 `webhook_delivery`와 발송기 전용 역할 `core_notify`), ADR-0338 '결과'의 남는 한계다.
- **급·차례**: 시험 먼저. 계획 → 시험(구현 전 트리의 실패 확인) → 구현 → 리뷰(보안) → 리뷰 반영 → 검증(틀린 구현 표본) → 기록. 커밋 꼬리말에 단계마다 `Role`·`Agent-Session`·`Batch`를 달고, `Agent-Model: deepseek-v4.1-flash`를 함께 적는다.
- **정본**: [ADR-0350](../../adr/0350-core-notify-sender-dedicated-db-role.md)(새), [ADR-0338](../../adr/0338-core-webhook-endpoint-merch-order-write-grants.md) 결정 1·2와 '결과', [ADR-0241](../../adr/0241-core-svc-partner-row-security.md) 결정 1·4·7, [devops.md](../../devops.md) §7.1, [authz-matrix](../../security/authz-matrix.md) §5.3·§7 **AZ-T19**(새 시험 ID), [data.md](../../data.md) `webhook_endpoint`·`webhook_delivery`, [asvs/notify](../../security/asvs/notify.md) 8.4.1·13.2.2, [notify.md](../../features/notify.md) §9·§13, [W12-core-rls2 계획](W12-core-rls2.md) §13.1.

## 결과 요약

| 위험 | 지금(출발점) | 이 묶음 뒤 | 남는 것 |
| --- | --- | --- | --- |
| 발송 행 사칭 | `core_app`이 `webhook_delivery`에 아무 행이나 넣고, 발송기가 그 행을 파트너 비밀로 서명해 보낸다 | 발송기는 `core_notify`로만 원장에 넣는다. 팬 경로 코드는 `core_notify` 연결을 받지 못한다 | `core_app`의 원장 권한은 다음 배포까지 남는다(두 번 나눔, ADR-0350 결정 5). 그동안 팬 경로 쿼리 하나로 사칭 행을 넣는 길은 닫히지 않는다 |
| 원장 상태 조작 | `core_app`이 모든 원장 행의 상태를 고친다 | `core_notify`는 `PENDING`·`RETRYING` 행만 고치고, `payload`·`endpoint_id`·`webhook_id`·`event_type`·`created_at`은 고치지 못한다. 끝난 행을 되돌리지 못한다 | 팬 경로 역할의 권한은 다음 배포까지 남는다 |
| 끝점 비밀 읽기·끄기 | `core_app`이 모든 끝점의 비밀을 읽고 켜진 끝점을 끈다 | 발송기 역할 `core_notify`가 그 일을 하고, 팬 경로 역할은 다음 배포에서 거둔다 | 팬 경로 역할의 읽기·끄기는 다음 배포까지 남는다 |
| 잘못된 연결로 시작 | 발송기가 팬 경로 풀을 쓴다 | `PEAKET_NOTIFY_DATABASE_URL`이 없거나 `core_notify`가 아닌 로그인(슈퍼유저·다른 역할 겸함 포함)이면 서비스가 시작하지 않는다 | 없음 |

## 1. 조사 결과

### 1.1 지금 권한과 발송기가 쓰는 것

- **지금 권한**(`core_app`): `webhook_endpoint` 읽기(0004 25행 기본 권한)·`webhook_endpoint_app_read`(0015 50행), 0042 뒤 고치기 세 칸·`webhook_endpoint_app_disable`. `webhook_delivery` 읽기(0004 기본 권한)·`INSERT, UPDATE`(0016 77행)·`webhook_delivery_app_read`(0015 52행)·`webhook_delivery_app_all` FOR ALL `true`(0016 105행).
- **발송기가 실제로 쓰는 것**(`services/core-svc/src/modules/notify/adapters/db/drizzle-webhook-store.ts`, `application/dispatcher.ts`, `main.ts`의 `WebhookWorker`, 내부 입구 `POST /internal/v1/notify/webhook-events`):

| 메서드 | 표 | 명령 | 읽는 칸 | 쓰는 칸 |
| --- | --- | --- | --- | --- |
| `listActiveEndpoints` | `webhook_endpoint` | SELECT | 조건 `promoter_id`·`status`, 돌려받기는 11칸 전부 | — |
| `findEndpointById` | `webhook_endpoint` | SELECT | 조건 `id`, 돌려받기는 11칸 전부 | — |
| `disableEndpoint` | `webhook_endpoint` | UPDATE | `id`·`version` | `status`·`disabled_reason`·`version` |
| `insertDeliveries` | `webhook_delivery` | INSERT | — | 12칸(표 객체의 칸, `lease_until`은 넣지 않는다) |
| `listDueDeliveries` | `webhook_delivery` | SELECT … FOR UPDATE SKIP LOCKED → UPDATE … RETURNING | `id`·`status`·`next_attempt_at`·`lease_until`, 돌려받기는 13칸 전부 | `lease_until` |
| `saveDelivery` | `webhook_delivery` | UPDATE | `id`·`status` | `status`·`attempt_count`·`last_http_status`·`last_error`·`next_attempt_at`·`finished_at`·`lease_until` |
| `countDeadSince` | `webhook_delivery` | SELECT count | `endpoint_id`·`status`·`finished_at`·`created_at` | — |
| `lastSuccessAt` | `webhook_delivery` | SELECT max | `endpoint_id`·`status`·`finished_at` | — |

- 팬 경로의 다른 코드는 두 표를 읽지도 쓰지도 않는다(`grep -rn "webhookDelivery\|webhook_delivery\|webhookEndpoint" services/core-svc/src`가 notify 모듈만 준다). 파트너 경로(`core_partner`)는 끝점 관리와 다시 보내기(`redeliver`, 원장 상태 되돌리기)를 그대로 쓴다. 이 묶음은 파트너 역할의 권한을 바꾸지 않는다.
- **`core_app`에서 거둘 것**(다음 배포, ADR-0350 결정 5): 두 표의 읽기(기본 권한으로 받은 것), `webhook_endpoint` 고치기 세 칸, `webhook_delivery` 넣기·고치기, 정책 넷(`webhook_endpoint_app_read`·`webhook_endpoint_app_disable`·`webhook_delivery_app_read`·`webhook_delivery_app_all`).

### 1.2 새 역할이 받을 권한·정책

- 그룹 역할 `core_notify`: `NOLOGIN NOSUPERUSER NOBYPASSRLS`, 표 소유자가 아니다. 로그인 사용자는 비밀 관리·데모가 만들고 이 역할 하나에만 넣는다.
- `webhook_endpoint`
  - `GRANT SELECT`(표 단위, 발송기가 11칸을 모두 읽는다).
  - `GRANT UPDATE ("status", "disabled_reason", "version")`(표 단위 고치기를 먼저 거두고 칸만 준다).
  - 정책 `webhook_endpoint_notify_read` FOR SELECT USING `true`.
  - 정책 `webhook_endpoint_notify_disable` FOR UPDATE USING `"status" = 'ACTIVE'` WITH CHECK `"status" = 'DISABLED' AND "disabled_reason" = 'FAILING'`. 켜진 끝점을 사유 `FAILING`으로 끄는 것만 된다.
- `webhook_delivery`
  - `GRANT SELECT, INSERT`(발송기가 표 객체의 칸을 모두 넣고, 집은 행을 모두 돌려받는다).
  - `GRANT UPDATE ("status", "attempt_count", "last_http_status", "last_error", "next_attempt_at", "finished_at", "lease_until")`. `payload`·`endpoint_id`·`webhook_id`·`event_type`·`created_at`은 고치지 못한다.
  - 정책 `webhook_delivery_notify_read` FOR SELECT USING `true`.
  - 정책 `webhook_delivery_notify_insert` FOR INSERT WITH CHECK `true`.
  - 정책 `webhook_delivery_notify_update` FOR UPDATE USING `"status" IN ('PENDING', 'RETRYING')` WITH CHECK `"status" IN ('PENDING', 'RETRYING', 'SUCCEEDED', 'DEAD')`. 끝난 행(`SUCCEEDED`·`DEAD`)을 되돌리지 못하고, 지금 도는 행만 결과로 바꾼다.
- `DELETE`·`TRUNCATE`·다른 표 권한은 주지 않는다. 스키마 `USAGE`만 준다.
- `FORCE ROW LEVEL SECURITY`는 걸지 않는다(마이그레이션·시드는 소유자로 돌고, 앱 역할은 소유자가 아니다, ADR-0241 결정 6).
- 0043은 다시 돌려도 같게 `CREATE ROLE`은 `IF NOT EXISTS` 꼴로, 정책은 `DROP POLICY IF EXISTS` 뒤 `CREATE POLICY`로 쓴다.

### 1.3 연결·시작 확인·주입

- 환경 변수 `PEAKET_NOTIFY_DATABASE_URL`. 없으면 `main.ts`가 시작하지 않는다. `PEAKET_DATABASE_URL`로 조용히 되돌아가지 않는다.
- 풀 이름 `core-svc-notify`, 최대 4개 [가정](발송 주기 5초·한 번에 100행, 내부 입구가 같은 저장소를 쓴다). 종료 때 함께 닫는다.
- `assertDatabaseRole(notifyDatabase, 'core_notify')`를 다른 연결과 같은 자리에서 부른다. 슈퍼유저·표 소유자·다른 서비스 역할(`core_app`·`core_partner`·`core_ops`·`core_maintenance`·`core_search`)을 하나라도 겸하면 시작하지 않는다.
- `NotifyModule`의 `NOTIFY_APP_STORE`는 `notifyDatabase`로 만든 `DrizzleWebhookStore`다. `main.ts`의 `WebhookWorker`도 같은 저장소를 쓴다(지금은 `database`로 따로 만든다).
- `AppModule.register`의 database 갈래는 `notifyDatabase`를 **필수**로 받는다. 빠뜨린 조립은 컴파일되지 않는다(시험 조립 실수로 팬 경로 풀이 발송기에 붙는 길을 막는다).

### 1.4 배포를 두 번에 나누는 결정

- **이번 배포(N)**: 역할·권한·정책·연결·시작 확인·코드 전환. `core_app`의 기존 권한은 **건드리지 않는다**.
- **다음 배포(N+1, 다음 묶음)**: 이 코드가 모든 파드에 깔린 뒤 첫 core-svc 마이그레이션이 `core_app`의 두 표 권한과 정책 넷을 거둔다.
- **까닭**: devops.md §7.1 2·3. 카나리·되돌리기 동안 N-1 파드가 같은 DB를 쓴다. N-1 파드는 발송기를 `core_app`으로 돌리므로, 같은 배포에서 `core_app` 권한을 거두면 N-1 파드의 발송기가 42501로 멈춘다. 그래서 확장(새 역할·새 길)과 축소(옛 역할 권한 회수)를 나눈다.
- **이번에 하지 않는 것**: `core_app`의 `REVOKE`·정책 삭제, `webhook_delivery`의 `core_app` 정책 변경.
- **남는 위험**: 다음 배포까지 ①~③의 위험이 그대로다. 이 묶음은 '발송기가 실제로 쓰는 길'을 먼저 만들고, 위험을 닫는 회수는 다음 배포로 넘긴다. 넘긴 일은 기록 커밋과 BUILD_ORDER 비고에 적는다.

## 2. 목표와 비목표

- **목표**
  1. 발송기가 `core_notify` 역할로만 두 표를 쓴다. 발송기가 쓰는 8개 메서드가 실제 PostgreSQL에서 그대로 돈다.
  2. `core_notify`는 다른 표를 읽거나 쓰지 못하고, `webhook_endpoint`의 비밀을 고치지 못하며, 끝난 원장 행을 되돌리지 못한다.
  3. `PEAKET_NOTIFY_DATABASE_URL`이 없거나 `core_notify`가 아닌 로그인으로 시작하면 프로세스가 시작하지 않는다.
  4. 정본(ADR-0350, authz-matrix §5.3·§7, data.md, notify.md §13)과 배포 값이 코드와 같은 말을 한다.
- **비목표**
  - `core_app` 권한 회수(다음 배포).
  - 파트너 역할(`core_partner`)의 웹훅 관리 권한 변경.
  - 발송 원장 새 칸·인덱스·정리 작업, 발송기 리더 선출, 파트너 알림함.
  - `notification_job` 등 팬 알림 발송 작업의 DB 역할(이 묶음은 파트너 웹훅 원장만).
  - 계약·화면·생성물.

## 3. 완료의 정의

1. `services/core-svc/migrations/0043_core_notify_role.sql`이 저널 idx 43으로 올라가고, 새 DB에서 `core_notify`·정책·칸 권한이 1.2와 같다.
2. AZ-T19 ①~⑧ 시험이 실제 PostgreSQL 18 컨테이너에서 통과한다. ④는 빌드한 `dist/main.js` 프로세스로 본다.
3. `main.ts`가 `PEAKET_NOTIFY_DATABASE_URL` 없이, 그리고 `core_notify`가 아닌 로그인으로 시작하지 않는다. `PEAKET_DATABASE_URL`로 되돌아가는 코드 경로가 없다.
4. 단위 시험·대상 통합 시험·typecheck·lint·doc-check·`trace-check --ids AZ-T19`·`ledger --batch W12-core-notify --require`가 통과한다.
5. 계획의 `리뷰`·`검증` 절과 기록(R-757)이 채워지고, `records.mjs --check`·`roles-check --base origin/develop --head HEAD`가 통과한다.
6. 틀린 구현 표본(§10)이 판정 항목마다 최소 1개씩 잡힌다.

## 4. 엣지와 실패 시나리오

| 상황 | 기대 |
| --- | --- |
| `PEAKET_NOTIFY_DATABASE_URL`이 빈 문자열·없음 | 시작 실패, 오류 줄에 변수 이름. 다른 풀로 대신하지 않는다 |
| 발송기 주소가 `core_app` 로그인 | `assertDatabaseRole`이 'DB 사용자가 core_notify 역할이 아니다'로 시작 실패 |
| 발송기 주소가 슈퍼유저·표 소유자 | '슈퍼유저이거나 표 소유자라 행 보안이 걸리지 않는다(core_notify로 접속해야 한다)'로 시작 실패 |
| 발송기 주소가 `core_notify`와 `core_app`을 겸함 | 'DB 사용자가 core_app… 역할을 함께 가져 행 보안 정책이 합쳐진다'로 시작 실패 |
| 파트너가 끈 끝점에 발송기가 끄기를 부름 | 0행, 사유 `PARTNER`·판 그대로(0042와 같은 행동) |
| 끝난 원장 행에 `saveDelivery` | 0행(정책 USING 밖), 상태 그대로 |
| 원장 행의 `payload`만 고치기 | 42501(칸 권한 없음) |
| `webhook_endpoint`의 `secret`만 고치기 | 42501(칸 권한 없음) |
| 다른 표(`product`·`merch_order`·`attendee_export_audit`) 읽기·쓰기 | 42501 |
| 마이그레이션을 다시 돌림 | 역할·정책이 같은 모양(오류 없음) |
| N-1 파드가 도는 배포 창 | `core_app` 권한이 남아 있어 발송기가 계속 돈다 |
| 다음 배포 전에 `core_app` 권한을 손으로 거둠 | N-1 발송기가 42501로 멈춘다. 하지 않는다(§1.4) |

## 5. 인터페이스 계약

| 이름 | 값·모양 | 정하는 곳 |
| --- | --- | --- |
| 환경 변수 | `PEAKET_NOTIFY_DATABASE_URL`(필수, 없으면 시작 실패) | 이 계획, ADR-0350 결정 2 |
| DB 역할 | `core_notify`, `NOLOGIN NOSUPERUSER NOBYPASSRLS` | ADR-0350 결정 1 |
| 연결 풀 | `core-svc-notify`, 최대 4 [가정] | ADR-0350 결정 2 |
| 시작 확인 | `assertDatabaseRole(notifyDatabase, 'core_notify')` | ADR-0241 결정 7, ADR-0350 결정 4 |
| `webhook_endpoint` 권한 | `SELECT`(표), `UPDATE ("status","disabled_reason","version")` | ADR-0350 결정 3 |
| `webhook_endpoint` 정책 | `webhook_endpoint_notify_read`(SELECT, `true`), `webhook_endpoint_notify_disable`(UPDATE, USING `status='ACTIVE'`, WITH CHECK `status='DISABLED' AND disabled_reason='FAILING'`) | ADR-0350 결정 3 |
| `webhook_delivery` 권한 | `SELECT, INSERT`(표), `UPDATE ("status","attempt_count","last_http_status","last_error","next_attempt_at","finished_at","lease_until")` | ADR-0350 결정 3 |
| `webhook_delivery` 정책 | `webhook_delivery_notify_read`(SELECT, `true`), `webhook_delivery_notify_insert`(INSERT, `true`), `webhook_delivery_notify_update`(UPDATE, USING `status IN ('PENDING','RETRYING')`, WITH CHECK `status IN ('PENDING','RETRYING','SUCCEEDED','DEAD')`) | ADR-0350 결정 3 |
| 마이그레이션 | `services/core-svc/migrations/0043_core_notify_role.sql`, 저널 idx 43 | data.md, 이 계획 |
| 시험 ID | `AZ-T19` ①~⑧ | authz-matrix §7 |
| 배포 값 | `tools/local/demo-objects.mjs`의 `core_notify_login`·`coreNotify`·`demo-core`의 `PEAKET_NOTIFY_DATABASE_URL` | ADR-0350 결정 2 |
| 시작 확인 시험 | `services/core-svc/test-int/startup-db-role.int.test.ts`에 `PEAKET_NOTIFY_DATABASE_URL` 경우를 더한다 | 이 계획 §8 |

## 6. 보안 위협과 운영 확인

| 위협 | 누가 어떻게 | 이 묶음의 막이 | 남는 것 |
| --- | --- | --- | --- |
| 사칭 발송 | 팬 경로 코드가 `webhook_delivery`에 꾸민 행을 넣고 발송기가 그 파트너 비밀로 서명 | 발송기 연결이 `core_notify`뿐이고, `NotifyModule`·`WebhookWorker` 모두 그 풀을 쓴다. `core_notify`를 받지 못한 코드는 원장에 닿지 못한다 | `core_app` 권한 회수 전까지 팬 경로 코드는 옛 길로 넣을 수 있다(§1.4) |
| 진짜 사건 죽이기·되돌리기 | 원장 상태를 고침 | `core_notify`는 `PENDING`·`RETRYING` 행만 고치고 끝난 행은 못 고친다. 칸 권한이 `payload`·식별 칸을 막는다 | `core_app` 회수 전까지 옛 길이 남는다 |
| 끝점 비밀 읽기·끄기 | 모든 끝점을 읽고 켜진 것을 끔 | 발송기 역할은 비밀을 읽어야 한다(서명). 끄기는 켜진 끝점을 `FAILING`으로만 | `core_app` 회수 전까지 팬 경로 코드가 같은 일을 할 수 있다. 발송기 역할 자체는 여전히 비밀을 읽는다(설계상 필요) |
| 잘못된 역할로 시작 | 주소를 잘못 넣음 | 시작 확인 3종(없음·다른 역할·슈퍼유저/소유자) | 없음 |
| 마이그레이션 재실행 | 같은 마이그레이션을 두 번 | `IF NOT EXISTS`·`DROP POLICY IF EXISTS` | 없음 |

**운영 확인 표(docs/architecture.md §8.4)**

| 확인할 것 | 신호·지표(로그 필드·요청 값) | SLI(측정값) | 임계치·알림 | 대응(런북·자동화) | 배포 뒤 확인 시점 |
| --- | --- | --- | --- | --- | --- |
| 발송기가 `core_notify`로 붙었는가 | 시작 로그의 `kind=start`에 새 연결 이름은 아직 없다. `pg_stat_activity.usename`이 `core_notify_login`(데모) | 배포 뒤 `core_notify` 로그인 연결 수 | 0이면 알림(발송기가 팬 경로 풀을 쓰는 회귀) | `PEAKET_NOTIFY_DATABASE_URL`·Secret 확인, 파드 재시작 | 배포 직후 5분 |
| 발송기가 계속 돈다 | `kind=webhook-worker` 로그의 `attempted`·`succeeded`·`retrying`·`dead` | 5분 동안 `attempted` 합 | 0이 10분 계속이면 알림 | `pg_stat_activity`의 `wait_event`, 42501 로그 확인 | 배포 직후 10분 |
| 권한 오류가 없다 | 42501이 든 오류 로그(`webhook-worker`·internal 입구) | 5분 42501 건수 | 1건 이상이면 알림 | 마이그레이션 0043 적용 여부·연결 주소 확인 | 배포 직후 10분 |
| 다음 배포에서 `core_app` 권한을 거둘 수 있다 | `has_table_privilege('core_app', 'webhook_delivery', 'INSERT')` | 거짓이면 회수 완료 | 참이면 다음 묶음 대기 | 다음 묶음의 마이그레이션 | N+1 배포 뒤 |

## 7. 손댈 파일과 담당

| 담당 | 파일 | 할 일 |
| --- | --- | --- |
| 계획 | `docs/review/plans/W12-core-notify.md`(새), `docs/adr/0350-core-notify-sender-dedicated-db-role.md`(새), `docs/security/authz-matrix.md` §7 AZ-T19, `docs/BUILD_ORDER.md` 묶음 줄 | 결정·시험 ID·장부 범위 먼저 |
| 시험 | `services/core-svc/test-int/notify-role.int.test.ts`(새) | AZ-T19 ①~③·⑤~⑧ |
| 시험 | `services/core-svc/test-int/startup-db-role.int.test.ts` | ④와 '환경 변수 없음' 경우 |
| 시험 | `services/core-svc/test-int/roles.ts` | 역할 목록에 `core_notify` |
| 시험 | database 갈래로 `AppModule.register`를 부르는 `test-int/*.int.test.ts` 25곳 | `notifyDatabase`를 명시(운영 조립과 같은 필수 인자) |
| 구현 | `services/core-svc/migrations/0043_core_notify_role.sql`(새), `migrations/meta/_journal.json` | 1.2·1.3 |
| 구현 | `src/main.ts` | 환경 변수·풀·시작 확인·`WebhookWorker` 저장소·종료 |
| 구현 | `src/app.module.ts`, `src/modules/notify/notify.module.ts` | `notifyDatabase` 필수, `NOTIFY_APP_STORE` 주입 |
| 구현 | `src/modules/catalog/adapters/db/database-role.ts` | `ServiceDbRole`에 `core_notify` |
| 구현 | `src/modules/notify/adapters/db/drizzle-webhook-store.ts` 1~4행 주석 | 발송기 연결이 `core_notify`임을 적는다 |
| 구현 | `tools/local/demo-objects.mjs` | `core_notify_login`·`coreNotify`·`demo-core` 비밀 |
| 구현 | `docs/security/authz-matrix.md` §5.3, `docs/features/notify.md` §13, `docs/data.md` `webhook_endpoint.disabled_reason` 문장 | 정본 문장 |
| 리뷰 | 이 계획 `## 리뷰` | RV-01… |
| 검증 | 이 계획 `## 검증` | 표본·명령·결과 |
| 기록 | 이 계획, `docs/review/consistency-review.md`, `docs/00-summary.md`, WBS, `docs/lanes/lane3.md` | R-757 |

- 구현 커밋은 시험 파일을 바꾸지 않는다. 시험 커밋은 제품 코드를 바꾸지 않는다(§8.6 '바꾸는 파일').
- 바꾸지 않는 것: 적용된 마이그레이션(0004·0015·0016·0042), `schema.ts`, `packages/platform`, 파트너·관제·검색 역할의 권한, 계약·생성물·화면, ADR-0241·0338.

## 8. 시험 목록(AZ-T19, 시험 담당)

- **준비**: 실제 PostgreSQL 18 컨테이너(`startPostgres`)에 `migrateCore`, `admin`(슈퍼유저)으로 시드. `loginFor(admin, pg, 'core_notify_login', 'core_notify', …)`로 운영과 같은 그룹 역할의 로그인 사용자를 만든다. 시드는 `admin`으로 넣어 행 보안·권한을 지난다. 42501은 `rejects.toMatchObject({ cause: { code: '42501' } })` 꼴로 본다.
- **시험 값**: 판매자 A·B, 끝점 A1(A, 켜짐)·A2(A, 꺼짐 `PARTNER`)·B1(B, 켜짐)·E(B, 켜짐, 옛 비밀 유효)·F(B, 꺼짐), 원장 행 P1(E, `PENDING`, 지금)·P2(E, `PENDING`, 미래)·D1(E, `DEAD`, 5일 창 안)·S1(E, `SUCCEEDED`, 어제). 서명 시험은 `node:crypto` HMAC으로 따로 만든다.

| 시험 이름 | 단언 | 구현 전 트리 |
| --- | --- | --- |
| `AZ-T19 ① 발송기 역할 core_notify는 끝점 읽기·끄기와 발송 원장 넣기·집기·저장·세기·마지막 성공을 할 수 있다 [ASVS v5.0.0-8.4.1]` | `new DrizzleWebhookStore(notifyDb)`로: `listActiveEndpoints(B)`가 E·B1만, `findEndpointById(E)`가 비밀·옛 비밀 포함, `insertDeliveries` 1행, `listDueDeliveries(NOW)`가 P1만 집고 `lease_until`이 NOW+2분, `saveDelivery`로 SUCCEEDED·finishedAt, `countDeadSince(E, NOW-5일)`이 D1 하나, `lastSuccessAt(E)`이 그 finishedAt, `disableEndpoint(A1)` 뒤 A1이 `DISABLED`·`FAILING`·판 2. `admin`으로 본 행 값이 모두 기대와 같다 | 실패(첫 `loginFor`의 `GRANT core_notify`가 42704) |
| `AZ-T19 ② core_notify는 webhook_endpoint·webhook_delivery 밖의 표를 읽거나 쓰지 못한다 [ASVS v5.0.0-8.4.1]` | `product`·`merch_order`·`production`·`outbox`·`attendee_export_audit`마다 SELECT·INSERT·UPDATE·DELETE가 42501. `webhook_endpoint`·`webhook_delivery`의 DELETE·TRUNCATE도 42501 | 실패(역할 없음) |
| `AZ-T19 ③ core_notify는 webhook_endpoint의 비밀·주소·구독·판매자·끝점 ID를 고치지 못하고 켜진 끝점을 FAILING으로 끄는 세 칸만 고친다 [ASVS v5.0.0-8.4.1] [ASVS v5.0.0-8.2.3]` | A1에 `secret`·`url`·`previous_secret`·`event_types`·`promoter_id`·`id`를 각각 SET → 42501. A1에 `status='DISABLED', disabled_reason='FAILING', version=version+1` → 1행, A1이 `DISABLED`·`FAILING`·판 2. A2 다시 켜기 → 0행, A2 그대로. A1이 이미 꺼진 뒤 사유를 `PARTNER`로 → 0행(USING 밖) | 실패(역할 없음) |
| `AZ-T19 ④ 운영 시작 파일은 PEAKET_NOTIFY_DATABASE_URL이 없거나 core_notify가 아닌 로그인으로 시작하면 뜨지 않는다 [ASVS v5.0.0-8.4.1]` | `dist/main.js`를 띄운다. (가) `PEAKET_NOTIFY_DATABASE_URL` 없음 → 종료 코드 1, `PEAKET_NOTIFY_DATABASE_URL이 없다` (나) `core_app_login` 주소 → 종료 코드 1, `core_notify 역할이 아니다` (다) 슈퍼유저 주소 → 종료 코드 1, `core_notify로 접속해야 한다` (라) `core_notify_login` 주소 → 30초 안에 뜨고 죽이면 `stillRunning` | 실패(가~다는 그대로 뜨고, 라는 시작 확인이 없다) |
| `AZ-T19 ⑤ core_notify는 끝난 발송 원장 행을 되돌리거나 본문·식별 칸을 고치지 못한다 [ASVS v5.0.0-8.4.1]` | `payload`·`endpoint_id`·`webhook_id`·`event_type`·`created_at` 고치기 → 42501. D1(`DEAD`)을 `PENDING`으로 → 0행. S1(`SUCCEEDED`)을 `RETRYING`으로 → 0행. P1(`PENDING`)을 `DEAD`·`finished_at`으로 → 1행 | 실패(역할 없음) |
| `AZ-T19 ⑥ core_notify는 끝점을 넣거나 두 표의 행을 지우지 못한다 [ASVS v5.0.0-8.4.1]` | `webhook_endpoint` INSERT → 42501. 두 표 DELETE → 42501. `TRUNCATE webhook_delivery` → 42501 | 실패(역할 없음) |
| `AZ-T19 ⑦ core_notify 역할·정책·칸 권한이 ADR-0350 결정 1·3과 같고 표 소유자가 아니며 FORCE가 없다 [ASVS v5.0.0-8.4.1]` | `pg_roles`: `rolcanlogin` 거짓·`rolsuper` 거짓·`rolbypassrls` 거짓. `pg_class`: 두 표 `relrowsecurity` 참·`relforcerowsecurity` 거짓, 소유자가 `core_notify`·로그인 사용자 아님. `pg_policies` 이름·명령·역할·`qual`·`with_check`가 1.2와 같다. `has_table_privilege`·`has_column_privilege`로 끝점 UPDATE는 표 거짓·세 칸 참·나머지 거짓, 원장 UPDATE는 표 거짓·일곱 칸 참·`payload` 등 거짓, 원장 INSERT·SELECT 참, 두 표 DELETE 거짓. `pg_has_role('core_notify','core_app','member')` 거짓 | 실패(역할 없음) |
| `AZ-T19 ⑧ 실제 발송기를 core_notify 저장소로 돌리면 구독한 끝점에 서명해 보내고 성공을 원장에 남긴다 [ASVS v5.0.0-8.4.1]` | `WebhookDispatcher({ store: new DrizzleWebhookStore(notifyDb), transport: <200 받는 가짜>, clock })`로 `enqueue({promoterId:B, eventType:'order.confirmed', …})` → 수신기가 E에 1건, `webhook-signature`가 시험에서 만든 HMAC과 같다. `processDue(NOW)` → `{attempted:1, succeeded:1}`, `admin`으로 그 행이 `SUCCEEDED`·`finished_at=NOW` | 실패(역할 없음) |

- **회귀(게이트에서 돈다)**: `test-int/startup-db-role.int`, `test-int/shop-notify.int`, `test-int/webhook-lease.int`, `test-int/webhook-lease-concurrent.int`, `test-int/webhook-merch-grants.int`(AZ-T18 ③은 이 묶음 뒤에도 `core_app`으로 돌아 통과해야 한다), `test/webhook-dispatcher.test.ts`, `test/migrations-journal.test.ts`, `node --test tools/local/demo-objects.test.mjs`.
- `core_app`이 이 묶음 뒤에도 두 표를 쓸 수 있는 것은 **알려진 위험**이며 시험하지 않는다(§1.4). 다음 배포의 회수 시험이 그때 `core_app`의 42501을 본다.

## 실패 확인

시험 커밋을 구현 커밋 위에 쌓지 않은 트리(0043 없음)에서 실제 PostgreSQL 18 컨테이너로 보았다. Docker 차례는 `C:\Program Files\Git\bin\bash.exe /d/ticketpass-locks/lock.sh take docker lane3-W12-core-notify`로 잡았다(2026-11-22 10:42, 잡은 뒤 유지).

```bash
corepack pnpm exec turbo run build --filter=@peaket/core-svc^...   # platform dist가 낡아 dist/main.js 빌드가 먼저 실패했으므로 의존 패키지를 빌드했다
PEAKET_TEST_CONTAINER_PREFIX=lane3-w12corenotify corepack pnpm --filter @peaket/core-svc test:integration test-int/notify-role.int.test.ts test-int/startup-db-role.int.test.ts
```

- `notify-role.int.test.ts`: 파일 실패(7개 모두 skip). `beforeAll`의 `loginFor(admin, pg, 'core_notify_login', 'core_notify', 2)`가 `CREATE USER ... GRANT core_notify TO core_notify_login`에서 `role "core_notify" does not exist`(SQLSTATE 42704)로 멈췄다. 역할이 없으니 저장소 시험은 실행 전에 실패한다.
- `startup-db-role.int.test.ts`: AZ-T5가 실패했다. 새로 더한 `PEAKET_NOTIFY_DATABASE_URL` 경우만 슈퍼유저 주소로 바꿔도 시작 확인이 없어 프로세스가 30초 동안 떠 있었고(`code: null`, `stillRunning: true`), 기대는 `code: 1`·`refusedFor: core_notify`였다. AZ-T19 ④는 `expect(notifyUrl).toBeDefined()`에서 5ms 만에 실패했다(`role core_notify가 없어 로그인을 만들지 못했다`).
- 합계: 2파일 9시험 가운데 2실패·7skip. 실패는 모두 '역할·연결·시작 확인이 아직 없다'는 같은 까닭이다.
- 이 실패를 본 표본: ①~⑧ 전부가 구현 전 트리에서 실행되지 못한다. 구현이 역할·연결을 넣은 뒤에는 ①~⑧이 실제 단언으로 돈다.

## 9. 틀린 구현 표본(검증 담당)

기준선은 구현 뒤 트리에서 `notify-role.int`·`startup-db-role.int` 통과. 표본마다 하나만 넣고 돌린 뒤 `git checkout -- <파일>`. 0043을 바꾸는 표본은 통합 시험이 파일마다 새 컨테이너에 마이그레이션을 다시 올리므로 그대로 걸린다.

| # | 항목 | 넣을 곳 | 틀린 구현 | 잡아야 할 시험 |
| --- | --- | --- | --- | --- |
| M1 | ③ | 0043 | `core_notify`의 끝점 UPDATE를 표 단위로 준다 | ③(비밀·주소 고치기가 됨), ⑦ |
| M2 | ③ | 0043 | `webhook_endpoint_notify_disable`의 USING을 `true`로 | ③(A2 다시 켜기가 1행), ⑦ |
| M3 | ③ | 0043 | WITH CHECK에서 사유 조건을 뺀다 | ③(사유 `PARTNER`로 끄기가 됨), ⑦ |
| M4 | ⑤ | 0043 | 원장 UPDATE 칸에 `payload`를 더한다 | ⑤(본문 고치기가 됨), ⑦ |
| M5 | ⑤ | 0043 | `webhook_delivery_notify_update`의 USING을 `true`로 | ⑤(D1·S1 되돌리기가 1행), ⑦ |
| M6 | ② | 0043 | `GRANT SELECT ON ALL TABLES IN SCHEMA public TO core_notify`를 더한다 | ②(product 읽기가 됨), ⑦ |
| M7 | ④ | `src/main.ts` | `notifyUrl`이 없으면 `url`(PEAKET_DATABASE_URL)로 되돌린다 | ④가(그대로 뜸) |
| M8 | ④ | `src/main.ts` | `assertDatabaseRole(notifyDatabase, 'core_notify')`를 뺀다 | ④나·다(다른 역할·슈퍼유저로 뜸) |
| M9 | ① | `src/modules/notify/notify.module.ts` | `NOTIFY_APP_STORE`를 `DATABASE`(팬 경로 풀)로 만든다 | ①(발송기 저장소가 core_app이라 통과?) → ⑧은 통과하므로 ④·⑦로 본다. 이 표본은 `main.ts`의 `WebhookWorker`가 `notifyDatabase`를 쓰는지도 함께 본다 |
| M10 | ⑦ | 0043 | `core_notify`를 `BYPASSRLS`로 만든다 | ⑦만 |

- 항목마다 수: ① 1, ② 1, ③ 3, ④ 2, ⑤ 2, ⑥ 0, ⑦ 1. ⑥은 DELETE·TRUNCATE 권한을 주는 표본(M11: `GRANT DELETE ON webhook_delivery TO core_notify`)을 더해 1개로 센다.
- '검증' 절에 적을 것: 표본마다 실패한 시험, 놓친 표본과 시험 담당에게 넘긴 것, AZ-T19 ①~⑧ 판정 기준과 단언의 대조 전수.

## 10. 게이트 명령과 닿는 CI 잡

```bash
cd /d/ticketpass-lane3
pnpm exec turbo run build --filter=@peaket/core-svc^...
pnpm --filter @peaket/core-svc typecheck
pnpm --filter @peaket/core-svc test
PEAKET_TEST_REPORT=test-report-int.json pnpm --filter @peaket/core-svc test:integration test-int/notify-role.int.test.ts test-int/startup-db-role.int.test.ts test-int/shop-notify.int.test.ts test-int/webhook-merch-grants.int.test.ts
pnpm --filter @peaket/core-svc exec node --test ../../tools/local/demo-objects.test.mjs
pnpm lint
python -I -X utf8 tools/doc-check/check_all.py
node tools/ci/trace-check.mjs --ids "AZ-T19" --report services/core-svc/test-report-int.json
node tools/ci/ledger.mjs --batch W12-core-notify --require
node tools/ci/records.mjs --check
node tools/ci/roles-check.mjs --base origin/develop --head HEAD
```

| 잡 | 왜 |
| --- | --- |
| `ci.yml` → `ci-node.yml` / node | core-svc typecheck·단위·통합 시험 |
| `docs-check` | ADR-0350·authz-matrix·data.md·notify.md·이 계획 |
| `lint-guard` | core-svc 어댑터 층 주석·배포 값 |
| `tools-check` | `tools/local/demo-objects.test.mjs` |

- spec-check: `specs/specs.json`이 바꾸는 문서를 가리키지 않아 해당 없음.
- 장부: BUILD_ORDER 묶음 줄을 이 계획 커밋에서 더하고, `ledger --batch W12-core-notify --require`로 AZ-T19 ①~⑧이 모두 '자동 시험'인지 본다.
- Docker가 막히면 초안 PR CI로 같은 파일을 돌린다(ADR-0283 결정 3). 이 묶음은 Docker 잠금을 잡고 한다.

## 11. 자주 놓친 결함 가운데 해당하는 것

- 정확한 값까지: ①은 집은 행·임대 시각·바뀐 행의 모든 칸, ⑧은 서명 문자열·보낸 건수·원장 상태.
- 경계·세 상태: 끝점 `ACTIVE`·`DISABLED/PARTNER`·`DISABLED/FAILING`, 원장 `PENDING`·`RETRYING`·`SUCCEEDED`·`DEAD`. ⑤는 끝난 두 상태를 되돌리는 경우를 모두 본다.
- 겹친 가드 하나씩: 칸 권한과 정책(③은 허용 세 칸과 함께, ⑤는 허용 칸만), `INSERT` 권한과 `INSERT` 정책(⑥은 넣기 금지, ①은 넣기 허용), 역할과 시작 확인(④).
- 목록 밖 값마다: ③ 끝점 칸마다, ⑤ 원장 칸마다, ② 표마다.
- 부르는 쪽이 결과를 쓰는지: ⑧은 실제 발송기를 돌려 수신기가 받은 요청과 원장 값을 함께 본다.
- 시험 값은 코드 기본값과 다르게(판 2·3, 임대 2분, 5일 창, HMAC 비밀 `whsec_seed_e`).

## 12. 범위 밖과 넘기는 것

- **다음 배포/다음 묶음**: `core_app`의 `webhook_endpoint`·`webhook_delivery` 읽기, 끝점 세 칸 고치기, 원장 넣기·고치기, 정책 넷 회수. 그때 AZ-T19 ⑨(또는 새 시험)로 `core_app`의 42501과 0042의 `webhook_endpoint_app_disable` 삭제를 본다.
- **넘기는 것**: 파트너 역할의 웹훅 관리 권한, 알림 발송 작업(`notification_job`·`notification_broadcast_chunk`)의 DB 역할, 발송기 리더 선출, 발송 원장 정리 작업, 내부 입구의 인증 방식.
- **남는 위험**: 다음 배포 전까지 `core_app`이 두 표에 닿는다(§1.4). 발송기 역할 `core_notify`는 설계상 모든 끝점의 비밀을 읽는다(서명에 필요). 이는 notify.md §13의 '발송 워커의 서비스 계정만 비밀을 읽는다'와 같은 뜻이고, 이제 팬 경로 역할이 아니라 발송기 역할만 읽는다.

## 13. WBS 일 [가정]

0.6일 = 계획 0.15 + 시험 0.2(새 통합 파일·시작 확인 확장·조립 25곳) + 구현 0.15(마이그레이션·연결·주입·배포 값·정본) + 리뷰 0.05 + 검증 0.1(표본 11개) + 기록 0.05. 감독이 coord.md에 적는다.

## 리뷰

리뷰 담당(보안 관점, 다른 세션)이 채운다. RV-01부터 적고, 막는 지적은 '시험 먼저 → 구현'으로 고친다.

## 검증

검증 담당이 채운다. 게이트 명령·결과, 틀린 구현 표본 11개의 실패 시험, 놓친 표본, AZ-T19 ①~⑧ 판정 기준 대조 전수를 적는다.

## 담당 표

| 역할 | 세션 ID | 모델 | 시작 | 끝 |
| --- | --- | --- | --- | --- |
| plan | lane3-w12corenotify-plan | deepseek-v4.1-flash | 2026-11-22T10:30+09:00 | 2026-11-22T11:00+09:00 |
| test | lane3-w12corenotify-test | deepseek-v4.1-flash | 2026-11-22T11:00+09:00 | 2026-11-22T11:40+09:00 |
| impl | lane3-w12corenotify-impl | deepseek-v4.1-flash | 2026-11-22T11:40+09:00 | 2026-11-22T12:20+09:00 |
| review | lane3-w12corenotify-review | deepseek-v4.1-flash | 2026-11-22T12:20+09:00 | 2026-11-22T12:40+09:00 |
| verify | lane3-w12corenotify-verify | deepseek-v4.1-flash | 2026-11-22T12:40+09:00 | 2026-11-22T13:20+09:00 |

## 감독에게

1. **두 번 나눔의 위험**: 이 묶음은 새 길을 만들 뿐 `core_app`의 옛 권한을 거두지 않는다(§1.4). 다음 배포/묶음의 회수를 잊으면 위험이 그대로다. BUILD_ORDER 비고와 기록에 적었다.
2. **CI env**: 통합 시험은 컨테이너를 새로 띄우고 `test-int/roles.ts`가 로그인 사용자를 만들므로 CI에 `PEAKET_NOTIFY_DATABASE_URL`을 넣지 않는다. 운영·데모만 비밀 관리에서 넣는다. 운영 Secret 키 추가는 배포 묶음(BAS-060) 몫이다.
3. **Docker 잠금**: `lock.sh`는 Git bash로 실행해야 한다(W12-purchase-fixes 계획 §감독에게 1과 같은 이유). 이 묶음은 `C:\Program Files\Git\bin\bash.exe`로 잡았다.
