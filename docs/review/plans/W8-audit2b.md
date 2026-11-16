# 묶음 계획: W8-audit2b(갈래 3, 감사 잔여 둘째 몫 ② — 소유자 결정 OPEN[43], ADR-0278)

**웨이브 9, 감독 배정 2026-11-16.** 이 파일은 웨이브 8에 미리 쓴 계획이다. 웨이브 9를 시작할 때 계획 담당이 그때의 출발점(develop)에서 손댈 파일·번호·닿는 곳을 다시 보고, 아래 §0 '웨이브 9 계획 커밋에서 할 일'을 한 뒤 시험 담당에게 넘긴다.

- **무엇**: 웨이브 7 W7-audit가 소유자 결정으로 남긴 셋 가운데 OPEN[43](파트너 예매자 명단 보기·내려받기 접속기록을 ops-svc 감사 저장소 `admin_data_access`로 사건을 보내 옮김)의 작업 목록이다(docs/architecture.md §8.6 4의 1, ADR-0270 결정 1·2). OPEN[42]·[44]는 [W8-audit2a](W8-audit2a.md)(웨이브 8)다. 검토 기록이고 규범이 아니다. 정본과 다르면 정본이 이긴다.
- **바탕**: 2026-11-16 작업 폴더 `D:/ticketpass-lane3-w8b`, 가지 `wave/lane3-w8-audit2`, 출발점 `origin/develop` `c3b0935c`에서 썼다. 이 묶음의 정본(사건 계약·data.md·settlement·control-tower·ASVS 등)은 W8-audit2a 계획 커밋이 미리 고쳤다(W8-audit2a §0.1 '2b 몫'). BUILD_ORDER 묶음 표에는 넣지 않고 `docs/lanes/lane3.md`와 계획 파일로 간다(감독 결정 2026-11-16).
- **등급**: B(개인정보·법정 의무 — 접속기록 보호·점검). 틀린 구현 표본에 접속기록 항목을 꼭 넣는다(아래 §3).
- **근거로 읽은 것**: 지시서 `brief-W8-audit2.md`·`brief-W8-common.md`, docs/review/plans/W7-audit.md §2·§5·§7, docs/review/measurements/W7-lane3-review-security.md S1·S3·S4, 커밋 `c3b0935c` 본문, 아래 '손댈 파일'의 기존 코드(core-svc export·relay.ts·0001·0004·0019·0021, ops-svc audit·consumers·0000·0005·0012, platform outbox).

## 계획

### 0. 범위·크기·차례

- WBS 3일 [가정](계약·core 1일, ops 표·소비자·체인 1.25일, 시험 0.75일). 웨이브 9에서 W8-audit2a 뒤에 한다.
- **마이그레이션(감독 배정 2026-11-16)**: core-svc **0027**(파일 이름 예 `0027_outbox_partner_grant.sql`, `core_partner`에 `outbox` 넣기와 `outbox_seq` 사용), ops-svc **0015**(파일 이름 예 `0015_admin_data_access.sql`, 새 표). 다음 출시 몫(이 묶음 아님, 정본에만 적음): core `attendee_export_audit` 지우기(docs/data.md §2).
- **ADR**: [ADR-0278](../../adr/0278-withdrawn-review-purge-and-partner-access-log-to-ops-audit.md) 결정 3~5.
- **다른 갈래와 닿는 곳**:
  - ops-svc 감사 저장소(`src/modules/audit`, `audit_chain`·`audit_chain_head`)는 지금까지 갈래 3이 만들었다(R-552 GAT-110, BAT-465 R-568·R-584, 감사 고침 R-614). 정본 단계 OPS-270(키 건 해시 체인의 mac·체인 작업자·5분 앵커·검증 잡)은 갈래 2 몫이고 아직 하지 않았다. 이 묶음은 지금 함수 `appendAuditIn`으로 잇는다. 옮길 문장은 §4다.
  - ops-svc `main.ts`·`app.module.ts`·마이그레이션 0013·0014는 같은 갈래의 웨이브 8 `wave/lane3-w8`(BAT-415·BAT-420)이 고쳤다. 이 묶음은 `main.ts`를 고치지 않게 잡았다(시작 함수 안에서 둘째 소비자를 함께 건다).
  - core-svc 마이그레이션 번호는 2a의 0026 다음 0027이다.
- **웨이브 9 계획 커밋에서 할 일(감독 결정 2026-11-16)**:
  1. FR-064 매일 탐지 일(규칙 다섯, `access_review`·`access_finding`)과 월 점검 목록의 서버 몫을 새 단계 **OPS-275**로 BUILD_ORDER 갈래 2에 더한다: wbs 4.4.1 ③ [후보], 1.5일 [가정], 선행 OPS-270·W8-audit2b, 갈래 2. 읽을 면은 이 묶음의 `AdminDataAccessStore.between`이다.
  2. 그 단계를 담는 새 묶음 **BAT-357**(갈래 2, 구간 3, B)을 BUILD_ORDER 묶음 표에 더한다.
  3. 두 줄·행은 그 계획 커밋에서 감독에게 문안을 보이고 더한다(다른 갈래의 줄이다). 웨이브 8에는 이 파일에 할 일만 적는다.
  4. 웨이브 8 동안 정본이 바뀌었으면(특히 `docs/data.md` §2, asyncapi, settlement §9) 이 계획의 단언 값을 맞춘다.

