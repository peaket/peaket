# 묶음 계획: W7-audit(웨이브 7 갈래 3, 웨이브 6 남은 결함 넷)

- **무엇**: 웨이브 6 감사가 남긴 결함 넷(A2-17, A2-19, R-628 회귀 시험 공백, COV2-06)의 작업 목록이다(docs/architecture.md §8.6 4의 1, ADR-0270 결정 1·2). 검토 기록이고 규범이 아니다. 정본과 다르면 정본이 이긴다.
- **바탕**: 작업 폴더 `D:/ticketpass-lane3`, 가지 `wave/lane3-w7`, 출발점 `origin/develop` `982a78a8`. 2026-11-16 작성.
- **등급**: B(권한·개인정보·법정 의무 포함, 지시서). 장부는 J-T26을 원천 문서(settlement.md) 때문에 A로 보인다. 이 묶음이 닿는 J-T26 ④~⑥은 돈이 아니라 명단·접속기록이므로 B로 증명하되, 틀린 구현 표본은 항목마다 2개 이상을 둔다(아래 표본 표).
- **근거로 읽은 것**: docs/review/audit/wave6.md 93·99·106·107·111줄, findings.md 233·235~237·242줄, reports/A2.md A2-17·A2-19, reports/verification/R625V.md §5, R628V.md, COV2.md COV2-06, 커밋 `039d6c0d`·`24c6504d`·`869336c3`·`89ce5357`·`93e95ebd`, 아래 '손댈 파일'의 기존 코드.

## 계획

### 0. 공통 규칙

- 시험 이름에 결함 ID를 단다. 정본 시험 ID가 있는 항목은 세부 번호까지 단다(`J-T26 ④`). 결함 ID 뒤의 ①②…는 이 계획 안의 세부 번호다(장부는 `A2-17`·`SEC-06R`·`COV2-06`을 ID로 읽지 않는다).
- 단언 값은 코드 상수를 가져오지 않고 정본 값을 적는다(1,000행 페이지, 2년 달력, `peaket.core-svc.<환경>`, 401).
- '가져옴'은 `test/audit-core-gaps`의 `039d6c0d`(R-625 독립 시험 작성자가 쓴 재현 시험)를 시험 담당이 `cherry-pick -n` 등으로 가져와 고쳐 쓰는 시험이다. 그 시험은 지금 구현 모양에 맞춘 우회(형 변환, 배열 원천)가 있어 그대로는 쓰지 못한다. 고칠 곳을 항목마다 적었다.
- '처음부터 통과 예상'은 이미 있는 동작을 묶는 시험이다. 실패 확인 절에 그렇게 적고, 검증 담당의 틀린 구현으로 한 번은 실패를 본다(ADR-0270 결정 3).
- 공개 인터페이스가 바뀌어 **기존 시험 파일도 고쳐야 한다**(시험 담당 몫, 구현 담당은 고치지 않는다): `test/export-paging.test.ts`, `test/export-paging-limit.test.ts`, `test/export-audit.test.ts`, `test/export-attendee-source.test.ts`, `test/http-attendee-source.test.ts`, `test/export.test.ts`(81줄 원천 람다, `exportsStore.audits`), `test/export-reauth.test.ts`·`test/export-reauth-cases.test.ts`(`list: async () => []` → 페이지 모양).
- 마이그레이션 번호 0021은 이 갈래 기준이다. 다른 갈래가 core-svc에 0021을 먼저 합치면 감독이 번호를 조정한다.

### 1. A2-17 예매자 명단 짧은 페이지 절단

**무엇이 틀렸나(코드 확인)**: purchase-svc 원천(`DrizzleAttendeeReader`)은 `limit + 1` 주문을 읽고 SOLD 좌석이 없는 주문을 걸러서, 한 페이지가 `limit`보다 적거나 0건이어도 정확한 `nextCursor`를 준다(이 부분은 맞다). 그런데 core `HttpAttendeeSource.list`가 `nextCursor`를 버리고 배열만 돌려주고, `AttendeeExports.create`는 `page.length < 1_000`이면 멈추며, 같은 커서면 조용히 `break`한다. 명단 보기(`listAttendees`)도 `rows.length === limit`일 때만 커서를 다시 만든다. 그래서 짧은 페이지 하나로 나머지가 조용히 사라진다. 개발용 `DrizzleMerchOrderStore.listAttendees`의 `limit * 10`·`slice`는 A2-03 뒤 어디서도 부르지 않는 죽은 코드다.

**손댈 파일**

| 나눔 | 파일 |
| --- | --- |
| 제품 코드 | `services/core-svc/src/modules/export/domain/ports.ts`, `…/export/adapters/http-attendee-source.ts`, `…/export/application/attendee-exports.ts`, `…/export/export.module.ts`(`MerchAttendeeSource`), `…/shop/domain/merch-ports.ts`, `…/shop/adapters/db/drizzle-merch-store.ts`, `…/shop/adapters/memory-merch-store.ts` |
| 마이그레이션 | 없음 |
| 시험 | 고침: `services/core-svc/test/export-paging-limit.test.ts`(가져옴 포함), `test/export-paging.test.ts`, `test/http-attendee-source.test.ts`, `test/export-attendee-source.test.ts`, `test/export.test.ts`. 새로: `services/purchase-svc/test-int/attendee-reader.int.test.ts` |
| 정본(이 커밋) | `docs/api/guidelines.md` §3 '끝은 `nextCursor`가 null일 때뿐', `docs/features/settlement.md` §9 '예매자 명단 보기·내려받기의 원천 페이지와 접속기록'·§13 J-T26 ④ |

**공개 인터페이스**

```ts
// services/core-svc/src/modules/export/domain/ports.ts
/** 명단 원천 한 페이지. nextCursor가 null일 때만 끝이다. items가 limit보다 적거나 0건이어도 nextCursor가 있으면 다음이 있다 */
export interface AttendeeSourcePage {
  items: AttendeeRecord[];
  nextCursor: string | null;
}
export interface AttendeeSource {
  list(promoterId: string, eventId: string, limit: number, cursor?: string): Promise<AttendeeSourcePage>;
  count(promoterId: string, eventId: string): Promise<{ bookings: number; tickets: number }>; // 그대로
}
```

- `HttpAttendeeSource.list(promoterId, eventId, limit, cursor?) → Promise<AttendeeSourcePage>`: 원천의 `nextCursor`를 그대로 넘긴다. 요청 `limit`은 지금처럼 1,000으로 자른다. 오류: 응답이 2xx가 아니면 지금처럼 `Error`(`…원천이 {status}로 답했다`). 새로 응답 모양이 틀리면(`items`가 배열이 아님, `nextCursor`가 없거나 문자열·null이 아님) `Error('예매자 명단 원천 응답 모양이 틀렸다')`를 던진다(조용히 끝으로 보지 않는다).
- `MemoryMerchOrderStore.listAttendees(promoterId, eventId, limit, cursor?) → Promise<{ items: AttendeeRecord[]; nextCursor: string | null }>`: 커서 뒤 행에서 `limit`개를 주고, 그 뒤에 행이 더 있을 때만 `nextCursor = base64url(마지막 항목 orderId)`, 없으면 null. `countAttendees`는 그대로.
- `MerchOrderStore` 포트와 `DrizzleMerchOrderStore`에서 `listAttendees`·`countAttendees`를 뺀다(운영 조립은 `HttpAttendeeSource`·`UnavailableAttendeeSource`만 쓴다. 메모리 조립의 `MerchAttendeeSource`는 `MemoryMerchOrderStore`를 받는다). `limit * 10` 결함이 코드에서 사라진다.
- `AttendeeExports.create(...)`(인자·반환 그대로): 1,000행씩 부른다. 받은 `items`를 모으고, 모은 수가 500,000을 넘으면 422 `invalid-query`(지금 그대로). `nextCursor`가 null이면 멈춘다. 방금 보낸 커서와 같은 `nextCursor`가 오면 `ExportProblem('dependency-unavailable', 503, …)`로 끝내고 이력·접속기록을 남기지 않는다. 항목 수로 끝을 보지 않는다.
- `AttendeeExports.listAttendees(...)`(A2-19에서 행위자 인자가 붙는다): 응답 `nextCursor`는 원천 페이지의 값 그대로다.

**시험 목록**

| 시험 이름 | 단계 | 단언(정본 값) | 비고 |
| --- | --- | --- | --- |
| `A2-17 J-T26 ④ 999건 짧은 페이지 뒤에도 nextCursor로 이어 읽어 2,000건을 모두 내보낸다` | 단위 | 원천 셋: `{999건, 'c1'}`·`{1,000건, 'c2'}`·`{1건, null}`. `record.count` 2,000, 부른 커서가 정확히 `[undefined, 'c1', 'c2']`(core가 커서를 직접 만들지 않는지 보려고 원천 커서를 주문 ID와 다른 값으로 준다), 부른 `limit`이 모두 1,000, CSV에 `order-0000998`·`order-0000999`·`order-0001999`가 있다 | 가져옴. 고칠 곳: 배열 대신 페이지를 돌려주고, 두 번째 페이지가 `limit`을 넘는 1,001건이던 것을 1,000건 + 1건으로 나눈다 |
| `A2-17 J-T26 ④ 0건 페이지와 다음 커서가 와도 멈추지 않는다` | 단위 | `{0건, 'c1'}`·`{500건, null}` → 500건, 두 번 부름 | |
| `A2-17 J-T26 ④ 정확히 1,000건이고 nextCursor가 null이면 더 부르지 않는다` | 단위 | 한 번만 부름, 1,000건. 경계 반대쪽: `{1,000건, 'c1'}`·`{0건, null}`이면 두 번 | 기존 '정확히 1,000행이면 다음 빈 페이지로 끝내고' 시험(두 번 부름 단언)을 이것으로 바꾼다 |
| `A2-17 J-T26 ④ 원천이 같은 커서를 되풀이하면 503이고 이력·접속기록이 없다` | 단위 | `{1,000건, 'c1'}`·`{1,000건, 'c1'}` → `ProblemError` 503 `dependency-unavailable`, 메모리 저장소의 이력 0·접속기록 0 | 조용한 `break` 변이를 잡는다 |
| `A2-17 J-T26 ④ 명단 보기 응답의 nextCursor는 원천 값 그대로다` | 단위 + HTTP | `limit` 50에 원천 `{49건, 'opaque-c'}` → 응답 `nextCursor` `'opaque-c'`. 원천 `{50건, null}` → 응답 null(경계 양쪽). HTTP는 `GET /v1/partner/events/{id}/attendees?limit=50`을 `AppModule.register({ memory: true, export: { source } })`로 부른다 | 부르는 쪽이 결과를 실제로 쓰는지 |
| `A2-17 HttpAttendeeSource는 원천의 nextCursor를 넘기고 다음 요청에 그 커서를 싣는다` | 단위 | 가짜 `fetch`가 `nextCursor: 'abc'`를 주면 `page.nextCursor === 'abc'`, null이면 null. `cursor='abc'`로 부르면 요청 주소에 `cursor=abc`, 내부 토큰 머리가 있다 | 기존 A2-03 시험의 배열 단언을 `page.items`로 고친다 |
| `A2-17 HttpAttendeeSource는 응답 모양이 틀리면 실패한다` | 단위 | `nextCursor` 없음, `nextCursor: 5`, `items: {}` 각각 거절(reject) | fail-closed |
| `A2-17 메모리 명단 원천은 다음 주문이 있을 때만 nextCursor를 준다` | 단위 | 주문 3건, `limit` 2 → 2건과 커서, 그 커서로 1건과 null. `limit` 3 → 3건과 null | `MemoryMerchOrderStore` |
| `A2-17 J-T26 ④ purchase 명단 원천은 SOLD 좌석이 없는 주문을 걸러도 다음 커서를 준다` | 통합(purchase) | 결제 완료 주문 o1·o2·o3(o2는 좌석이 모두 RETURNED). `limit` 2 → `items` [o1], `nextCursor` = o2의 커서(null 아님). 그 커서로 → [o3], null. o2만 걸리는 `limit` 1 페이지는 `items` []와 null 아닌 커서 | 처음부터 통과 예상(이미 있는 동작). `test-int/order-fixtures.ts`를 쓴다 |

**차례**: 시험 담당이 위 단위 시험과 기존 시험 고치기를 한 커밋에 쓰고(포트 모양 바뀜으로 typecheck가 깨지면 빈 뼈대 타입만 더한다), 구현 담당이 포트 → `HttpAttendeeSource` → 메모리 원천 → `create`·`listAttendees` 순으로 고친다. A2-19와 같은 파일을 건드리므로 A2-17을 먼저 끝낸다.

**돌릴 통합 시험**(보충으로 고침, 파일 거르기가 먹는 명령): purchase-svc 폴더에서 `npx vitest run --config vitest.integration.config.mjs test-int/attendee-reader.int.test.ts`

**정본 빈칸과 정한 것(이 커밋에 씀)**
- 짧은 페이지·0건 페이지도 끝이 아니고 `nextCursor` null일 때만 끝이다. 마지막 페이지가 정확히 `limit`건이어도 null이다. 같은 커서가 다시 오면 끝까지 읽는 쪽은 실패로 끝낸다(guidelines §3, 추천 적용).
- 내려받기 페이지 1,000행, 같은 커서면 503 `dependency-unavailable`, 이력·접속기록 없음(settlement.md §9, 추천 적용).
- 범위 밖(후속): 파트너 화면 `RosterLive`는 첫 100건만 읽고 더 보기가 없다(화면 묶음 몫). 컨트롤러는 openapi의 `orderId`·`tier` 거르기를 넘기지 않는다. J-T26 ② 스트리밍(50만 행 메모리 적재)은 그대로다.

**틀린 구현 표본 후보**
1. `create`가 다시 `page.items.length < 1_000`이면 멈춘다.
2. `HttpAttendeeSource`가 늘 `nextCursor: null`을 돌려준다(원천 값 버림).
3. `listAttendees`가 `items.length === limit`일 때만 커서를 만든다(원천 값 무시).
4. 같은 커서면 `break`로 조용히 끝내고 COMPLETED 이력을 남긴다.

### 2. A2-19 명단 조회 접속기록 누락·내려받기 기록 트랜잭션

**무엇이 틀렸나(코드 확인)**: 명단 보기(`listAttendees`)는 행위자를 받지 않고 접속기록을 남기지 않는다(openapi `listPartnerEventAttendees`는 "조회도 개인정보 접속기록에 남긴다(FR-064)"). 내려받기는 `store.insert`와 `store.audit`을 따로 부르고 Drizzle에서도 트랜잭션이 둘이라, 접속기록이 실패해도 이력 행이 남는다. 접속기록 `retain_until`은 `2 * 365일`이라 윤년이 끼면 2년보다 하루 짧다(정본 '최소 2년 이상').

**손댈 파일**

| 나눔 | 파일 |
| --- | --- |
| 제품 코드 | `services/core-svc/src/modules/export/domain/ports.ts`, `…/export/domain/export.ts`(보존 끝 계산), `…/export/application/attendee-exports.ts`, `…/export/inbound/partner-attendee-export.controller.ts`, `…/export/adapters/db/drizzle-export-store.ts`, `…/export/adapters/db/schema.ts`, `…/export/adapters/memory-export-store.ts`, `…/export/index.ts`(새 이름 내보내기) |
| 마이그레이션 | 새 `services/core-svc/migrations/0021_attendee_access_audit_list.sql`, `migrations/meta/_journal.json`, `migrations/meta/0021_snapshot.json`(`pnpm --dir D:/ticketpass-lane3/services/core-svc db:generate`로 만든 뒤 GRANT·CHECK를 손으로 확인) |
| 시험 | 고침: `services/core-svc/test/export-audit.test.ts`(가져옴 포함), `test/export.test.ts`. 새로: `services/core-svc/test-int/export-audit.int.test.ts` |
| 정본(이 커밋) | `docs/features/settlement.md` §9 같은 항목·§13 J-T26 ⑤⑥, `docs/data.md` §2 '예매자 명단 내려받기 이력과 접속기록'·§6 '관리자 계정 접속 로그' 행, `docs/security/asvs/settlement.md` v5.0.0-16.2.1 행 |

**공개 인터페이스**

```ts
// services/core-svc/src/modules/export/domain/ports.ts
export interface AttendeeViewRecord {
  auditId: string;          // uuidv7(clock)
  promoterId: string;
  eventId: string;
  actorAccountId: string;
  actorDisplayName: string;
  actorRole: string;
  count: number;            // 이 페이지에 보인 행 수(items.length)
  filter: { limit: number; cursor?: string }; // 받은 cursor가 없으면 키를 두지 않는다
  createdAt: Date;
}
export interface AttendeeExportStore {
  /** 내려받기 이력(attendee_export)과 DOWNLOAD 접속기록을 한 트랜잭션에 쓴다. 하나라도 실패하면 둘 다 남지 않고 오류를 던진다 */
  recordExport(record: AttendeeExportRecord): Promise<void>;
  /** 명단 보기 LIST 접속기록. 실패하면 오류를 던진다 */
  recordView(view: AttendeeViewRecord): Promise<void>;
  list(promoterId: string, eventId: string, limit: number): Promise<AttendeeExportRecord[]>; // 그대로
}
// insert·audit은 포트에서 뺀다(따로 부를 길을 남기지 않는다)

// services/core-svc/src/modules/export/domain/export.ts
/** 접속기록 보존 끝: UTC 달력으로 2년 뒤 같은 월·일(2월 29일 → 3월 1일). 730일이 아니다 */
export function accessLogRetainUntil(createdAt: Date): Date;
```

- `AttendeeExports.listAttendees(promoterId, eventId, q: { limit: number; cursor?: string }, actor: ExportActor) → Promise<AttendeePageView>`: 차례는 ① 행위자 확인(없거나 `accountId`가 빈 문자열이면 원천을 읽기 전에 `Error`를 던진다) ② 회차 확인(404) ③ 보유 기간(410) ④ 원천 페이지·합계 읽기 ⑤ 표시 이름 풀기(`actors.displayName` 실패·없음이면 `partner_admin` → '파트너 관리자', 그 밖은 역할 이름. `create`와 같은 함수를 쓴다) ⑥ `store.recordView(...)`를 기다린다. 실패하면 그 오류를 그대로 던지고 명단을 돌려주지 않는다 ⑦ 응답.
- `AttendeeExports.create(...)`(인자·반환 그대로): `store.recordExport(record)` 한 번만 부른다. 실패하면 오류를 그대로 던진다(파일을 돌려주지 않는다).
- `PartnerAttendeeExportController.attendees`: `CurrentPrincipal`로 `{ accountId: me.accountId, sessionId: me.sessionId, role: me.role ?? 'partner_admin' }`를 넷째 인자로 넘긴다(HTTP 모양은 그대로).
- `DrizzleAttendeeExportStore.recordExport`: `db.transaction(tx => { attendee_export 넣기; attendee_export_audit 넣기({ id: exportId, exportId, action: 'DOWNLOAD', filter: {}, retainUntil: accessLogRetainUntil(createdAt), … }) }, { tenantId: promoterId, accessMode: 'read write' })` 하나. `recordView`: 같은 옵션으로 `{ id: auditId, action: 'LIST', exportId: null, reason: null, format: null, count, filter, createdAt, retainUntil }`.
- `MemoryAttendeeExportStore`: `rows`(이력), `audits`(DOWNLOAD 접속기록), `views`(LIST 접속기록)를 공개 배열로 둔다.
- 0021 SQL: `action text NOT NULL DEFAULT 'DOWNLOAD'`, `filter jsonb NOT NULL DEFAULT '{}'::jsonb`를 더하고 `export_id`·`reason`·`format`의 NOT NULL을 푼다. CHECK 둘: `action in ('LIST','DOWNLOAD')`, `(action = 'DOWNLOAD' and export_id is not null and reason is not null and format is not null) or (action = 'LIST' and export_id is null and reason is null and format is null)`. 권한·RLS는 건드리지 않는다(`core_partner`에 `SELECT, INSERT`만).

**시험 목록**

| 시험 이름 | 단계 | 단언(정본 값) | 비고 |
| --- | --- | --- | --- |
| `A2-19 J-T26 ⑤ 명단 보기는 행위자·보인 건수·조건을 LIST 접속기록에 남긴다` | 단위 | `views`에 한 행: `promoterId`·`eventId`, `actorAccountId` = 넘긴 계정, `actorRole` `partner_admin`, 이름이 없을 때 `actorDisplayName` '파트너 관리자'(이름이 있으면 그 이름), `count` 2, `filter` `{ limit: 50 }`(커서 없음 → 키 없음), 커서 `'c1'`로 다시 부르면 `{ limit: 50, cursor: 'c1' }`, `createdAt` = 가짜 시계, `auditId`가 UUIDv7 | 가져옴. 고칠 곳: `as unknown as` 형 변환과 `auditList` 이름을 버리고 `recordView`·넷째 인자 `actor`로 부른다 |
| `A2-19 J-T26 ⑤ 접속기록을 남기지 못하면 명단을 돌려주지 않는다` | 단위 | `recordView`가 던지면 `listAttendees`가 같은 오류로 거절된다 | fail-closed |
| `A2-19 J-T26 ⑤ 행위자 없이 부르면 원천을 읽지 않고 실패한다` | 단위 | `actor` undefined, `accountId` '' 각각 거절, 원천 `list` 호출 0, `views` 0 | 빠진 행위자 거절 |
| `A2-19 J-T26 ⑤ 명단을 보이지 않은 요청은 접속기록에 남지 않는다` | 단위 | 다른 파트너 회차 404, 보유 기간 끝 410에서 `views` 0 | 경계 반대쪽 |
| `A2-19 J-T26 ⑤ GET …/attendees는 로그인 주체를 접속기록 행위자로 쓴다` | HTTP | 같은 파트너의 서로 다른 `partner_admin` 둘(`FakeIdentity.partner`)이 부르면 `views` 두 행의 `actorAccountId`가 각자의 `x-user-id`다(파트너 ID·고정값이 아니다). `partner_member`는 403이고 `views`가 늘지 않는다 | 부르는 쪽이 결과를 실제로 쓰는지 |
| `A2-19 J-T26 ⑥ 내려받기는 이력과 DOWNLOAD 접속기록을 recordExport 한 번으로 쓴다` | 단위 | `recordExport` 호출 1, 넘긴 기록의 `exportId`·사유·형식·건수 2·행위자가 응답 기록과 같다. 기존 `['insert','audit']` 차례 단언을 이것으로 바꾼다 | |
| `A2-19 J-T26 ⑥ 접속기록 저장이 실패하면 내려받기 성공으로 답하지 않는다` | 단위 + HTTP | `recordExport`가 던지면 `create`가 그 오류로 거절된다. HTTP는 5xx이고 `content-disposition`이 없다 | 가져옴. 고칠 곳: `expect(store.inserted).toBeDefined()`(비원자 동작을 굳히는 단언)를 지운다 |
| `A2-19 J-T26 ⑥ Drizzle recordExport는 두 행을 한 트랜잭션에 넣는다` | 단위 | 가짜 `db`: `transaction` 호출 1, 옵션 `{ tenantId: promoterId, accessMode: 'read write' }`, 그 안의 같은 `tx`로 넣기 둘(이력 값, 접속기록 값 `{ id: exportId, exportId, action: 'DOWNLOAD', filter: {} }`). 둘째 넣기가 던지면 `recordExport`가 거절된다 | 기존 '…retain_until을 만든 시각 + 2년' 시험을 이것과 아래로 나눈다 |
| `A2-19 J-T26 ⑤ Drizzle recordView는 LIST 행을 export_id·reason·format 없이 넣는다` | 단위 | 값 `{ id: auditId, action: 'LIST', exportId: null, reason: null, format: null, count, filter }` | |
| `A2-19 J-T26 ⑤ 접속기록 보존 끝은 만든 때 + 2년(달력)이다` | 단위 | `2026-11-15T00:00:00Z` → `2028-11-15T00:00:00Z`(730일이면 11-14), `2027-03-01T00:00:00Z` → `2029-03-01T00:00:00Z`, `2028-02-29T12:00:00Z` → `2030-03-01T12:00:00Z`. Drizzle 넣기 값의 `retainUntil`도 같다 | 기존 `2 * 365일` 정확값 단언을 지운다 |
| `A2-19 0021은 action·filter를 더하고 LIST·DOWNLOAD 모양을 CHECK로 강제하며 UPDATE·DELETE를 주지 않는다` | 단위(SQL 원문) | `ADD COLUMN "action"`·`"filter"`, CHECK 두 개의 글, `attendee_export_audit`에 대한 GRANT가 없거나 `SELECT, INSERT`뿐, journal idx 21의 tag | 기존 0019 시험과 같은 방식 |
| `A2-19 J-T26 ⑥ 접속기록 넣기가 실패하면 attendee_export도 남지 않는다` | 통합(core) | `core_partner`·같은 테넌트로 `id = exportId`인 접속기록 행을 먼저 넣고 `recordExport` → 유일 위반으로 거절, `attendee_export`에 그 ID 행 0 | 실제 롤백 |
| `A2-19 J-T26 ⑤⑥ 0021 뒤 LIST·DOWNLOAD 행이 들어가고 모양이 틀리면 CHECK가 거절한다` | 통합(core) | `recordView`·`recordExport`가 넣은 행을 읽어 값이 같다(`retain_until` 포함). 사유 있는 LIST, `export_id` 없는 DOWNLOAD, `action` 'VIEW'는 23514 | |
| `A2-19 core_partner는 접속기록을 고치거나 지우지 못하고 다른 테넌트 행을 읽지 못한다 [ASVS v5.0.0-8.4.1]` | 통합(core) | UPDATE·DELETE는 42501, 테넌트 B로 A의 행 0건 | |

