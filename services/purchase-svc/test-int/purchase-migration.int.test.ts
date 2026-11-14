// purchase DB의 좌석 표 마이그레이션을 실제 PostgreSQL 18 컨테이너에서 돈다(docs/data.md §4 'purchase DB의 좌석 표 마이그레이션', docs/features/seat-hold.md §6 'Hard Sale 저장소의 첫 구현',
// BUILD_ORDER PRF-140 ①). 마이그레이션 멱등, seat_hold의 월 파티션, check 제약, 활성 상태 부분 유일 인덱스가 실제 DB에서 정본대로 막는지 본다.
// 세 번째 마이그레이션(0002, BUILD_ORDER PRF-143, docs/data.md §4 '다시 만들기 표와 원장 칸')의 seat_rebuild 표와 seat_hold의 hold_id·purchase_session_id 칸도 본다.
// 네 번째 마이그레이션(0003, BUILD_ORDER PRF-160, docs/data.md §4 '주문 표 마이그레이션')은 표가 생기는 것과 파티션 여부만 여기서 보고(주문 표 다섯은 나누지 않고 Outbox 부모만 ID 범위로 나눈다),
// 주문 표의 제약·인덱스·전이는 test-int/order-store.int.test.ts가 본다.
// 컨테이너는 이 파일이 끝나면 afterAll에서 지운다.
import { randomUUID } from 'node:crypto';
import { fakeClock, systemClock, uuidv7, uuidv7Time } from '@peaket/platform';
import { getTableConfig } from 'drizzle-orm/pg-core';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { ensureSeatHoldPartitions, migratePurchase } from '../scripts/migrate.mjs';
import { purchaseQuota, seatHold, seatRebuild, seatSale } from '../src/modules/inventory/adapters/db/schema.js';
import { type PostgresContainer, startPostgres } from './postgres.js';

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
/** ms가 든 한국 시각 달에서 add달 뒤 달의 1일 0시(유닉스 ms). 플랫폼 함수와 따로 센 값이다 */
function kstMonthStart(ms: number, add = 0): number {
  const d = new Date(ms + KST_OFFSET_MS);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + add, 1) - KST_OFFSET_MS;
}
const partitionName = (ms: number, add = 0): string => `seat_hold_p${new Date(kstMonthStart(ms, add) + KST_OFFSET_MS).toISOString().slice(0, 7).replace('-', '')}`;
/** 그 시각에 만든 UUIDv7 회차 ID */
const eventAt = (ms: number): string => uuidv7(fakeClock({ now: ms }));

const NO_PARTITION = /no partition of relation "seat_hold" found for row/;
/** 시작 때 한 번 정한 '지금'. 첫 파티션은 이 달부터 만들어진다 */
let startedAt = 0;
let container: PostgresContainer | undefined;
let url = '';
let db: pg.Client;
/** 처음 ensureSeatHoldPartitions가 돌려준 이름 */
let firstCreated: string[] = [];

beforeAll(async () => {
  container = await startPostgres();
  url = container.url;
  startedAt = Date.now();
  await migratePurchase(url);
  firstCreated = await ensureSeatHoldPartitions(url);
  db = new pg.Client({ connectionString: url });
  await db.connect();
});

afterAll(async () => {
  await db?.end().catch(() => undefined);
  container?.stop();
});

const q = <R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params?: unknown[]) => db.query<R>(text, params);
const id = (): string => randomUUID();

const putSale = (e: string, s: string, o: string, status: string) =>
  q('insert into seat_sale (event_id, seat_id, order_id, account_id, status) values ($1, $2, $3, $4, $5)', [e, s, o, id(), status]);
const putHold = (e: string, s: string, token: number, status: string, kind?: string) =>
  kind === undefined
    ? q(`insert into seat_hold (event_id, seat_id, account_id, fencing_token, status, expires_at) values ($1, $2, $3, $4, $5, now() + interval '1 minute')`, [e, s, id(), token, status])
    : q(`insert into seat_hold (event_id, seat_id, account_id, fencing_token, status, kind, expires_at) values ($1, $2, $3, $4, $5, $6, now() + interval '1 minute')`, [e, s, id(), token, status, kind]);
const putQuota = (account: string, event: string, used: number, limit: number) =>
  q('insert into purchase_quota (account_id, event_id, used, limit_count) values ($1, $2, $3, $4)', [account, event, used, limit]);
const count = async (text: string, params: unknown[]): Promise<number> => Number((await q<{ n: string }>(text, params)).rows[0]!.n);
const salesOf = (e: string, s: string) => count('select count(*) as n from seat_sale where event_id = $1 and seat_id = $2', [e, s]);