### 0.1 공통 규칙

- 시험 이름에 정본 시험 ID와 세부 번호를 단다: `J-T26 ⑤⑥`(core, docs/features/settlement.md)과 `C-T19 ①`~`⑤`(ops, docs/features/control-tower.md §14). 정본 표의 세부 번호는 W8-audit2a 계획 커밋이 썼다.
- 단언 값은 코드 상수를 가져오지 않고 정본 값을 적는다: 접속기록 보존 끝 = 접근한 때 + 2년(달력), 토픽 `audit.data-accessed`, 그룹 `peaket.ops-svc-data-access.<환경>`.
- 판 번호·건수는 두 자리까지 넣는다. 경계는 양쪽을 둔다(기간 [시작, 끝)의 시작·끝 −1ms·끝).
- '처음부터 통과 예상'은 이미 있는 동작을 묶는 시험이다. 실패 확인 절에 그렇게 적고, 검증 담당의 틀린 구현으로 한 번은 실패를 본다(ADR-0270 결정 3).
- 공개 인터페이스가 바뀌어 **기존 시험 파일도 시험 담당이 고친다**(구현 담당은 고치지 않는다): `services/core-svc/test/export-audit.test.ts`, `test/export.test.ts`, `test/export-paging-limit.test.ts`(메모리 저장소의 `views`·`audits` → `events`), `test-int/export-audit.int.test.ts`(접속기록 행 → Outbox 행). 아래 §1의 '§0.1의 목록'은 이 목록이다.
- 계약 생성물(`packages/contracts/src/gen/asyncapi/model/dataAccessed.zod.ts`·`index.ts`)은 W8-audit2a 구현 담당이 먼저 만든다. 이 묶음은 `gen:check`로 같은지만 본다.

### 1. OPEN[43] 파트너 명단 접속기록을 ops 감사 저장소로

**무엇이 틀렸나(코드 확인)**: 명단 보기·내려받기 접속기록은 core 논리 DB 보통 표 `attendee_export_audit`(0019·0021)다. 해시 체인이 없고 FR-064 점검이 읽지 않는다(W7 리뷰 S1). ops-svc에는 정본의 `admin_data_access` 표가 아직 없고(docs/data.md 그림에만 있다), 감사 체인은 `audit_chain`·`audit_chain_head`와 트랜잭션 안 함수 `appendAuditIn`, 원본 대조 `DrizzleAuditChain.sourceMatches`(B3-H03)가 있다. core-svc에는 Outbox 릴레이 프로세스(`relay.ts`)는 있지만 Outbox에 쓰는 모듈이 아직 없고, `core_partner`에는 `outbox` 넣기 권한이 없다. ops-svc는 Kafka 소비자 하나(`ops.command-events`, 그룹 `peaket.ops-svc.<환경>`)를 이미 돌린다.

**정한 것(정본, 2026-11-16 W8-audit2a 계획 커밋에서 미리 씀)**:
- 길: core-svc export 모듈이 보기 한 페이지·내려받기 한 번마다 사건 `DataAccessed`를 core Outbox에 쓴다(토픽 `audit.data-accessed`, Kafka 키 = 행위자 계정 ID). core Outbox 릴레이가 거래·제어 클러스터로 낸다. ops-svc가 자기 그룹 `peaket.ops-svc-data-access.<환경>`으로 받아 `admin_data_access` 행과 감사 체인 기록을 **같은 ops 트랜잭션**에 쓴다(docs/api/asyncapi.yaml, docs/streaming.md §2.6, docs/data.md §2, 소유자 결정 2026-11-16 OPEN[43]).
- fail-closed: 사건을 Outbox에 쓰지 못하면 명단·파일을 주지 않는다. 보기는 Outbox 한 줄 트랜잭션, 내려받기는 `attendee_export` 이력 + Outbox를 한 트랜잭션(Outbox가 마지막 문장, ADR-0116 결정 3). 사건을 만들 칸(행위자·접속지·회차·건수 등)이 빠지거나 계약에 맞지 않으면 Outbox 전에 실패한다.
- 멱등: 사건의 `eventKey`가 `admin_data_access.id`다. 보기는 새 UUIDv7, 내려받기는 `exportId`(= `attendee_export.id`). 같은 `eventKey`·같은 내용이면 아무것도 하지 않고, 같은 `eventKey`·다른 내용이면 같은 결과일 실패로 던져 5회 뒤 보류한다(`ops.command-events`와 같다).
- 감사 체인 기록: `recordType` `ADMIN_DATA_ACCESS_RECORDED`, `recordId` = 행 ID, payload `{ rowSha256 }`(행의 정규화 JSON SHA-256). 접속지·커서 원문은 체인 `record_json`에 복사하지 않는다. 검증의 원본 대조(`sourceMatches`)가 지금 행으로 해시를 다시 계산해 견준다(추천 적용).
- 표시 이름은 사건·`admin_data_access`에 싣지 않는다(식별자는 계정 ID, 정본 그림의 칸과 같다. 추천 적용). 내려받기 이력(`attendee_export`)의 표시 이름은 그대로다.
- core `attendee_export_audit`: 이 묶음부터 쓰지 않는다. 표·권한은 이전 판(N-1)이 배포 창 동안 쓰도록 남기고, 다음 출시 마이그레이션이 지운다. 운영 전이라 옮길 행이 없다(운영 뒤라면 옮기는 일회 작업이 먼저다, docs/data.md §2).
- FR-064 점검이 읽는 면: ops `AdminDataAccessStore.between(fromMs, toMs)`([시작, 끝), `occurred_at`·`id` 순). 매일 탐지 일 자체는 이 묶음 밖이다(§0).