**차례**: A2-17 구현이 끝난 뒤 시작한다(같은 파일). 시험 담당 → 구현 담당(포트·메모리 → 유스케이스·컨트롤러 → 보존 끝 함수 → 0021·스키마·Drizzle).

**돌릴 통합 시험**(보충으로 고침, 파일 거르기가 먹는 명령): core-svc 폴더에서 `npx vitest run --config vitest.integration.config.mjs test-int/export-audit.int.test.ts`

**정본 빈칸과 정한 것(이 커밋에 씀)**
- 보기 접속기록 단위는 '돌려준 페이지 하나'이고 건수는 그 페이지에 보인 행 수, 조건은 `limit`·`cursor`다. 404·410·403은 남기지 않는다. 행위자는 로그인 주체, 표시 이름 대체는 역할 이름(settlement.md §9, 추천 적용).
- 저장은 지금의 `attendee_export_audit`를 넓혀 쓴다: `action LIST|DOWNLOAD`, `filter`, LIST의 NULL 칸, CHECK(data.md §2, 추천 적용).
- 내려받기 이력과 접속기록은 한 트랜잭션, 실패 시 둘 다 없고 파일 없음. 접속기록 실패 시 보기도 오류(fail-closed).
- `retain_until` = 만든 때 + 2년(UTC 달력, 2월 29일 → 3월 1일). 730일로 세지 않는다.

**틀린 구현 표본 후보**(개인정보 접속기록은 꼭 넣는다)
1. `listAttendees`가 `recordView`를 부르지 않거나, 부른 뒤 오류를 `catch`로 삼키고 명단을 돌려준다.
2. Drizzle `recordExport`가 트랜잭션 둘로 나눠 넣는다(이력 먼저 커밋).
3. 컨트롤러가 행위자로 `tenantOf(me)`나 고정 계정을 넘긴다. 또는 `count`에 `totals.bookings`를 넣는다.
4. `accessLogRetainUntil`이 `+ 730일`이다.

#### R2 보충(2026-11-16, 리뷰 R2: 접속기록에 접속지 정보가 없다)

**무엇이 빠졌나**: 개인정보의 안전성 확보조치 기준의 접속기록 항목은 계정·접속일시·접속지 정보·처리한 정보주체 정보·수행업무다(고시 제2조 제3호, docs/security/internal-management-plan.md §4.5). 명단 보기·내려받기 접속기록은 접속지만 없다. 저장소에 이미 있는 같은 꼴은 관리 계정 접속기록 `admin_data_access.source_ip`('접속지 정보', data.md §2 ⑦)와 identity-svc 관리 계정 로그인의 클라이언트 IP 읽기(`clientIpOf`: 입구가 하나로 다시 쓴 `x-forwarded-for`가 IP 모양이면 그것, 아니면 연결 상대 주소, docs/infra.md §3 입구 규칙 2)다. 둘을 그대로 따른다. 기기 식별값은 `admin_data_access`에도 없어 남기지 않는다. 보존은 그 행의 2년, 가림은 '응답·화면에 싣지 않음, 로그는 플랫폼의 원문 식별값 가림 키 `clientIp`'다(정본에 먼저 씀: settlement.md §9 '접속지'·J-T26 ⑤, data.md §2 `source_ip`, data-classification '관리자 시스템 접속기록' 행, internal-management-plan §4.5, asvs/settlement 16.2.1).

**마이그레이션**(웨이브 끝 리뷰 K1로 바뀜: `source_ip` CHECK는 0021에서 빼고 다음 출시로 미룬다, §7): 새 번호를 쓰지 않는다. 아직 develop에 없는 **0021**(`0021_attendee_access_audit_list.sql`)에 더한다: `ALTER TABLE "attendee_export_audit" ADD COLUMN "source_ip" inet;`와 `ADD CONSTRAINT "attendee_export_audit_source_ip_check" CHECK ("source_ip" IS NOT NULL) NOT VALID;`(0019로 이미 들어간 행은 그대로, 새 행은 반드시 접속지가 있다). 권한은 바꾸지 않는다. Drizzle 스키마 `attendeeExportAudit`에 `sourceIp: inet('source_ip')`를 더하고 0021 스냅숏을 다시 만든다(`NOT VALID`는 손으로 쓴 SQL에만 있다).

**손댈 파일**

| 나눔 | 파일 |
| --- | --- |
| 제품 코드 | `services/core-svc/src/modules/export/application/attendee-exports.ts`(`ExportActor`, 접속지 확인), `…/export/domain/ports.ts`(`AttendeeViewRecord`, `recordExport` 둘째 인자), 새 `…/export/inbound/client-ip.ts`, `…/export/inbound/partner-attendee-export.controller.ts`(GET에도 `@Req()`), `…/export/adapters/db/drizzle-export-store.ts`, `…/export/adapters/db/schema.ts`, `…/export/adapters/memory-export-store.ts` |
| 마이그레이션 | `services/core-svc/migrations/0021_attendee_access_audit_list.sql`(위 두 줄 더함), `migrations/meta/0021_snapshot.json` |
| 시험 | 고침(시험 담당 몫): `test/export-audit.test.ts`(0021 원문 시험 `A2-19 0021은 action·filter를 더하고 …`에 `source_ip` 칸·CHECK 글을 더한다, 기존 LIST·DOWNLOAD 단언에 `clientIp`), `test-int/export-audit.int.test.ts`(74·98줄처럼 접속기록 행을 직접 넣는 준비에 `source_ip`를 넣어야 새 CHECK에 걸리지 않는다), 행위자 객체를 만드는 export 시험 전부(`test/export-paging-limit.test.ts`, `test/export-paging.test.ts`, `test/export-attendee-source.test.ts`, `test/export-reauth.test.ts`, `test/export-reauth-cases.test.ts`, `test/export.test.ts`에 `clientIp`). 새로: `test/client-ip.test.ts` |

**공개 인터페이스(바뀌는 곳만)**

```ts
// services/core-svc/src/modules/export/application/attendee-exports.ts
export interface ExportActor {
  accountId: string;
  sessionId: string;
  role: string;
  /** 접속지 정보: 요청의 클라이언트 IP 원문. 이름이 clientIp라 플랫폼 로그가 가린다 */
  clientIp: string;
}
// listAttendees·create: actor.clientIp가 IP 모양이 아니면(isIP === 0, 빈 문자열 포함) 원천·회차를 읽기 전에 Error를 던진다(행위자 없음과 같은 자리, 접속기록·이력 없음)

// services/core-svc/src/modules/export/domain/ports.ts
export interface AttendeeViewRecord { /* … 지금 칸 … */ clientIp: string }
export interface AttendeeExportStore {
  /** 둘째 인자의 접속지는 DOWNLOAD 접속기록에만 쓴다(attendee_export 이력·exportView에는 싣지 않는다) */
  recordExport(record: AttendeeExportRecord, access: { clientIp: string }): Promise<void>;
  recordView(view: AttendeeViewRecord): Promise<void>; // view.clientIp → source_ip
  list(promoterId: string, eventId: string, limit: number): Promise<AttendeeExportRecord[]>; // 그대로, 접속지 없음
}

// services/core-svc/src/modules/export/inbound/client-ip.ts(새)
/** identity-svc admin-login.controller의 clientIpOf와 같은 규칙: x-forwarded-for(배열이면 첫 값)를 다듬어 IP 모양이면 그것, 아니면 socket.remoteAddress, 없으면 '' */
export function clientIpOf(req: Pick<FastifyRequest, 'headers' | 'socket'>): string;
```

- 컨트롤러 `attendees`·`create`는 행위자에 `clientIp: clientIpOf(request)`를 싣는다. 메모리 저장소는 `views: AttendeeViewRecord[]`(접속지 포함)와 `audits: (AttendeeExportRecord & { clientIp: string })[]`(DOWNLOAD 접속기록에 받은 접속지를 붙인 것)를 공개 배열로 두고, `rows`(이력)에는 접속지를 넣지 않는다. Drizzle은 LIST·DOWNLOAD 넣기 값에 `sourceIp`를 싣는다.
- `AttendeeExportRecord`·`exportView`·다운로드 이력 응답 모양은 바꾸지 않는다(접속지를 이력으로 내보내지 않는다).

**시험 목록(R2 보충)**

| 시험 이름 | 단계 | 단언(정본 값) | 비고 |
| --- | --- | --- | --- |
| `A2-19 R2 J-T26 ⑤ 명단 보기 접속기록에 요청의 접속지를 남긴다` | 단위 + HTTP | 단위: `actor.clientIp` `'203.0.113.7'` → `views[0].clientIp` 정확히 같다. HTTP: 머리 `x-forwarded-for: 203.0.113.7` → `'203.0.113.7'`, 머리 없음 → 주입 요청의 연결 주소 `'127.0.0.1'`, `x-forwarded-for: not-an-ip` → `'127.0.0.1'`, IPv6 `2001:db8::1` → 그대로 | 부르는 쪽이 결과를 쓰는지(컨트롤러가 요청에서 읽어 넘김) |
| `A2-19 R2 J-T26 ⑤ 접속지를 정하지 못하면 원천을 읽지 않고 실패한다` | 단위 | `clientIp` `''`·`'abc'`·`'300.1.1.1'` 각각 `listAttendees` 거절, 원천 `list` 호출 0, `views` 0. 같은 값으로 `create` 거절, `recordExport` 호출 0 | 빠진 접속지 거절·fail-closed |
| `A2-19 R2 J-T26 ⑥ 내려받기 접속기록에도 접속지를 남기고 이력 응답에는 싣지 않는다` | 단위 + HTTP | `recordExport` 둘째 인자 `{ clientIp: '203.0.113.7' }`. HTTP `GET …/attendee-exports` 응답 본문에 `203.0.113.7` 글자가 없다 | 가림 |
| `A2-19 R2 Drizzle 접속기록 넣기 값에 source_ip가 있다` | 단위 | 가짜 `tx`의 LIST·DOWNLOAD 넣기 값 모두 `sourceIp` = 넘긴 IP | |
| `A2-19 R2 클라이언트 IP는 다시 쓴 x-forwarded-for가 IP일 때만 그것이고 아니면 연결 주소다` | 단위 | `clientIpOf`: `'203.0.113.7'` → 그대로, `' 203.0.113.7 '` → 다듬은 값, 배열 `['198.51.100.1', '203.0.113.7']` → 첫 값, `'203.0.113.7, 10.0.0.1'`(쉼표 목록, IP 모양 아님) → 연결 주소, 머리·연결 주소 둘 다 없음 → `''` | identity 규칙과 같은지 |
| `A2-19 0021은 action·filter를 더하고 LIST·DOWNLOAD 모양을 CHECK로 강제하며 UPDATE·DELETE를 주지 않는다`(고침) | 단위(SQL 원문) | 지금 단언에 더해 `ADD COLUMN "source_ip" inet`, `CHECK ("source_ip" IS NOT NULL) NOT VALID`가 있다 | 0021 원문 시험. 시험 담당이 고친다 |
| `A2-19 R2 0021 뒤 접속지 없는 새 행은 CHECK가, IP 모양이 아닌 값은 inet이 거절한다` | 통합(core PostgreSQL) | `source_ip` 없이 넣기 23514, `'abc'` 22P02, `'2001:db8::1'`은 들어가고 읽으면 같은 값. `recordView`·`recordExport`로 넣은 행의 `source_ip`가 넘긴 IP | |

**차례**: 리뷰 반영이다. 시험 담당이 위 시험과 고칠 시험을 먼저 쓰고 실패를 본다(`Role: review-fix`, `Fix-By: test`). 구현 담당이 0021·스키마·코드를 고친다(`Fix-By: impl`).

**돌릴 통합 시험**: core-svc 폴더에서 `npx vitest run --config vitest.integration.config.mjs test-int/export-audit.int.test.ts`

**틀린 구현 표본 후보(R2)**
1. 컨트롤러가 `x-forwarded-for`를 보지 않고 늘 `socket.remoteAddress`(입구 파드 주소)를 넣는다.
2. 접속지가 빈 문자열이어도 막지 않고 `''`이나 `'0.0.0.0'`을 넣는다(fail-open).
3. DOWNLOAD 접속기록에는 접속지를 싣지 않는다(LIST만 싣는다).
4. `exportView`나 이력 응답에 접속지를 싣는다.

**R3(리뷰, 정본 문구)**: J-T26 ④ 상황 칸의 '999건 페이지 뒤에 1,001건 페이지'를 '999건 페이지 뒤에 1,000건 페이지와 1건 페이지(원천은 한 페이지에 요청한 `limit`보다 많이 주지 않는다)'로 고쳤다(settlement.md §13). 시험(§1 첫 줄)은 이미 이 모양이라 바꿀 것이 없다. 원천이 `limit`보다 많이 줄 때 core가 거절할지는 정하지 않았다(지금 코드는 그대로 받는다).

### 3. R-628 회귀 시험 공백(`InternalToken401Guard` 시작 차단·상수 시간 비교)

**무엇이 틀렸나**: 제품 코드는 맞다(R628V 확인). 커밋된 시험이 `onModuleInit` 상속(운영 무토큰 시작 차단)과 `timingSafeEqual` 사용을 묶지 않아, 두 변이(M1 `onModuleInit` 빈 재정의, M3 `===` 비교)가 모든 시험을 통과했다. 기존 core 시험은 `PEAKET_ENV=ci`만 본다. 그래서 이 항목은 **시험만** 더한다. 모두 처음부터 통과 예상이다.

**손댈 파일**

| 나눔 | 파일 |
| --- | --- |
| 제품 코드 | 없음 |
| 마이그레이션 | 없음 |
| 시험 | 새로: `services/core-svc/test/internal-sale-config-token-boot.test.ts`, `packages/platform/test/internal-token-constant-time.test.ts` |
| 정본(이 커밋) | `docs/architecture.md` §3.2 'REST' 행(401·시작 차단·상수 시간), `docs/security/asvs/settlement.md` v5.0.0-11.2.4 행 |

**공개 인터페이스(바꾸지 않는다, 시험이 부르는 면)**
- `InternalSaleConfigController`(`services/core-svc/src/modules/catalog/inbound/internal-sale-config.controller.ts`, 내보낸 클래스). 가드 `InternalToken401Guard`는 내보내지 않으므로 컨트롤러를 최소 Nest 모듈에 넣어 띄운다: `controllers: [InternalSaleConfigController]`, `providers: [{ provide: SALE_CONFIG_READER, useValue: MemorySaleConfigStore }, { provide: INTERNAL_TOKEN, useValue: <토큰|undefined|''> }]`. `INTERNAL_TOKEN_REQUIRED`는 `createService`가 `PEAKET_ENV`로 넣는다(그래서 `createService`로 띄워야 한다).
- `createService({ name, module, env: { PEAKET_ENV, PEAKET_LOG_SAMPLE_ONE_IN: '1', PEAKET_LOG_PSEUDONYM_KEY: <32바이트 base64> } })`. 운영 환경의 다른 필수 값은 `packages/platform/test/internal-token-boot.test.ts`처럼 채운다.
- 플랫폼 `InternalTokenGuard(expected?, required)`의 `canActivate`·`onModuleInit`, 내부 함수 `sameSecret`은 `node:crypto`의 `timingSafeEqual`을 쓴다. 상수 시간 검사는 `vi.mock('node:crypto', …)`로 원래 함수를 감싼 엿보기(spy)를 둔다. core 단위 시험은 `@peaket/platform`을 원본(`packages/platform/src`)으로 잇기 때문에(vitest.config.mjs 별칭) core 시험에서도 그 엿보기가 닿는다. 다른 시험에 번지지 않게 새 파일에 둔다.

**시험 목록**(모두 처음부터 통과 예상)

| 시험 이름 | 단계 | 단언 |
| --- | --- | --- |
| `SEC-06R ① prod·staging에서 토큰이 없거나 비면 내부 판매 설정 컨트롤러 조립이 시작하지 않는다` | 단위(core, 서비스 띄움) | `PEAKET_ENV` `prod`·`staging` × 토큰 undefined·'' 넷 모두 `createService`가 `/PEAKET_INTERNAL_TOKEN/`으로 거절. 시작되면 닫고 실패 |
| `SEC-06R ② local·ci에서는 토큰 없이 시작하고 요청이 통과한다` | 단위(core) | 시작 성공, 있는 회차 200, 없는 회차 404 |
| `SEC-06R ③ prod에서 토큰이 있으면 머리 없음·틀림·길이 다름은 401, 맞으면 200이다` | 단위(core) | 401 셋(403이 아니다), 맞으면 200과 `eventId`, `GET /internal/v1/events/settlement-due?through=2026-11-15` 토큰 없이 401 |
| `SEC-06R ④ 내부 판매 설정 가드는 공용 상수 시간 비교를 쓴다` | 단위(core) | 맞는 토큰 → `timingSafeEqual` 호출 1(길이가 같은 Buffer 둘), 같은 길이의 틀린 토큰 → 호출 1이고 401, 길이가 다른 토큰 → 호출 0이고 401 |
| `SEC-06R ⑤ InternalTokenGuard는 길이가 같은 토큰을 timingSafeEqual로 비교한다` | 단위(platform) | 가드를 직접 만들어 위와 같은 세 경우를 본다 |

**차례**: 다른 결함과 파일이 겹치지 않아 언제든 된다. 시험 담당이 쓰고 '처음부터 통과(이미 있는 동작)'로 적는다. 구현 담당 몫은 없다.

**돌릴 통합 시험**: 없음(서비스를 메모리로 띄우는 단위 시험이다).

**정본 빈칸과 정한 것(이 커밋에 씀)**: 이 경로의 401 계약(공용 가드의 403과 다름), local·ci 밖 무토큰 시작 거절, 상수 시간 비교(길이가 다르면 비교 없이 거절)를 architecture.md §3.2와 ASVS 11.2.4에 적었다(추천 적용). 범위 밖(후속, R628V 권고 4): `CatalogModule`이 `INTERNAL_TOKEN`을 `createService`의 env가 아니라 `process.env`에서 읽는다.

**틀린 구현 표본 후보**(내부 토큰 인증은 꼭 넣는다)
1. `InternalToken401Guard`에 빈 `onModuleInit()`을 둔다(R628V M1).
2. 플랫폼 `sameSecret`을 `a === b`로 바꾼다(R628V M3).
3. 하위 가드의 `canActivate`가 `super`를 부르지 않고 `got !== this.expected`로 직접 비교한다.
4. 하위 가드 생성자에서 `@Inject(INTERNAL_TOKEN_REQUIRED)`를 빼서 `required`가 늘 기본값 false다.

### 4. COV2-06 탈퇴 뒤 후기 익명화 연결

**무엇이 틀렸나(코드 확인)**: R-617이 후기 익명화(`Reviews.anonymizeAccount` → `account_id`·`basis_order_id`를 후기 ID로, 작성자 표시 '탈퇴한 사용자')와 내부 경로 `POST /internal/v1/reviews/accounts/{accountId}/anonymize`를 만들었지만, 아무도 그 경로를 부르지 않는다. core-svc에는 Kafka 소비자가 하나도 없고, `identity.accounts-withdrawn`의 소비자는 queue-svc뿐이다. R-617은 익명화 시험도 남기지 않았다. 병합은 정본상 흡수 계정이 후기를 가질 수 없어(identity.md §2.1 병합 불변식) 익명화 대상이 아니다.

**보충(2026-11-16, 시험 담당이 실패 확인 중 찾은 계획 빈칸)**: 운영 역할에 후기 표 쓰기 권한이 없다. 0004는 `core_app`에 모든 표 읽기(기본 권한)와 `wish` 넣기·지우기만 주고, 0013(review·content_report·takedown_action·review_hidden_fingerprint)과 그 뒤 마이그레이션은 `core_app`·`core_maintenance`에 이 표들의 쓰기를 주지 않았다(`grep -n GRANT services/core-svc/migrations/*.sql`로 확인). ADR-0241 결정 4('`core_app`은 … 쓰기가 생기면 그 단계의 마이그레이션이 더한다')를 BAT-585가 빠뜨린 것이다. 그래서 ⑪이 운영과 같은 `core_app` 로그인에서 42501로 실패했고, 다음도 운영에서 모두 실패한다(기존 `test-int/review.int.test.ts`는 슈퍼유저로 붙어 드러나지 않았다).
- `core_app`(main.ts의 `PEAKET_DATABASE_URL`, 팬·관제 경로): 후기 쓰기·고치기·지우기, 신고, 통보 가림, CS 조치, 탈퇴 익명화(⑪), Kafka 보류 넣기(⑫ `held_event` INSERT).
- `core_maintenance`(relay.ts의 정비 연결): 정비 일 `review-temp-block-expire`(`review`·`takedown_action` 읽기·고치기 권한 없음)와 플랫폼 정비 일 `held-events-delete`(`held_event` 지우기 권한 없음).
- **이번 범위에 넣는다.** COV2-06의 익명화·보류가 같은 권한에 막히고, 고칠 곳이 마이그레이션 하나다. 권한은 코드가 실제로 쓰는 칸·동작만 준다(아래 0022, 정본 docs/data.md §2 '후기 표의 DB 권한'·§4의 15 'DB 권한'에 먼저 적었다).

**손댈 파일**

| 나눔 | 파일 |
| --- | --- |
| 제품 코드 | 새 `services/core-svc/src/modules/review/inbound/account-withdrawn.handler.ts`, `…/review/index.ts`(내보내기), 새 `services/core-svc/src/consumers/index.ts`·`src/consumers/start.ts`, `services/core-svc/src/main.ts`(설정 읽기·시작·멈춤) |
| 마이그레이션 | (보충) 새 `services/core-svc/migrations/0022_review_role_grants.sql`과 `migrations/meta/_journal.json`의 idx 22 항목. 권한만 바꾸므로 Drizzle 스키마·스냅숏은 바꾸지 않는다(0012·0013처럼). `held_event` 표는 0000에 있다 |
| 시험 | 새로: `services/core-svc/test/review-withdrawn.test.ts`, `test/core-consumers.test.ts`, `test-int/review-withdrawn.int.test.ts`(PostgreSQL), `test-int/review-withdrawn-consumer.int.test.ts`(Kafka + PostgreSQL), `test-int/kafka.ts`(queue-svc `test-int/kafka.ts`를 본뜬 시험 도우미). (보충) 고침: `test-int/review.int.test.ts`(서비스를 `core_app` 로그인으로 띄운다). 새로: `test/review-grants.test.ts`(0022 SQL 원문), `test-int/review-grants.int.test.ts`(역할별 허용·거절) |
| 정본 | 계획 커밋: `docs/api/asyncapi.yaml`(채널 설명·`consumeAccountWithdrawn`), `docs/streaming.md` §2.4 업무 키·§2.6 'core-svc 소비자', `docs/features/identity.md` §8 '후기 익명화' 아래 넷, `docs/security/data-classification.md` '탈퇴 사건의 pid 사본' 행, `docs/security/asvs/catalog-review.md` v5.0.0-14.2.7 행. 보충 커밋: `docs/data.md` §2 '후기 표의 DB 권한'·§4의 15 'DB 권한' |

**공개 인터페이스**

```ts
// services/core-svc/src/modules/review/inbound/account-withdrawn.handler.ts
export const ACCOUNTS_WITHDRAWN_TOPIC = 'identity.accounts-withdrawn';
/** core가 읽는 칸만. pid·purgeBy는 읽지 않는다 */
export interface ReviewWithdrawnEvent { eventKey: string; accountId: string; withdrawnAt: string }
export interface AccountWithdrawnCodec { decode(value: Buffer): unknown }
export const jsonAccountWithdrawnCodec: AccountWithdrawnCodec; // JSON 대역(Avro는 BAS-030)
export class ReviewAccountWithdrawnHandler implements KeyedHandler<ReviewWithdrawnEvent> {
  constructor(reviews: Pick<Reviews, 'anonymizeAccount'>, codec?: AccountWithdrawnCodec, o?: { logger?: { info(o: object, msg?: string): void } });
  /** @throws Error 값이 null, 또는 계약 Zod AccountWithdrawn.pick({ eventKey, accountId, withdrawnAt })에 맞지 않음 → 플랫폼이 5회 뒤 보류 */
  decode(m: ConsumedMessage): ReviewWithdrawnEvent; // accountId는 소문자로 바꾼다
  keyOf(e: ReviewWithdrawnEvent): string;            // accountId
  eventKeyOf(e: ReviewWithdrawnEvent): string;       // eventKey
  /** reviews.anonymizeAccount(accountId)를 기다린다. 로그에는 eventKey와 바꾼 건수만(계정 ID 없음). 저장소 일시 장애는 그대로 던져 파티션을 멈춘다 */
  handle(e: ReviewWithdrawnEvent): Promise<void>;
}

// services/core-svc/src/consumers/index.ts
export const CORE_GROUP: (env: string) => string;   // `peaket.core-svc.${env}`
export const CORE_TOPICS: readonly ['identity.accounts-withdrawn'];
export type CoreKafkaConfig =
  | { enabled: false; warning: string }
  | { enabled: true; brokers: string[]; auth: KafkaAuth | undefined; env: string };
/** PEAKET_KAFKA_BROKERS가 없거나 빈칸뿐이면 local·ci만 꺼진 설정, 그 밖(값 없음 포함)은 PlatformConfigError. 틀린 조각은 몇 번째인지만 알린다(queue-svc와 같은 규칙) */
export function kafkaConsumersFromEnv(env: Record<string, string | undefined>): CoreKafkaConfig;
/** 보류 포트 감싸기: identity.accounts-withdrawn의 값은 {eventKey, accountId, withdrawnAt} JSON으로 바꿔 넣고, 읽지 못한 값은 null로 넣는다. 다른 토픽은 그대로 */
export function pidFreeHeldEventStore(inner: HeldEventStore): HeldEventStore;

// services/core-svc/src/consumers/start.ts(네이티브 Kafka 모듈은 이 파일만 싣는다)
export interface CoreConsumersOptions {
  env: string; brokers: string[]; clientId: string; auth?: KafkaAuth;
  database: Database;                       // core_app(held_event·review)
  handler: ReviewAccountWithdrawnHandler;
  registry?: Registry; logger?: { warn(o: object, msg?: string): void };
  clock?: Clock; startAt?: 'earliest' | 'latest'; commitEveryMs?: number; measureHeldEveryMs?: number;
}
/** runKeyedConsumer({ service: 'core-svc', groupId: CORE_GROUP(env), topics: [...CORE_TOPICS], held: pidFreeHeldEventStore(drizzleHeldEventStore(database, clock)), heldCounts: () => heldEventCounts(database) … }) */
export function startCoreConsumers(o: CoreConsumersOptions): { started: Promise<void>; stop(): Promise<void> };
```