describe('마이그레이션과 표 모양', () => {
  test('마이그레이션을 더 돌려도 오류가 없고 표가 그대로이며 적용 기록은 마이그레이션 파일 수 17(0000 좌석 표, 0001 보류 표, 0002 다시 만들기 표·원장 칸, 0003 주문 표·Outbox, 0004 주문의 홀드·구매 세션 칸, 0005 결제 참조 칸·판 번호·Saga 작업 표, 0006 실패 사유·작업 단계 CHECK, 0007 발권 재시도 큐, 0008 주문의 묶은 시각, 0009 발권 큐 임대·표시 칸, 0010 작업 단계 AWAIT·다음 당기기 점검 시각, 0011 열린 주문 부분 인덱스, 0012 회차 판매 상태 표·결제 중 부분 인덱스, 0013 발권 무효 작업 큐, 0014 예매 취소 표·환급 시각, 0015 환급 재시도 칸·부분 인덱스, 0016 회차 취소 요청·환불 항목)과 같다 [ASVS v5.0.0-2.3.4]', async () => {
    const tables = async () => (await q<{ relname: string }>(`select relname from pg_class where relnamespace = 'public'::regnamespace and relkind in ('r', 'p') order by relname`)).rows.map((r) => r.relname);
    const before = await tables();
    // 0003이 만든 주문 표 다섯과 Outbox 부모 표(PRF-160), 0005가 만든 Saga 작업 표(PRF-162), 0007이 만든 발권 재시도 큐(PRF-163)가 있다
    expect(before).toEqual(
      expect.arrayContaining(['purchase_order', 'order_item', 'order_event', 'order_idempotency', 'payment_attempt', 'outbox', 'order_saga_job', 'ticket_issue_job', 'event_sale', 'order_cancellation', 'event_cancellation_request', 'event_refund_item']),
    );
    await migratePurchase(url);
    await migratePurchase(url);
    expect(await tables()).toEqual(before);
    expect(await count('select count(*) as n from drizzle.__drizzle_migrations', [])).toBe(19);
  });

  test('GAT080_0014(예매 취소): order_cancellation은 refund_due_at·진행 중 취소 1건 유일 색인·상태/사유/금액 CHECK를 만든다', async () => {
    const cols = await q<{ column_name: string; data_type: string; is_nullable: string }>(
      "select column_name, data_type, is_nullable from information_schema.columns where table_schema = 'public' and table_name = 'order_cancellation' order by ordinal_position",
    );
    expect(cols.rows).toEqual(
      expect.arrayContaining([
        { column_name: 'order_id', data_type: 'uuid', is_nullable: 'NO' },
        { column_name: 'ticket_id', data_type: 'uuid', is_nullable: 'NO' },
        { column_name: 'reason', data_type: 'text', is_nullable: 'NO' },
        { column_name: 'deduction_bp', data_type: 'integer', is_nullable: 'NO' },
        { column_name: 'refund_amount', data_type: 'integer', is_nullable: 'NO' },
        { column_name: 'status', data_type: 'text', is_nullable: 'NO' },
        { column_name: 'refund_due_at', data_type: 'timestamp with time zone', is_nullable: 'YES' },
      ]),
    );
    const idx = await q<{ indexname: string; indexdef: string }>("select indexname, indexdef from pg_indexes where schemaname = 'public' and tablename = 'order_cancellation'");
    expect(idx.rows.find((r) => r.indexname === 'order_cancellation_active_key')?.indexdef).toContain("status <> 'VOIDED'");
    const checks = await q<{ conname: string }>("select conname from pg_constraint where conrelid = 'public.order_cancellation'::regclass and contype = 'c' order by conname");
    expect(checks.rows.map((r) => r.conname)).toEqual(['order_cancellation_amounts_check', 'order_cancellation_reason_check', 'order_cancellation_refund_attempts_check', 'order_cancellation_status_check']);
  });

  test('GAT090_0015(환급 재시도): refund_attempts·next_refund_at·refund_failed_at·refund_last_error와 REFUND_PENDING 부분 인덱스를 만든다', async () => {
    const cols = await q<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }>(
      "select column_name, data_type, is_nullable, column_default from information_schema.columns where table_schema = 'public' and table_name = 'order_cancellation' and column_name in ('refund_attempts','next_refund_at','refund_failed_at','refund_last_error') order by column_name",
    );
    expect(cols.rows).toEqual([
      { column_name: 'next_refund_at', data_type: 'timestamp with time zone', is_nullable: 'YES', column_default: null },
      { column_name: 'refund_attempts', data_type: 'integer', is_nullable: 'NO', column_default: '0' },
      { column_name: 'refund_failed_at', data_type: 'timestamp with time zone', is_nullable: 'YES', column_default: null },
      { column_name: 'refund_last_error', data_type: 'text', is_nullable: 'YES', column_default: null },
    ]);
    const idx = await q<{ indexdef: string }>("select indexdef from pg_indexes where schemaname = 'public' and tablename = 'order_cancellation' and indexname = 'order_cancellation_refund_due_idx'");
    expect(idx.rows[0]?.indexdef).toContain("WHERE ((status = 'REFUND_PENDING'::text) AND (refund_failed_at IS NULL))");
    const checks = await q<{ conname: string }>("select conname from pg_constraint where conrelid = 'public.order_cancellation'::regclass and contype = 'c' order by conname");
    expect(checks.rows.map((r) => r.conname)).toContain('order_cancellation_refund_attempts_check');
  });

  test('ST25_ADR0122_0012(PRF-144, data.md §4 열세 번째 마이그레이션·§5.1): seat_sale_pending_idx는 seat_sale (event_id, reserved_at)의 PENDING 부분 인덱스이고(리뷰 고침 L11), event_sale은 다섯 상태·판 번호 1 이상·음수 아닌 셈을 CHECK로 거절하며 매진 등급 기본값은 빈 배열이다 [ASVS v5.0.0-2.3.4]', async () => {
    const idx = await q<{ indexdef: string }>(`select indexdef from pg_indexes where schemaname = 'public' and tablename = 'seat_sale' and indexname = 'seat_sale_pending_idx'`);
    expect(idx.rows).toHaveLength(1);
    expect(idx.rows[0]!.indexdef).toBe(`CREATE INDEX seat_sale_pending_idx ON public.seat_sale USING btree (event_id, reserved_at) WHERE (status = 'PENDING'::text)`);

    const ok = id();
    await q(`insert into event_sale (event_id, status, version, sellable_seats, available, held, paying, changed_at, counted_at) values ($1, 'ON_SALE', 1, 10, 10, 0, 0, now(), now())`, [ok]);
    expect((await q<{ sold_out_tiers: string[]; reopen_count: number }>('select sold_out_tiers, reopen_count from event_sale where event_id = $1', [ok])).rows).toEqual([{ sold_out_tiers: [], reopen_count: 0 }]);

    const insert = (over: { status?: string; previous?: string | null; version?: number; available?: number; held?: number; paying?: number; sellable?: number; reopen?: number }) =>
      q(
        `insert into event_sale (event_id, status, previous_status, version, sellable_seats, available, held, paying, reopen_count, changed_at, counted_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, now(), now())`,
        [id(), over.status ?? 'ON_SALE', over.previous ?? null, over.version ?? 1, over.sellable ?? 10, over.available ?? 0, over.held ?? 0, over.paying ?? 0, over.reopen ?? 0],
      );
    for (const status of ['UPCOMING', 'ON_SALE', 'ALL_HELD', 'SOLD_OUT', 'ENDED']) await expect(insert({ status })).resolves.toBeDefined();
    for (const bad of [{ status: 'SOLD' }, { previous: 'SOLD' }, { version: 0 }, { available: -1 }, { held: -1 }, { paying: -1 }, { sellable: -1 }, { reopen: -1 }]) {
      await expect(insert(bad), JSON.stringify(bad)).rejects.toMatchObject({ code: '23514' });
    }
  });

  test('PT41_ADR0107_리뷰 고침 M1: 0011(PRF-172, data.md §4 열두 번째 마이그레이션·§5.1): purchase_order_session_idx는 purchase_order (purchase_session_id)의 유일이 아닌 조건 없는 인덱스다(status를 조건에 넣으면 상태를 바꾸는 UPDATE가 모두 HOT 갱신에서 빠진다) [ASVS v5.0.0-2.3.4]', async () => {
    const idx = await q<{ indexdef: string }>(`select indexdef from pg_indexes where schemaname = 'public' and tablename = 'purchase_order' and indexname = 'purchase_order_session_idx'`);
    expect(idx.rows).toHaveLength(1);
    expect(idx.rows[0]!.indexdef).toBe('CREATE INDEX purchase_order_session_idx ON public.purchase_order USING btree (purchase_session_id)');
  });

  test('0010(PRF-171, data.md §4 열한 번째 마이그레이션·§2 ERD order_saga_job): pull_next_at은 널 허용 timestamptz이고 기본값이 없으며 그 칸에 걸린 인덱스가 없고(작은 작업 표, data.md §5.1), step CHECK는 RESERVE·CONFIRM·RELEASE·AWAIT를 받는다 [ASVS v5.0.0-2.3.4]', async () => {
    const col = await q<{ data_type: string; is_nullable: string; column_default: string | null }>(
      `select data_type, is_nullable, column_default from information_schema.columns where table_schema = 'public' and table_name = 'order_saga_job' and column_name = 'pull_next_at'`,
    );
    expect(col.rows).toEqual([{ data_type: 'timestamp with time zone', is_nullable: 'YES', column_default: null }]);
    const idx = await q<{ indexdef: string }>(`select indexdef from pg_indexes where schemaname = 'public' and tablename = 'order_saga_job'`);
    expect(idx.rows.filter((r) => r.indexdef.includes('pull_next_at'))).toEqual([]);
    const step = await q<{ def: string }>(
      `select pg_get_constraintdef(oid) as def from pg_constraint where conrelid = 'public.order_saga_job'::regclass and conname = 'order_saga_job_step_check'`,
    );
    expect(step.rows).toHaveLength(1);
    // 값 넷(차례 RESERVE·CONFIRM·RELEASE·AWAIT, 0010이 AWAIT를 더했다). 실제 행 거절(23514)은 saga-db.int.test.ts의 setStep 시험이 본다
    expect(step.rows[0]!.def.match(/'[A-Z_]+'::text/g)).toEqual(["'RESERVE'::text", "'CONFIRM'::text", "'RELEASE'::text", "'AWAIT'::text"]);
  });

  test('0009(PRF-170, data.md §4 열 번째 마이그레이션·§2 ERD ticket_issue_job): lease_until·delayed_at·overdue_at은 널 허용 timestamptz이고 기본값이 없으며, 세 칸에 걸린 CHECK·인덱스가 없다(진행 중 행만 있는 작은 표, data.md §5.1) [ASVS v5.0.0-2.3.4]', async () => {
    const cols = await q<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }>(
      `select column_name, data_type, is_nullable, column_default from information_schema.columns where table_schema = 'public' and table_name = 'ticket_issue_job' and column_name in ('lease_until', 'delayed_at', 'overdue_at') order by ordinal_position`,
    );
    expect(cols.rows).toEqual(
      ['lease_until', 'delayed_at', 'overdue_at'].map((n) => ({ column_name: n, data_type: 'timestamp with time zone', is_nullable: 'YES', column_default: null })),
    );
    const checks = await q<{ def: string }>(`select pg_get_constraintdef(oid) as def from pg_constraint where conrelid = 'public.ticket_issue_job'::regclass and contype = 'c'`);
    expect(checks.rows).toEqual([]);
    const idx = await q<{ indexdef: string }>(`select indexdef from pg_indexes where schemaname = 'public' and tablename = 'ticket_issue_job'`);
    expect(idx.rows.filter((r) => /lease_until|delayed_at|overdue_at/.test(r.indexdef))).toEqual([]);
  });

  test('0008(PRF-167, data.md §4 아홉 번째 마이그레이션): purchase_order.pinned_at은 널 허용 timestamptz이고 기본값이 없으며, 그 칸에 걸린 CHECK·인덱스가 없다(쓰기가 많은 표, data.md §5.1) [ASVS v5.0.0-2.3.4]', async () => {
    const col = await q<{ data_type: string; is_nullable: string; column_default: string | null }>(
      `select data_type, is_nullable, column_default from information_schema.columns where table_schema = 'public' and table_name = 'purchase_order' and column_name = 'pinned_at'`,
    );
    expect(col.rows).toEqual([{ data_type: 'timestamp with time zone', is_nullable: 'YES', column_default: null }]);
    const checks = await q<{ def: string }>(`select pg_get_constraintdef(oid) as def from pg_constraint where conrelid = 'public.purchase_order'::regclass and contype = 'c'`);
    expect(checks.rows.filter((r) => r.def.includes('pinned_at'))).toEqual([]);
    const idx = await q<{ indexdef: string }>(`select indexdef from pg_indexes where schemaname = 'public' and tablename = 'purchase_order'`);
    expect(idx.rows.filter((r) => r.indexdef.includes('pinned_at'))).toEqual([]);
  });

  test('0007(PRF-163, data.md §4 여덟 번째 마이그레이션·§2 ERD ticket_issue_job): 칸 일곱(order_id uuid 기본 키·주문 외래 키, event_id uuid, attempts int 기본 0, next_attempt_at 널 허용, issue_due_at·created_at 널 불허, last_error 널 허용 text)과 쓸기 색인 (next_attempt_at), 파티션 표가 아니다 [ASVS v5.0.0-2.3.4]', async () => {
    const cols = await q<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }>(
      `select column_name, data_type, is_nullable, column_default from information_schema.columns where table_schema = 'public' and table_name = 'ticket_issue_job' order by ordinal_position`,
    );
    // 0007이 만든 앞 일곱 칸(0009가 뒤에 세 칸을 더했다, 위 0009 시험)
    expect(cols.rows.slice(0, 7).map((c) => [c.column_name, c.data_type, c.is_nullable])).toEqual([
      ['order_id', 'uuid', 'NO'],
      ['event_id', 'uuid', 'NO'],
      ['attempts', 'integer', 'NO'],
      ['next_attempt_at', 'timestamp with time zone', 'YES'],
      ['issue_due_at', 'timestamp with time zone', 'NO'],
      ['last_error', 'text', 'YES'],
      ['created_at', 'timestamp with time zone', 'NO'],
    ]);
    expect(cols.rows.find((c) => c.column_name === 'attempts')?.column_default).toBe('0');
    // 널 불허 제약(contype n, PostgreSQL 18)은 위 칸 표가 본다. CHECK·유일 제약은 없다
    const cons = await q<{ contype: string; def: string }>(
      `select contype, pg_get_constraintdef(oid) as def from pg_constraint where conrelid = 'public.ticket_issue_job'::regclass and contype <> 'n' order by contype`,
    );
    expect(cons.rows).toEqual([
      { contype: 'f', def: 'FOREIGN KEY (order_id) REFERENCES purchase_order(id)' },
      { contype: 'p', def: 'PRIMARY KEY (order_id)' },
    ]);
    const idx = await q<{ indexdef: string }>(`select indexdef from pg_indexes where schemaname = 'public' and tablename = 'ticket_issue_job' and indexname = 'ticket_issue_job_next_attempt_idx'`);
    expect(idx.rows.map((r) => r.indexdef)).toEqual(['CREATE INDEX ticket_issue_job_next_attempt_idx ON public.ticket_issue_job USING btree (next_attempt_at)']);
    const kind = await q<{ relkind: string }>(`select relkind from pg_class where relnamespace = 'public'::regnamespace and relname = 'ticket_issue_job'`);
    expect(kind.rows).toEqual([{ relkind: 'r' }]);
    // 한 주문에 행은 하나뿐이고, 없는 주문의 행은 넣지 못한다
    const order = randomUUID();
    await expect(q(`insert into ticket_issue_job (order_id, event_id, issue_due_at, created_at) values ($1, $2, now(), now())`, [order, id()])).rejects.toMatchObject({ code: '23503' });
  });

  test('0006(PRF-165, data.md §4 일곱 번째 마이그레이션): purchase_order.failure_reason은 널 허용 text이고 CHECK가 없으며, order_saga_job.confirm_sent_at은 널 허용 timestamptz(리뷰 H1)이고, order_saga_job.step CHECK는 RESERVE·CONFIRM·RELEASE를 받는다(RELEASE는 리뷰 M4. 0010이 AWAIT를 뒤에 더했다) [ASVS v5.0.0-2.3.4]', async () => {
    const col = await q<{ data_type: string; is_nullable: string }>(
      `select data_type, is_nullable from information_schema.columns where table_schema = 'public' and table_name = 'purchase_order' and column_name = 'failure_reason'`,
    );
    expect(col.rows).toEqual([{ data_type: 'text', is_nullable: 'YES' }]);
    // failure_reason에 걸린 CHECK가 없다(값 목록이 PRF-163에서 늘어난다)
    const checks = await q<{ def: string }>(
      `select pg_get_constraintdef(oid) as def from pg_constraint where conrelid = 'public.purchase_order'::regclass and contype = 'c'`,
    );
    expect(checks.rows.filter((r) => r.def.includes('failure_reason'))).toEqual([]);
    const sent = await q<{ data_type: string; is_nullable: string }>(
      `select data_type, is_nullable from information_schema.columns where table_schema = 'public' and table_name = 'order_saga_job' and column_name = 'confirm_sent_at'`,
    );
    expect(sent.rows).toEqual([{ data_type: 'timestamp with time zone', is_nullable: 'YES' }]);
    const step = await q<{ def: string }>(
      `select pg_get_constraintdef(oid) as def from pg_constraint where conrelid = 'public.order_saga_job'::regclass and conname = 'order_saga_job_step_check'`,
    );
    expect(step.rows).toHaveLength(1);
    // 0006의 값 셋(차례 RESERVE·CONFIRM·RELEASE)이 앞에 그대로 있다. 값 목록 전체는 위 0010 시험이 본다
    expect(step.rows[0]!.def).toMatch(/step.*'RESERVE'::text.*'CONFIRM'::text.*'RELEASE'::text/);
    expect(step.rows[0]!.def.match(/'[A-Z_]+'::text/g)?.slice(0, 3)).toEqual(["'RESERVE'::text", "'CONFIRM'::text", "'RELEASE'::text"]);
  });

  test('0003: payment_attempt.order_id에 일반(유일 아님) 인덱스 payment_attempt_order_id_idx가 있다(주문으로 결제 시도 찾기, 주문 행을 지울 때 외래 키 검사) [ASVS v5.0.0-2.3.4]', async () => {
    const r = await q<{ indexdef: string }>(`select indexdef from pg_indexes where schemaname = 'public' and indexname = 'payment_attempt_order_id_idx'`);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]!.indexdef).toBe('CREATE INDEX payment_attempt_order_id_idx ON public.payment_attempt USING btree (order_id)');
  });

  test('seat_sale·purchase_quota·seat_hold·seat_rebuild 네 표가 있다 [ASVS v5.0.0-2.3.4]', async () => {
    const r = await q<{ relname: string }>(
      `select relname from pg_class where relnamespace = 'public'::regnamespace and relname in ('seat_sale', 'purchase_quota', 'seat_hold', 'seat_rebuild') and relkind in ('r', 'p') order by relname`,
    );
    expect(r.rows.map((x) => x.relname)).toEqual(['purchase_quota', 'seat_hold', 'seat_rebuild', 'seat_sale']);
  });

  test('파티션 부모는 seat_hold(event_id 범위)와 0003의 outbox(id 범위) 둘뿐이고, seat_sale·purchase_quota·seat_rebuild와 주문 표 다섯은 파티션 표가 아니다 [ASVS v5.0.0-2.3.4]', async () => {
    const parts = await q<{ relname: string; partstrat: string; keydef: string }>(
      `select c.relname, pt.partstrat, pg_get_partkeydef(pt.partrelid) as keydef
         from pg_partitioned_table pt join pg_class c on c.oid = pt.partrelid
        where c.relnamespace = 'public'::regnamespace order by c.relname`,
    );
    expect(parts.rows).toEqual([
      { relname: 'outbox', partstrat: 'r', keydef: 'RANGE (id)' },
      { relname: 'seat_hold', partstrat: 'r', keydef: 'RANGE (event_id)' },
    ]);
    // 주문 표는 나누지 않는다(ADR-0114)
    const orders = await q<{ relname: string; relkind: string }>(
      `select relname, relkind from pg_class where relnamespace = 'public'::regnamespace
         and relname in ('purchase_order', 'order_item', 'order_event', 'order_idempotency', 'payment_attempt') order by relname`,
    );
    expect(orders.rows).toEqual(['order_event', 'order_idempotency', 'order_item', 'payment_attempt', 'purchase_order'].map((relname) => ({ relname, relkind: 'r' })));
    const kinds = await q<{ relname: string; relkind: string }>(
      `select relname, relkind from pg_class where relnamespace = 'public'::regnamespace and relname in ('seat_sale', 'purchase_quota', 'seat_hold', 'seat_rebuild') and relkind in ('r', 'p') order by relname`,
    );
    expect(kinds.rows).toEqual([
      { relname: 'purchase_quota', relkind: 'r' },
      { relname: 'seat_hold', relkind: 'p' },
      { relname: 'seat_rebuild', relkind: 'r' },
      { relname: 'seat_sale', relkind: 'r' },
    ]);
  });

  test('DB의 열 이름·차례·종류·널 허용이 schema.ts 정의와 같다 [ASVS v5.0.0-2.3.4]', async () => {
    for (const t of [seatSale, purchaseQuota, seatHold, seatRebuild]) {
      const c = getTableConfig(t);
      const r = await q<{ column_name: string; data_type: string; is_nullable: string }>(
        `select column_name, data_type, is_nullable from information_schema.columns where table_schema = 'public' and table_name = $1 order by ordinal_position`,
        [c.name],
      );
      expect(
        r.rows.map((x) => [x.column_name, x.data_type, x.is_nullable === 'NO']),
        c.name,
      ).toEqual(c.columns.map((col) => [col.name, col.getSQLType(), col.notNull]));
    }
  });

  test('0002가 더한 칸: seat_hold의 hold_id(uuid)·purchase_session_id(text)는 널 허용이고(파티션에도 있다), seat_rebuild는 event_id(uuid)·gen(integer, 널 불허)·holder(text)·lease_until(timestamptz)이다 [ASVS v5.0.0-2.3.4]', async () => {
    const cols = async (table: string) =>
      (
        await q<{ column_name: string; data_type: string; is_nullable: string }>(
          `select column_name, data_type, is_nullable from information_schema.columns where table_schema = 'public' and table_name = $1 order by ordinal_position`,
          [table],
        )
      ).rows.map((x) => [x.column_name, x.data_type, x.is_nullable]);
    for (const table of ['seat_hold', firstCreated[0]!]) {
      const hold = await cols(table);
      expect(hold, table).toContainEqual(['hold_id', 'uuid', 'YES']);
      expect(hold, table).toContainEqual(['purchase_session_id', 'text', 'YES']);
    }
    expect(await cols('seat_rebuild')).toEqual([
      ['event_id', 'uuid', 'NO'],
      ['gen', 'integer', 'NO'],
      ['holder', 'text', 'YES'],
      ['lease_until', 'timestamp with time zone', 'YES'],
    ]);
  });

  test('인덱스는 기본 키와 활성 상태 유일 부분 인덱스, 0012가 더한 결제 중 부분 인덱스뿐이고(seat_rebuild는 기본 키만), 활성 인덱스는 유일하며 WHERE 조건이 있다 [ASVS v5.0.0-2.3.4]', async () => {
    const r = await q<{ tablename: string; indexname: string; indexdef: string }>(
      `select tablename, indexname, indexdef from pg_indexes where schemaname = 'public' and tablename in ('seat_sale', 'purchase_quota', 'seat_hold', 'seat_rebuild') order by tablename, indexname`,
    );
    expect(r.rows.map((x) => `${x.tablename}.${x.indexname}`)).toEqual([
      'purchase_quota.purchase_quota_pkey',
      'seat_hold.seat_hold_active_key',
      'seat_hold.seat_hold_pkey',
      'seat_rebuild.seat_rebuild_pkey',
      'seat_sale.seat_sale_active_key',
      'seat_sale.seat_sale_pending_idx',
      'seat_sale.seat_sale_pkey',
    ]);
    const def = (name: string) => r.rows.find((x) => x.indexname === name)!.indexdef;
    expect(def('seat_sale_active_key')).toMatch(/^CREATE UNIQUE INDEX seat_sale_active_key ON public\.seat_sale USING btree \(event_id, seat_id\) WHERE /);
    expect(def('seat_hold_active_key')).toMatch(/^CREATE UNIQUE INDEX seat_hold_active_key ON (ONLY )?public\.seat_hold USING btree \(event_id, seat_id\) WHERE /);
  });

  test('check 제약 이름이 schema.ts와 같게 DB에 있다 [ASVS v5.0.0-2.3.2]', async () => {
    const r = await q<{ conname: string }>(
      `select conname from pg_constraint where contype = 'c' and conrelid in ('seat_sale'::regclass, 'purchase_quota'::regclass, 'seat_hold'::regclass, 'seat_rebuild'::regclass) order by conname`,
    );
    const expected = [seatSale, purchaseQuota, seatHold, seatRebuild].flatMap((t) => getTableConfig(t).checks.map((k) => k.name)).sort();
    expect(r.rows.map((x) => x.conname)).toEqual(expected);
    expect(expected).toEqual(['purchase_quota_used_within_limit', 'seat_hold_kind_check', 'seat_hold_status_check', 'seat_rebuild_gen_check', 'seat_sale_status_check']);
  });
});