**사건 계약(docs/api/asyncapi.yaml `DataAccessed`, docs/api/avro/peaket/audit/DataAccessed.avsc, W8-audit2a 계획 커밋에서 미리 씀)**

| 칸 | 필수 | 뜻 |
| --- | --- | --- |
| `eventKey` | 예 | 중복 제거 키이자 `admin_data_access.id`(uuid) |
| `sourceService` | 예 | 낸 서비스(`core-svc`) |
| `actorAccountId`·`actorRole` | 예 | 관리 계정(파트너 계정 포함)과 그때의 역할 |
| `action` | 예 | `LIST`(명단 보기 한 페이지)·`DOWNLOAD`(내려받기 한 번) |
| `targetKind` | 예 | `ATTENDEE_LIST` |
| `promoterId`·`eventId` | targetKind ATTENDEE_LIST | 파트너와 회차 |
| `pageLimit` | action LIST | 받은 `limit` |
| `cursor` | 받은 커서가 있을 때만 | 받은 `cursor` 원문 |
| `reason`·`format` | action DOWNLOAD | 사유와 `CSV`·`XLSX`·`PDF` |
| `targetCount` | 예 | 보인 행 수(보기) 또는 파일 행 수(내려받기) |
| `sourceIp` | 예 | 요청의 클라이언트 IP 원문(settlement.md §9 '접속지') |
| `occurredAt` | 예 | 접근한 시각 |

- 값은 BAS-030 전까지 JSON 대역이다(`identity.accounts-withdrawn`과 같다). Avro 스키마 초안은 같은 칸으로 W8-audit2a 계획 커밋에 썼다.

**손댈 파일**

| 나눔 | 파일 |
| --- | --- |
| 계약 생성물 | `pnpm --dir D:/ticketpass-lane3-w8b/packages/contracts gen` 뒤 `packages/contracts/src/gen/asyncapi/model/dataAccessed.zod.ts`·`index.ts`(W8-audit2a 구현 담당이 먼저 다시 만든다. 2b 구현 담당은 `gen:check`로 같은지만 본다) |
| core 제품 코드 | 새 `services/core-svc/src/modules/export/domain/data-accessed.ts`(사건 만들기·검사·JSON 부호기), `…/export/domain/ports.ts`(`recordView`·`recordExport`의 뜻), `…/export/adapters/db/drizzle-export-store.ts`(Outbox, 생성자에 `Clock`), `…/export/adapters/memory-export-store.ts`(`events`), `…/export/export.module.ts`(시계 주입), `…/export/index.ts`. `…/export/adapters/db/schema.ts`의 `attendeeExportAudit`는 남기되 쓰지 않는다 |
| core 마이그레이션 | 새 `services/core-svc/migrations/0027_outbox_partner_grant.sql`(감독 배정): `GRANT INSERT ON "outbox" TO core_partner; GRANT USAGE ON SEQUENCE "outbox_seq" TO core_partner;`(읽기·고치기·지우기는 주지 않는다). 스키마가 바뀌지 않아 스냅숏은 앞 번호와 같다(0022처럼) |
| ops 제품 코드 | 새 `services/ops-svc/src/modules/audit/data-access.ts`(행 모양·해시·보존 끝·저장소), `…/audit/checkpoint.ts`(`sourceMatches`에 `ADMIN_DATA_ACCESS_RECORDED`), `…/audit/index.ts`, 새 `services/ops-svc/src/consumers/data-access-events.ts`(처리기), `src/consumers/start.ts`(둘째 `runKeyedConsumer`), `src/consumers/index.ts`. `src/main.ts`는 고치지 않는다(시작 함수 안에서 함께 건다) |
| ops 마이그레이션 | 새 `services/ops-svc/migrations/0015_admin_data_access.sql`(감독 배정, 아래 DDL) |
| 시험 | core 새로: `test/data-accessed.test.ts`, `test-int/export-access-outbox.int.test.ts`. core 고침: §0.1의 목록. ops 새로: `test/data-access.test.ts`, `test/data-access-events.test.ts`, `test/migration-admin-data-access.test.ts`, `test-int/data-access.int.test.ts`(PostgreSQL), `test-int/data-access-consumer.int.test.ts`(Kafka + PostgreSQL, core `test-int/kafka.ts`를 본뜬 도우미 `test-int/kafka.ts`) |
| 정본(W8-audit2a 계획 커밋에서 이미 씀) | docs/api/asyncapi.yaml, docs/api/avro/peaket/audit/DataAccessed.avsc·README §1·§4·§6, docs/streaming.md §2.4·§2.6, docs/data.md 그림 `admin_data_access`·§2 '예매자 명단 내려받기 이력과 접속기록'·'관리 계정 개인정보 열람·내려받기 기록'·§6 '관리자 계정 접속 로그', docs/features/settlement.md §9·J-T26 ⑤⑥, docs/features/control-tower.md §7·C-T19, docs/security/data-classification.md '관리자 시스템 접속기록', docs/security/internal-management-plan.md §4.5, docs/security/asvs/settlement.md v5.0.0-16.2.1·16.4.2 |