- `main.ts`: `createService` 전에 `kafkaConsumersFromEnv(process.env)`를 읽어 운영에서 브로커가 없으면 시작하지 않는다. `service.listen()` 뒤에 켜져 있으면 `startCoreConsumers({ …, clientId: \`core-svc-${env}-${파드}\`, auth: kafkaAuthFromEnv('core-svc', process.env), handler: new ReviewAccountWithdrawnHandler(service.app.get(Reviews), undefined, { logger }) })`. `started`가 실패하면 오류 한 줄 뒤 종료 코드 1. SIGTERM에서는 소비자를 먼저 멈춘 뒤 서비스를 닫는다. 꺼진 설정(local·ci)은 경고 한 줄.
- 내부 경로와 `Reviews.anonymizeAccount`·`ReviewStore.anonymizeByAccount`의 동작은 바꾸지 않는다(아래 OPEN[42]).
- (보충) 0022 권한. 표 쓰기 SQL을 하나씩 대조해 정했다(`review/adapters/db/drizzle-review-store.ts`, 플랫폼 `held-events.ts`). 여기 없는 권한(표 전체 UPDATE, `review`·`content_report`·`takedown_action` DELETE, TRUNCATE)은 주지 않는다. `SELECT … FOR UPDATE`(통보 가림)는 아래 UPDATE 칸 권한으로 된다.

  | 역할 | 표 | 줄 권한 | 쓰는 곳 |
  | --- | --- | --- | --- |
  | `core_app` | `review` | `SELECT`, `INSERT`, `UPDATE (rating, body, status, notice, notice_until, content_fingerprint, author_display, edited, updated_at, deleted_at, account_id, basis_order_id)` | 쓰기, 고치기, 지우기(소프트), 신고 가림, 통보 가림, CS 조치, 탈퇴 익명화. `id`·`event_id`·`created_at`은 고치지 못한다 |
  | `core_app` | `content_report` | `SELECT`, `INSERT`, `UPDATE (status, outcome, resolved_at)` | 신고, 신고 처리 완료 |
  | `core_app` | `takedown_action` | `SELECT`, `INSERT`, `UPDATE (restored_at)` | 가림 조치 기록, 해제 |
  | `core_app` | `review_hidden_fingerprint` | `SELECT`, `INSERT`, `DELETE` | 같은 내용 지문 등록(`ON CONFLICT DO NOTHING`)·해제 |
  | `core_app` | `held_event` | `SELECT`, `INSERT` | 탈퇴 사건 보류(⑫). 다시 처리(RB-11)의 `UPDATE (reprocessed_at)`은 주지 않는다(범위 밖) |
  | `core_maintenance` | `review` | `SELECT (id, status, notice, notice_until)`, `UPDATE (status, notice, notice_until, updated_at)` | 임시조치 끝내기 `review-temp-block-expire` |
  | `core_maintenance` | `takedown_action` | `SELECT (reason, restored_at, ends_at)`, `UPDATE (restored_at)` | 〃 |
  | `core_maintenance` | `held_event` | `SELECT (reprocessed_at)`, `DELETE` | 플랫폼 정비 일 `held-events-delete` |

  - `core_app`의 `SELECT`는 0004의 기본 권한과 같은 것을 다시 적는 것이다(이미 있는 권한이 사라지지 않게, 0006 `production_image`와 같은 방식).
  - 실행 순서: 0021(A2-19) 다음이다. 다른 갈래가 core-svc 0021·0022를 먼저 합치면 감독이 번호를 조정한다.

**시험 목록**

| 시험 이름 | 단계 | 단언(정본 값) | 비고 |
| --- | --- | --- | --- |
| `COV2-06 ① 탈퇴 사건을 받으면 그 계정 후기의 계정·주문 참조를 후기 ID로 바꾼다` | 단위 | 메모리 저장소: 계정 A 후기 둘(VISIBLE·DELETED), 계정 B 후기 하나. A의 사건 뒤 A의 두 행 `accountId`·`basisOrderId` = 각자의 후기 ID, `authorDisplay` '탈퇴한 사용자', `updatedAtMs` = 가짜 시계. B 행은 모든 칸이 그대로 | 본문·별점 단언은 OPEN[42]에 따라 바뀔 수 있어 지금은 '그대로'만 본다 |
| `COV2-06 ② 같은 사건을 다시 받아도 결과가 같다` | 단위 | 둘째 처리 뒤 바꾼 건수 0, 행(갱신 시각 포함)이 첫 처리 뒤와 같다 | |
| `COV2-06 ③ decode는 eventKey·accountId·withdrawnAt만 읽고 pid 없이도 읽는다` | 단위 | 계약 전체 JSON과 pid를 뺀 JSON 모두 읽힌다. 결과에 `pids`·`purgeBy` 키가 없다. 대문자 accountId는 소문자가 된다 | 보류 뒤 다시 처리를 위해 |
| `COV2-06 ④ 값이 없거나 모양이 틀리면 decode가 실패한다` | 단위 | 값 null, UUID 아닌 accountId, eventKey 없음, 날짜 아닌 withdrawnAt 각각 throw | |
| `COV2-06 ⑤ keyOf는 계정 ID, eventKeyOf는 eventKey다` | 단위 | 정확한 값 | |
| `COV2-06 ⑥ 보류 기록에는 pid를 뺀 값만 넣는다` | 단위 | 기록하는 가짜 inner에 `hold`·`holdIfHeld`로 pid가 든 값을 넣으면 inner가 받은 값의 JSON이 정확히 `{ eventKey, accountId, withdrawnAt }`이고 바이트에 pid 글자가 없다. 읽지 못한 값은 null. 다른 토픽 값은 바이트가 그대로 | 개인정보 |
| `COV2-06 ⑦ PEAKET_KAFKA_BROKERS가 없으면 local·ci만 소비자 없이 뜨고 그 밖의 환경은 시작하지 않는다` | 단위 | local·ci → `enabled: false`. prod·staging·demo·PEAKET_ENV 없음 → `PlatformConfigError`. '', '   '도 같다. 'bad host'는 몇 번째 조각인지 알리고 값은 싣지 않는다. 'b1:9092, b2:9092' + prod → `enabled: true`, 브로커 둘, env 'prod' | 허용·거부 목록 밖 값마다 |
| `COV2-06 ⑧ 소비자 그룹은 peaket.core-svc.<환경>이고 탈퇴 토픽 하나만 읽는다` | 단위 | `CORE_GROUP('prod') === 'peaket.core-svc.prod'`, `CORE_TOPICS`가 정확히 `['identity.accounts-withdrawn']` | |
| `COV2-06 ⑨ 내부 익명화 경로는 토큰이 없거나 틀리면 403이고 맞으면 바꾼 건수를 준다` | HTTP | `PEAKET_ENV=ci`, 토큰 설정. 없음·틀림 403(공용 가드), UUID 아닌 계정 400(요청 검사), 맞으면 200 `{ anonymized: 2 }`(정확한 수), 다시 부르면 `{ anonymized: 0 }` | R-617이 남긴 시험 공백 |
| `COV2-06 ⑩ main.ts는 시작 전에 Kafka 설정을 읽고 듣기 뒤에 후기 탈퇴 소비자를 켠다` | 단위(원문 대조) | `main.ts` 글에서 `kafkaConsumersFromEnv(`가 `createService(`보다 앞, `startCoreConsumers(`와 `ReviewAccountWithdrawnHandler`가 `service.listen()` 뒤, SIGTERM 처리에 소비자 `stop` | 시작 파일 조립(자주 놓친 결함). 약한 검사라 ⑫가 실제 동작을 본다 |
| `COV2-06 ⑪ Drizzle 익명화는 그 계정 행만 바꾸고 다시 해도 0건이다` | 통합(core PostgreSQL) | A의 두 회차 후기·B의 후기. 첫 호출 2, A 행 `account_id = id`·`basis_order_id = id`·`author_display` '탈퇴한 사용자'·`updated_at` = 넘긴 시각, B 행 그대로, 회차·계정 부분 유일 인덱스 위반 없음. 둘째 호출 0 | (보충으로 바뀜) '처음부터 통과 예상'이 아니다. `core_app` 로그인에서 42501로 실패했다(권한 결함 재현). 0022 뒤 통과해야 한다 |
| `COV2-06 ⑫ 실제 Kafka의 탈퇴 사건이 core 후기를 익명화하고, 읽지 못한 사건은 pid 없이 held_event에 보류된다` | 통합(core Kafka + PostgreSQL) | 맞는 JSON 사건 → 기다리면 A 후기 익명화. pid가 들고 accountId가 틀린 사건 → 보류 행 1, `topic` 탈퇴 토픽, 값 null, 값·머리 어디에도 pid 글자 없음. 그룹 `peaket.core-svc.<시험 환경>` | 네이티브 Kafka 모듈이 이 PC의 응용 프로그램 제어에 막히면 CI에서만 돈다. 소비자의 DB는 `core_app` 로그인이다(보류 넣기 권한도 본다) |
| (보충) `COV2-06 ⑬ 0022는 후기 표와 보류 표에 코드가 쓰는 칸·동작만 준다` | 단위(SQL 원문) | 위 0022 표의 GRANT 줄이 모두 있고, `review`·`content_report`·`takedown_action`에 대한 `DELETE`·`TRUNCATE`·칸 없는 `UPDATE`가 없으며, `review` UPDATE 칸 목록에 `id`·`event_id`·`created_at`이 없다. `held_event`의 `core_app` 권한은 `SELECT, INSERT`뿐. journal idx 22의 tag가 `0022_review_role_grants` | 0019 시험과 같은 방식 |
| (보충) `COV2-06 ⑭ 운영 역할 core_app으로 후기 쓰기·신고·통보 가림·조치가 된다` | 통합(core PostgreSQL) | 기존 `test-int/review.int.test.ts`의 시험 넷(동시 쓰기 409, 신고 하루 10건 429, 동시 신고 409, 지문 가림·조치·신고 처리 한 트랜잭션)을 마이그레이션은 관리자로, 서비스는 `loginFor(admin, pg, …, 'core_app', 8)` 로그인으로 띄워 돌린다. 단언은 그대로 | 기존 시험 고침. 0022 전에는 42501로 실패해야 한다 |
| (보충) `COV2-06 ⑮ core_app은 후기의 id·event_id·created_at을 고치지 못하고 후기·신고·조치 행을 지우지 못한다` | 통합(core PostgreSQL) | `core_app` 로그인으로 `UPDATE review SET event_id = …`·`SET id = …`·`SET created_at = …`, `DELETE FROM review`·`content_report`·`takedown_action` 각각 42501. `UPDATE held_event SET reprocessed_at = now()`도 42501 | 최소 권한의 거부 쪽 |
| (보충) `COV2-06 ⑯ 정비 역할로 임시조치 끝내기와 보류 표 정리가 되고, 후기를 새로 쓰지는 못한다` | 통합(core PostgreSQL) | `core_maintenance` 로그인: `notice_until`이 지난 RIGHTS_TEMP 가림 후기와 그 조치를 둔 뒤 정비 일 `review-temp-block-expire`를 한 번 돌리면 후기 `status` VISIBLE·`notice` null, 조치 `restored_at` = 돌린 시각. 지나지 않은 것(경계: `notice_until` = 지금 + 1ms)은 그대로. `deleteReprocessedHeldEvents`가 다시 처리한 지 8일 된 행만 지우고 6일 된 행·다시 처리 안 한 행은 남긴다. `INSERT INTO review`는 42501 | 정비 연결은 relay.ts와 같은 역할 |

**차례**: A2-17·A2-19와 파일이 겹치지 않아 나란히 해도 된다. 시험 담당은 처리기·설정·보류 감싸기의 빈 뼈대(동작 없이 '아직 없음'을 던짐)를 더해 실패를 본다. 구현 담당은 처리기 → `consumers/index.ts` → `consumers/start.ts` → `main.ts` 순으로 한다. (보충) 시험 담당이 ⑬~⑯과 `review.int.test.ts` 고침을 먼저 쓰고 실패를 본 뒤(⑬은 파일 없음, ⑭⑯은 42501), 구현 담당이 0022를 쓴다. 0022는 0021(A2-19) 뒤이므로 A2-19 마이그레이션과 같은 구현 차례에서 이어 쓴다.

**돌릴 통합 시험**(보충으로 고침: `pnpm … test:integration -- <파일>`은 파일 거르기가 먹지 않아 통합 시험 전체가 돈다. 실패 확인 절 참고): core-svc 폴더에서 `npx vitest run --config vitest.integration.config.mjs test-int/review-withdrawn.int.test.ts test-int/review-grants.int.test.ts test-int/review.int.test.ts test-int/review-withdrawn-consumer.int.test.ts`(마지막 것은 Kafka 컨테이너가 필요하다)

**정본 빈칸과 정한 것(이 커밋에 씀)**
- 부르는 길: identity가 내부 경로를 부르지 않고, core-svc가 `peaket.core-svc.<환경>` 그룹으로 탈퇴 사건을 받아 익명화한다. 업무 키는 계정 ID, 커밋이 없으면 EARLIEST. 내부 경로는 손으로 다시 하는 길로 남긴다(identity.md §8, streaming.md §2.6, asyncapi, 추천 적용).
- pid를 core에 남기지 않는다: 읽는 칸은 `eventKey`·`accountId`·`withdrawnAt`뿐이고, 보류 기록의 값은 그 셋의 JSON으로 바꾸며 읽지 못한 값은 값 없이 둔다(data-classification, 추천 적용).
- 운영 환경에서 브로커 설정이 없으면 core-svc가 시작하지 않는다(queue-svc·purchase-svc와 같은 규칙, 법정 파기 의무를 소리 없이 놓치지 않으려는 것, 추천 적용).
- 사건이 없는 계정(본인확인 안 한 계정)은 후기를 쓸 수 없고, 병합 흡수 계정도 후기가 없다(정본 확인, 새로 정한 것 아님).
- 남는 한계: 탈퇴 전 액세스 토큰(최대 15분)으로 사건 처리 뒤 쓴 후기는 계정 ID가 남는다. HOT-400(끝난 세션 토큰 막기)이 막는다(identity.md §8에 적음).
- (보충, 정본에 씀) 후기 표·보류 표의 역할별 권한: 위 0022 표(docs/data.md §2 '후기 표의 DB 권한', §4의 15 'DB 권한', 추천 적용). 규칙 자체(코드가 쓰는 만큼만)는 ADR-0241 결정 4이고 새 결정이 아니다.
- 범위 밖(후속): 탈퇴 계정이 낸 신고(`content_report.reporter_account_id`) 정리, core-svc `AccountMergeCheckService`(지금 없어 병합 확정은 503으로 닫힌다), 서비스별 MSK 권한(그룹·토픽 읽기) 배포 설정, 보류 사건 다시 처리(RB-11)를 core-svc에 붙일 때의 역할과 `reprocessed_at` 고치기 권한, 신고 기록 파기(`content_report.purge_at`) 정비 일과 그 지우기 권한(정비 일이 아직 없다). 다른 core 모듈의 운영 역할 권한은 이번에 전수로 보지 않았다(눈에 띈 것은 후기·보류 표뿐).

**틀린 구현 표본 후보**(탈퇴 익명화는 꼭 넣는다)
1. `handle`이 `anonymizeAccount`를 부르지 않거나 `eventKey`를 계정 ID 자리에 넘긴다.
2. `CORE_TOPICS`에서 탈퇴 토픽을 빼거나 `main.ts`에서 소비자 시작 줄을 뺀다.
3. `pidFreeHeldEventStore`가 값을 그대로 넘긴다(pid가 core DB에 남는다).
4. `kafkaConsumersFromEnv`가 prod에서 브로커가 없어도 `enabled: false`로 뜬다(fail-open).
5. (보충) 0022가 `review`에 칸 없는 `UPDATE`(또는 `DELETE`)를 준다(⑬⑮가 잡는다).
6. (보충) 0022가 `core_maintenance` 줄이나 `core_app`의 `held_event` INSERT를 빠뜨린다(⑯·⑫가 잡는다).

### 5. OPEN 항목(방향을 바꾸는 결정이라 정본에 쓰지 않았다. develop 48faf8a8에서 번호를 받았다: 후보 1 → OPEN[42], 후보 2 → OPEN[43], 후보 3 → OPEN[44])

1. **OPEN[42] 탈퇴한 계정의 후기를 익명화해 남길지, 파기할지(대기: OPEN[42]).** 정본끼리 어긋난다. R-617(2026-11-15)이 쓴 docs/features/identity.md §8 '후기 익명화'는 "본문·평점은 법정 보존·분쟁 대응을 위해 남기고 계정·주문 참조만 끊는다"이다. 그런데 docs/data.md §6 '관람 후기' 행은 "작성자가 지우거나 회원이 탈퇴하면 파기한다. 행은 DELETED로 바꾸며 본문·별점·사진 키·계정 ID를 바로 비운다"이고, docs/security/data-classification.md '관람 후기' 행("후기 삭제 또는 회원 탈퇴 시 파기")과 docs/planning/03-policies-glossary.md 권한표 '관람 후기' 행("탈퇴 때 삭제"), ADR-0086 ⑧(소프트 삭제 때 비우는 칸)도 같은 쪽이다. 후기 본문을 남길 법정 근거는 정본에 없다(법정 차단 조치 증적 3년은 `takedown_action`이 따로 둔다).
   - 추천: (가) 파기 쪽으로 맞춘다. 정본 넷이 같은 쪽이고 개인정보를 덜 남긴다. 하려면 `review.rating` NOT NULL 풀기(마이그레이션), `review_image` 파일·행 지우기, `content_fingerprint` 비우기, 공개 목록·요약에서 빠지는 것을 함께 정해야 한다. (나) R-617대로 두고 data.md·data-classification·planning/03을 고친다.
   - 이번 묶음: 결정 전까지 배선(사건 → 기존 `anonymizeAccount`)만 한다. 어느 쪽이든 '계정·주문 참조를 끊는다'는 같으므로 시험 ①⑪의 그 단언은 남고, 본문·별점·작성자 표시 단언만 바뀐다. identity.md에 결정 대기를 한 줄 적었다.
   - 웨이브 끝 보안 리뷰 S2(=대조 리뷰 R1)의 근거 보탬: 남는 칸은 본문·별점만이 아니라 사진 키·내용 지문(`content_fingerprint`)도 있다. 후기 본문에는 작성자나 다른 사람의 개인정보가 섞여 들 수 있다. 결정 전까지 asvs/catalog-review.md v5.0.0-14.2.7 행을 '부분 적용'으로 낮추고 빠진 몫을 적었다(§7). (가)로 정하면 0022의 `review` 칸 권한(별점을 비우려면 `rating` NOT NULL 풀기)과 `review_image` 지우기 권한도 함께 바뀐다.
2. **OPEN[43] 파트너 명단 접속기록을 어디에 둘지(대기: OPEN[43]).** 정본의 관리 계정 접속기록 저장소는 ops-svc 감사 저장소의 `admin_data_access`(해시 체인, 접속지 정보 `source_ip`, FR-064 매일 이상 점검이 읽는 곳)인데, 구현은 core DB `attendee_export_audit`이다(R-606). 지금은 FR-064 점검(같은 명단 24시간 3회, 1만 건 이상, 근무 일정 밖 조회)이 파트너 명단 기록을 읽지 못한다. 이번 묶음은 core 표를 넓혀 쓰고 data.md에 '옮기는 일은 정해지지 않았다'고 적었다. 접속지 칸(`source_ip`)은 리뷰 R2 보충으로 core 표에도 더했으므로, 남는 차이는 해시 체인과 FR-064 점검이 읽는 곳이다. 옮길지, 옮긴다면 core가 사건으로 보낼지 ops가 읽을지는 소유자 결정이다.
   - 웨이브 끝 보안 리뷰 S1의 근거 보탬: 고시 제8조는 접속기록의 월 1회 이상 점검과 위·변조·도난·분실 방지 조치를 요구한다. core 표는 앱 역할 `core_partner`만 고치거나 지우지 못하고, 표 주인(마이그레이션 역할)과 DB 관리자는 고칠 수 있으며 고친 것을 찾아낼 해시 체인이 없다. data-classification '관리자 시스템 접속기록' 행의 보호 방법(변조를 찾아내는 불변 감사 저장소)과 다르다. 결정 전까지 asvs/settlement.md v5.0.0-16.4.2·16.2.1 행을 '부분 적용'으로 낮추고 빠진 몫을 적었다(§7). 고를 길: (가) ops 감사 저장소로 사건을 보내 옮긴다 (나) core 표를 두고 해시 체인·월 점검 읽기를 core에 붙인다 (다) 위험 수용과 그 기한.
3. **OPEN[44] 탈퇴 직후 15분 창(웨이브 끝 동시 실행 리뷰 K3, 대기: OPEN[44]).** 탈퇴 사건을 받자마자 익명화하므로, 탈퇴 전에 받은 액세스 토큰(최대 15분)으로 사건 처리 뒤에 쓴 후기는 계정·주문 참조를 가진 채 남는다(그 계정의 사건은 다시 오지 않는다). 지금 정본은 이것을 docs/features/identity.md §8 '남는 한계'로 두고 HOT-400(끝난 세션 토큰 막기)을 기다린다. 같은 사건을 읽는 queue-svc는 바로 이 15분 때문에 `withdrawnAt + 15분` 뒤에 처리한다(docs/streaming.md §2.6, ADR-0214 결정 7).
   - 고를 길: (가) core도 `withdrawnAt + 15분` 뒤에 한 번 더 익명화한다(사건 처리는 지금처럼 바로 하고 15분 뒤 같은 계정을 다시 부른다. 익명화는 다시 해도 결과가 같다) (나) HOT-400 전까지 지금 한계를 받아들인다. 추천은 (가)다(같은 저장소의 queue-svc가 이미 같은 까닭으로 늦춘다).
   - 확인할 것: 후기 쓰기 경로가 탈퇴한 계정의 세션을 따로 막는지(ticket-svc 후기 자격 확인이 탈퇴 계정을 거절하면 이 창은 없다).

### 6. 막힌 것·확인할 것

- 막힌 것은 없다. 위 OPEN[42]는 COV2-06 배선을 막지 않는다.
- (보충 2026-11-16) 실패 확인 절 '확인할 것 1'(운영 역할의 후기·보류 표 쓰기 권한)은 §4 보충(0022, 시험 ⑬~⑯)으로 받았다. 기존 후기 쓰기 경로도 같은 결함이라 이번 범위에 넣었다. '확인할 것 2'(0021 CHECK 글)는 §2의 글을 그대로 쓴다. 같은 뜻의 다른 글로 쓰려면 구현 담당이 '시험 이의'로 적는다.
- 장부: `node tools/ci/ledger.mjs --batch BAT-610`은 이 커밋 뒤 J-T26 ④⑤⑥을 'ID만'으로 보인다(기존 파트너 화면 시험 이름이 세부 번호 없이 `J-T26`을 단다). 이 묶음의 시험이 들어오면 채워진다. 기록 담당이 장부를 다시 쓸 때 확인한다.
- 정본 점검: `python -I -X utf8 tools/doc-check/check_all.py` 오류 0, `pnpm --dir packages/contracts gen:check`(asyncapi는 설명만 바꿔 생성물이 같다).

### 7. 웨이브 끝 리뷰 반영(2026-11-16)

웨이브 끝 관점 리뷰 셋(`docs/review/measurements/W7-lane3-review-correctness.md`·`-concurrency.md`·`-security.md`)과 이 파일 `## 검증` 절 가운데 감독이 이번에 고치기로 정한 것이다: C1, C4, K1, K6, K2, S1·S2(정본 상태 고침만), 검증 살아남음 M28·M33(시험 몫). R1=S2(OPEN[42]), S1(OPEN[43]), K3(OPEN[44])은 §5 OPEN 항목에 근거만 보탰다. 차례는 리뷰 반영이다: 시험 담당이 아래 시험을 먼저 쓰고 실패를 본다(`Role: review-fix`, `Fix-By: test`) → 구현 담당(`Fix-By: impl`). 새 마이그레이션 번호는 쓰지 않는다(이번 웨이브 core 번호는 0021·0022뿐).

