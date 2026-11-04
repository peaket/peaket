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
  test('마이그레이션을 더 돌려도 오류가 없고 표가 그대로이며 적용 기록은 마이그레이션 파일 수 6(0000 좌석 표, 0001 보류 표, 0002 다시 만들기 표·원장 칸, 0003 주문 표·Outbox, 0004 주문의 홀드·구매 세션 칸, 0005 결제 참조 칸·판 번호·Saga 작업 표)과 같다 [ASVS v5.0.0-2.3.4]', async () => {
    const tables = async () => (await q<{ relname: string }>(`select relname from pg_class where relnamespace = 'public'::regnamespace and relkind in ('r', 'p') order by relname`)).rows.map((r) => r.relname);
    const before = await tables();
    // 0003이 만든 주문 표 다섯과 Outbox 부모 표(PRF-160), 0005가 만든 Saga 작업 표(PRF-162)가 있다
    expect(before).toEqual(expect.arrayContaining(['purchase_order', 'order_item', 'order_event', 'order_idempotency', 'payment_attempt', 'outbox', 'order_saga_job']));
    await migratePurchase(url);
    await migratePurchase(url);
    expect(await tables()).toEqual(before);
    expect(await count('select count(*) as n from drizzle.__drizzle_migrations', [])).toBe(6);
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

  test('인덱스는 기본 키와 활성 상태 유일 부분 인덱스뿐이고(seat_rebuild는 기본 키만), 활성 인덱스는 유일하며 WHERE 조건이 있다 [ASVS v5.0.0-2.3.4]', async () => {
    const r = await q<{ tablename: string; indexname: string; indexdef: string }>(
      `select tablename, indexname, indexdef from pg_indexes where schemaname = 'public' and tablename in ('seat_sale', 'purchase_quota', 'seat_hold', 'seat_rebuild') order by tablename, indexname`,
    );
    expect(r.rows.map((x) => `${x.tablename}.${x.indexname}`)).toEqual([
      'purchase_quota.purchase_quota_pkey',
      'seat_hold.seat_hold_active_key',
      'seat_hold.seat_hold_pkey',
      'seat_rebuild.seat_rebuild_pkey',
      'seat_sale.seat_sale_active_key',
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