**공개 인터페이스(core)**

```ts
// services/core-svc/src/modules/export/domain/data-accessed.ts(새)
export const DATA_ACCESSED_TOPIC = 'audit.data-accessed';
/** 계약 asyncapi DataAccessed와 같은 칸(생성 Zod로 검사한다) */
export interface DataAccessedEvent { eventKey: string; sourceService: 'core-svc'; actorAccountId: string; actorRole: string; action: 'LIST' | 'DOWNLOAD'; targetKind: 'ATTENDEE_LIST'; promoterId: string; eventId: string; pageLimit?: number; cursor?: string; reason?: string; format?: 'CSV' | 'XLSX' | 'PDF'; targetCount: number; sourceIp: string; occurredAt: string }
/** @throws Error 칸이 빠졌거나(빈 문자열 포함) 계약 Zod에 맞지 않거나 sourceIp가 IP 모양이 아니면. 오류 글에 값을 싣지 않는다 */
export function listAccessEvent(view: AttendeeViewRecord): DataAccessedEvent;      // eventKey = view.auditId, pageLimit = filter.limit, cursor는 있을 때만
export function downloadAccessEvent(record: AttendeeExportRecord, access: { clientIp: string }): DataAccessedEvent; // eventKey = exportId
/** JSON 대역(Avro는 BAS-030). Outbox payload 바이트 */
export const jsonDataAccessedCodec: { encode(e: DataAccessedEvent): Uint8Array };

// services/core-svc/src/modules/export/domain/ports.ts(모양 그대로, 뜻이 바뀜)
export interface AttendeeExportStore {
  /** attendee_export 이력과 DOWNLOAD 사건 Outbox 행을 한 트랜잭션에 쓴다(Outbox가 마지막 문장). 하나라도 실패하면 둘 다 없고 오류를 던진다 */
  recordExport(record: AttendeeExportRecord, access: { clientIp: string }): Promise<void>;
  /** LIST 사건 Outbox 행 하나. 실패하면 오류를 던진다 */
  recordView(view: AttendeeViewRecord): Promise<void>;
  list(promoterId: string, eventId: string, limit: number): Promise<AttendeeExportRecord[]>; // 그대로
}

// services/core-svc/src/modules/export/adapters/db/drizzle-export-store.ts
export class DrizzleAttendeeExportStore { constructor(db: Database, clock: Clock) }
// recordView: db.transaction(tx => writeOutbox(tx, clock, [{ topic: DATA_ACCESSED_TOPIC, key: actorAccountId, payload: encode(listAccessEvent(view)) }]), { tenantId: promoterId, accessMode: 'read write' })
// recordExport: 같은 옵션의 한 트랜잭션에서 attendee_export 넣기 → writeOutbox(DOWNLOAD). attendee_export_audit에는 쓰지 않는다
// 사건 만들기(검사)는 트랜잭션을 열기 전에 한다(빠진 칸이면 DB를 건드리지 않는다)

// services/core-svc/src/modules/export/adapters/memory-export-store.ts
export class MemoryAttendeeExportStore {
  readonly rows: AttendeeExportRecord[];                                  // 이력(그대로)
  readonly events: { topic: string; key: string; value: DataAccessedEvent }[]; // Outbox 대역. views·audits는 지운다
  failNextEvent?: Error;                                                   // 시험이 Outbox 실패를 흉내 낸다(이력도 남지 않는다)
}
```

- `AttendeeExports.listAttendees`·`create`의 차례·오류(행위자·접속지 먼저 확인, 404·410·403은 기록 없음, 기록 실패면 명단·파일 없음)는 W7-audit A2-19 그대로다.

**공개 인터페이스(ops)**