**정본(이 커밋에 씀, 추천 적용 2026-11-16)**

| 지적 | 정본 |
| --- | --- |
| C1 | docs/features/settlement.md §9 '원천 오류의 응답 계약', docs/api/openapi.yaml `listPartnerEventAttendees`·`createPartnerEventAttendeeExport`의 `'503'`(ServiceUnavailable). 이 바뀜으로 api-client 생성물이 달라진다(아래 '손댈 파일'의 생성물 줄, 구현 담당 몫). contracts 생성물은 같다 |
| C4 | docs/api/guidelines.md §3(빈 문자열 `nextCursor`는 계약 위반), settlement.md §9 '원천 페이지' |
| K1 | docs/data.md §2 `source_ip`(0021은 칸만, NULL 허용. CHECK는 다음 출시) |
| K6 | docs/data.md §2 `DOWNLOAD`·`LIST` 모양 항목(0021의 CHECK 둘은 `NOT VALID`, `VALIDATE`는 다음 출시의 정비 시간) |
| K2 | docs/data.md §5.1 '탈퇴 익명화' 행·§2 '후기 표의 DB 권한'(0022가 `review (account_id)` 색인), docs/streaming.md §2.6 'core-svc 소비자'(따로 둔 풀 최대 2, 파티션 1·키 2) |
| S1 | docs/security/asvs/settlement.md v5.0.0-16.2.1·16.4.2 → '부분 적용'과 빠진 몫 |
| S2 | docs/security/asvs/catalog-review.md v5.0.0-14.2.7 → '부분 적용'과 빠진 몫 |

**손댈 파일**

| 나눔 | 파일 |
| --- | --- |
| 제품 코드 | C1: `services/core-svc/src/modules/export/domain/export.ts`(`ExportProblem`), `…/export/application/attendee-exports.ts`(`guard`, 되풀이 503), `…/export/export.module.ts`(`UnavailableAttendeeSource`), `…/export/adapters/http-attendee-source.ts`(모양 틀림을 503으로). C4: `http-attendee-source.ts`. K2: `services/core-svc/src/consumers/start.ts`, `services/core-svc/src/main.ts`(소비자 전용 풀), `…/review/adapters/db/schema.ts`(색인) |
| 생성물(구현 담당) | C1: api-client 생성물 다시 만들기 — `packages/api-client` 폴더에서 `node scripts/generate.mjs`(또는 `pnpm --filter @peaket/api-client gen`)로 `src/gen/endpoints/partner/partner.ts`를 다시 만들고 `node scripts/check-generated.mjs`로 확인한다(503 응답 타입만 늘어난다. 계획 커밋은 코드 폴더를 바꾸지 않아 이 커밋 뒤 api-client `gen:check`는 구현 커밋 전까지 '다르다'로 나온다). contracts `gen:check`는 지금도 같다 |
| 마이그레이션 | K1·K6: `services/core-svc/migrations/0021_attendee_access_audit_list.sql`(`source_ip` CHECK 줄을 뺀다, CHECK 둘 끝에 `NOT VALID`), `migrations/meta/0021_snapshot.json`(같은 뜻으로). K2: `migrations/0022_review_role_grants.sql` 끝에 `CREATE INDEX "review_account_idx" ON "review" USING btree ("account_id");`(운영 전이라 트랜잭션 안. purchase 0011과 같은 까닭), `migrations/meta/0022_snapshot.json`(새로, 색인 때문에 스키마가 바뀐다), `_journal.json` 그대로 |
| 시험(시험 담당이 고침) | `test/export-audit.test.ts`(0021 원문 시험), `test-int/export-audit.int.test.ts`(R2 통합 시험), `test/export-attendee-source.test.ts`·`test/http-attendee-source.test.ts`(C1·C4), `test/export-paging-limit.test.ts`(C1 되풀이 503 단언), `test/export.test.ts`(C1 HTTP), `test/review-grants.test.ts`(0022 원문), `test-int/review-withdrawn.int.test.ts`(K2 색인), `test/core-consumers.test.ts`(K2·M28·M33, 원문 대조 ⑩ 고침) |
| 다음 출시 후속(이번에 하지 않음) | 새 마이그레이션 하나: `ADD CONSTRAINT "attendee_export_audit_source_ip_check" CHECK ("source_ip" IS NOT NULL) NOT VALID`, 정비 시간에 `VALIDATE CONSTRAINT` 셋(`action`·모양·`source_ip`). 번호는 그 웨이브가 정한다. 기록 담당이 후속 목록에 올린다 |

**공개 인터페이스(바뀌는 곳만)**

```ts
// services/core-svc/src/modules/export/domain/export.ts
export class ExportProblem extends Error {
  constructor(type: string, status: number, title: string, o?: { detail?: string; retryAfterSeconds?: number });
  readonly detail?: string;
  readonly retryAfterSeconds?: number;
}
/** 원천을 쓸 수 없음: 503 dependency-unavailable, 제목은 오류 목록 값, 사정은 detail, Retry-After 30초 [가정] */
export function attendeeSourceUnavailable(detail: string): ExportProblem;
// 쓰는 곳과 detail: 같은 커서 되풀이 '예매자 명단 원천이 같은 페이지를 되풀이했습니다', 조립 없음 '예매자 명단 원천을 쓸 수 없습니다',
// 응답 모양 틀림(빈 nextCursor 포함) '예매자 명단 원천의 응답 모양이 틀렸습니다'. guard는 detail·retryAfterSeconds를 ProblemError로 넘긴다.
// 원천의 2xx 아닌 답·시간 초과는 이번에 바꾸지 않는다(K7 후속, 지금은 500)

// services/core-svc/src/modules/export/adapters/http-attendee-source.ts
// 응답 nextCursor: z.string().min(1).nullable() — ''는 attendeeSourceUnavailable(…모양…)

// services/core-svc/src/consumers/start.ts
// CoreConsumersOptions.database는 소비자 전용 풀이다. runKeyedConsumer에 maxKeys: 2, partitionsConcurrently: 1을 넘긴다
// services/core-svc/src/main.ts
// const consumerDatabase = createDatabase({ url, applicationName: 'core-svc-consumer', max: 2 }); await assertDatabaseRole(consumerDatabase, 'core_app');
// startCoreConsumers({ …, database: consumerDatabase }). SIGTERM: await consumers?.stop() → service.close() → 연결 닫기(consumerDatabase 포함)
```

**시험 목록**

| 지적 | 시험 이름 | 단계 | 단언(정본 값) | 비고 |
| --- | --- | --- | --- | --- |
| C1 | `A2-17 C1 J-T26 ④ 같은 커서를 되풀이하면 503 dependency-unavailable의 목록 제목·detail·Retry-After 30을 싣는다` | 단위 + HTTP | 단위: `ProblemError` `status` 503, `title` '의존 서비스를 잠시 쓸 수 없습니다', `detail` '예매자 명단 원천이 같은 페이지를 되풀이했습니다', `retryAfterSeconds` 30, 이력·접속기록 0. HTTP `POST …/attendee-exports`: 503, 머리 `retry-after: 30`, 본문 `type` `…/dependency-unavailable`·같은 제목·`detail`, `content-disposition` 없음 | 기존 'A2-17 J-T26 ④ 원천이 같은 커서를 되풀이하면 503이고 …' 시험에 단언을 더한다 |
| C1 | `A2-17 C1 원천이 조립되지 않았을 때도 같은 503 계약이다` | 단위 | 운영 조립(`purchaseHttp` 없음)의 원천이 던진 오류가 `guard`를 거쳐 503·목록 제목·`detail` '예매자 명단 원천을 쓸 수 없습니다'·`retryAfterSeconds` 30 | `export-attendee-source.test.ts`의 기존 503 시험 고침 |
| C1·C4 | `A2-17 C4 HttpAttendeeSource는 빈 문자열 nextCursor와 틀린 응답 모양을 503으로 거절한다` | 단위 | `nextCursor: ''`, `nextCursor` 없음, `nextCursor: 5`, `items: {}` 각각 `ExportProblem`(503, `detail` '예매자 명단 원천의 응답 모양이 틀렸습니다'). `nextCursor: 'a'`(한 글자)는 받는다(경계 반대쪽) | 기존 '응답 모양이 틀리면 실패한다' 시험의 단언을 503으로 좁힌다 |
| C1 | `A2-17 C1 GET …/attendees는 원천을 쓸 수 없으면 503과 Retry-After 30이고 접속기록이 없다` | HTTP | 원천이 `attendeeSourceUnavailable`을 던지면 503·`retry-after: 30`, `views` 0 | |
| K1·K6 | `A2-19 0021은 action·filter를 더하고 LIST·DOWNLOAD 모양을 CHECK로 강제하며 UPDATE·DELETE를 주지 않는다`(고침) | 단위(SQL 원문) | R2 보충 때 더한 `CHECK ("source_ip" IS NOT NULL) NOT VALID` 단언을 **반대로** 바꾼다: `source_ip` 칸 추가(`inet`)는 있고, `source_ip`에 대한 CHECK·`SET NOT NULL`·`VALIDATE`가 0021에 없다. (K6) `action`·모양 CHECK 둘은 끝에 `NOT VALID`가 붙고, `VALIDATE CONSTRAINT`가 없다 | **K1·K6 때문에 바뀌는 0021 원문 시험** |
| K1 | `A2-19 R2 0021 뒤 접속지 없는 새 행은 CHECK가, IP 모양이 아닌 값은 inet이 거절한다`(고침, 이름을 `A2-19 R2 K1 0021 뒤 접속지 없는 새 행도 DB는 받고(이전 판 호환), IP 모양이 아닌 값은 inet이 거절한다`로 바꾼다) | 통합(core PostgreSQL) | `source_ip` 없이 넣기는 **성공**(지금 단언 23514를 뒤집는다), `'abc'` 22P02, `'2001:db8::1'` 그대로 읽힘. `recordView`·`recordExport`로 넣은 행은 `source_ip`가 넘긴 IP(앱이 강제) | **K1 때문에 바뀌는 R2 통합 시험** |
| K1 | `A2-19 K1 0021 뒤에도 이전 판(N-1) 코드의 내려받기 기록 모양이 들어간다` | 통합(core PostgreSQL) | `core_partner` 로그인으로 853758eb 판이 쓰던 문장(`action`·`filter`·`source_ip` 없이 `id, export_id, promoter_id, event_id, actor_account_id, actor_display_name, actor_role, reason, format, count, created_at, retain_until`)을 넣으면 성공하고 `action` 'DOWNLOAD'·`filter` `{}`·`source_ip` NULL로 읽힌다 | docs/devops.md §7.3 적용 시험 ③의 작은 꼴 |
| K1·K6 | `A2-19 K6 0019 행이 있는 DB에 0021·0022를 적용해도 실패하지 않고 옛 행은 그대로다` | 통합(core PostgreSQL) | 0020까지 적용 → 0019 모양 행 하나 → 0021·0022 적용 성공. 옛 행 `action` 'DOWNLOAD'·`filter` `{}`·`source_ip` NULL. `pg_constraint.convalidated`가 `action`·모양 CHECK 둘 모두 false(NOT VALID) | 정확성 리뷰 C3과 같은 시험 |
| K2 | `COV2-06 K2 0022는 review(account_id) 색인을 만든다` | 단위(SQL 원문) | `CREATE INDEX "review_account_idx" ON "review" USING btree ("account_id")`가 있다. ⑬의 기존 단언(GRANT·REVOKE 없음)은 그대로 | `review-grants.test.ts` |
| K2 | `COV2-06 K2 탈퇴 익명화는 review_account_idx로 찾는다` | 통합(core PostgreSQL) | `SET enable_seqscan = off` 뒤 익명화 문장의 `EXPLAIN (FORMAT JSON)`이 `review_account_idx`를 쓴다. 색인이 없으면(이름이 다르면) 실패 | docs/devops.md §7.3 실행 계획 검사의 작은 꼴 |
| K2 | `COV2-06 K2 소비자는 따로 둔 core_app 풀과 파티션 1·키 2로 돈다` | 단위(가짜 `runKeyedConsumer`) + 원문 대조 | `startCoreConsumers`가 `runKeyedConsumer`에 `maxKeys: 2`·`partitionsConcurrently: 1`과 받은 풀로 만든 보류 저장소를 넘긴다(값은 정본 숫자로 적는다). `main.ts` 글: 소비자 풀이 `max: 2`로 만들어지고 `assertDatabaseRole(그 풀, 'core_app')`을 거치며 `startCoreConsumers({ … database: 그 풀 })`에 넘겨지고, API의 `database`는 넘겨지지 않는다 | 기존 ⑩(R5에서 `database`가 core_app인지 본 단언)을 이 풀 이름으로 고친다 |
| M28 | `COV2-06 ⑰ main.ts의 소비자 시작은 조건 없이 돈다` | 단위(원문 대조) + 통합(선택) | 원문: `consumers = startCoreConsumers({`가 `kafka.enabled`(또는 같은 뜻의 설정) 분기 안에서 앞에 `&&`·`?`·`if (false`·주석 없이 대입되는 문장이다. 통합(선택, 검증 담당 제안): `PEAKET_ENV=ci`·`PEAKET_KAFKA_BROKERS=127.0.0.1:1`로 빌드한 `dist/main.js`를 띄우면 'Kafka 소비자를 켜지 못해' 한 줄과 종료 코드 1로 끝난다(닿지 않는 브로커에서 `connect()`가 거부하는지는 동시 실행 리뷰 K4의 확인 필요라, 거부하지 않으면 이 통합 시험은 시험 이의로 넘긴다) | 검증 살아남음 M28 |
| M33 | `COV2-06 ⑱ SIGTERM은 소비자 stop()이 끝난 뒤에 서비스와 연결을 닫는다` | 단위(원문 대조) | SIGTERM 처리 글에서 `await consumers?.stop(`(또는 그 약속을 `.then`으로 기다린 뒤)가 `service.close(`보다 앞이고, 연결 닫기(`database.close`·소비자 풀 닫기)가 그 뒤다. `void consumers?.stop(`이나 기다리지 않는 꼴이면 실패 | 검증 살아남음 M33 |

**틀린 구현 표본 후보(웨이브 끝 반영)**
1. (C1) 되풀이 503의 제목을 지금 문구('예매자 명단 원천이 같은 페이지를 되풀이했습니다')로 둔다, 또는 `retryAfterSeconds`를 빠뜨린다.
2. (C4) 응답 검사를 `z.string().nullable()`로 되돌린다.
3. (K1) 0021에 `source_ip` CHECK를 남긴다(이전 판 호환 시험이 잡는다).
4. (K6) CHECK 둘에서 `NOT VALID`를 뺀다.
5. (K2) `maxKeys`를 넘기지 않거나 소비자에 API의 `database`를 넘긴다.
6. (M33) SIGTERM에서 `await`를 `void`로 바꾼다.

**이번에 하지 않는 것(후속·OPEN)**: K3(§5, 대기: OPEN[44]), K4(Kafka 장애 때 API 새 파드가 못 뜨는 문제), K5·S7(값 없는 보류 행을 닫는 절차와 보류 기한·경보), K7(긴 내려받기 전체 한도·취소, 원천 2xx 아닌 답의 503), K8(purchase 합계 쿼리), K9, C2·R4(보류 감싸기 해독기, BAS-030 때), S3(접속지 대체 지표), S4(커서 길이 상한), S5(토큰 길이 비교), S6(`restored_at` 한 번 쓰기, 익명화 역할 분리), S8(CSV 널 문자), S9(원천에 파트너 ID). 기록 담당이 구간 끝 정리 목록에 올린다.

## 실패 확인

- **누가·언제**: 시험 담당(세션 `l3w7-audit-test`), 2026-11-16. 가지 `wave/lane3-w7`, 계획 커밋 `f6c3568e` 위. Docker 없이 돌렸다.
- **가져온 시험**: `039d6c0d`(R-625 독립 시험 작성자)의 두 파일을 `cherry-pick -n`으로 가져와 계획 §0대로 고쳤다. `test/export-paging-limit.test.ts`의 짧은 페이지 시험은 배열 대신 `{ items, nextCursor }`를 돌려주고 둘째 페이지 1,001건을 1,000건 + 1건으로 나눴다. `test/export-audit.test.ts`의 두 시험은 `as unknown as` 형 변환·`auditList` 이름 대신 `recordView`·넷째 인자 `actor`로 부르고, 비원자 동작을 굳히던 `expect(store.inserted).toBeDefined()`를 지웠다.

### 뼈대와 모양만 바꾼 제품 코드(동작은 그대로)

시험이 컴파일되게 공개 인터페이스만 더했다. 새 메서드·함수는 `throw new Error('아직 없음')`이고, 모양이 바뀐 곳은 지금 동작을 그대로 두고 타입만 맞췄다(각 자리에 '뼈대(W7-audit 시험 단계)' 주석). 구현 담당이 채우거나 뺄 것:

| 파일 | 한 것 | 구현 담당이 할 것 |
| --- | --- | --- |
| `export/domain/ports.ts` | `AttendeeSourcePage`·`AttendeeViewRecord` 더함, `AttendeeSource.list`가 페이지를 돌려줌, `AttendeeExportStore`에 `recordExport`·`recordView` 더함 | 지금 내려받기 동작을 살리려고 남긴 `insert`·`audit`을 포트에서 뺀다(계획 §2) |
| `export/adapters/memory-export-store.ts` | `views` 배열, `recordExport`·`recordView` 뼈대 | 채우고 `insert`·`audit`을 뺀다 |
| `export/adapters/db/drizzle-export-store.ts` | `recordExport`·`recordView` 뼈대 | 채우고 `insert`·`audit`을 뺀다 |
| `export/domain/export.ts`, `export/index.ts` | `accessLogRetainUntil` 뼈대와 내보내기 | 채운다 |
| `export/application/attendee-exports.ts` | 원천 결과에서 `.items`만 꺼냄(끝 판단·커서 만들기는 옛 그대로), `listAttendees` 넷째 인자 `_actor?`(쓰지 않음) | 계획 §1·§2대로 고친다. 넷째 인자는 필수로 해도 된다(시험은 늘 넘기고, 빠진 경우는 형 변환으로 넘긴다) |
| `export/adapters/http-attendee-source.ts` | `{ items, nextCursor: null }`(옛 동작처럼 원천 커서를 버림) | 원천 `nextCursor`를 넘기고 응답 모양을 검사한다 |
| `export/export.module.ts` | `MerchAttendeeSource`가 `MemoryMerchOrderStore`를 받음 | 그대로 |
| `shop/domain/merch-ports.ts` | `listAttendees`·`countAttendees`를 포트에서 뺌 | `DrizzleMerchOrderStore`의 두 메서드(죽은 코드, `limit * 10`)를 지운다 |
| `shop/adapters/memory-merch-store.ts` | `listAttendees`가 `{ items, nextCursor: null }` | 다음 주문이 있을 때만 커서를 준다 |
| 새 `review/inbound/account-withdrawn.handler.ts`, `review/index.ts` | 처리기·코덱 뼈대(`ACCOUNTS_WITHDRAWN_TOPIC`만 실제 이름) | 채운다 |
| 새 `src/consumers/index.ts`·`start.ts` | `CORE_GROUP`·`kafkaConsumersFromEnv`·`pidFreeHeldEventStore`·`startCoreConsumers` 뼈대, `CORE_TOPICS`는 빈 배열을 형 변환 | 채운다. `main.ts`는 손대지 않았다 |

### 단위 시험(Docker 없음)

명령은 각 패키지 폴더에서 `npx vitest run <파일>`(`pnpm test`의 `vitest run`과 같다)이다. 전체: `pnpm --dir D:/ticketpass-lane3/services/core-svc test` 시험 427개 가운데 **29개 실패, 398개 통과**. 실패 29개는 모두 이 묶음의 새 시험이고, 그 밖의 기존 시험은 모두 통과했다. `pnpm --dir … typecheck`는 core-svc·purchase-svc·platform 모두 오류 0, 닿은 경로 `npx eslint` 오류 0.

| 파일 | 시험 | 결과 | 실패 까닭 |
| --- | --- | --- | --- |
| core `test/export-paging-limit.test.ts` | A2-17 J-T26 ④ 정확히 1,000건이고 nextCursor가 null이면 더 부르지 않는다 | 실패 | 단언: 한 번 더 부른다(`[1000, 1000]`) |
| 〃 | A2-17 J-T26 ④ 999건 짧은 페이지 뒤에도 nextCursor로 이어 읽어 2,000건을 모두 내보낸다 | 실패 | 단언: 999건에서 멈춘다(가져온 재현 시험) |
| 〃 | A2-17 J-T26 ④ 0건 페이지와 다음 커서가 와도 멈추지 않는다 | 실패 | 단언: 0건에서 멈춘다 |
| 〃 | A2-17 J-T26 ④ 원천이 같은 커서를 되풀이하면 503이고 이력·접속기록이 없다 | 실패 | 단언: 조용히 끝나 성공한다 |
| 〃 | A2-17 J-T26 ④ 명단 보기 응답의 nextCursor는 원천 값 그대로다 | 실패 | 단언: null을 준다 |
| 〃 | 2,500행도 1,000행 이하 페이지로만 읽고 건수를 잃지 않는다(기존) | 통과 | — |
| core `test/http-attendee-source.test.ts` | A2-17 HttpAttendeeSource는 원천의 nextCursor를 넘기고 다음 요청에 그 커서를 싣는다 | 실패 | 단언: `nextCursor`가 null |
| 〃 | A2-17 HttpAttendeeSource는 응답 모양이 틀리면 실패한다 | 실패 | 단언: 거절하지 않는다 |
| 〃 | A2-03 기존 시험(`page.items`로 고침) | 통과 | — |
| core `test/export-attendee-source.test.ts` | A2-17 메모리 명단 원천은 다음 주문이 있을 때만 nextCursor를 준다 | 실패 | 단언: 커서가 null |
| 〃 | A2-03 기존 다섯(페이지 모양·넷째 인자로 고침) | 통과 | — |
| core `test/export-audit.test.ts` | A2-19 J-T26 ⑤ 명단 보기는 행위자·보인 건수·조건을 LIST 접속기록에 남긴다 | 실패 | 단언: 접속기록 0건(가져온 재현 시험) |
| 〃 | A2-19 J-T26 ⑤ 접속기록을 남기지 못하면 명단을 돌려주지 않는다 | 실패 | 단언: 명단을 돌려준다 |
| 〃 | A2-19 J-T26 ⑤ 행위자 없이 부르면 원천을 읽지 않고 실패한다 | 실패 | 단언: 거절하지 않는다 |
| 〃 | A2-19 J-T26 ⑤ 명단을 보이지 않은 요청은 접속기록에 남지 않는다 | **처음부터 통과(이미 있는 동작)** | 404·410은 지금도 기록 전에 끝난다 |
| 〃 | A2-19 J-T26 ⑥ 내려받기는 이력과 DOWNLOAD 접속기록을 recordExport 한 번으로 쓴다 | 실패 | 단언: `['insert', 'audit']`를 따로 부른다 |
| 〃 | A2-19 J-T26 ⑥ 접속기록 저장이 실패하면 내려받기 성공으로 답하지 않는다 | 실패 | 단언: 성공한다(가져온 재현 시험) |
| 〃 | A2-19 J-T26 ⑥ Drizzle recordExport는 두 행을 한 트랜잭션에 넣는다 | 실패 | 뼈대 '아직 없음' |
| 〃 | A2-19 J-T26 ⑤ Drizzle recordView는 LIST 행을 export_id·reason·format 없이 넣는다 | 실패 | 뼈대 '아직 없음' |
| 〃 | A2-19 J-T26 ⑤ 접속기록 보존 끝은 만든 때 + 2년(달력)이다 | 실패 | 뼈대 '아직 없음' |
| 〃 | A2-19 0021은 action·filter를 더하고 LIST·DOWNLOAD 모양을 CHECK로 강제하며 UPDATE·DELETE를 주지 않는다 | 실패 | 마이그레이션 파일이 아직 없다(ENOENT) |
| 〃 | 0019는 접속기록 표를 만들고 core_partner에 SELECT·INSERT만 준다(기존) | 통과 | — |
| core `test/export.test.ts` | A2-17 J-T26 ④ 명단 보기 응답의 nextCursor는 원천 값 그대로다 — GET …/attendees | 실패 | 단언: null을 준다 |
| 〃 | A2-19 J-T26 ⑤ GET …/attendees는 로그인 주체를 접속기록 행위자로 쓴다 | 실패 | 단언: 접속기록 0건 |
| 〃 | A2-19 J-T26 ⑥ 접속기록 저장이 실패하면 내려받기 성공으로 답하지 않는다 — POST …/attendee-exports | 실패 | 단언: 200과 파일을 준다 |
| 〃 | 기존 열 개(원천 람다·저장소를 바꿀 수 있게 고침) | 통과 | — |
| core `test/export-paging.test.ts`, `test/export-reauth.test.ts`, `test/export-reauth-cases.test.ts` | 기존 일곱(원천을 페이지 모양으로만 고침) | 통과 | — |
| core `test/review-withdrawn.test.ts` | COV2-06 ①②③④⑤ | 실패 5 | 뼈대 '아직 없음'(④는 맞는 값 대조군이 먼저 실패한다) |
| 〃 | COV2-06 ⑨ 내부 익명화 경로는 토큰이 없거나 틀리면 403이고 맞으면 바꾼 건수를 준다 | **처음부터 통과(이미 있는 동작)** | R-617 경로가 이미 있다 |
| core `test/core-consumers.test.ts` | COV2-06 ⑥⑦⑧ | 실패 3 | 뼈대 '아직 없음' |
| 〃 | COV2-06 ⑩ main.ts는 시작 전에 Kafka 설정을 읽고 듣기 뒤에 후기 탈퇴 소비자를 켠다 | 실패 | 단언: `main.ts`에 `kafkaConsumersFromEnv(`가 없다 |
| core `test/internal-sale-config-token-boot.test.ts` | SEC-06R ①②③④ | **처음부터 통과(이미 있는 동작)** 4 | 계획대로 시험만 더했다. 검증 담당이 틀린 구현(M1 빈 `onModuleInit`, M3 `===`, `super` 안 부름, `required` 주입 뺌)으로 실패를 본다 |
| platform `test/internal-token-constant-time.test.ts` | SEC-06R ⑤ InternalTokenGuard는 길이가 같은 토큰을 timingSafeEqual로 비교한다 | **처음부터 통과(이미 있는 동작)** | 〃 |

