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
- 내부 경로와 `Reviews.anonymizeAccount`·`ReviewStore.anonymizeByAccount`의 동작은 바꾸지 않는다(아래 OPEN 후보 1).
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
| `COV2-06 ① 탈퇴 사건을 받으면 그 계정 후기의 계정·주문 참조를 후기 ID로 바꾼다` | 단위 | 메모리 저장소: 계정 A 후기 둘(VISIBLE·DELETED), 계정 B 후기 하나. A의 사건 뒤 A의 두 행 `accountId`·`basisOrderId` = 각자의 후기 ID, `authorDisplay` '탈퇴한 사용자', `updatedAtMs` = 가짜 시계. B 행은 모든 칸이 그대로 | 본문·별점 단언은 OPEN 후보 1에 따라 바뀔 수 있어 지금은 '그대로'만 본다 |
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

### 5. OPEN 후보(방향을 바꾸는 결정이라 정본에 쓰지 않았다)

1. **탈퇴한 계정의 후기를 익명화해 남길지, 파기할지.** 정본끼리 어긋난다. R-617(2026-11-15)이 쓴 docs/features/identity.md §8 '후기 익명화'는 "본문·평점은 법정 보존·분쟁 대응을 위해 남기고 계정·주문 참조만 끊는다"이다. 그런데 docs/data.md §6 '관람 후기' 행은 "작성자가 지우거나 회원이 탈퇴하면 파기한다. 행은 DELETED로 바꾸며 본문·별점·사진 키·계정 ID를 바로 비운다"이고, docs/security/data-classification.md '관람 후기' 행("후기 삭제 또는 회원 탈퇴 시 파기")과 docs/planning/03-policies-glossary.md 권한표 '관람 후기' 행("탈퇴 때 삭제"), ADR-0086 ⑧(소프트 삭제 때 비우는 칸)도 같은 쪽이다. 후기 본문을 남길 법정 근거는 정본에 없다(법정 차단 조치 증적 3년은 `takedown_action`이 따로 둔다).
   - 추천: (가) 파기 쪽으로 맞춘다. 정본 넷이 같은 쪽이고 개인정보를 덜 남긴다. 하려면 `review.rating` NOT NULL 풀기(마이그레이션), `review_image` 파일·행 지우기, `content_fingerprint` 비우기, 공개 목록·요약에서 빠지는 것을 함께 정해야 한다. (나) R-617대로 두고 data.md·data-classification·planning/03을 고친다.
   - 이번 묶음: 결정 전까지 배선(사건 → 기존 `anonymizeAccount`)만 한다. 어느 쪽이든 '계정·주문 참조를 끊는다'는 같으므로 시험 ①⑪의 그 단언은 남고, 본문·별점·작성자 표시 단언만 바뀐다. identity.md에 결정 대기를 한 줄 적었다.
2. **파트너 명단 접속기록을 어디에 둘지.** 정본의 관리 계정 접속기록 저장소는 ops-svc 감사 저장소의 `admin_data_access`(해시 체인, 접속지 정보 `source_ip`, FR-064 매일 이상 점검이 읽는 곳)인데, 구현은 core DB `attendee_export_audit`이다(R-606). 지금은 FR-064 점검(같은 명단 24시간 3회, 1만 건 이상, 근무 일정 밖 조회)이 파트너 명단 기록을 읽지 못한다. 이번 묶음은 core 표를 넓혀 쓰고 data.md에 '옮기는 일은 정해지지 않았다'고 적었다. 옮길지, 옮긴다면 core가 사건으로 보낼지 ops가 읽을지는 소유자 결정이다.

### 6. 막힌 것·확인할 것

- 막힌 것은 없다. 위 OPEN 후보 1은 COV2-06 배선을 막지 않는다.
- (보충 2026-11-16) 실패 확인 절 '확인할 것 1'(운영 역할의 후기·보류 표 쓰기 권한)은 §4 보충(0022, 시험 ⑬~⑯)으로 받았다. 기존 후기 쓰기 경로도 같은 결함이라 이번 범위에 넣었다. '확인할 것 2'(0021 CHECK 글)는 §2의 글을 그대로 쓴다. 같은 뜻의 다른 글로 쓰려면 구현 담당이 '시험 이의'로 적는다.
- 장부: `node tools/ci/ledger.mjs --batch BAT-610`은 이 커밋 뒤 J-T26 ④⑤⑥을 'ID만'으로 보인다(기존 파트너 화면 시험 이름이 세부 번호 없이 `J-T26`을 단다). 이 묶음의 시험이 들어오면 채워진다. 기록 담당이 장부를 다시 쓸 때 확인한다.
- 정본 점검: `python -I -X utf8 tools/doc-check/check_all.py` 오류 0, `pnpm --dir packages/contracts gen:check`(asyncapi는 설명만 바꿔 생성물이 같다).

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