```ts
// services/ops-svc/src/modules/audit/data-access.ts(새)
export const ADMIN_DATA_ACCESS_RECORD_TYPE = 'ADMIN_DATA_ACCESS_RECORDED';
export interface AdminDataAccessRow {
  id: string; adminAccountId: string; actorRole: string; promoterId: string | null;
  action: 'LIST' | 'DOWNLOAD' | 'VIEW_UNMASKED' | 'DATA_EXPORT'; targetKind: 'ATTENDEE_LIST' | 'SHIPPING_LIST' | 'FAN_PROFILE' | 'DATA_REQUEST';
  eventId: string | null; filter: Record<string, unknown>; occurredAtMs: number; reason: string | null; targetCount: number;
  format: 'CSV' | 'XLSX' | 'PDF' | null; sourceIp: string; sourceService: string; recordedAtMs: number; retainUntilMs: number;
}
/** 사건 → 행. filter는 LIST면 { limit, cursor? }, DOWNLOAD면 {}. @throws RangeError 계약·모양 규칙(LIST는 reason·format 없음, DOWNLOAD는 둘 다 있음, ATTENDEE_LIST는 promoterId·eventId 있음, sourceIp는 IP)에 맞지 않으면 */
export function adminDataAccessRowOf(e: DataAccessed, nowMs: number): AdminDataAccessRow;
/** 만든 때 + 2년(UTC 달력, 2월 29일 → 3월 1일). core accessLogRetainUntil과 같은 규칙 */
export function accessLogRetainUntil(occurredAtMs: number): number;
/** 행의 정규화 JSON(키 정렬, 시각은 ISO) SHA-256 16진 */
export function adminDataAccessRowSha256(row: AdminDataAccessRow): string;
export interface AdminDataAccessStore {
  /** 행 넣기와 appendAuditIn을 한 트랜잭션에. 같은 id·같은 내용이면 'duplicate'(체인에 더하지 않는다), 같은 id·다른 내용이면 'conflict'(아무것도 쓰지 않는다) */
  record(row: AdminDataAccessRow): Promise<'recorded' | 'duplicate' | 'conflict'>;
  /** FR-064 매일 탐지·월 정기 점검이 읽는 면. occurred_at이 [fromMs, toMs)인 행, occurred_at·id 순 */
  between(fromMs: number, toMs: number): Promise<readonly AdminDataAccessRow[]>;
}
export class DrizzleAdminDataAccessStore implements AdminDataAccessStore { constructor(database: Database) }
export class MemoryAdminDataAccessStore implements AdminDataAccessStore { constructor(chain: MemoryAuditChain); readonly rows: AdminDataAccessRow[] }

// services/ops-svc/src/consumers/data-access-events.ts(새)
export const DATA_ACCESSED_TOPIC = 'audit.data-accessed';
export type DataAccessRecord = { kind: 'event'; event: DataAccessed } | { kind: 'bad'; key: string; error: string };
export class DataAccessEventsHandler implements KeyedHandler<DataAccessRecord> {
  constructor(store: AdminDataAccessStore, clock: Clock);
  decode(m: ConsumedMessage): DataAccessRecord;   // 값 없음·JSON 아님·계약 Zod 실패는 'bad'(키 bad:<토픽>:<Kafka 키>)
  keyOf(e): string;                                // eventKey(bad면 그 키)
  eventKeyOf(e): string | undefined;               // eventKey
  /** @throws RangeError bad, adminDataAccessRowOf 실패, record가 'conflict' → 5회 뒤 보류. 'duplicate'는 성공 */
  handle(e: DataAccessRecord): Promise<void>;
}

// services/ops-svc/src/consumers/start.ts
export const OPS_DATA_ACCESS_GROUP = (env: string): string => `peaket.ops-svc-data-access.${env}`;
// startOpsConsumers: 지금 소비자에 더해 둘째 runKeyedConsumer(groupId OPS_DATA_ACCESS_GROUP, topics [DATA_ACCESSED_TOPIC], clientId `${clientId}-data-access`, handler DataAccessEventsHandler(new DrizzleAdminDataAccessStore(database)), held 같은 held_event)를 켠다. started는 둘 다, stop은 둘 다

// services/ops-svc/src/modules/audit/checkpoint.ts
// DrizzleAuditChain.sourceMatches: case ADMIN_DATA_ACCESS_RECORDED → admin_data_access에서 id 행을 읽어 adminDataAccessRowSha256(행) === payload.rowSha256
```

**ops 마이그레이션(DDL, ops-svc 0015)**