- 요약: 새로 쓰거나 고쳐 쓴 시험 36개 가운데 실패 29개(뼈대 '아직 없음' 11, 마이그레이션 파일 없음 1, 단언 17), 처음부터 통과 7개(A2-19 ⑤ 404·410, COV2-06 ⑨, SEC-06R ①~⑤).
- `node tools/ci/trace-check.mjs --ids "J-T26,SEC-06R,COV2-06,A2-17,A2-19" --report <core 단위 JSON 보고서>`는 통과(0)였다. 세부 번호가 아니라 ID만 세므로 이 단계에서는 뜻이 없다. 구현 뒤 게이트에서 다시 본다.

### 통합 시험(도커 잠금 아래 2026-11-16 08:52 KST부터 돌림)

명령은 각 패키지 폴더에서 `npx vitest run --config vitest.integration.config.mjs <파일>`이다. **주의**: 계획에 적은 `pnpm … test:integration -- <파일>`은 vitest에 `-- <파일>`로 넘어가 파일 거르기가 먹지 않고 그 패키지의 통합 시험 전체가 돌았다(purchase-svc에서 그 파일이 띄우지 않는 Valkey 컨테이너까지 떠서 알았다. 멈추고 남은 시험 컨테이너를 지웠다).

| 시험 | 명령(패키지 폴더) | 필요한 것 | 결과 | 까닭 |
| --- | --- | --- | --- | --- |
| A2-17 J-T26 ④ purchase 명단 원천은 SOLD 좌석이 없는 주문을 걸러도 다음 커서를 준다 | purchase-svc `npx vitest run --config vitest.integration.config.mjs test-int/attendee-reader.int.test.ts` | Docker(PostgreSQL) | **처음부터 통과(이미 있는 동작)** 1/1 | 처음 돌릴 때는 시험 준비가 상태 이력 지연 제약(`order_status_has_event`, 0003)에 걸려 23514였다. 시험 쪽만 고쳐(주문 행과 이력 행을 한 트랜잭션에 넣음) 다시 돌렸다 |
| A2-19 J-T26 ⑥ 접속기록 넣기가 실패하면 attendee_export도 남지 않는다 | core-svc `npx vitest run --config vitest.integration.config.mjs test-int/export-audit.int.test.ts` | Docker(PostgreSQL) | 실패 | 뼈대 '아직 없음'(`recordExport`). 먼저 넣는 충돌 행은 core_partner로 들어갔다 |
| A2-19 J-T26 ⑤⑥ 0021 뒤 LIST·DOWNLOAD 행이 들어가고 모양이 틀리면 CHECK가 거절한다 | 〃 | 〃 | 실패 | 뼈대 '아직 없음'(`recordView`). 0021도 아직 없다 |
| A2-19 core_partner는 접속기록을 고치거나 지우지 못하고 다른 테넌트 행을 읽지 못한다 [ASVS v5.0.0-8.4.1] | 〃 | 〃 | 실패 | 뼈대 '아직 없음'(`recordView`로 행을 만드는 첫 줄) |
| COV2-06 ⑪ Drizzle 익명화는 그 계정 행만 바꾸고 다시 해도 0건이다 | core-svc `npx vitest run --config vitest.integration.config.mjs test-int/review-withdrawn.int.test.ts` | Docker(PostgreSQL) | 실패 | 단언 밖 DB 오류 42501(권한 없음): core_app이 `review`를 UPDATE하지 못한다. 계획은 '처음부터 통과 예상'이었다. 아래 '확인할 것 1'이 맞았다 |
| COV2-06 ⑫ 실제 Kafka의 탈퇴 사건이 core 후기를 익명화하고, 읽지 못한 사건은 pid 없이 held_event에 보류된다 | core-svc `npx vitest run --config vitest.integration.config.mjs test-int/review-withdrawn-consumer.int.test.ts` | Docker(PostgreSQL + Kafka), 네이티브 Kafka 모듈 | 실패 | 뼈대 '아직 없음'(`startCoreConsumers`). 이 PC에서 네이티브 Kafka 모듈이 막히지 않았다(Kafka 컨테이너·토픽·생산자 연결까지 됐다). 처음에는 소비자를 `beforeAll`에서 켜 시험이 '건너뜀'으로 보였으므로 켜기를 시험 안으로 옮겨 이 시험의 실패로 남겼다(시험 쪽만 고침). 구현 뒤에도 '확인할 것 1'(review UPDATE·held_event INSERT 권한)에 걸릴 것이다 |

- 통합 합계: 6개 가운데 실패 5(뼈대 4, 권한 42501 1), 처음부터 통과 1. 돌린 뒤 이 갈래 시험 컨테이너는 남지 않았다(`docker ps`).

- 시험 도우미: 새 `services/core-svc/test-int/kafka.ts`(queue-svc의 것에서 `startKafka`·`until`만 옮김).

### 보충 시험(시험 3단계, 계획 보충 `337a191c`의 ⑬~⑯. 통합은 도커 잠금 아래 2026-11-16 09:20 KST부터 돌림)

제품 코드·마이그레이션은 쓰지 않았다(0022는 구현 담당 몫). core-svc typecheck 오류 0.

| 시험 | 파일 | 단계 | 명령(core-svc 폴더) | 결과 | 까닭 |
| --- | --- | --- | --- | --- | --- |
| COV2-06 ⑬ 0022는 후기 표와 보류 표에 코드가 쓰는 칸·동작만 준다 | 새 `test/review-grants.test.ts` | 단위(SQL 원문) | `npx vitest run test/review-grants.test.ts` | 실패 1 | 마이그레이션 파일이 아직 없다(ENOENT). GRANT 문을 (역할, 표, 권한, 칸)으로 풀어 계획 §4 보충 0022 표와 정확히 같은지 본다(줄 나눔·순서·따옴표·`public.`이 달라도 같은 뜻이면 통과). GRANT·REVOKE 밖의 문이 있으면 실패 |
| COV2-06 ⑭(기존 넷: 동시 쓰기 409, 신고 하루 10건 429, 동시 신고 409, 지문 가림·조치·신고 처리 한 트랜잭션) | 고침 `test-int/review.int.test.ts` | 통합(PostgreSQL) | `npx vitest run --config vitest.integration.config.mjs test-int/review.int.test.ts` | 실패 4(⑭ 넷), 0013 표 확인 1 통과 | 후기 쓰기·신고가 500이다(서비스 로그는 시험에서 숨긴다. core_app 로그인으로 바꾼 것 말고는 전과 같아 권한 거부로 본다). 뒤 둘(동시 신고 404, 통보 가림의 '후기 ID가 올바르지 않습니다')은 앞 단계의 후기 쓰기가 실패해 이어진 것이다. 서비스를 `loginFor(admin, pg, 'core_app_review_int', 'core_app', 8)`로 띄우고, 마이그레이션·시험 자료·확인은 관리자 연결로 바꿨다. 단언은 그대로이고 네 시험 이름 앞에 `COV2-06 ⑭`를 달았다. 0022 전에는 후기 쓰기가 42501이라 실패해야 한다. 0013 표 확인 시험(첫째)은 관리자로 읽어 그대로 통과해야 한다 |
| COV2-06 ⑮ core_app은 후기의 id·event_id·created_at을 고치지 못하고 후기·신고·조치 행을 지우지 못한다 | 새 `test-int/review-grants.int.test.ts` | 통합(PostgreSQL) | `npx vitest run --config vitest.integration.config.mjs test-int/review-grants.int.test.ts` | 실패 | 허용 쪽 대조군(`review.updated_at` 고치기)이 42501이다. 거부 일곱(42501)에 더해 경계의 허용 쪽 대조군 둘(`review.updated_at` 고치기, 지문 지우기)을 두었다. 그래서 0022 전에는 대조군에서 실패하고, 0022 뒤에는 거부·허용이 모두 맞아야 통과한다 |
| COV2-06 ⑯ 정비 역할로 임시조치 끝내기와 보류 표 정리가 되고, 후기를 새로 쓰지는 못한다 | 〃 | 통합(PostgreSQL) | 〃 | 실패 | 정비 일의 `update review …`가 42501(`permission denied for table review`)이다. `core_maintenance` 로그인으로 실제 정비 일(`reviewMaintenanceTasks`의 `review-temp-block-expire`, `platformMaintenanceTasks`의 `held-events-delete`)을 돌린다. 끝 시각 지금 − 1ms는 풀리고 지금 + 1ms는 그대로, 다시 처리한 지 8일 행만 지우고 6일·다시 처리 안 한 행은 남는다. 0022 전에는 42501로 실패해야 한다 |

- 보충 통합 시험을 한 번에 돌렸다: core-svc 폴더에서 `npx vitest run --config vitest.integration.config.mjs test-int/review-withdrawn.int.test.ts test-int/review-grants.int.test.ts test-int/review.int.test.ts test-int/review-withdrawn-consumer.int.test.ts`(마지막 것은 Kafka 컨테이너). 시험 9개 가운데 실패 8, 통과 1(0013 표 확인). 다시 돈 ⑪은 전과 같이 42501, ⑫는 전과 같이 뼈대 '아직 없음'(`startCoreConsumers`)이다. ⑪⑫는 0022와 소비자 구현 뒤 통과해야 한다. 돌린 뒤 이 갈래 시험 컨테이너는 남지 않았다(`docker ps -a`).

### 확인할 것(계획 담당·감독에게)

1. **core_app에는 review·held_event 쓰기 권한이 없다(통합 시험 ⑪이 42501로 확인, 2026-11-16).** 0004가 `GRANT SELECT ON ALL TABLES … TO core_app`만 주고, 0013(review)·0000(held_event)과 그 뒤 마이그레이션에 core_app 쓰기 권한이 없다(`grep -n GRANT services/core-svc/migrations/*.sql`). 계획 §4의 `CoreConsumersOptions.database`는 core_app이고 `main.ts`도 core_app으로 붙으므로, ⑪(계획은 '처음부터 통과 예상')과 ⑫는 운영과 같은 core_app 로그인으로 써 두었다. 그대로면 `UPDATE review`와 `INSERT held_event`가 42501로 실패할 것이다. 계획 §4는 '마이그레이션 없음'이라 구현 담당이 막힌다. 권한 마이그레이션(예: core_app에 review의 익명화 칸 UPDATE, held_event 넣기·다시 처리 권한)을 계획에 더할지 정해야 한다. 같은 까닭으로 지금의 후기 쓰기 경로(`POST /v1/events/{id}/reviews`)도 운영 역할에서는 실패할 수 있다(기존 `test-int/review.int.test.ts`는 슈퍼유저로 붙어 드러나지 않았다). 이 묶음 범위 밖이면 따로 적어 둔다.
2. 0021 시험은 CHECK 글을 표 이름 접두·따옴표·공백을 지운 뒤 계획의 글(`action in ('LIST','DOWNLOAD')`, `(action = 'DOWNLOAD' and export_id is not null and reason is not null and format is not null) or (action = 'LIST' and export_id is null and reason is null and format is null)`)로 견준다. 뜻이 같은 다른 글로 쓰면 '시험 이의'로 알려 달라.

### 리뷰 반영(시험 쪽, 리뷰 R2·R5·R6, 2026-11-16)

- **뼈대**: 새 공개 인터페이스만 더했다. `ExportActor.clientIp`·`AttendeeViewRecord.clientIp`는 선택 칸, `recordExport`의 둘째 인자 `access`는 선택 인자로 두어 지금 코드가 컴파일되게 했다(구현 담당이 필수로 바꾸고 검사한다). 메모리 저장소 `audits`의 타입에 `clientIp`를 더했다. 새 `export/inbound/client-ip.ts`의 `clientIpOf`는 '아직 없음'을 던진다. 컨트롤러·0021·스키마는 손대지 않았다.
- **전체 단위**: core-svc 폴더에서 `npx vitest run` 시험 436개 가운데 실패 10, 통과 426. 실패 10개는 모두 R2 시험이고 그 밖은 모두 통과한다. typecheck 오류 0, 닿은 경로 eslint 오류 0.

| 지적 | 시험 | 파일 | 결과 | 까닭 |
| --- | --- | --- | --- | --- |
| R2 | A2-19 R2 J-T26 ⑤ 명단 보기 접속기록에 요청의 접속지를 남긴다 | `test/export-audit.test.ts`(단위), `test/export.test.ts`(— GET …/attendees, 머리 넷: IP, 없음, IP 아님, IPv6) | 실패 2 | 단언: 접속지가 `undefined`다 |
| R2 | A2-19 R2 J-T26 ⑤ 접속지를 정하지 못하면 원천을 읽지 않고 실패한다 | `test/export-audit.test.ts` | 실패 | 단언: `''`·`'abc'`·`'300.1.1.1'`에도 명단을 돌려준다(칸이 아예 없는 행위자도 본다) |
| R2 | A2-19 R2 J-T26 ⑥ 내려받기 접속기록에도 접속지를 남기고 이력 응답에는 싣지 않는다 | `test/export-audit.test.ts`(단위), `test/export.test.ts`(— POST·GET …/attendee-exports) | 실패 2 | 단언: `recordExport` 둘째 인자·DOWNLOAD 접속기록에 접속지가 없다 |
| R2 | A2-19 R2 Drizzle 접속기록 넣기 값에 source_ip가 있다 | `test/export-audit.test.ts` | 실패 | 단언: `sourceIp`가 없다 |
| R2 | A2-19 R2 클라이언트 IP는 다시 쓴 x-forwarded-for가 IP일 때만 그것이고 아니면 연결 주소다 | 새 `test/client-ip.test.ts` | 실패 | 뼈대 '아직 없음' |
| R2 | A2-19 0021은 action·filter를 더하고 …(고침: `ADD COLUMN "source_ip" inet`, `CHECK (source_ip is not null) NOT VALID`) | `test/export-audit.test.ts` | 실패 | 단언: 0021에 `source_ip` 칸이 아직 없다 |
| R2 | 기존 둘에 접속지 단언을 더함: A2-19 J-T26 ⑤ 명단 보기는 행위자·보인 건수·조건을 …, A2-19 J-T26 ⑥ 내려받기는 … recordExport 한 번으로 쓴다 | `test/export-audit.test.ts` | 실패 2 | 단언: 접속지가 없다 |
| R2 | 행위자 객체에 `clientIp`를 더함(export 시험 여섯 파일) | `test/export-paging-limit.test.ts` 등 | 통과 | 모양만 고침 |
| R2 | A2-19 R2 0021 뒤 접속지 없는 새 행은 CHECK가, IP 모양이 아닌 값은 inet이 거절한다 | `test-int/export-audit.int.test.ts` | 실패(10:22 KST 도커 잠금 아래 돌림) | 단언: 접속지 칸 없이 넣은 새 행이 거절되지 않고 들어간다(0021에 CHECK가 아직 없다). 같은 파일의 준비(직접 넣는 접속기록 행 둘)에 `source_ip`를 넣고, `recordView`·`recordExport` 부르기에 접속지를 실었다 |
| R5 | COV2-06 ⑩ R5 main.ts는 후기 탈퇴 소비자에 core_app으로 확인한 DB를 넘긴다 | `test/core-consumers.test.ts` | 지금 코드에서 통과 | 손 확인: `main.ts`의 소비자 인자를 `database: partnerDatabase`로 바꾸면 이 시험이 실패하고(기존 ⑩은 그래도 통과), 되돌린 뒤 통과. `git diff`로 `main.ts`가 깨끗한 것을 봤다 |
| R6 | COV2-06 ⑬ 0022는 …(고침: REVOKE도 비교해 없어야 한다) | `test/review-grants.test.ts` | 지금 코드에서 통과 | 손 확인: 0022 끝에 `REVOKE UPDATE (account_id, basis_order_id) ON review FROM core_app`을 더하면 실패하고, 되돌린 뒤 통과. `git diff`로 0022가 깨끗한 것을 봤다 |

- **통합 시험 결과(10:22 KST 도커 잠금 아래)**: core-svc 폴더에서 `npx vitest run --config vitest.integration.config.mjs test-int/export-audit.int.test.ts` 시험 4개 가운데 실패 3, 통과 1. 위 R2 시험 말고도 둘이 실패한다. 'A2-19 J-T26 ⑥ 접속기록 넣기가 실패하면 …'은 준비의 직접 넣기가 `source_ip` 칸 없음(42703)이다. 'A2-19 J-T26 ⑤⑥ 0021 뒤 LIST·DOWNLOAD …'는 저장소로 넣은 두 행은 맞게 읽혔지만, 틀린 모양 넣기에서 23514 대신 42703이 난다. 셋 다 0021에 `source_ip`가 생기면 풀려야 한다. 'A2-19 core_partner는 …'은 통과했다. 이 갈래 시험 컨테이너는 남지 않았다(`docker ps -a`).

### 웨이브 끝 리뷰 반영(시험 쪽, 계획 §7의 C1·C4·K1·K2·K6·K9, 검증 살아남음 M28·M33, 2026-11-16)

- **뼈대**: `ExportProblem` 생성자의 넷째 인자 `{ detail?, retryAfterSeconds? }`(받기만 하고 채우지 않는다)와 같은 이름의 칸, 새 `attendeeSourceUnavailable(detail)`('아직 없음'을 던진다, export `index.ts`로도 내보낸다). 그 밖의 제품 코드·마이그레이션은 손대지 않았다.
- **전체 단위**: core-svc 폴더에서 `npx vitest run` 시험 442개 가운데 실패 8, 통과 434. 실패 8개는 모두 아래 표의 새·고친 시험이고 그 밖은 모두 통과한다. `pnpm typecheck` 오류 0, 닿은 경로 eslint 오류 0.

| 지적 | 시험 | 파일 | 결과 | 까닭 |
| --- | --- | --- | --- | --- |
| C1 | A2-17 C1 J-T26 ④ 같은 커서를 되풀이하면 503 dependency-unavailable의 목록 제목·detail·Retry-After 30을 싣는다 | `test/export-paging-limit.test.ts`(기존 되풀이 시험의 이름을 바꾸고 단언을 더함) | 실패 | 단언: 제목이 사정 글('…되풀이했습니다')이고 `detail`·`retryAfterSeconds`가 없다 |
| C1 | 같은 이름 — POST …/attendee-exports | `test/export.test.ts` | 실패 | 단언: `retry-after` 머리가 없다 |
| C1 | A2-17 C1 원천이 조립되지 않았을 때도 같은 503 계약이다 | `test/export-attendee-source.test.ts`(기존 503 시험 고침) | 실패 | 단언: 제목이 '예매자 명단 원천을 쓸 수 없습니다'이고 `detail`·`retryAfterSeconds`가 없다 |
| C1 | A2-17 C1 GET …/attendees는 원천을 쓸 수 없으면 503과 Retry-After 30이고 접속기록이 없다 | `test/export.test.ts` | 실패 | 뼈대 '아직 없음'(`attendeeSourceUnavailable`)이 던져져 500 |
| C1·C4 | A2-17 C4 HttpAttendeeSource는 빈 문자열 nextCursor와 틀린 응답 모양을 503으로 거절한다 | `test/http-attendee-source.test.ts`(기존 '응답 모양이 틀리면 실패한다'를 좁힘) | 실패 | 단언: 빈 문자열 `nextCursor`를 받는다, 틀린 모양은 503 `ExportProblem`이 아니다. 경계 반대쪽(한 글자 커서 받기)도 둔다 |
| K1·K6 | A2-19 0021은 action·filter를 더하고 …(고침: `source_ip` 칸은 있고 NOT NULL·CHECK·SET NOT NULL·VALIDATE가 없다, action·모양 CHECK 둘은 `NOT VALID`) | `test/export-audit.test.ts` | 실패 | 단언: 0021에 `source_ip` CHECK가 있다(K6 쪽 `NOT VALID` 단언은 그 다음이라 아직 보이지 않는다). 검사는 주석 줄을 뺀 SQL 문장으로 한다 |
| K2 | COV2-06 K2 0022는 review(account_id) 색인을 만든다 | `test/review-grants.test.ts` | 실패 | 단언: 색인 문장이 없다. ⑬은 GRANT 밖의 문으로 이 색인 하나만 허락하게 고쳤다(REVOKE 없음은 그대로) |
| K2 | COV2-06 K2 소비자는 따로 둔 core_app 풀과 파티션 1·키 2로 돈다 | `test/core-consumers.test.ts`(가짜 `runKeyedConsumer` + main.ts 원문) | 실패 | 단언: `maxKeys`·`partitionsConcurrently`를 넘기지 않는다(main.ts는 API의 `database`를 넘긴다) |
| M28 | COV2-06 ⑰ main.ts의 소비자 시작은 조건 없이 돈다 | `test/core-consumers.test.ts` | **처음부터 통과(이미 있는 동작)** | 손 확인: `consumers = undefined && startCoreConsumers({`(검증 M28)로 바꾸면 실패하고(기존 ⑩은 그래도 통과), 되돌린 뒤 통과. 계획의 통합(선택: 빌드한 `dist/main.js`를 닿지 않는 브로커로 띄우기)은 DB 주소 등 시작 필수 값이 많아 이번에 쓰지 않았다 |
| M33 | COV2-06 ⑱ SIGTERM은 소비자 stop()이 끝난 뒤에 서비스와 연결을 닫는다 | `test/core-consumers.test.ts` | **처음부터 통과(이미 있는 동작)** | 손 확인: `await consumers?.stop()`을 `void consumers?.stop()`(검증 M33)으로 바꾸면 실패하고, 되돌린 뒤 통과. 두 손 확인 뒤 `git diff`로 `main.ts`가 깨끗한 것을 봤다 |
| K1 | A2-19 R2 K1 0021 뒤 접속지 없는 새 행도 DB는 받고(이전 판 호환), IP 모양이 아닌 값은 inet이 거절한다 | `test-int/export-audit.int.test.ts`(R2 통합 시험의 이름과 첫 단언을 뒤집음) | 실패 | 접속지 없는 넣기가 23514(지금 0021의 `source_ip` CHECK) |
| K1 | A2-19 K1 0021 뒤에도 이전 판(N-1) 코드의 내려받기 기록 모양이 들어간다 | 〃 | 실패 | core_partner로 853758eb 판의 넣기 문장이 23514 |
| K1·K6 | A2-19 K6 0019 행이 있는 DB에 0021·0022를 적용해도 실패하지 않고 옛 행은 그대로다 | 〃 | 실패 | 적용과 옛 행 값은 맞지만 `attendee_export_audit_action_check`의 `convalidated`가 true다(NOT VALID 아님). 같은 컨테이너에 새 DB를 만들어 0020까지(임시 폴더의 잘린 journal)만 적용하고 0019 모양 행을 넣은 뒤 `migrateCore`로 나머지를 적용한다 |
| K2 | COV2-06 K2 탈퇴 익명화는 review_account_idx로 찾는다 | `test-int/review-withdrawn.int.test.ts` | 실패 | 실행 계획에 `review_account_idx`가 없다(색인 없음). `enable_seqscan = off` 뒤 익명화 문장의 `EXPLAIN (FORMAT JSON)`을 본다 |
| K9 | COV2-06 ⑫ …(고침: 지표 저장소를 넘기고 `consumer_held_events`가 탈퇴 토픽에서 1이 되는지 본다) | `test-int/review-withdrawn-consumer.int.test.ts` | **처음부터 통과(이미 있는 동작)** | 보류 수 세기는 core_app으로 `held_event`를 읽는다(0022의 SELECT). 검증 담당이 틀린 구현(예: `registry`를 넘기지 않거나 보류 수 세기에 다른 DB)으로 한 번 실패를 본다 |