describe('seat_hold 월 파티션', () => {
  test('ensureSeatHoldPartitions는 처음에 이번 달부터 3개월 앞까지 4개 파티션(seat_hold_pYYYYMM, 한국 시각 달)을 만들어 이름을 돌려준다 [ASVS v5.0.0-2.3.4]', async () => {
    const expected = [0, 1, 2, 3].map((add) => partitionName(startedAt, add));
    expect(firstCreated).toEqual(expected);
    expect(firstCreated).toHaveLength(4);
    for (const n of firstCreated) expect(n).toMatch(/^seat_hold_p\d{4}(0[1-9]|1[0-2])$/);
    const r = await q<{ relname: string }>(`select c.relname from pg_inherits i join pg_class c on c.oid = i.inhrelid where i.inhparent = 'seat_hold'::regclass order by c.relname`);
    expect(r.rows.map((x) => x.relname)).toEqual(expected);
  });

  test('두 번째 호출은 아무것도 만들지 않고 빈 배열을 돌려준다(파티션은 그대로 4개) [ASVS v5.0.0-2.3.4]', async () => {
    await expect(ensureSeatHoldPartitions(url)).resolves.toEqual([]);
    await expect(ensureSeatHoldPartitions(url)).resolves.toEqual([]);
    expect(await count(`select count(*) as n from pg_inherits where inhparent = 'seat_hold'::regclass`, [])).toBe(4);
  });

  test('DEFAULT 파티션이 없다: 파티션 경계가 모두 FOR VALUES이고 seat_hold 이름의 다른 표도 없다 [ASVS v5.0.0-2.3.4]', async () => {
    const r = await q<{ relname: string; bound: string }>(
      `select c.relname, pg_get_expr(c.relpartbound, c.oid) as bound from pg_inherits i join pg_class c on c.oid = i.inhrelid where i.inhparent = 'seat_hold'::regclass`,
    );
    expect(r.rows).toHaveLength(4);
    for (const p of r.rows) {
      expect(p.bound, p.relname).not.toBe('DEFAULT');
      expect(p.bound, p.relname).toMatch(/^FOR VALUES FROM \(/);
    }
    const all = await q<{ relname: string }>(`select relname from pg_class where relnamespace = 'public'::regnamespace and relkind in ('r', 'p') and relname like 'seat\\_hold%' order by relname`);
    expect(all.rows.map((x) => x.relname)).toEqual(['seat_hold', ...firstCreated]);
  });

  test('이번 달에 만든 회차 ID(UUIDv7)로 홀드 행을 넣으면 들어가고 그 달 파티션에 있다 [ASVS v5.0.0-2.3.4]', async () => {
    const e = uuidv7(systemClock);
    await putHold(e, id(), 1, 'HELD');
    const r = await q<{ part: string }>('select tableoid::regclass::text as part from seat_hold where event_id = $1', [e]);
    expect(r.rows).toEqual([{ part: partitionName(uuidv7Time(e)) }]);
  });

  test('3개월 앞 달의 마지막 순간까지는 그 달 파티션에 들어가고, 그 다음 달의 첫 순간부터는 파티션이 없어 못 넣는다 [ASVS v5.0.0-2.3.4]', async () => {
    const lastIn = eventAt(kstMonthStart(startedAt, 4) - 1);
    await putHold(lastIn, id(), 1, 'HELD');
    const r = await q<{ part: string }>('select tableoid::regclass::text as part from seat_hold where event_id = $1', [lastIn]);
    expect(r.rows).toEqual([{ part: partitionName(startedAt, 3) }]);

    const firstOut = eventAt(kstMonthStart(startedAt, 4));
    await expect(putHold(firstOut, id(), 1, 'HELD')).rejects.toThrow(NO_PARTITION);
    expect(await count('select count(*) as n from seat_hold where event_id = $1', [firstOut])).toBe(0);
  });

  test('파티션이 없는 먼 미래(5년 뒤) 달의 회차 ID는 넣을 때 실패하고 행이 남지 않는다 [ASVS v5.0.0-2.3.4]', async () => {
    const far = eventAt(startedAt + 5 * 365 * 24 * 60 * 60 * 1000);
    await expect(putHold(far, id(), 1, 'HELD')).rejects.toThrow(NO_PARTITION);
    expect(await count('select count(*) as n from seat_hold where event_id = $1', [far])).toBe(0);
  });

  test('이번 달의 첫 순간은 들어가고, 그 바로 앞(지난달)은 기본 파티션이 없어 못 넣는다 [ASVS v5.0.0-2.3.4]', async () => {
    const first = eventAt(kstMonthStart(startedAt, 0));
    await putHold(first, id(), 1, 'HELD');
    const r = await q<{ part: string }>('select tableoid::regclass::text as part from seat_hold where event_id = $1', [first]);
    expect(r.rows).toEqual([{ part: partitionName(startedAt, 0) }]);

    const before = eventAt(kstMonthStart(startedAt, 0) - 1);
    await expect(putHold(before, id(), 1, 'HELD')).rejects.toThrow(NO_PARTITION);
  });
});

describe('check 제약', () => {
  test.each(['FOO', 'pending', 'Sold', ''])("seat_sale.status에 '%s'를 넣으면 check 위반(23514)이다 [ASVS v5.0.0-2.3.2]", async (bad) => {
    const [e, s] = [id(), id()];
    await expect(putSale(e, s, id(), bad)).rejects.toMatchObject({ code: '23514', constraint: 'seat_sale_status_check' });
    expect(await salesOf(e, s)).toBe(0);
  });

  test.each(['PENDING', 'SOLD', 'RETURNED'])("seat_sale.status에 '%s'는 들어간다 [ASVS v5.0.0-2.3.2]", async (ok) => {
    const [e, s] = [id(), id()];
    await putSale(e, s, id(), ok);
    expect(await salesOf(e, s)).toBe(1);
  });

  test.each<[string, number, number]>([
    ['used가 limit_count보다 크면', 3, 2],
    ['used가 limit_count보다 1만 커도', 1, 0],
    ['used가 음수이면', -1, 5],
    ['limit_count가 음수이면', 0, -1],
    ['둘 다 음수이면', -1, -1],
  ])('purchase_quota에서 %s(used=%i, limit_count=%i) check 위반(23514)이다 [ASVS v5.0.0-2.3.2]', async (_name, used, limit) => {
    const [a, e] = [id(), id()];
    await expect(putQuota(a, e, used, limit)).rejects.toMatchObject({ code: '23514', constraint: 'purchase_quota_used_within_limit' });
    expect(await count('select count(*) as n from purchase_quota where account_id = $1 and event_id = $2', [a, e])).toBe(0);
  });

  test.each<[number, number]>([
    [0, 0],
    [0, 4],
    [2, 2],
    [4, 4],
  ])('purchase_quota의 경계값 used=%i, limit_count=%i는 들어간다 [ASVS v5.0.0-2.3.2]', async (used, limit) => {
    const [a, e] = [id(), id()];
    await putQuota(a, e, used, limit);
    expect(await count('select count(*) as n from purchase_quota where account_id = $1 and event_id = $2', [a, e])).toBe(1);
  });

  test('purchase_quota를 한도 넘게 올리거나 한도를 보유 수 아래로 내리는 갱신은 마지막 안전망이 막고 행은 그대로다 [ASVS v5.0.0-2.3.2]', async () => {
    const [a, e] = [id(), id()];
    await putQuota(a, e, 1, 2);
    await expect(q('update purchase_quota set used = used + 2 where account_id = $1 and event_id = $2', [a, e])).rejects.toMatchObject({ code: '23514' });
    await expect(q('update purchase_quota set limit_count = 0 where account_id = $1 and event_id = $2', [a, e])).rejects.toMatchObject({ code: '23514' });
    // 한도까지는 올릴 수 있다
    await q('update purchase_quota set used = used + 1 where account_id = $1 and event_id = $2', [a, e]);
    const r = await q<{ used: number; limit_count: number }>('select used, limit_count from purchase_quota where account_id = $1 and event_id = $2', [a, e]);
    expect(r.rows).toEqual([{ used: 2, limit_count: 2 }]);
  });

  test.each(['FOO', 'held', 'Released', ''])("seat_hold.status에 '%s'를 넣으면 check 위반(23514)이다 [ASVS v5.0.0-2.3.2]", async (bad) => {
    const e = uuidv7(systemClock);
    await expect(putHold(e, id(), 1, bad)).rejects.toMatchObject({ code: '23514' });
    expect(await count('select count(*) as n from seat_hold where event_id = $1', [e])).toBe(0);
  });

  test.each(['HELD', 'RELEASED', 'EXPIRED'])("seat_hold.status에 '%s'는 들어간다 [ASVS v5.0.0-2.3.2]", async (ok) => {
    const e = uuidv7(systemClock);
    await putHold(e, id(), 1, ok);
    expect(await count('select count(*) as n from seat_hold where event_id = $1', [e])).toBe(1);
  });

  test.each(['VIP', 'fan', 'Priority', ''])("seat_hold.kind에 '%s'를 넣으면 check 위반(23514)이다 [ASVS v5.0.0-2.3.2]", async (bad) => {
    const e = uuidv7(systemClock);
    await expect(putHold(e, id(), 1, 'HELD', bad)).rejects.toMatchObject({ code: '23514' });
    expect(await count('select count(*) as n from seat_hold where event_id = $1', [e])).toBe(0);
  });

  test.each(['FAN', 'PRIORITY'])("seat_hold.kind에 '%s'는 들어간다 [ASVS v5.0.0-2.3.2]", async (ok) => {
    const e = uuidv7(systemClock);
    await putHold(e, id(), 1, 'HELD', ok);
    const r = await q<{ kind: string }>('select kind from seat_hold where event_id = $1', [e]);
    expect(r.rows).toEqual([{ kind: ok }]);
  });

  test('널 불허 칸에 null을 넣으면 23502다(seat_sale.status, purchase_quota.limit_count, seat_hold.expires_at) [ASVS v5.0.0-2.3.2]', async () => {
    await expect(q('insert into seat_sale (event_id, seat_id, order_id, account_id, status) values ($1, $2, $3, $4, null)', [id(), id(), id(), id()])).rejects.toMatchObject({ code: '23502' });
    await expect(q('insert into purchase_quota (account_id, event_id, used, limit_count) values ($1, $2, 0, null)', [id(), id()])).rejects.toMatchObject({ code: '23502' });
    await expect(
      q(`insert into seat_hold (event_id, seat_id, account_id, fencing_token, status, expires_at) values ($1, $2, $3, 1, 'HELD', null)`, [uuidv7(systemClock), id(), id()]),
    ).rejects.toMatchObject({ code: '23502' });
  });
});

describe('기본값', () => {
  test('seat_hold.kind의 기본값은 FAN이고, priority_grant_id·held_at·hold_id·purchase_session_id는 비어 있다 [ASVS v5.0.0-2.3.4]', async () => {
    const e = uuidv7(systemClock);
    await putHold(e, id(), 1, 'HELD');
    const r = await q<{ kind: string; priority_grant_id: string | null; held_at: Date | null; hold_id: string | null; purchase_session_id: string | null }>(
      'select kind, priority_grant_id, held_at, hold_id, purchase_session_id from seat_hold where event_id = $1',
      [e],
    );
    expect(r.rows).toEqual([{ kind: 'FAN', priority_grant_id: null, held_at: null, hold_id: null, purchase_session_id: null }]);
  });

  test('seat_rebuild에 event_id만 넣으면 gen 1(판매 열기의 판 번호)이고 holder·lease_until은 비어 있다 [ASVS v5.0.0-2.3.4]', async () => {
    const e = id();
    await q('insert into seat_rebuild (event_id) values ($1)', [e]);
    const r = await q<{ gen: number; holder: string | null; lease_until: Date | null }>('select gen, holder, lease_until from seat_rebuild where event_id = $1', [e]);
    expect(r.rows).toEqual([{ gen: 1, holder: null, lease_until: null }]);
  });

  test('seat_sale.reserved_at의 기본값은 now()라 넣은 직후 5초 안이고, pending_until은 비어 있다 [ASVS v5.0.0-2.3.4]', async () => {
    const [e, s] = [id(), id()];
    await putSale(e, s, id(), 'PENDING');
    // 컨테이너와 시험 PC의 시계가 다를 수 있어, 견주기를 DB 시계 하나로 한다
    const r = await q<{ filled: boolean; not_future: boolean; recent: boolean; pending_until_null: boolean }>(
      `select reserved_at is not null as filled,
              reserved_at <= clock_timestamp() as not_future,
              clock_timestamp() - reserved_at < interval '5 seconds' as recent,
              pending_until is null as pending_until_null
         from seat_sale where event_id = $1 and seat_id = $2`,
      [e, s],
    );
    expect(r.rows).toEqual([{ filled: true, not_future: true, recent: true, pending_until_null: true }]);
  });
});

describe('seat_rebuild 제약', () => {
  test.each([0, -1])('seat_rebuild.gen에 %i를 넣거나 그 값으로 바꾸면 check 위반(23514)이고 행은 그대로다 [ASVS v5.0.0-2.3.2]', async (bad) => {
    const e = id();
    await expect(q('insert into seat_rebuild (event_id, gen) values ($1, $2)', [e, bad])).rejects.toMatchObject({ code: '23514', constraint: 'seat_rebuild_gen_check' });
    expect(await count('select count(*) as n from seat_rebuild where event_id = $1', [e])).toBe(0);
    await q('insert into seat_rebuild (event_id, gen) values ($1, 2)', [e]);
    await expect(q('update seat_rebuild set gen = $2 where event_id = $1', [e, bad])).rejects.toMatchObject({ code: '23514', constraint: 'seat_rebuild_gen_check' });
    expect(await count('select gen as n from seat_rebuild where event_id = $1', [e])).toBe(2);
  });

  test('seat_rebuild는 회차마다 한 행이다: 같은 event_id를 또 넣으면 23505(seat_rebuild_pkey)이고 처음 행만 남는다 [ASVS v5.0.0-2.3.4]', async () => {
    const e = id();
    await q('insert into seat_rebuild (event_id) values ($1)', [e]);
    await expect(q('insert into seat_rebuild (event_id, gen) values ($1, 5)', [e])).rejects.toMatchObject({ code: '23505', constraint: 'seat_rebuild_pkey' });
    expect(await count('select gen as n from seat_rebuild where event_id = $1', [e])).toBe(1);
  });
});

describe('seat_sale 활성 상태 유일성', () => {
  const conflictActive = { code: '23505', constraint: 'seat_sale_active_key' };

  test('같은 (회차, 좌석)에 다른 주문이 PENDING을 두 번 넣으면 23505이고 첫 행만 남는다 [ASVS v5.0.0-2.3.4]', async () => {
    const [e, s, o1, o2] = [id(), id(), id(), id()];
    await putSale(e, s, o1, 'PENDING');
    await expect(putSale(e, s, o2, 'PENDING')).rejects.toMatchObject(conflictActive);
    const r = await q<{ order_id: string }>('select order_id from seat_sale where event_id = $1 and seat_id = $2', [e, s]);
    expect(r.rows).toEqual([{ order_id: o1 }]);
  });

  test.each<[string, string]>([
    ['PENDING', 'PENDING'],
    ['PENDING', 'SOLD'],
    ['SOLD', 'PENDING'],
    ['SOLD', 'SOLD'],
  ])('활성 상태끼리는 모두 충돌한다: 먼저 %s, 다른 주문이 %s를 넣으면 23505다 [ASVS v5.0.0-2.3.4]', async (first, second) => {
    const [e, s] = [id(), id()];
    await putSale(e, s, id(), first);
    await expect(putSale(e, s, id(), second)).rejects.toMatchObject(conflictActive);
    expect(await salesOf(e, s)).toBe(1);
  });

  test('PENDING을 SOLD로 바꾼 주문이 있으면(삭제 없이) 다른 주문의 PENDING은 여전히 23505다 [ASVS v5.0.0-2.3.4]', async () => {
    const [e, s, o1, o2] = [id(), id(), id(), id()];
    await putSale(e, s, o1, 'PENDING');
    await q(`update seat_sale set status = 'SOLD', pending_until = null where event_id = $1 and seat_id = $2 and order_id = $3`, [e, s, o1]);
    await expect(putSale(e, s, o2, 'PENDING')).rejects.toMatchObject(conflictActive);
    expect(await salesOf(e, s)).toBe(1);
  });

  test('RETURNED가 있어도 새 주문의 PENDING·SOLD는 들어간다(환불 뒤 재판매) [ASVS v5.0.0-2.3.4]', async () => {
    const [e, s1, s2] = [id(), id(), id()];
    await putSale(e, s1, id(), 'RETURNED');
    await putSale(e, s1, id(), 'PENDING');
    await putSale(e, s2, id(), 'RETURNED');
    await putSale(e, s2, id(), 'SOLD');
    expect(await salesOf(e, s1)).toBe(2);
    expect(await salesOf(e, s2)).toBe(2);
  });

  test('같은 좌석에 RETURNED 이력은 주문이 다르면 몇 개든 쌓이고, 그 위에 활성 행은 하나만 얹힌다 [ASVS v5.0.0-2.3.4]', async () => {
    const [e, s] = [id(), id()];
    for (let i = 0; i < 4; i += 1) await putSale(e, s, id(), 'RETURNED');
    await putSale(e, s, id(), 'PENDING');
    await expect(putSale(e, s, id(), 'PENDING')).rejects.toMatchObject(conflictActive);
    await expect(putSale(e, s, id(), 'SOLD')).rejects.toMatchObject(conflictActive);
    await putSale(e, s, id(), 'RETURNED');
    expect(await salesOf(e, s)).toBe(6);
  });

  test('SOLD를 RETURNED로 돌리면 같은 좌석을 다른 주문이 다시 얻을 수 있다 [ASVS v5.0.0-2.3.4]', async () => {
    const [e, s, o1, o2] = [id(), id(), id(), id()];
    await putSale(e, s, o1, 'SOLD');
    await expect(putSale(e, s, o2, 'PENDING')).rejects.toMatchObject(conflictActive);
    await q(`update seat_sale set status = 'RETURNED' where event_id = $1 and seat_id = $2 and order_id = $3`, [e, s, o1]);
    await putSale(e, s, o2, 'PENDING');
    expect(await salesOf(e, s)).toBe(2);
  });

  test('다른 주문이 활성인 좌석의 RETURNED 행을 다시 SOLD로 되살릴 수 없다 [ASVS v5.0.0-2.3.4]', async () => {
    const [e, s, o1, o2] = [id(), id(), id(), id()];
    await putSale(e, s, o1, 'RETURNED');
    await putSale(e, s, o2, 'PENDING');
    await expect(q(`update seat_sale set status = 'SOLD' where event_id = $1 and seat_id = $2 and order_id = $3`, [e, s, o1])).rejects.toMatchObject(conflictActive);
    const r = await q<{ order_id: string; status: string }>('select order_id, status from seat_sale where event_id = $1 and seat_id = $2 order by status', [e, s]);
    expect(r.rows).toEqual([
      { order_id: o2, status: 'PENDING' },
      { order_id: o1, status: 'RETURNED' },
    ]);
  });

  test('기본 키 (회차, 좌석, 주문)가 같은 행을 또 넣으면 23505다 [ASVS v5.0.0-2.3.4]', async () => {
    const [e, s, o] = [id(), id(), id()];
    await putSale(e, s, o, 'RETURNED');
    await expect(putSale(e, s, o, 'RETURNED')).rejects.toMatchObject({ code: '23505', constraint: 'seat_sale_pkey' });
    expect(await salesOf(e, s)).toBe(1);
  });

  test('유일 범위는 (회차, 좌석)이다: 다른 회차의 같은 좌석 ID, 같은 회차의 다른 좌석은 충돌하지 않는다 [ASVS v5.0.0-2.3.4]', async () => {
    const [e1, e2, s1, s2] = [id(), id(), id(), id()];
    await putSale(e1, s1, id(), 'PENDING');
    await putSale(e2, s1, id(), 'PENDING');
    await putSale(e1, s2, id(), 'PENDING');
    expect(await salesOf(e1, s1)).toBe(1);
    expect(await salesOf(e2, s1)).toBe(1);
    expect(await salesOf(e1, s2)).toBe(1);
  });

  test('연결 여덟 개가 같은 좌석을 동시에 PENDING으로 넣어도 정확히 하나만 들어가고 나머지는 모두 23505다 [ASVS v5.0.0-2.3.4]', async () => {
    const pool = new pg.Pool({ connectionString: url, max: 8 });
    try {
      const [e, s] = [id(), id()];
      const results = await Promise.allSettled(
        Array.from({ length: 8 }, () => pool.query('insert into seat_sale (event_id, seat_id, order_id, account_id, status) values ($1, $2, $3, $4, $5)', [e, s, id(), id(), 'PENDING'])),
      );
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      expect(rejected).toHaveLength(7);
      for (const r of rejected) expect(r.reason).toMatchObject(conflictActive);
      expect(await salesOf(e, s)).toBe(1);
    } finally {
      await pool.end();
    }
  });
});

describe('seat_hold 활성 홀드 유일성', () => {
  test('같은 (회차, 좌석)에 HELD 둘(fencing_token만 다름)을 넣으면 23505이고 첫 행만 남는다 [ASVS v5.0.0-2.3.4]', async () => {
    const [e, s] = [uuidv7(systemClock), id()];
    await putHold(e, s, 1, 'HELD');
    await expect(putHold(e, s, 2, 'HELD')).rejects.toMatchObject({ code: '23505' });
    const r = await q<{ fencing_token: string }>('select fencing_token from seat_hold where event_id = $1 and seat_id = $2', [e, s]);
    expect(r.rows).toEqual([{ fencing_token: '1' }]);
  });

  test('HELD 하나와 RELEASED·EXPIRED 여럿은 같은 좌석에 함께 있을 수 있다 [ASVS v5.0.0-2.3.4]', async () => {
    const [e, s] = [uuidv7(systemClock), id()];
    await putHold(e, s, 1, 'RELEASED');
    await putHold(e, s, 2, 'EXPIRED');
    await putHold(e, s, 3, 'HELD');
    await putHold(e, s, 4, 'RELEASED');
    await putHold(e, s, 5, 'EXPIRED');
    expect(await count('select count(*) as n from seat_hold where event_id = $1 and seat_id = $2', [e, s])).toBe(5);
    expect(await count(`select count(*) as n from seat_hold where event_id = $1 and seat_id = $2 and status = 'HELD'`, [e, s])).toBe(1);
  });

  test('HELD를 RELEASED로 바꾸면 더 큰 fencing_token의 새 HELD가 들어가고, 이미 HELD가 있는 좌석의 옛 행은 HELD로 되살릴 수 없다 [ASVS v5.0.0-2.3.4]', async () => {
    const [e, s] = [uuidv7(systemClock), id()];
    await putHold(e, s, 1, 'HELD');
    await q(`update seat_hold set status = 'RELEASED' where event_id = $1 and seat_id = $2 and fencing_token = 1`, [e, s]);
    await putHold(e, s, 2, 'HELD');
    await expect(q(`update seat_hold set status = 'HELD' where event_id = $1 and seat_id = $2 and fencing_token = 1`, [e, s])).rejects.toMatchObject({ code: '23505' });
    const r = await q<{ fencing_token: string; status: string }>('select fencing_token, status from seat_hold where event_id = $1 and seat_id = $2 order by fencing_token', [e, s]);
    expect(r.rows).toEqual([
      { fencing_token: '1', status: 'RELEASED' },
      { fencing_token: '2', status: 'HELD' },
    ]);
  });

  test('기본 키 (회차, 좌석, fencing_token)가 같은 행을 또 넣으면 23505다 [ASVS v5.0.0-2.3.4]', async () => {
    const [e, s] = [uuidv7(systemClock), id()];
    await putHold(e, s, 7, 'RELEASED');
    await expect(putHold(e, s, 7, 'RELEASED')).rejects.toMatchObject({ code: '23505' });
    expect(await count('select count(*) as n from seat_hold where event_id = $1 and seat_id = $2', [e, s])).toBe(1);
  });

  test('유일 범위는 (회차, 좌석)이다: 다른 좌석, 다른 회차의 같은 좌석 ID는 각자 HELD를 가질 수 있다 [ASVS v5.0.0-2.3.4]', async () => {
    const [e1, e2, s1, s2] = [uuidv7(systemClock), uuidv7(systemClock), id(), id()];
    await putHold(e1, s1, 1, 'HELD');
    await putHold(e1, s2, 1, 'HELD');
    await putHold(e2, s1, 1, 'HELD');
    expect(await count(`select count(*) as n from seat_hold where event_id in ($1, $2) and status = 'HELD'`, [e1, e2])).toBe(3);
  });
});