```sql
CREATE TABLE admin_data_access (
  id uuid PRIMARY KEY,                 -- 사건 eventKey
  admin_account_id uuid NOT NULL,
  actor_role text NOT NULL,
  promoter_id uuid,
  action text NOT NULL,
  target_kind text NOT NULL,
  event_id uuid,
  filter jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL,
  reason text,
  target_count integer NOT NULL,
  format text,
  source_ip inet NOT NULL,
  source_service text NOT NULL,
  recorded_at timestamptz NOT NULL,
  retain_until timestamptz NOT NULL,
  CONSTRAINT admin_data_access_action_check CHECK (action IN ('LIST', 'DOWNLOAD', 'VIEW_UNMASKED', 'DATA_EXPORT')),
  CONSTRAINT admin_data_access_target_kind_check CHECK (target_kind IN ('ATTENDEE_LIST', 'SHIPPING_LIST', 'FAN_PROFILE', 'DATA_REQUEST')),
  CONSTRAINT admin_data_access_format_check CHECK (format IS NULL OR format IN ('CSV', 'XLSX', 'PDF')),
  CONSTRAINT admin_data_access_count_check CHECK (target_count >= 0),
  CONSTRAINT admin_data_access_shape_check CHECK (
    (action = 'LIST' AND reason IS NULL AND format IS NULL) OR
    (action = 'DOWNLOAD' AND reason IS NOT NULL AND format IS NOT NULL) OR
    action IN ('VIEW_UNMASKED', 'DATA_EXPORT')),
  CONSTRAINT admin_data_access_attendee_check CHECK (target_kind <> 'ATTENDEE_LIST' OR (event_id IS NOT NULL AND promoter_id IS NOT NULL))
);
CREATE INDEX admin_data_access_occurred_idx ON admin_data_access (occurred_at, id);
CREATE INDEX admin_data_access_account_idx ON admin_data_access (admin_account_id, occurred_at);
```

- ops 논리 DB는 지금 역할을 나누지 않는다(마이그레이션에 GRANT가 없다). 표 주인이 행을 고칠 수 있는 것은 그대로이고, 고친 것은 체인 검증의 원본 대조가 찾는다. 역할 나누기는 OPS-270 몫이다.

**시험 목록(2b)**