- **통합 시험 결과(11:49 KST 도커 잠금 아래, 구현 전 트리)**: 시험 커밋 `eec8779c`만 꺼낸 작업 폴더 `D:/ticketpass-lane3-t`의 core-svc 폴더에서 `npx vitest run --config vitest.integration.config.mjs test-int/export-audit.int.test.ts test-int/review-withdrawn.int.test.ts test-int/review-withdrawn-consumer.int.test.ts`를 돌렸다. 시험 9개 가운데 실패 4(K1 둘·K6·K2 색인), 통과 5(⑥ 롤백, ⑤⑥ CHECK, core_partner 권한, ⑪, ⑫·K9). 처음 돌릴 때 그 폴더에 공용 패키지 빌드(`@peaket/search-normalize` 등 dist)가 없어 후기 두 파일이 읽히지 않았으므로(실패로 세지 않는다) `packages/platform`·`contracts`·`search-normalize`·`validation`을 빌드한 뒤 두 파일을 다시 돌렸다. 그 폴더의 추적 파일은 바꾸지 않았다. 이 갈래 시험 컨테이너는 남지 않았다(`docker ps -a`).
- **구현 전 트리에서 통과한 통합 시험 다섯(처음부터 통과, 이미 있는 동작)**: 웨이브 끝 리뷰 반영이 바꾸지 않는 동작을 묶는 시험이다. 검증 담당이 아래 틀린 구현으로 한 번은 실패를 본다.

  | 시험 | 묶는 이미 있는 동작 | 이 시험을 실패시킬 틀린 구현 |
  | --- | --- | --- |
  | A2-19 J-T26 ⑥ 접속기록 넣기가 실패하면 attendee_export도 남지 않는다 | `DrizzleAttendeeExportStore.recordExport`가 이력과 DOWNLOAD 접속기록을 트랜잭션 하나에 넣는다(A2-19 구현 `91d11bd9`). K1·K6은 칸·CHECK만 바꾼다 | `recordExport`가 `attendee_export`를 자기 트랜잭션으로 먼저 커밋한 뒤 접속기록을 따로 넣는다 |
  | A2-19 J-T26 ⑤⑥ 0021 뒤 LIST·DOWNLOAD 행이 들어가고 모양이 틀리면 CHECK가 거절한다 | 0021의 `action`·모양 CHECK 둘(A2-19 구현). `NOT VALID`여도 새 행은 검사한다 | 0021에서 모양 CHECK를 빼거나 `action in ('LIST','DOWNLOAD')`만 남긴다(사유 있는 LIST가 들어간다) |
  | A2-19 core_partner는 접속기록을 고치거나 지우지 못하고 다른 테넌트 행을 읽지 못한다 [ASVS v5.0.0-8.4.1] | 0019의 `core_partner`에 `SELECT, INSERT`만 주는 GRANT와 테넌트 행 보안 정책. 0021·0022는 건드리지 않는다 | 0021이나 0022에 `GRANT UPDATE, DELETE ON attendee_export_audit TO core_partner`를 더하거나 그 표의 행 보안을 끈다 |
  | COV2-06 ⑪ Drizzle 익명화는 그 계정 행만 바꾸고 다시 해도 0건이다 | 0022의 `core_app` 후기 UPDATE 칸 권한(`e727395a`)과 `anonymizeByAccount`의 `where account_id = …`. K2 색인은 속도만 바꾼다 | 0022의 `core_app` `review` UPDATE 칸 목록에서 `account_id`·`basis_order_id`를 뺀다(42501), 또는 `anonymizeByAccount`가 `where`를 빠뜨린다 |
  | COV2-06 ⑫ 실제 Kafka의 탈퇴 사건이 core 후기를 익명화하고, 읽지 못한 사건은 pid 없이 held_event에 보류된다(K9: 지표 저장소를 넘김) | `startCoreConsumers`가 `registry`를 받으면 그것과 `heldCounts: () => heldEventCounts(database)`를 `runKeyedConsumer`에 넘긴다(`9b26a579`). `core_app`의 `held_event` 읽기는 0004의 전체 읽기 권한으로도 된다 | `startCoreConsumers`가 `heldCounts`(또는 `registry`)를 `runKeyedConsumer`에 넘기지 않는다(`consumer_held_events`가 1이 되지 않는다) |

- **검증 2단계 살아남음 N07(시험 추가)**: `test/core-consumers.test.ts`에 `COV2-06 K2 N07 소비자의 익명화 저장소도 소비자 전용 풀을 쓴다`를 더했다(main.ts 원문: 처리기에 넘기는 `Reviews`의 `store: new DrizzleReviewStore(풀)`의 풀이 `startCoreConsumers`의 `database` 칸과 같고 `database`·`partnerDatabase`·`opsDatabase`가 아니다). core-svc 폴더 `npx vitest run test/core-consumers.test.ts`: 지금 코드에서 통과(9/9). 손 확인: 그 저장소를 `new DrizzleReviewStore(database)`(N07 꼴)로 바꾸면 이 시험만 실패하고, 되돌린 뒤 `git diff`로 `main.ts`가 깨끗한 것을 봤다. typecheck 오류 0.

## 시험 이의

- **누가·언제**: 구현 담당(세션 `l3w7-audit-impl`), 2026-11-16. 리뷰 반영 R2(계획 §2 'R2 보충')를 구현하다 찾았다.

| 시험 | 파일:줄 | 무엇이 틀렸나 | 근거 | 바라는 고침(시험 담당 몫) | 멈춘 것 |
| --- | --- | --- | --- | --- | --- |
| `A2-19 R2 J-T26 ⑥ 내려받기 접속기록에도 접속지를 남기고 이력 응답에는 싣지 않는다 — POST·GET …/attendee-exports`, 그리고 같은 파일의 기존 `J-T26 ① 사유가 없으면 거절되고, 사유·건수는 이력에 남는다`·`J-T26 ② XLSX는 ZIP 머리로 시작하고 파일 이름이 붙는다` | `services/core-svc/test/export.test.ts` 22~28줄(시험 도우미 `FailableExportStore`) | 도우미의 `override async recordExport(record)`가 둘째 인자(접속지)를 받지 않고 `super.recordExport(record)`로 버린다. 그래서 메모리 저장소가 DOWNLOAD 접속기록에 접속지를 붙일 수 없고(R2 ⑥ HTTP 단언 `audits.at(-1).clientIp`가 될 수 없다), 계획대로 둘째 인자를 필수로 하면 `access`가 `undefined`라 내려받기가 500이 되어 기존 ①②도 실패한다. typecheck도 이 줄에서 `TS2554: Expected 2 arguments, but got 1`이다(뼈대가 둘째 인자를 선택으로 두어 시험 단계에서는 드러나지 않았다) | 계획 §2 'R2 보충' 공개 인터페이스 `recordExport(record, access: { clientIp: string })`(필수), 메모리 저장소 `audits`에 받은 접속지를 붙인다 | 도우미가 둘째 인자를 받아 넘긴다: `override async recordExport(record: AttendeeExportRecord, access: { clientIp: string }): Promise<void> { if (this.failExport) throw new Error('audit-down'); return super.recordExport(record, access); }` | 이 세 시험만 실패로 남는다. 제품 코드는 계획 인터페이스대로(둘째 인자 필수) 두었다. 둘째 인자를 선택으로 되돌려 시험을 맞추지 않았다(빠진 접속지가 fail-open이 된다) |

## 시험 이의 답

- **누가·언제**: 시험 담당(세션 `l3w7-audit-test`), 2026-11-16. 위 `## 시험 이의`의 한 줄(구현 담당이 적은 것)만 보고 판단했다.
- **판단: 이의가 맞다. 시험 쪽을 고쳤다.** `test/export.test.ts`의 시험 도우미 `FailableExportStore.recordExport`가 둘째 인자(접속지)를 받지 않고 `super.recordExport(record)`로 버렸다. 계획 §2 'R2 보충'의 포트는 `recordExport(record, access: { clientIp: string })`(필수)이고 메모리 저장소는 받은 접속지를 DOWNLOAD 접속기록에 붙여야 하므로, 이 도우미는 정본·계획과 어긋난 시험 쪽 결함이다(리뷰 반영 시험 단계의 뼈대가 둘째 인자를 선택으로 두어 그때는 드러나지 않았다).
- **고침**: 도우미가 `access: { clientIp: string }`을 받아 `super.recordExport(record, access)`로 그대로 넘긴다. 실패 주입(`failExport`)은 그대로다. 도우미는 접속지를 만들거나 바꾸지 않으므로, 컨트롤러가 접속지를 빠뜨리거나 틀리게 넘기면 제품 코드의 접속지 확인에서 거절되어 `A2-19 R2 J-T26 ⑥ … — POST·GET …/attendee-exports`가 실패한다(fail-open이 되지 않는다). 다른 시험 도우미(`test/export-audit.test.ts`의 `RecordingStore`)는 이미 둘째 인자를 받아 남긴다.
- **결과**: core-svc 폴더에서 `npx vitest run` 시험 436개 모두 통과(고치기 전에는 이의에 적힌 셋이 500으로 실패했다), `pnpm typecheck` 오류 0(고치기 전에는 이 줄에서 TS2554).

## 리뷰

- **누가·언제**: 리뷰 담당(세션 `l3w7-audit-review`), 2026-11-16. 짧은 대조 리뷰(docs/architecture.md §8.6 4의 5). 본 것: 지시서, 이 파일의 `## 계획`·`## 실패 확인`, `git diff 853758eb..e727395a`(drizzle 스냅숏 제외), 커밋 꼬리말, 계획이 가리킨 정본 줄(settlement.md §9·J-T26, data.md §2·§6, guidelines.md §3, streaming.md §2.6, identity.md §8, asvs 두 표, data-classification). 구현 담당의 설명은 받지 않았다. 시험은 돌리지 않았다(통합 시험 결과는 검증 담당 몫).
- **결론**: 높음 0, 중간 2, 낮음 5. 이번 묶음 안에서 꼭 고칠 지적(높음·보안·통과 기준)은 없다. 중간·낮음은 모두 '정리 목록 후보'다.

### 대조 결과

- **계획 항목이 다 들어왔나**: 들어왔다. A2-17(원천 `nextCursor` 넘기기, 응답 모양 검사, 짧은·0건 페이지 이어 읽기, 같은 커서 503, 보기 커서 그대로, 메모리 원천 커서, Drizzle 굿즈 저장소의 죽은 `limit * 10` 코드 삭제), A2-19(행위자 필수, LIST 접속기록, `recordExport` 한 트랜잭션, 포트에서 `insert`·`audit` 뺌, 2년 달력 보존 끝, 0021과 CHECK 둘), SEC-06R(시험만, 제품 코드 없음), COV2-06(처리기, 설정·그룹·토픽, pid 빼기 보류 감싸기, 시작 함수, main.ts 조립·SIGTERM 차례), 보충 0022(계획 표와 GRANT 줄이 칸까지 같다). 계획 시험 목록의 이름(A2-17 9개, A2-19 13개, SEC-06R ①~⑤, COV2-06 ①~⑯)이 모두 시험 파일에 있다. 계획 밖으로 바뀐 제품 파일은 `shop/shop.module.ts` 하나이고, `DrizzleMerchOrderStore` 생성자 인자가 줄어 생긴 조립 고침이라 문제없다.
- **역할 경계**: 구현 커밋 넷(`31bb0008`·`91d11bd9`·`9b26a579`·`e727395a`)은 시험 파일을 건드리지 않았다. 시험 커밋 넷의 제품 코드는 '아직 없음'을 던지는 뼈대와 모양만 맞춘 타입 고침뿐이다(`attendee-exports.ts`의 `.items` 꺼내기, 메모리 원천의 `nextCursor: null`, `MerchAttendeeSource` 인자 타입). 계획 커밋 둘은 `docs/`만 바꿨다. 열 커밋 모두 `Role`·`Batch`·`Agent-Session` 꼬리말이 있고, `1de78b1f` 본문에 R-625 시험을 가져왔다고 적혀 있다.
- **정본과의 어긋남**: settlement.md §9·J-T26 ④~⑥, data.md §2(접속기록 칸·CHECK·2년 달력·한 트랜잭션, 후기 표 권한), guidelines.md §3, streaming.md §2.6(그룹·업무 키·보류 값), identity.md §8(부르는 길·pid 안 읽음), data-classification '탈퇴 사건의 pid 사본'과 코드가 맞는다. 같은 커서 검사는 정본('방금 보낸 커서와 같은')보다 넓게 '이미 보낸 어느 커서와 같아도' 503이다. 더 엄격한 쪽이라 어긋남으로 보지 않는다. 아래 R1·R2·R3은 정본 문구 쪽 문제다.
- **자주 놓친 결함**: 정확한 값 단언(커서 배열, 2,000건, 2028-11-15·2030-03-01, `peaket.core-svc.prod`, 401·403·503), 경계 양쪽(1,000건 + null 대 1,000건 + 커서, 49건 + 커서 대 50건 + null, `notice_until` ±1ms, 다시 처리 8일·6일), 빠진 행위자 거절(원천 호출 0), fail-closed(보기 기록 실패, 원천 응답 모양, 운영 무브로커, 운영 무토큰), 같은 트랜잭션(가짜 db의 같은 `tx`와 실제 DB 롤백), 부르는 쪽이 결과를 쓰는가(컨트롤러가 로그인 주체를 넘김, 보기 응답 커서, `anonymized` 건수), 최소 권한(칸 단위 GRANT와 거부 쪽 42501 일곱)이 모두 시험에 있다. 시작 파일 조립은 원문 대조(⑩)뿐이라 약하다(아래 R5). 겹친 가드는 새로 생긴 것이 없다.
- **이름만 달린 시험**: 찾지 못했다. J-T26 ④~⑥의 판정 기준 문장마다 그 값을 단언하는 시험이 있다(④의 '1,001건 페이지' 문구만 R3).

### 지적

| 번호 | 심각도 | 파일:줄 | 무엇이 틀렸나 | 근거 | 고칠 쪽 | 처리 |
| --- | --- | --- | --- | --- | --- | --- |
| R1 | 중간 | `services/core-svc/src/modules/review/adapters/db/drizzle-review-store.ts` 254~259줄(`anonymizeByAccount`, 이번에 바꾸지 않음), `docs/security/asvs/catalog-review.md` v5.0.0-14.2.7 행 | 이번 묶음으로 탈퇴 사건이 실제로 후기 정리를 부르게 됐지만, 정리는 계정·주문 참조만 끊고 본문·별점을 남긴다. data.md §6 '관람 후기' 행·data-classification '관람 후기' 행·planning/03 권한표는 '탈퇴 때 파기(본문·별점 비움)'다. 그런데 ASVS 14.2.7 행은 '적용'으로 적혀, 탈퇴 때 파기를 다 한 것처럼 읽힌다 | 계획 §5 OPEN 후보 1, data.md §6 '관람 후기' 행, §8.6의 6(정본이 이긴다) | plan | 정리 목록 후보. 방향 결정이라 이번에 코드를 고치지 않는다. 기록 담당이 OPEN 후보 1을 소유자 결정 목록에 올리고, 결정 전까지 ASVS 행 문구를 '계정·주문 참조만 끊음, 본문·별점 파기는 결정 대기'로 낮추기를 권한다 |
| R2 | 중간 | `docs/security/asvs/settlement.md` v5.0.0-16.2.1 행, `services/core-svc/migrations/0021_attendee_access_audit_list.sql` | 명단 보기·내려받기 접속기록에 접속지 정보(IP 등 '어디서')가 없다. ASVS 16.2.1은 '언제·어디서·누가·무엇을'인데 행은 '적용'이다. data.md §2(2435줄)는 접속지 정보를 ops 감사 저장소로 옮길 때의 일로 미뤘지만, OPEN 후보 2는 '어디에 둘지'로만 적혀 있어 칸이 빠진 사실이 결정 목록에서 보이지 않는다 | data.md §2 '예매자 명단 내려받기 이력과 접속기록' 마지막 항목, §6 '관리자 계정 접속 로그' 행, 계획 §5 OPEN 후보 2 | plan | 정리 목록 후보. OPEN 후보 2에 '접속지 정보 칸 없음'을 적고, ASVS 행을 '부분 적용'으로 낮추기를 권한다(확인 필요: 파트너 명단 조회가 고시의 접속기록 항목 전부를 요구하는지는 정본에 판단이 없다) |
| R3 | 낮음 | `docs/features/settlement.md` 444줄(J-T26 ④ 상황 칸) | 상황 칸이 '999건 페이지 뒤에 1,001건 페이지'인데, 계획·시험은 원천이 `limit`(1,000)을 넘게 주지 않는다고 보고 1,000건 + 1건으로 나눴다. 원천이 `limit`보다 많이 줄 때 core가 받을지 거절할지는 어디에도 없다(지금 코드는 그대로 받는다) | 계획 §1 시험 목록 첫 줄 '고칠 곳' | plan | 정리 목록 후보. 상황 칸을 '999건 페이지 뒤에 1,000건·1건 페이지'로 고친다 |
| R4 | 낮음 | `services/core-svc/src/consumers/index.ts` 44~54줄(`pidFreeValue`) | 보류 값의 pid 빼기가 처리기의 코덱(`AccountWithdrawnCodec`)이 아니라 `JSON.parse`를 바로 쓴다. Avro(BAS-030)로 바뀌면 탈퇴 사건 보류 값이 모두 null이 되어 다시 처리(RB-11)할 값이 없어진다. pid가 새지는 않는다(fail-closed 쪽) | 계획 §4 공개 인터페이스(`jsonAccountWithdrawnCodec`는 JSON 대역, Avro는 BAS-030) | impl | 정리 목록 후보(BAS-030 때). `pidFreeHeldEventStore`가 코덱을 받게 한다 |
| R5 | 낮음 | `services/core-svc/test/core-consumers.test.ts` 140~159줄(⑩) | main.ts 원문 대조가 `startCoreConsumers`에 넘기는 DB를 보지 않는다. `database` 대신 `partnerDatabase`(core_partner, 후기 표 권한 없음)를 넘기는 틀린 조립도 ⑩을 통과하고, ⑫는 자기 DB를 따로 만들어 이것을 잡지 못한다 | architecture.md '자주 놓친 결함'의 시작 파일 조립, 계획 §4 `CoreConsumersOptions.database` 'core_app' | test | 정리 목록 후보. ⑩에 `startCoreConsumers({` 인자 안의 `database,`(또는 `database: database`)와 그 이름이 `assertDatabaseRole(…, 'core_app')`의 이름과 같은지를 더한다 |
| R6 | 낮음 | `services/core-svc/test/review-grants.test.ts` 95줄 | 0022 원문 시험이 REVOKE 문을 비교에서 뺀다. 계획 0022 표에는 REVOKE가 없으므로, 필요한 권한을 REVOKE로 거둬 가는 틀린 0022도 ⑬을 통과한다(통합 ⑭~⑯만 잡는다) | 계획 §4 보충 0022 표, ⑬ 단언 '0022 표의 GRANT 줄이 모두 있고' | test | 정리 목록 후보. 0022에 REVOKE가 없음을 단언한다 |
| R7 | 낮음(확인 필요) | `services/core-svc/src/modules/export/application/attendee-exports.ts` 167~180줄(`#readAll`) | 읽은 페이지 수의 상한이 없다. 원천이 0건 페이지와 매번 새 커서를 끝없이 주면(원천 결함) 50만 행 상한에 닿지 않아 내려받기 요청이 끝나지 않는다. 정상 원천은 주문 수 ÷ 1,000쪽에서 끝나므로 실제로 생길지는 확인 필요다 | settlement.md §9 '같은 커서면 503'(되풀이만 정함) | plan | 정리 목록 후보. 필요하면 정본에 쪽 수 상한(예: 50만 ÷ 1,000 + 여유)과 503을 적는다 |

### 검증 담당에게 넘길 것

- 통합 시험은 구현 뒤 아직 기록이 없다. core-svc 폴더에서 `npx vitest run --config vitest.integration.config.mjs test-int/export-audit.int.test.ts test-int/review-withdrawn.int.test.ts test-int/review-grants.int.test.ts test-int/review.int.test.ts test-int/review-withdrawn-consumer.int.test.ts`, purchase-svc 폴더에서 `npx vitest run --config vitest.integration.config.mjs test-int/attendee-reader.int.test.ts`(도커 잠금 아래).
- 틀린 구현 표본에서 R5(⑩이 DB 인자를 안 봄)와 R6(REVOKE)을 함께 보면 놓침을 바로 확인할 수 있다.

### 다시 보기(고친 곳)

- **누가·언제·범위**: 리뷰 담당(세션 `l3w7-audit-review`), 2026-11-16. `git diff 4633d2b4..a388e0e9`만 봤다. 커밋은 계획 보충 `0cc5c2c9`, 시험 `11705bcf`·`cfed9694`·`a388e0e9`, 구현 `8a7586e8`, 시험 이의 `ba782a27`이다. 파일은 `a388e0e9` 기준으로 읽었고, 시험은 돌리지 않았다.
- **역할 경계**: 구현 커밋 `8a7586e8`은 시험 파일을 건드리지 않았다(`client-ip.ts`는 `src/` 아래 제품 파일). 시험 커밋 `11705bcf`의 제품 코드는 '아직 없음'을 던지는 `clientIpOf` 뼈대와 선택 인자(`_access?`, `clientIp?`) 타입 고침뿐이다. `a388e0e9`은 시험 이의 `ba782a27`(시험 도우미 `FailableExportStore`가 접속지 인자를 버림)에 따른 시험 쪽 고침이다. 0021·0022는 아직 `origin/develop`(`2c20b915`)에 없어서, 이 가지에서 0021을 고쳐 써도 이미 적용된 마이그레이션과 어긋나지 않는다.

| 지적 | 판정 | 근거 |
| --- | --- | --- |
| R2 접속지 | 고쳐짐 | 정본: settlement.md §9 '접속지', data.md §2 `source_ip`, ASVS 16.2.1 행, internal-management-plan §4.5. 0021이 `source_ip inet`과 `CHECK (source_ip IS NOT NULL) NOT VALID`를 더한다. 보기·내려받기 모두 행위자 확인 자리에서 접속지가 IP 모양이 아니면(빈 문자열, 칸 없음 포함) 원천을 읽기 전에 실패한다(fail-closed, 오류 글에 값이 없다). 접속지는 DOWNLOAD·LIST 접속기록에만 들어가고, `attendee_export` 이력 행·`exportView`·이력 응답·명단 응답에는 없다(단위·HTTP·Drizzle 가짜 db·실제 DB 시험이 각각 단언한다). 새 로그 줄은 없다 |
| R3 J-T26 ④ 문구 | 고쳐짐 | settlement.md J-T26 ④가 '1,000건 페이지와 1건 페이지(원천은 `limit`보다 많이 주지 않는다)'로 바뀌어 시험과 맞는다 |
| R5 소비자 DB | 고쳐짐 | 새 시험 `COV2-06 ⑩ R5`가 `startCoreConsumers({…})` 인자에서 `database` 칸의 이름을 뽑고, 그 이름이 `assertDatabaseRole(…, 'core_app')`로 확인된 DB인지, `core_partner`·`core_ops`가 아닌지를 본다. `partnerDatabase`를 넘기는 틀린 조립을 잡는다 |
| R6 REVOKE | 고쳐짐 | `review-grants.test.ts`가 REVOKE 문이 없음과 GRANT 밖의 문이 없음을 함께 단언한다 |

- **새 결함을 찾아본 곳**:
  - fail-open: 접속지를 정하지 못하면 원천·회차·재인증보다 먼저 거절한다. 찾지 못했다.
  - 접속지가 이력 응답·로그로 새는 곳: Drizzle `list`는 `attendee_export`만 읽고, `ExportActor`를 로그에 싣는 곳이 없다. 찾지 못했다.
  - 0021 CHECK가 기존 행을 깨는 곳: `action`은 기본값 `DOWNLOAD`·NOT NULL로 먼저 더해지고, 0019 행은 `export_id`·`reason`·`format`이 NOT NULL이었다. 그래서 바로 검사되는 모양 CHECK를 통과하고, 접속지 CHECK는 NOT VALID라 옛 행에 걸리지 않는다. 시험은 빈 DB에 전체 마이그레이션을 돌려 옛 행 경우를 실제로 만들지는 않는다. `not valid` 글은 0021 원문 시험이 본다. 찾지 못했다.
  - 믿을 수 없는 머리를 믿는 곳: 아래 N1 하나.

| 번호 | 심각도 | 파일:줄 | 무엇이 문제인가 | 근거 | 고칠 쪽 | 처리 |
| --- | --- | --- | --- | --- | --- | --- |
| N1 | 낮음(확인 필요) | `services/core-svc/src/modules/export/inbound/client-ip.ts` 8~13줄 | 한 값짜리 `x-forwarded-for`를 그대로 믿는다. 정본 입구 규칙(infra.md §3 규칙 2: 입구가 받은 `x-forwarded-` 머리를 지우고 클라이언트 IP 하나로 다시 쓴다)과 identity-svc 관리 계정 로그인 규칙에 맞으므로 결함은 아니다. 다만 입구를 거치지 않고 core-svc 앱 포트에 닿는 클러스터 안 호출이 있다면 접속지를 꾸밀 수 있다. 또 머리가 없거나 틀리면 연결 상대 주소(운영에서는 입구 파드 주소)가 조용히 남는다. 정본이 정한 대체 동작이지만 접속기록 값으로는 클라이언트 IP가 아니다 | settlement.md §9 '접속지', infra.md §3 규칙 2 | plan | 정리 목록 후보. core-svc 앱 포트 NetworkPolicy가 입구만 받는지 확인하고, 운영에서 대체 주소가 쓰이면 경고를 남길지 정한다 |