| 시험 이름 | 단계 | 단언(정본 값) | 비고 |
| --- | --- | --- | --- |
| `J-T26 ⑤ 명단 보기는 LIST 사건 하나를 Outbox에 쓴다` | 단위 | 메모리 저장소 `events` 한 줄: `topic` `audit.data-accessed`, `key` = 행위자 계정 ID, 값 칸 모두 정확히(`eventKey` = UUIDv7, `sourceService` `core-svc`, `action` LIST, `targetKind` ATTENDEE_LIST, `promoterId`·`eventId`, `actorRole` `partner_admin`, `pageLimit` 50, 커서 없음 → `cursor` 키 없음, 커서 `'c1'`로 다시 → `'c1'`, `targetCount` 2, `sourceIp` `'203.0.113.7'`, `occurredAt` = 가짜 시계). 값에 표시 이름 글자가 없다 | 기존 A2-19 ⑤ 시험 고침 |
| `J-T26 ⑤ 사건을 쓰지 못하면 명단을 돌려주지 않는다` | 단위 | `failNextEvent` → `listAttendees`가 같은 오류로 거절, `events` 0 | fail-closed |
| `J-T26 ⑤ 사건 칸이 빠지면 Outbox를 건드리지 않고 실패한다` | 단위 | `listAccessEvent`/`downloadAccessEvent`에 행위자 계정 ''·역할 ''·회차 없음·`sourceIp` `'abc'`·`targetCount` −1·DOWNLOAD 사유 '' 각각 throw(글에 값 없음). Drizzle 대역 `transaction` 호출 0 | 빠진 칸 거절 |
| `J-T26 ⑥ 내려받기는 이력과 DOWNLOAD 사건을 한 트랜잭션에 쓴다` | 단위 | 가짜 `db`: `transaction` 1번, 옵션 `{ tenantId: promoterId, accessMode: 'read write' }`, 같은 `tx`로 `attendee_export` 넣기 → Outbox 넣기(마지막 문장). 사건 `eventKey` = `exportId`, `reason`·`format`·`targetCount` = 기록 값. `attendee_export_audit` 넣기가 없다 | 같은 트랜잭션·아웃박스 |
| `J-T26 ⑥ 사건 쓰기가 실패하면 이력도 남지 않고 파일을 주지 않는다` | 단위 + HTTP + 통합(core PostgreSQL) | 단위·HTTP: `failNextEvent` → `create` 거절, `rows` 0, HTTP 5xx·`content-disposition` 없음. 통합: Outbox 일 파티션이 없는 날로 가짜 시계를 옮겨 `recordExport` → 거절, `attendee_export`에 그 ID 0행, `outbox` 0행 | 실제 롤백. 끊긴 사례가 있었는지(거절 1) 단언 |
| `J-T26 ⑤⑥ core_partner로 Outbox에 넣을 수 있고 읽거나 고칠 수는 없다` | 통합(core PostgreSQL) + 단위(SQL 원문) | 원문: 두 GRANT 줄뿐. 통합: `recordView`·`recordExport`가 넣은 `outbox` 행의 `topic`·`msg_key`·JSON 값이 단위 단언과 같다. `core_partner`로 `SELECT … FROM outbox`·`UPDATE outbox`·`DELETE FROM outbox` 각각 42501. `attendee_export_audit` 새 행 0 | 최소 권한 |
| `C-T19 ① 사건 하나에 admin_data_access 행 하나와 감사 체인 기록 하나를 한 트랜잭션에 쓴다` | 단위(메모리) + 통합(ops PostgreSQL) | 행 칸 모두 정확히(`id` = eventKey, `filter` LIST `{ limit: 50, cursor: 'c1' }`·DOWNLOAD `{}`, `retain_until` = `2026-11-15T00:00:00Z` → `2028-11-15T00:00:00Z`, `2028-02-29T12:00:00Z` → `2030-03-01T12:00:00Z`, `recorded_at` = 가짜 시계), 체인 기록 `recordType` `ADMIN_DATA_ACCESS_RECORDED`·`recordId` = 행 ID·payload `{ rowSha256 }`만(체인 `record_json`에 IP 글자 없음). 통합: 체인 넣기가 실패하게(`audit_chain_head` 행을 지워 둠) 하면 행도 없다 | 같은 트랜잭션 |
| `C-T19 ② 같은 사건을 다시 받으면 행과 체인이 그대로다` | 단위 + 통합 | 둘째 `record` 'duplicate', 행 1·체인 `last_seq` 그대로. 같은 `eventKey`·`targetCount`만 다른 사건 → 'conflict', 처리기 RangeError, 행 그대로 | 멱등·다시 해도 같음 |
| `C-T19 ③ 칸이 빠지거나 모양이 틀린 사건은 쓰지 않고 보류한다` | 단위 | `decode`: 값 null·JSON 아님·`sourceIp` 없음·`action` LIST인데 `reason` 있음·DOWNLOAD인데 `format` 없음·ATTENDEE_LIST인데 `eventId` 없음 각각 'bad' 또는 `adminDataAccessRowOf` RangeError → `handle` 던짐, `record` 호출 0. 보류 오류 글에 IP·계정 ID 글자가 없다 | 빠진 칸 거절 |
| `C-T19 ④ 감사 체인이 이어지고 행을 고치면 검증이 찾는다` | 통합(ops PostgreSQL) | 명령 기록 하나 → 접근 기록 둘 → 명령 기록 하나 차례로 쓴 뒤 `prev_hash`가 앞 기록 해시와 모두 같고 체크포인트 검증 `valid` true. 접근 행 하나의 `source_ip`를 SQL로 고치면 `sourceMatches` false, 검증 `valid` false | 해시 체인 이어짐 |
| `C-T19 ⑤ 점검 읽기는 기간 안의 파트너 명단 보기·내려받기 기록을 읽는다` | 단위 + 통합 | `between(from, to)`: `occurred_at` = from(든다), to − 1ms(든다), to(안 든다), from − 1ms(안 든다). 돌려준 행에 REPEAT_DOWNLOAD·BULK_DOWNLOAD·OFF_HOURS·OUTSIDE_IP 판정에 쓰는 칸(계정, 회차, 종류, 건수, 시각, 접속지)이 있다. 0건 기간은 빈 배열 | FR-064 점검이 읽음 |
| `C-T19 ①③ 실제 Kafka 사건이 admin_data_access에 쓰이고 모양이 틀린 사건은 보류된다` | 통합(ops Kafka + PostgreSQL) | 맞는 JSON 사건 → 기다리면 행 1·체인 1, 그룹 `peaket.ops-svc-data-access.<시험 환경>`. `sourceIp` 없는 사건 → `held_event` 1(토픽 `audit.data-accessed`), 다른 사건은 계속 처리 | 네이티브 Kafka 모듈이 막히면 CI에서만 |
| `C-T19 ① 마이그레이션은 admin_data_access와 CHECK 다섯·색인 둘을 만든다` | 단위(SQL 원문) + 통합 | 원문에 표·CHECK 이름·색인 이름이 있다. 통합: LIST에 사유 23514, DOWNLOAD에 형식 없음 23514, ATTENDEE_LIST에 회차 없음 23514, `source_ip` `'abc'` 22P02, `target_count` −1 23514 | |

**틀린 구현 표본(2b, 접속기록·법정 의무)**: core ⓐ `recordView`가 Outbox 실패를 삼키고 명단을 돌려줌 ⓑ `recordExport`가 이력과 Outbox를 트랜잭션 둘로 씀 ⓒ 사건 `targetCount`에 회차 합계를 넣음 ⓓ `sourceIp`를 빼고도 낸다(빈 문자열 허용) ⓔ 아직 `attendee_export_audit`에도 씀(옛 표가 남음, 해가 없어 보여도 정본과 어긋남). ops ⓕ 행만 넣고 체인에 더하지 않음 ⓖ 체인을 행과 다른 트랜잭션에 씀 ⓗ 'duplicate'에서 체인을 또 더함 ⓘ 'conflict'를 성공으로 넘김 ⓙ `between`이 끝을 포함(`<=`)하거나 파트너 행을 거름 ⓚ `sourceMatches`가 새 기록 종류를 '해당 없음(참)'으로 둠 ⓛ 체인 payload에 행 원문(IP)을 실음 ⓜ 보존 끝을 730일로 셈.

### 2. 돌릴 통합 시험(도커 잠금 아래, 파일 거르기가 먹는 명령)

- core-svc 폴더에서: `npx vitest run --config vitest.integration.config.mjs test-int/export-access-outbox.int.test.ts test-int/export-audit.int.test.ts`
- ops-svc 폴더에서: `npx vitest run --config vitest.integration.config.mjs test-int/data-access.int.test.ts test-int/data-access-consumer.int.test.ts test-int/ops-command-audit.int.test.ts`(마지막은 체인 기존 동작 회귀. 둘째는 Kafka 컨테이너가 필요하고, 네이티브 Kafka 모듈이 막히면 CI에서만 돈다)
- 싼 게이트: `pnpm --dir …/services/core-svc test`·`typecheck`, `pnpm --dir …/services/ops-svc test`·`typecheck`, 닿는 경로 `npx eslint`, `pnpm --dir …/packages/contracts gen:check`, `node tools/ci/avro-schema.mjs`, 문서 점검, `node tools/ci/trace-check.mjs --ids "J-T26,C-T19" --report <보고서>`.

### 3. 틀린 구현 표본(B등급, 20개)

§1의 ⓐ~ⓜ(13개)에 아래 일곱을 더한다. 꼭 넣는 것(개인정보·법정 의무): ⓐⓑⓓⓕⓖⓚ, 아래 ⓢⓣ.

- ⓝ ops 소비자를 명령 사건과 같은 그룹 `peaket.ops-svc.<환경>`으로 건다(정본 그룹 이름과 다름).
- ⓞ ops 처리기의 업무 키를 계정 ID로 둔다(보류된 사건 하나가 같은 사람의 뒤 기록을 막는다).
- ⓟ core `recordView`가 테넌트 옵션(`tenantId`) 없이 트랜잭션을 연다.
- ⓠ 사건 만들기(검사)를 트랜잭션 안 Outbox 직전에 해, 칸이 빠진 내려받기에서 이력 넣기까지 간 뒤 실패한다(되돌리기는 되지만 '트랜잭션을 열기 전에 실패' 규칙과 다름).
- ⓡ core 마이그레이션이 `core_partner`에 `outbox` 읽기(`SELECT`)도 준다.
- ⓢ ops `retain_until`을 `recorded_at`(받은 시각) 기준으로 센다.
- ⓣ `sourceMatches`가 행이 있는지만 보고 해시를 견주지 않는다.

겹친 가드(자주 놓친 결함): §1 ⓗ는 `record`의 'duplicate'와 처리기의 `eventKey` 거르기가 겹친다. 하나씩 빼 본다.

### 4. 감독에게 넘길 것

- **OPS-270(갈래 2) 줄에 덧붙일 문장(감독이 메인 감독 세션에 보낸다)**: "W8-audit2b가 넘긴 것(2026-11-16, ADR-0278): ops 감사 체인 기록 종류 `ADMIN_DATA_ACCESS_RECORDED`(파트너 명단 접속기록, payload는 행 해시)도 mac·체인 작업자·검증 잡·원본 대조 대상이다. `admin_data_access` 표를 고칠 수 있는 역할을 나눈다(지금 ops DB는 역할 하나)."
- **새 단계·묶음(웨이브 9 계획 커밋)**: §0 '웨이브 9 계획 커밋에서 할 일' 1·2(OPS-275, BAT-357).
- **구간 끝 정리 목록 후보(기록 담당)**: 체인에 남는 행 해시로 지운 행의 접속지를 맞춰 볼 수 있는 대입(행을 2년 뒤 지우는 일이 생길 때 솔트를 볼 것), `admin_data_access` 2년 뒤 지우는 정비 일(지금 없음, core 때와 같다), 받은 커서의 길이·모양 검사(W7-audit 리뷰 S4), 접속지 대체 지표(S3).
- **OPEN 후보**: 없다.
- **막힌 것**: 없다.

### 5. 정본 빈칸과 정한 것(W8-audit2a 계획 커밋에서 씀)

- (OPEN[43]) 사건 계약 `audit.data-accessed`/`DataAccessed`(칸·필수·키), Outbox 같은 트랜잭션, ops 그룹 이름, `admin_data_access` 칸 더함(`promoter_id`·`source_service`·`recorded_at`·`retain_until`, `action` LIST), 체인 payload는 행 해시만, 표시 이름 뺌, `attendee_export_audit`은 쓰지 않고 다음 출시에 지움, FR-064 읽기 면 [시작, 끝)(asyncapi, avro, data.md, streaming.md, settlement.md §9·J-T26, control-tower §7·C-T19, data-classification, internal-management-plan §4.5, asvs settlement, 추천 적용).
- ASVS settlement 16.2.1은 '부분 적용'(빠진 몫: 접속지 대체 지표 S3, 매일 탐지 일 없음), 16.4.2는 '부분 적용'(빠진 몫: 체인 mac·체인 작업자·역할 나누기 OPS-270). 시험 칸은 '미실행' 그대로(구현 뒤 기록 담당이 고친다).
- 결정의 까닭과 버린 대안은 ADR-0278이다.