- **결론**: 다시 볼 지적 넷(R2·R3·R5·R6)은 모두 고쳐졌다. 새 지적은 낮음 1(N1, 확인 필요)이고, 이번에 고칠 것(높음·보안·통과 기준)은 없다. R1·R4·R7은 처음 리뷰대로 정리 목록 후보로 남는다.

### 다시 보기(웨이브 끝 지적)

- **누가·언제·범위**: 리뷰 담당(세션 `l3w7-audit-review`), 2026-11-16. `git diff ce1438cd..1ac417bd`만 봤다. 커밋은 계획 `b4fc3d6e`, 시험 `eec8779c`, 구현 `cc47938f`·`37e98447`·`1ac417bd`이다. 파일은 `1ac417bd` 기준으로 읽었고, 시험은 돌리지 않았다.
- **역할 경계**: 구현 커밋 셋은 시험 파일을 건드리지 않았다. 바꾼 것은 `src/`, 마이그레이션 0021·0022와 그 스냅숏, api-client 생성물(`packages/api-client/src/gen/endpoints/partner/partner.ts`)이다. 시험 커밋 `eec8779c`의 제품 코드는 `attendeeSourceUnavailable`의 '아직 없음' 뼈대와 `ExportProblem`의 선택 인자 타입, 내보내기 한 줄뿐이다.

| 지적 | 판정 | 근거 |
| --- | --- | --- |
| C1 503 계약 | 고쳐짐 | 원천을 쓸 수 없는 세 경우(조립 없음, 응답 모양 틀림, 같은 커서 되풀이)가 `attendeeSourceUnavailable` 하나로 모였다. 그 값은 `dependency-unavailable` 503, 제목은 오류 목록 값 '의존 서비스를 잠시 쓸 수 없습니다'(openapi 82줄과 같다), 사정은 `detail`, `retryAfterSeconds` 30이다. `guard`가 `detail`·`retryAfterSeconds`를 `ProblemError`로 넘기고, 플랫폼 오류 처리기가 `retry-after` 머리를 붙인다. openapi `listPartnerEventAttendees`(6383줄)·`createPartnerEventAttendeeExport` 두 연산 모두 `'503'` `ServiceUnavailable`을 적었고 api-client를 다시 만들었다. 원천의 2xx 아닌 답이 여전히 500인 것은 계획 §7이 K7 후속으로 남겼다 |
| C4 빈 커서 | 고쳐짐 | 응답 검사가 `z.string().min(1).nullable()`이 되어 `''`는 503(모양 틀림)이다. guidelines §3·settlement.md §9에도 적었다 |
| K1 N-1 호환 | 고쳐짐 | 0021은 `source_ip inet` 칸만 더한다(NULL 허용). `source_ip` CHECK는 Drizzle 스키마에서도 빠졌다. 이전 판(853758eb) 코드는 접속기록 표에 넣기만 하고 읽지 않는다. 그래서 이전 판의 넣기 문장도 기본값(`action` 'DOWNLOAD', `filter` `{}`)과 NOT NULL이던 세 칸으로 두 CHECK를 만족한다. 되돌려도 이전 판이 새 LIST 행(`export_id` NULL)을 읽는 곳이 없다. 통합 시험 'K1 이전 판(N-1) 코드의 내려받기 기록 모양'이 `core_partner`·테넌트로 이것을 본다 |
| K1 쪽: 앱이 접속지 빠짐을 막는가 | 막는다 | `requireActor`(`attendee-exports.ts` 66~70줄)가 보기(99줄)·내려받기(140줄) 모두에서 `isIP`가 0이면 원천·회차를 읽기 전에 거절한다. R2 때의 단위 시험('접속지를 정하지 못하면 원천을 읽지 않고 실패한다')이 그대로 있다. Drizzle 넣기는 보기·내려받기 모두 `sourceIp`를 싣는다 |
| K6 NOT VALID | 고쳐짐 | `action`·모양 CHECK 둘 끝에 `NOT VALID`가 붙었다. 새 행에는 바로 걸린다. 통합 시험 'K6'이 0020까지 적용한 DB에 0019 모양 행을 넣고 0021·0022를 적용한 뒤 옛 행과 `convalidated = false` 둘을 본다. `VALIDATE`는 다음 출시 후속이다(data.md §2) |
| K2 색인·전용 풀 | 고쳐짐 | 0022 끝에 `review_account_idx (account_id)`가 생겼고, Drizzle 스키마·0022 스냅숏·data.md §5.1 행이 함께 있다. 소비자는 `runKeyedConsumer`에 `maxKeys: 2`·`partitionsConcurrently: 1`을 넘긴다. main.ts는 소비자 전용 풀 `consumerDatabase`(`max: 2`)를 만들어 `assertDatabaseRole(consumerDatabase, 'core_app')`로 확인하고, 보류 저장소·보류 수 세기·익명화 저장소(`new Reviews({ store: new DrizzleReviewStore(consumerDatabase), … })`)에 쓴다. 종료 때는 `await consumers?.stop()` → `service.close()` → `consumerDatabase.close()` 차례다. 단위 시험이 가짜 `runKeyedConsumer`로 넘기는 값과 받은 풀을 보고, 원문 대조로 `max: 2`·역할 확인·닫기를 본다 |
| K9 운영 조립 경로 | 고쳐짐 | ⑫가 `registry`를 넘겨 `consumer_held_events`가 탈퇴 토픽에서 1이 되는지 본다(보류 수 세기를 `core_app`으로) |
| S1 ASVS 16.2.1·16.4.2 | 고쳐짐 | 두 행 모두 '부분 적용'이고 빠진 몫을 적었다(보통 표, 해시 체인 없음, 월 점검이 안 읽음, 입구 설정에 기댄 접속지와 연결 주소 대체, OPEN 후보 2). 코드 사실과 맞는다 |
| S2 ASVS 14.2.7 | 고쳐짐(문구 일부는 N2) | '부분 적용'과 탈퇴 때 남는 칸(본문·별점·사진 키·내용 지문)·보류 때 손 정리가 맞게 적혔다. 같은 행의 다른 문장은 아래 N2 |
| M28 | 고쳐짐 | ⑰이 `consumers = startCoreConsumers({` 줄이 조건식 없이 대입되고, 그 블록이 모듈 수준의 `if (kafka.enabled)`(또는 `if (!kafka.enabled) … else`)인지 본다 |
| M33 | 고쳐짐 | ⑱이 SIGTERM 쪽 글에서 `void consumers?.stop(`이 없고 `await consumers?.stop(`이 `service.close(`보다 앞인지 본다 |

- **새 결함을 찾아본 곳**: 0021의 이전 판·되돌림 호환, 앱의 접속지 거절, 소비자 풀의 역할 확인·닫기, 503 계약과 오류 목록·openapi의 일치, ASVS 행과 코드 사실. 앞의 넷에서는 결함을 찾지 못했다. 아래 N2·N3은 이번 묶음 전부터 있던 것이 이번 고침으로 드러났다.

| 번호 | 심각도 | 파일:줄 | 무엇이 문제인가 | 근거 | 고칠 쪽 | 처리 |
| --- | --- | --- | --- | --- | --- | --- |
| N2 | 낮음 | `docs/security/asvs/catalog-review.md` v5.0.0-14.2.7 행 | 행이 '신고 기록(`content_report.purge_at`, 처리 뒤 1년)과 붙이지 않은 후기 사진(24시간)을 정기 파기 작업이 자동으로 지운다'고 적는데, 지금 core-svc에는 그 정비 일이 없다. 정비 일은 `review-temp-block-expire` 하나뿐이고, `core_maintenance`에는 `content_report` 지우기 권한도 없다. `review_image` 표도 아직 없다. 또 `purge_at`은 넣을 때 '지금 + 365일'이라 '처리 뒤 1년'이 아니다(`reviews.ts` 220줄). S2 고침이 '빠진 몫'에 구현 사실을 적기 시작했으므로, 이것도 같은 자리에 적어야 사실과 맞는다 | 계획 §4 '범위 밖(후속)'의 신고 기록 파기 정비 일, 0022 표 | plan | 정리 목록 후보. 14.2.7 빠진 몫에 '신고 기록·후기 사진 파기 작업 없음, `purge_at` 기준이 넣은 때'를 더한다 |
| N3 | 낮음 | `services/core-svc/src/modules/export/application/attendee-exports.ts`(PDF 503 `export-format-unavailable`), `docs/api/openapi.yaml` 5153줄 | 내려받기 연산의 503은 이제 openapi에 `dependency-unavailable` 하나로만 적혀 있다. 그런데 같은 연산이 PDF 형식에서 `export-format-unavailable` 503을 낸다. 그 제목은 'PDF 형식은 아직 만들 수 없습니다'로, 목록 225줄의 '이 파일 형식은 아직 만들 수 없습니다'와 다르고 `Retry-After`도 없다. C1과 같은 계약 어긋남이 다른 오류 길에 남아 있다(이번 묶음 전부터) | guidelines §2, openapi 225줄 `export-format-unavailable` | impl + plan | 정리 목록 후보. 제목을 목록 값으로 바꾸고, openapi 503 설명에 그 type을 더한다(Retry-After를 줄지는 계획이 정한다) |
| N4 | 낮음(확인 필요) | `services/core-svc/src/main.ts`(`consumerDatabase` `max: 2`), `services/core-svc/src/consumers/start.ts`(`maxKeys: 2`) | 소비자 풀 연결 2개를 동시 키 2개, 보류 확인·넣기, 30초마다의 보류 수 세기가 함께 쓴다. 몰릴 때 셋째가 연결을 기다린다(플랫폼 풀 기다림 한도 1초, 동시 실행 리뷰 K2 근거). 늦으면 처리 실패 → 재시도 → 5회 뒤 보류로 갈 수 있다. 사건을 잃지는 않는다 | streaming.md §2.6 '풀 최대 2, 파티션 1·키 2 [가정]' | plan | 정리 목록 후보. [가정] 값을 잴 때 '풀 = 키 수 + 1'을 같이 본다 |

- **결론**: 이번 범위의 지적 열(C1·C4·K1·K2·K6·K9·S1·S2·M28·M33)은 모두 고쳐졌다. 새 지적은 낮음 3(N2·N3, N4 확인 필요)이고, 이번에 고칠 것(높음·보안·통과 기준)은 없다.

## 검증

- **누가·언제**: 검증 담당(세션 `l3w7-audit-verify`, 모델 claude-opus-5-5), 2026-11-16. 계획·시험·구현·리뷰에 관여하지 않았다. 본 것: 지시서, 이 파일의 `## 계획`·`## 실패 확인`, `git diff 853758eb..3087ad85`(drizzle 스냅숏 제외), 정본 판정 기준(settlement.md §13 J-T26, architecture.md §3.2 'REST' 행, asvs/settlement 11.2.4). 그 뒤 커밋(`2ed48686`·`5fc9d56f`)은 리뷰 문서만 바꿔 제품 코드는 `3087ad85`와 같다.
- **방법**: 제품 코드(또는 마이그레이션)를 한 군데 틀리게 바꾸고, 닿는 단위 시험 파일을 돌리고(패키지 폴더에서 `npx vitest run <파일들>`), 실패 여부를 적고, `git checkout -- <파일>`로 되돌렸다. 시험 파일은 바꾸지 않았다. 돌린 묶음은 셋이다.
  - 명단 묶음(core-svc, 시험 53개): `test/export-paging-limit.test.ts test/export-paging.test.ts test/http-attendee-source.test.ts test/export-attendee-source.test.ts test/export-audit.test.ts test/export.test.ts test/client-ip.test.ts test/export-reauth.test.ts test/export-reauth-cases.test.ts`
  - 후기 묶음(core-svc, 시험 31개): `test/review-withdrawn.test.ts test/core-consumers.test.ts test/review-grants.test.ts test/review.test.ts test/review.http.test.ts`
  - 토큰 묶음: core-svc `test/internal-sale-config-token-boot.test.ts`(4개). 플랫폼 변이는 packages/platform `test/internal-token-constant-time.test.ts test/internal-token.test.ts test/internal-token-boot.test.ts`(7개)도 돌렸다.
- 변이를 넣기 전 같은 묶음은 모두 통과했다. 끝난 뒤 `git status --short`·`git diff`에 제품 코드 변경이 없다(다른 리뷰 담당의 미추적 문서 하나만 있다).

### 넣은 틀린 구현(Docker 없음)

| 번호 | 파일:줄 | 바꾼 것 | 돌린 시험 | 결과(잡은 시험) |
| --- | --- | --- | --- | --- |
| M01 | core `export/application/attendee-exports.ts:184` | 내려받기가 짧은 페이지(`items < 1,000`)에서 멈춘다(계획 A2-17 표본 1) | 명단 묶음 | 잡힘(J-T26 ④ 999건 짧은 페이지, ④ 0건 페이지) |
| M02 | core `export/adapters/http-attendee-source.ts:63` | 원천 `nextCursor`를 버리고 늘 null(표본 2) | 명단 묶음 | 잡힘(A2-17 HttpAttendeeSource는 원천의 nextCursor를 넘기고…) |
| M03 | `attendee-exports.ts:122` | 보기 응답 커서를 `items.length === limit`일 때만 준다(표본 3) | 명단 묶음 | 잡힘(J-T26 ④ 보기 커서 단위·HTTP 둘) |
| M04 | `attendee-exports.ts:186` | 같은 커서면 조용히 끝내고 COMPLETED(표본 4) | 명단 묶음 | 잡힘(J-T26 ④ 같은 커서 503) |
| M05 | `http-attendee-source.ts:22` | 원천 `nextCursor` 모양이 틀리면 null로 본다(`.catch(null)`, fail-open) | 명단 묶음 | 잡힘(A2-17 응답 모양이 틀리면 실패한다) |
| M06 | core `shop/adapters/memory-merch-store.ts:38` | 메모리 원천이 남은 수가 정확히 `limit`이어도 커서를 준다(`>`를 `>=`로) | 명단 묶음 | 잡힘(A2-17 메모리 명단 원천은 다음 주문이 있을 때만…) |
| M07 | `attendee-exports.ts:100` | 명단 보기가 `recordView`를 부르지 않는다(A2-19 표본 1a) | 명단 묶음 | 잡힘(⑤ 시험 다섯) |
| M08 | `attendee-exports.ts:100` | `recordView` 오류를 삼키고 명단을 준다(표본 1b) | 명단 묶음 | 잡힘(⑤ 접속기록을 남기지 못하면…) |
| M09 | `attendee-exports.ts:106` | LIST `count`에 합계 `totals.bookings`(표본 3b) | 명단 묶음 | 잡힘(⑤ 행위자·보인 건수·조건) |
| M10 | `attendee-exports.ts:108` | 커서가 없어도 `filter.cursor` 키(undefined)를 둔다 | 명단 묶음 | 잡힘(⑤ 단위·HTTP) |
| M11 | `attendee-exports.ts:58` | 행위자 `accountId`가 빈 문자열이어도 통과 | 명단 묶음 | 잡힘(⑤ 행위자 없이 부르면…) |
| M12 | core `export/inbound/partner-attendee-export.controller.ts:43` | 보기 행위자로 `tenantOf(me)`(파트너 ID)를 넘긴다(표본 3a) | 명단 묶음 | 잡힘(⑤ GET …/attendees는 로그인 주체를…) |
| M13 | core `export/domain/export.ts:77` | 접속기록 보존 끝 `+ 730일`(표본 4) | 명단 묶음 | 잡힘(⑤ 보존 끝은 만든 때 + 2년) |
| M14 | core `export/adapters/db/drizzle-export-store.ts:31·43` | 이력을 따로 트랜잭션으로 먼저 커밋(트랜잭션 둘, 표본 2) | 명단 묶음 | 잡힘(⑥ Drizzle recordExport는 두 행을 한 트랜잭션에) |
| M15 | core `migrations/0021_attendee_access_audit_list.sql:11` | LIST 모양 CHECK에서 `reason is null`을 뺀다 | 명단 묶음 | 잡힘(A2-19 0021 원문 시험) |
| M16 | `partner-attendee-export.controller.ts:43` | 보기 접속지를 `x-forwarded-for` 없이 연결 주소로만(R2 표본 1) | 명단 묶음 | 잡힘(R2 ⑤ HTTP 접속지) |
| M17 | `attendee-exports.ts:61` | 접속지가 IP 모양이 아니어도(빈 문자열 포함) 통과(R2 표본 2) | 명단 묶음 | 잡힘(R2 ⑤ 접속지를 정하지 못하면…) |
| M18 | `drizzle-export-store.ts:60` | DOWNLOAD 넣기 값에서 `sourceIp`를 뺀다(R2 표본 3) | 명단 묶음 | 잡힘(R2 Drizzle 넣기 값에 source_ip) |
| M19 | core `export/adapters/memory-export-store.ts:15`, `export.ts:46` | 이력 행에 접속지를 붙이고 `exportView`가 행 전체를 펼친다(R2 표본 4) | 명단 묶음 | 잡힘(R2 ⑥ 단위·HTTP) |
| M20 | core `export/inbound/client-ip.ts:11` | IP 모양 검사 없이 `x-forwarded-for`를 믿는다 | 명단 묶음 | 잡힘(R2 clientIpOf, R2 ⑤ HTTP) |
| M21 | core `catalog/inbound/internal-sale-config.controller.ts:57` | `InternalToken401Guard`에 빈 `onModuleInit()`(R628V M1, 표본 1) | 토큰 묶음 | 잡힘(SEC-06R ①) |
| M22 | platform `src/auth.ts:93` | `sameSecret`을 `a === b`로(R628V M3, 표본 2) | 토큰 묶음, 플랫폼 | 잡힘(SEC-06R ④⑤) |
| M23 | `internal-sale-config.controller.ts:58` | 하위 가드가 `super` 없이 `!==`로 직접 비교(표본 3) | 토큰 묶음 | 잡힘(SEC-06R ④) |
| M24 | `internal-sale-config.controller.ts:52` | 하위 가드 생성자에서 `@Inject(INTERNAL_TOKEN_REQUIRED)`만 뺀다(표본 4 글 그대로) | 토큰 묶음 | 살아남음. **동등 변이**(아래) |
| M24b | `internal-sale-config.controller.ts:54` | 받은 `required`를 버리고 `super(expected, false)`(표본 4의 뜻) | 토큰 묶음 | 잡힘(SEC-06R ①) |
| M25 | platform `src/auth.ts:92` | `sameSecret`의 길이 검사를 뺀다 | 토큰 묶음, 플랫폼 | 잡힘(SEC-06R ③④⑤와 기존 플랫폼 시험 넷) |
| M40 | `internal-sale-config.controller.ts:57` | 하위 가드가 local·ci에서도 토큰이 없으면 시작을 막는다 | 토큰 묶음 | 잡힘(SEC-06R ②) |
| M26 | core `review/inbound/account-withdrawn.handler.ts:76` | `handle`이 `eventKey`를 계정 ID 자리에 넘긴다(COV2-06 표본 1) | 후기 묶음 | 잡힘(COV2-06 ①②) |
| M27 | core `consumers/index.ts:10` | `CORE_TOPICS`에서 탈퇴 토픽을 뺀다(표본 2a) | 후기 묶음 | 잡힘(COV2-06 ⑧) |
| M28 | core `main.ts:117` | 소비자를 실제로 켜지 않는다(`consumers = undefined && startCoreConsumers({…})`, 부르는 글은 남김, 표본 2b) | 후기 묶음 | **살아남음** |
| M29 | `consumers/index.ts:65` | 보류 감싸기 `hold`가 값을 그대로 넘긴다(표본 3) | 후기 묶음 | 잡힘(COV2-06 ⑥) |
| M30 | `consumers/index.ts:15` | `demo`에서도 브로커 없이 꺼진 설정으로 뜬다(표본 4, fail-open) | 후기 묶음 | 잡힘(COV2-06 ⑦) |
| M31 | `consumers/index.ts:49` | 해독 못 한 보류 값을 원래 바이트로 남긴다 | 후기 묶음 | 잡힘(COV2-06 ⑥) |
| M32 | `main.ts:122` | 소비자에 `partnerDatabase`(core_partner)를 넘긴다(리뷰 R5) | 후기 묶음 | 잡힘(COV2-06 ⑩ R5) |
| M33 | `main.ts:143` | SIGTERM에서 소비자 멈춤을 기다리지 않는다(`await`를 `void`로) | 후기 묶음 | **살아남음** |
| M34 | core `migrations/0022_review_role_grants.sql:7` | `review`에 칸 없는 `UPDATE`와 `DELETE`(표본 5) | 후기 묶음 | 잡힘(COV2-06 ⑬) |
| M35 | `0022_review_role_grants.sql:27` | `core_maintenance`의 `held_event` 줄을 뺀다(표본 6) | 후기 묶음 | 잡힘(COV2-06 ⑬) |
| M36 | `attendee-exports.ts:92` | 명단을 보이지 않은 요청(404·410)도 LIST 접속기록을 남긴다 | 명단 묶음 | 잡힘(⑤ 명단을 보이지 않은 요청은…) |
| M37 | core `review/inbound/internal-review.controller.ts:12` | 내부 익명화 경로에서 토큰 가드를 뺀다 | 후기 묶음 | 잡힘(COV2-06 ⑨) |
| M38 | `internal-review.controller.ts:21` | 바꾼 건수 대신 늘 `{ anonymized: 1 }` | 후기 묶음 | 잡힘(COV2-06 ⑨) |
| M39 | core `review/adapters/memory-review-store.ts:150` | 익명화가 주문 참조(`basisOrderId`)를 남긴다 | 후기 묶음 | 잡힘(COV2-06 ①) |

- **합계**: 넣은 수 41. 계획 표본 22개를 모두 넣었고, 꼭 넣을 항목은 개인정보 접속기록(M07~M13·M16~M20·M36), 탈퇴 익명화(M26~M39), 내부 토큰 인증(M21~M25·M24b·M40: 시작 차단·상수 시간 비교), 최소 권한(M34·M35), 정확한 커서(M01~M06)다. 동등 변이 1(M24)을 뺀 40개 가운데 **잡힘 38, 살아남음 2(M28, M33)**. 목표 20~30개보다 많은 것은 '처음부터 통과' 시험마다 실패를 한 번 보려고 M36~M40을 더했기 때문이다.
- **M24를 동등 변이로 본 까닭**: `@Inject(INTERNAL_TOKEN_REQUIRED)`만 빼도 가드에 `required`가 `true`로 들어왔다. 시험 ①을 돌리면서 `required !== true`이면 던지게 한 확인용 변이를 같이 넣었는데 던지지 않았다. Nest가 부모 `InternalTokenGuard`의 주입 정보를 이어 쓰는 것으로 보인다. 행동이 같으므로 시험 공백이 아니다. 표본 4의 뜻(`required`가 늘 false)은 M24b로 넣었고 ①이 잡았다.
- **'처음부터 통과' 시험이 실패를 본 곳**: A2-19 ⑤ 404·410(M36), COV2-06 ⑨(M37·M38), SEC-06R ①(M21·M24b)·②(M40)·③(M25)·④(M22·M23·M25)·⑤(M22·M25), COV2-06 ⑩ R5(M32), ⑬ R6(M34·M35). 남은 하나는 purchase 통합 시험 `A2-17 J-T26 ④ purchase 명단 원천은 SOLD 좌석이 없는 주문을 걸러도…`이고, 아래 D12로 본다.

### 살아남은 것: 시험 담당에게 넘김

| 번호 | 무엇이 새나 | 시험 담당에게 넘김: 무엇을 단언해야 하나 |
| --- | --- | --- |
| M28 | `COV2-06 ⑩`은 `main.ts` 글에서 `startCoreConsumers(`가 `service.listen()` 뒤에 있는지만 본다. 부르는 줄이 실제로 돌지 않아도(조건으로 막은 꼴) 통과하고, ⑫는 시험이 스스로 `startCoreConsumers`를 불러 `main.ts` 조립을 보지 않는다. 운영에서 탈퇴 사건이 조용히 익명화되지 않는 결함이다(계획 표본 2b, '자주 놓친 결함'의 시작 파일 조립) | `main.ts`를 시험 조립과 따로 띄워서 본다. 예: `PEAKET_ENV=ci`, 닿지 않는 브로커 `PEAKET_KAFKA_BROKERS=127.0.0.1:1`로 `main.ts`(또는 빌드한 `dist/main.js`)를 띄우면 소비자를 켜려다 실패해 'Kafka 소비자를 켜지 못해 core-svc를 끝낸다' 한 줄과 종료 코드 1로 끝나는지 단언한다(소비자를 켜지 않으면 계속 떠 있어 실패한다). 원문 대조로 남긴다면 적어도 `startCoreConsumers({`가 조건 없이 `consumers =`에 바로 대입되는 문장인지(앞에 `&&`·`?`·`if`가 없는지) 본다 |
| M33 | SIGTERM 차례 검사는 `consumers?.stop(`이 `service.close(`보다 글에서 앞에 있는지만 본다. `await`가 빠져 소비자가 처리 중인 키를 마치고 커밋하기 전에 DB 연결이 닫혀도 통과한다(계획 §4 '소비자를 먼저 멈춘 뒤 서비스를 닫는다') | 종료 함수가 소비자 `stop()`이 **끝난 뒤에** `service.close()`와 DB 닫기를 부르는지 본다. 원문 대조라면 `await consumers?.stop(`(또는 `stop()`의 약속을 기다리는 꼴)을 단언한다. 동작 시험이라면 늦게 끝나는 `stop()`을 가진 가짜 소비자를 넣고 그 사이 `database.close`가 불리지 않음을 단언한다(지금 `main.ts`는 바로 실행되는 파일이라 종료 함수를 떼어 내보내야 할 수 있고, 그러면 구현 담당 몫이 생긴다) |

### Docker 대기 목록(돌리지 않음)

DB·Kafka가 있어야 잡히거나, 단위 원문 시험과 따로 실제 DB가 잡는지 볼 변이다. 감독이 도커 잠금을 잡은 뒤 돌린다. 먼저 바꾸지 않은 상태로 아래 명령을 한 번 돌려 구현 뒤 기준선 통과(리뷰 '검증 담당에게 넘길 것')를 본 다음 변이를 하나씩 넣는다. 변이 목록과 실행 도구는 검증 담당 작업 폴더(저장소 밖)의 `mut/docker-mutants.mjs`·`mut/run-docker.mjs`에 있다.

| 번호 | 파일:줄 | 바꾼 것 | 돌릴 통합 시험(패키지 폴더) |
| --- | --- | --- | --- |
| D01 | core `migrations/0021_attendee_access_audit_list.sql:11` | LIST 모양 CHECK에서 `reason is null`을 뺀다(단위 M15와 같음) | core-svc `test-int/export-audit.int.test.ts`(⑤⑥ 23514) |
| D02 | `0021_attendee_access_audit_list.sql:13` | `source_ip` NOT NULL CHECK 줄을 뺀다 | 같은 파일(R2 접속지 없는 새 행 23514) |
| D03 | core `export/adapters/db/schema.ts:53` | `inet('source_ip')`를 `inet('client_ip')`로(가짜 db는 칸 이름을 못 본다) | 같은 파일 |
| D04 | core `export/adapters/db/drizzle-export-store.ts:31·43` | 이력을 따로 트랜잭션으로 먼저 커밋(단위 M14와 같음) | 같은 파일(⑥ 접속기록 넣기가 실패하면 attendee_export도 남지 않는다) |
| D05 | core `migrations/0022_review_role_grants.sql:7` | `core_app`의 review UPDATE 칸에서 `account_id`·`basis_order_id`를 뺀다 | core-svc `test-int/review-withdrawn.int.test.ts test-int/review-grants.int.test.ts test-int/review.int.test.ts test-int/review-withdrawn-consumer.int.test.ts`(⑪⑫) |
| D06 | `0022_review_role_grants.sql:22` | `core_maintenance`의 review UPDATE 칸에서 `updated_at`을 뺀다 | core-svc `test-int/review-withdrawn.int.test.ts test-int/review-grants.int.test.ts test-int/review.int.test.ts`(⑯) |
| D07 | `0022_review_role_grants.sql:19` | `core_app`의 `held_event` INSERT를 뺀다 | core-svc `test-int/review-withdrawn-consumer.int.test.ts`(⑫ 보류) |
| D08 | `0022_review_role_grants.sql:7` | `review`에 칸 없는 UPDATE·DELETE(단위 M34와 같음) | D06과 같은 셋(⑮) |
| D09 | core `review/adapters/db/drizzle-review-store.ts:257` | 익명화 `where`가 계정 조건 없이 모든 계정 행을 바꾼다 | D06과 같은 셋(⑪ B 행 그대로) |
| D10 | core `consumers/start.ts:43` | 보류 저장소를 `pidFreeHeldEventStore` 없이 건다 | core-svc `test-int/review-withdrawn-consumer.int.test.ts`(⑫ pid 없음) |
| D11 | `consumers/start.ts:40` | 소비자 그룹을 `core-svc.<환경>`으로 | 같은 파일(⑫ 그룹 커밋) |
| D12 | purchase `booking/adapters/db/drizzle-attendee-reader.ts:69` | 걸러 낸 뒤 남은 행 기준으로 커서를 만든다(SOLD 없는 주문만 든 페이지는 커서 null) | purchase-svc `test-int/attendee-reader.int.test.ts`('처음부터 통과' 시험의 실패 보기) |

- 돌릴 통합 시험(각 패키지 폴더): core-svc `npx vitest run --config vitest.integration.config.mjs test-int/export-audit.int.test.ts test-int/review-withdrawn.int.test.ts test-int/review-grants.int.test.ts test-int/review.int.test.ts test-int/review-withdrawn-consumer.int.test.ts`, purchase-svc `npx vitest run --config vitest.integration.config.mjs test-int/attendee-reader.int.test.ts`. 변이마다 돌릴 때는 표의 파일만 준다. 끝나면 자기가 띄운 시험 컨테이너를 `docker rm -f -v`로 지운다.

### 판정 기준 대조(이름만 달린 시험 찾기)

| 시험 ID | 정본 판정 기준(요지) | 그 ID를 단 시험의 단언 | 판정 |
| --- | --- | --- | --- |
| J-T26 ① | 사유가 없으면 거절, 사유를 넣으면 건수와 함께 접속기록에 남는다 | `J-T26 ①`: 사유 없음 400·빈칸 422, 성공 뒤 이력의 `reason`·`count 2`, `audits.at(-1)`의 사유·건수 | 맞음 |
| J-T26 ② | 스트리밍으로 보내고, 내려받는 동안 RSS 증가 100MB 이하, 첫 바이트 2초 안 | `J-T26 ② XLSX는 ZIP 머리로 시작하고 파일 이름이 붙는다`: 형식·파일 이름만 본다. RSS·첫 바이트 단언이 없다 | **이름만 달린 시험(기존, BAT-610)**. 계획 §1이 '② 스트리밍은 그대로'로 범위 밖에 둔 것과 같다. 장부가 ②를 이 시험으로 채운 것으로 읽지 않게 기록 담당이 notes를 확인한다 |
| J-T26 ③ | 410과 보유 기간 끝 안내 | `J-T26 ③`: 410과 `retention-ended` 형식 | 맞음(안내 문구는 화면 몫) |
| J-T26 ④ | 2,000건을 모두 싣고 `nextCursor` null에서만 멈춤, 보기 커서는 원천 값 그대로(짧은 페이지에서 null 아님, 정확히 `limit`건인 마지막에서 null), 같은 커서면 503·이력 없음 | export-paging-limit 다섯, export.test HTTP 하나, http-attendee-source 둘, 메모리 원천 하나, purchase 통합 하나가 문장마다 정확한 값(커서 배열 `[undefined, 'c1', 'c2']`, 2,000, 503 `dependency-unavailable`, 이력·접속기록 0)을 단언 | 맞음. M01~M06이 모두 잡혔다 |
| J-T26 ⑤ | 보인 건수·행위자(계정 ID·역할·표시 이름)·조건·접속지가 LIST에 남고, 보존 끝은 만든 때 + 2년(달력). 기록 실패·접속지 미정이면 명단을 주지 않음 | export-audit 단위 여덟, export.test HTTP 둘, 통합 셋이 칸마다 정확한 값(`count 2`, `filter`는 `toStrictEqual`, UUIDv7, `2028-11-15`·`2030-03-01`, `'203.0.113.7'`)과 거절·호출 0을 단언 | 맞음. M07~M13·M16~M18·M20·M36이 잡혔다 |
| J-T26 ⑥ | 파일을 주지 않고 내려받기 이력도 남지 않음(이력과 접속기록이 한 트랜잭션) | 단위: `recordExport` 한 번, 실패 시 오류 그대로, 가짜 db의 같은 `tx`. HTTP: 5xx·`content-disposition` 없음. 통합: 실제 롤백 뒤 `attendee_export` 0행 | 맞음(통합 쪽 실패 보기는 D04 대기) |
| SEC-06R ①~⑤ | 401(403이 아님), local·ci 밖 무토큰 시작 거절, 상수 시간 비교(길이가 다르면 비교 없이 거절)(architecture.md §3.2, ASVS 11.2.4) | ① prod·staging × undefined·'' 넷 모두 시작 실패, ② local·ci 200·404, ③ 401 셋과 `settlement-due` 401, ④⑤ `timingSafeEqual` 호출 1·1·0과 Buffer 길이 | 맞음. 다섯 모두 변이로 실패를 봤다 |
| COV2-06 ⑨ | 토큰 없음·틀림 403, UUID 아님 400, 맞으면 `{ anonymized: 2 }`, 다시 부르면 0 | 그대로 `toEqual`로 정확한 값 | 맞음(M37·M38로 실패 봄) |
| COV2-06 ⑩ | `main.ts`가 시작 전에 설정을 읽고, 듣기 뒤 소비자를 켜고, SIGTERM에서 소비자를 먼저 멈춘다. 소비자 DB는 core_app | 원문의 글 차례와 DB 이름만 본다 | **부분**. '켠다'와 '먼저 멈춘 뒤 닫는다'를 실제로 보지 않는다(M28·M33 살아남음, 위에서 넘김) |
| COV2-06 ⑪~⑯ | 계획 §4 표(그 계정 행만 바꾸고 다시 0건, 실제 Kafka·pid 없는 보류, 0022 칸 단위, core_app 허용·거부, 정비 역할 ±1ms·8일/6일) | 통합 시험 원문이 값마다 정확히 단언(`account_id = id`, B 행 그대로, 보류 `value` null·pid 글자 없음, 42501 일곱과 허용 대조군 둘, `notice_until` ±1ms, 8일 된 행만 지움). ⑬은 GRANT를 (역할, 표, 권한, 칸)으로 풀어 표와 같은지, REVOKE·다른 문이 없는지 본다 | 맞음(⑬은 M34·M35로 실패 봄, 통합 쪽은 D05~D11 대기) |
| A2-17·A2-19·R2(결함 ID) | 계획 §1·§2·R2 보충의 시험 목록 | 목록의 이름이 모두 시험 파일에 있고, 단언이 목록의 값과 같다 | 맞음 |

- **이름만 달린 시험**: 이 묶음이 쓴 시험에는 없다. 기존 `J-T26 ②`(위)가 판정 기준을 단언하지 않는다. 기존 `J-T26 명단 보기는 가린 값만…`·`J-T26 실무자는…`·`J-T26 CSV는 수식…`은 세부 번호 없이 ID만 단 시험이다(계획 §6이 적은 장부 'ID만'과 같다).
- **처리**: 살아남은 둘(M28·M33)은 시험 담당이 위 단언으로 시험을 더한다. 높음·보안·통과 기준 지적은 아니지만 '자주 놓친 결함'의 시작 파일 조립이라 이 웨이브 안에서 다루기를 권한다(감독이 정한다). Docker 대기 12개는 잠금 아래 돌린 뒤 이 절에 결과를 더한다.

### 2단계(Docker·고친 곳)

- **누가·언제·바탕**: 검증 담당(세션 `l3w7-audit-verify`), 2026-11-16 12:00~12:12 KST, 감독이 잡은 도커 잠금 아래. HEAD `a311e5c1`(가지를 origin/develop 위로 올린 뒤, 웨이브 끝 리뷰 반영 C1·C4·K1·K2·K6·K9와 검증 M28·M33 시험이 들어온 상태). 방법은 1단계와 같다(하나 넣고 돌리고 `git checkout -- <파일>`로 되돌림, 시험 파일은 안 건드림).
- **기준선(바꾸지 않은 상태)**: core-svc `npx vitest run --config vitest.integration.config.mjs test-int/export-audit.int.test.ts test-int/review-withdrawn.int.test.ts test-int/review-grants.int.test.ts test-int/review.int.test.ts test-int/review-withdrawn-consumer.int.test.ts` 파일 5개·시험 16개 모두 통과(29초), purchase-svc `npx vitest run --config vitest.integration.config.mjs test-int/attendee-reader.int.test.ts` 1개 통과.
- **D02는 해당 없음**: 겨누던 `source_ip` NOT NULL CHECK가 0021에서 빠졌다(리뷰 K1: 칸만 더하고 새 행의 접속지는 앱이 강제한다). 앱 쪽 검사를 빼는 변이는 아래 N05로 대신 넣었다. D01은 모양 CHECK가 `NOT VALID`가 된 뒤에도 새 행에는 검사가 걸리므로 그대로 넣었다.
- 단위 변이(N)는 1단계의 명단 묶음(지금 시험 55개)·후기 묶음(35개)으로 돌렸다.

| 번호 | 파일:줄 | 바꾼 것 | 돌린 시험 | 결과(잡은 시험) |
| --- | --- | --- | --- | --- |
| D01 | core `migrations/0021_attendee_access_audit_list.sql:14` | LIST 모양 CHECK에서 `reason is null`을 뺀다 | 통합 `test-int/export-audit.int.test.ts` | 잡힘(⑤⑥ 모양이 틀리면 CHECK가 거절한다) |
| D02 | — | (`source_ip` CHECK가 없어져 해당 없음) | — | 해당 없음 |
| D03 | core `export/adapters/db/schema.ts:53` | `inet('source_ip')`를 `inet('client_ip')`로 | 통합 `export-audit.int` | 잡힘(시험 넷: ⑥ 롤백, ⑤⑥ CHECK, core_partner 권한, R2 K1 접속지) |
| D04 | core `export/adapters/db/drizzle-export-store.ts:31·43` | 이력을 따로 트랜잭션으로 먼저 커밋 | 통합 `export-audit.int` | 잡힘(⑥ 접속기록 넣기가 실패하면 attendee_export도 남지 않는다) |
| D05 | core `migrations/0022_review_role_grants.sql:7` | core_app review UPDATE 칸에서 `account_id`·`basis_order_id`를 뺀다 | 통합 후기 넷(`review-withdrawn`·`review-grants`·`review`·`review-withdrawn-consumer`) | 잡힘(COV2-06 ⑪, ⑫) |
| D06 | `0022_review_role_grants.sql:22` | core_maintenance review UPDATE 칸에서 `updated_at`을 뺀다 | 통합 후기 셋 | 잡힘(COV2-06 ⑯) |
| D07 | `0022_review_role_grants.sql:19` | core_app `held_event` INSERT를 뺀다 | 통합 `review-withdrawn-consumer` | 잡힘(COV2-06 ⑫) |
| D08 | `0022_review_role_grants.sql:7` | review에 칸 없는 UPDATE·DELETE | 통합 후기 셋 | 잡힘(COV2-06 ⑮) |
| D09 | core `review/adapters/db/drizzle-review-store.ts:257` | 익명화 `where`가 계정 조건 없이 모든 행을 바꾼다 | 통합 후기 셋 | 잡힘(COV2-06 ⑪) |
| D10 | core `consumers/start.ts:47` | 보류 저장소를 `pidFreeHeldEventStore` 없이 건다 | 통합 `review-withdrawn-consumer`(실제 Kafka) | 잡힘(COV2-06 ⑫) |
| D11 | `consumers/start.ts:44` | 소비자 그룹을 `core-svc.<환경>`으로 | 통합 `review-withdrawn-consumer` | 잡힘(COV2-06 ⑫) |
| D12 | purchase `booking/adapters/db/drizzle-attendee-reader.ts:69` | 걸러 낸 뒤 남은 행 기준으로 커서를 만든다 | 통합 purchase `attendee-reader.int` | 잡힘('처음부터 통과'였던 A2-17 J-T26 ④ purchase 시험이 실패를 봤다) |
| D13 | `0022_review_role_grants.sql:30` | `review_account_idx` 색인을 뺀다(K2) | 단위 `test/review-grants.test.ts` + 통합 `review-withdrawn.int` | 잡힘(⑬, K2 색인 원문, K2 실행 계획 `review_account_idx`) |
| N01 | core `export/domain/export.ts:35` | 원천 503에서 Retry-After를 뺀다(C1) | 명단 묶음 | 잡힘(C4·C1 시험 넷) |
| N02 | `export.ts:35` | 503 제목에 목록 값 대신 사정(detail)을 쓴다(C1) | 명단 묶음 | 잡힘(C1 시험 셋) |
| N03 | core `export/application/attendee-exports.ts:52` | 유스케이스가 `retryAfterSeconds`를 넘기지 않는다(C1) | 명단 묶음 | 잡힘(C1 시험 셋) |
| N04 | core `export/adapters/http-attendee-source.ts:24` | 원천의 빈 문자열 `nextCursor`를 받는다(`.min(1)` 뺌, C4) | 명단 묶음 | 잡힘(A2-17 C4 빈 문자열 nextCursor…) |
| N05 | `attendee-exports.ts:70` | 앱 쪽 접속지 검사를 통째로 뺀다(K1, 이제 DB 검사가 없어 앱만 지킨다) | 명단 묶음 | 잡힘(R2 ⑤ 접속지를 정하지 못하면…) |
| N06 | core `main.ts:147` | 소비자에 API 풀(`database`)을 넘긴다(K2) | 후기 묶음 | 잡힘(COV2-06 K2 소비자는 따로 둔 core_app 풀…) |
| N07 | `main.ts:134` | 소비자용 익명화 저장소를 API 풀로 만든다(`new DrizzleReviewStore(database)`, K2) | 후기 묶음 | **살아남음** |
| N08 | core `consumers/start.ts:35` | 소비자 동시 처리 키 수를 2에서 16으로(K2) | 후기 묶음 | 잡힘(COV2-06 K2 … 파티션 1·키 2) |
| N09 | `main.ts:142` | 1단계 M28 다시: 소비자를 조건으로 막아 켜지 않는다 | 후기 묶음 | 잡힘(COV2-06 ⑰ 새 시험) |
| N10 | `main.ts:168` | 1단계 M33 다시: SIGTERM에서 `stop()`을 기다리지 않는다 | 후기 묶음 | 잡힘(COV2-06 ⑱ 새 시험) |

- **합계(2단계)**: 넣은 수 22(Docker 12, 단위 10), 해당 없음 1(D02). **잡힘 21, 살아남음 1(N07)**. 1단계에서 살아남았던 M28·M33은 시험 담당이 더한 ⑰⑱이 잡는다(N09·N10). 1단계 Docker 대기 목록은 D02를 빼고 모두 실패를 봤다.
- **1·2단계 합계**: 넣은 수 63(동등 변이 1·해당 없음 1 포함), 잡힘 59, 살아남음 1(N07, M28·M33은 고쳐짐).
- **컨테이너 정리**: 전후 `docker ps -a`가 같다(이 갈래 시험 컨테이너가 남지 않았고, 다른 갈래 컨테이너는 건드리지 않았다). 끝난 뒤 `git status --short`·`git diff`가 비어 있다.

| 번호 | 무엇이 새나 | 시험 담당에게 넘김: 무엇을 단언해야 하나 |
| --- | --- | --- |
| N07 | K2 시험은 `startCoreConsumers({ database: … })`가 소비자 풀인지만 본다. 처리기에 넘기는 `consumerReviews`의 저장소(`new DrizzleReviewStore(…)`)가 API 풀(`database`)이어도 통과한다. 그러면 사건이 몰릴 때 익명화 UPDATE가 팬·관제 HTTP 경로의 연결을 쓴다(리뷰 K2가 막으려던 것). 보류 표만 소비자 풀로 간다 | `main.ts`에서 `ReviewAccountWithdrawnHandler`에 넘기는 `Reviews`의 `store: new DrizzleReviewStore(<이름>)`의 이름이 `startCoreConsumers`의 `database` 칸과 같은 소비자 풀 이름(지금 `consumerDatabase`)인지, `database`·`partnerDatabase`·`opsDatabase`가 아닌지 단언한다 |

### 3단계(처음부터 통과 대조)

- **누가·언제·바탕**: 검증 담당(세션 `l3w7-audit-verify`), 2026-11-16, HEAD `76873015`. 시험 담당이 `## 실패 확인`에 적은 '구현 전 트리에서 통과한 통합 시험 다섯'(`f8284d51`)마다 1·2단계 변이 가운데 그 시험을 실패시킨 것이 있는지 맞춰 봤다. 없거나 엉뚱한 까닭으로만 실패한 것은 시험 담당이 적은 틀린 구현을 넣었다. 도커 잠금이 다른 갈래 차례라 Docker가 필요한 것은 돌리지 않고 목록에만 넣었다. 단위로 볼 수 있는 것만 돌렸다(1·2단계와 같은 방법, 끝난 뒤 `git status`·`git diff`에 제품 코드 변경 없음).

| 시험(처음부터 통과) | 그 시험을 실패시킨 1·2단계 변이 | 시험 담당이 적은 틀린 구현과의 대조 | 판정 |
| --- | --- | --- | --- |
| A2-19 J-T26 ⑥ 접속기록 넣기가 실패하면 attendee_export도 남지 않는다 | D04(이력을 따로 트랜잭션으로 먼저 커밋). 이 시험 하나만 실패했다 | 적힌 틀린 구현과 같다 | 실패 봄 |
| A2-19 J-T26 ⑤⑥ 0021 뒤 LIST·DOWNLOAD 행이 들어가고 모양이 틀리면 CHECK가 거절한다 | D01(LIST 모양 CHECK에서 `reason is null` 뺌). D03(칸 이름 틀림)에서도 실패 | D01이 '사유 있는 LIST가 들어간다'와 같은 뜻이다 | 실패 봄 |
| A2-19 core_partner는 접속기록을 고치거나 지우지 못하고 다른 테넌트 행을 읽지 못한다 [ASVS v5.0.0-8.4.1] | D03에서만 실패했다. 그것은 `source_ip` 칸이 없어 넣기가 실패한 것이라 권한 단언(42501, 다른 테넌트 0행)과 상관없다 | 적힌 틀린 구현을 단위로 넣었다. P01 0021에 `GRANT UPDATE, DELETE ON attendee_export_audit TO core_partner` 더함, P02 0021에서 그 표의 행 보안을 끔. 둘 다 단위 0021 원문 시험(`A2-19 0021은 … UPDATE·DELETE를 주지 않는다`)이 잡았다. 이 통합 시험 자체의 실패는 Docker가 있어야 본다 | **Docker 대기**: P01·P02를 core-svc `npx vitest run --config vitest.integration.config.mjs test-int/export-audit.int.test.ts`로 |
| COV2-06 ⑪ Drizzle 익명화는 그 계정 행만 바꾸고 다시 해도 0건이다 | D05(0022 review UPDATE 칸에서 `account_id`·`basis_order_id` 뺌, 42501), D09(`where` 계정 조건 빠뜨림) | 적힌 두 틀린 구현과 같다 | 실패 봄 |
| COV2-06 ⑫ 실제 Kafka의 탈퇴 사건이 core 후기를 익명화하고, 읽지 못한 사건은 pid 없이 held_event에 보류된다(K9) | D05·D07·D10·D11에서 실패. 이 넷은 익명화·보류·pid·그룹 단언에서 걸렸고 K9 지표 단언은 겨누지 않았다 | 적힌 틀린 구현(K9)을 단위로 넣었다. P03 `heldCounts`를 넘기지 않음: 단위 `COV2-06 K2 소비자는 따로 둔 core_app 풀과 파티션 1·키 2로 돈다`가 잡음. P04 `registry`를 넘기지 않음: **단위에서 살아남음**(단위 시험은 `heldCounts`만 부르고 `registry`가 넘어가는지 보지 않는다). 통합 ⑫의 K9 단언(`consumer_held_events` 1)이 잡아야 한다 | 실패는 봄(⑫). **K9 부분은 Docker 대기**: P04(필요하면 P03도)를 core-svc `npx vitest run --config vitest.integration.config.mjs test-int/review-withdrawn-consumer.int.test.ts`로 |

| 번호 | 파일:줄 | 바꾼 것 | 돌린 시험 | 결과 |
| --- | --- | --- | --- | --- |
| P01 | core `migrations/0021_attendee_access_audit_list.sql:15`(끝에 더함) | `GRANT UPDATE, DELETE ON attendee_export_audit TO core_partner;` | 단위 `test/export-audit.test.ts` | 잡힘(0021 원문 시험) |
| P02 | `0021_attendee_access_audit_list.sql:15`(끝에 더함) | `ALTER TABLE "attendee_export_audit" DISABLE ROW LEVEL SECURITY;` | 단위 `test/export-audit.test.ts` | 잡힘(0021 원문 시험) |
| P03 | core `consumers/start.ts:49` | `heldCounts`를 `runKeyedConsumer`에 넘기지 않는다 | 단위 `test/core-consumers.test.ts` | 잡힘(COV2-06 K2 소비자 조립) |
| P04 | `consumers/start.ts:48` | `registry`를 `runKeyedConsumer`에 넘기지 않는다 | 단위 `test/core-consumers.test.ts` | **살아남음(단위)**, 통합 ⑫ K9로 볼 것 |

- **합계(3단계)**: 넣은 수 4, 잡힘 3, 단위에서 살아남음 1(P04). 다섯 가운데 셋(⑥ 롤백, ⑤⑥ CHECK, ⑪)은 1·2단계 변이로 실패를 이미 봤다. core_partner 권한 시험은 권한 단언으로는 실패를 아직 못 봤고, ⑫는 K9 부분을 아직 못 봤다. 둘은 다음 도커 잠금에서 위 명령으로 P01·P02·P04를 돌린다.
- **시험 담당에게 넘김(P04)**: 단위 `COV2-06 K2 소비자는 따로 둔 core_app 풀과 파티션 1·키 2로 돈다`가 `runKeyedConsumer`에 넘긴 옵션에서 `registry`가 `startCoreConsumers`에 준 그 지표 저장소와 같은 객체인지(`toBe`)도 단언한다. 그러면 Docker 없이 잡힌다.
