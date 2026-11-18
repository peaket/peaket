// 굿즈 주문 마이그레이션 0027·0028 실제 PostgreSQL 시험(BUILD_ORDER LCH-010·LCH-020, BAT-600, ADR-0300 결정 1·9, ADR-0301 결정 2·4·5, docs/data.md §2).
// 0026까지만 올린 DB(옮긴 마이그레이션 폴더의 사본)에 BAT-610 때의 옛 상태 값 행을 넣고 전체를 올려 옮김을 본다.
// 그 뒤 새 상태 CHECK, 수령 시간대 CHECK, 유형 표 기본 행, 결제 시도 부분 유일 인덱스 둘, 취소 사유 CHECK, 역할 권한을 실제 DB로 본다.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDatabase, type Database } from '@peaket/platform';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migrateCore } from '../scripts/migrate.mjs';
import { startPostgres, type PostgresContainer } from './postgres.js';
import { loginFor } from './roles.js';

let container: PostgresContainer;
let admin: Database;
let appDb: Database;
let partnerDb: Database;
let partial: string;

const SELLER = randomUUID();
const EVENT = randomUUID();
const OLD = { pending: randomUUID(), paid: randomUUID(), cancelled: randomUUID(), refunded: randomUUID() };

/** 마이그레이션 폴더를 사본으로 옮기고 일지를 0026까지로 자른다 */
function migrationsUpTo(lastIdx: number): string {
  const src = fileURLToPath(new URL('../migrations', import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), 'core-mig-'));
  cpSync(src, dir, { recursive: true });
  const journalPath = join(dir, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { idx: number }[] };
  journal.entries = journal.entries.filter((e) => e.idx <= lastIdx);
  writeFileSync(journalPath, JSON.stringify(journal));
  return dir;
}

async function migrateFolder(url: string, folder: string): Promise<void> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await migrate(drizzle({ client }), { migrationsFolder: folder });
  } finally {
    await client.end();
  }
}

beforeAll(async () => {
  container = await startPostgres();
  partial = migrationsUpTo(26);
  await migrateFolder(container.url, partial);
  admin = createDatabase({ url: container.url, applicationName: 'core-svc-shop-migration-int', max: 2 });
  // BAT-610 때의 옛 상태 값 행(0016 칸만)
  for (const [id, status] of [
    [OLD.pending, 'PENDING'],
    [OLD.paid, 'PAID'],
    [OLD.cancelled, 'CANCELLED'],
    [OLD.refunded, 'REFUNDED'],
  ] as const) {
    await admin.pool.query(
      "insert into merch_order (id, promoter_id, event_id, buyer_name, buyer_phone, status, pg, pg_store, shipping_fee, ordered_at) values ($1, $2, $3, '김민수', '010-1234-5678', $4, 'TOSS', 'STANDARD', 0, now())",
      [id, SELLER, EVENT, status],
    );
  }
  await migrateCore(container.url);
  appDb = await loginFor(admin, container, 'core_app_login', 'core_app', 2);
  partnerDb = await loginFor(admin, container, 'core_partner_login', 'core_partner', 2);
});
afterAll(async () => {
  await partnerDb?.close();
  await appDb?.close();
  await admin?.close();
  container?.stop();
  if (partial) rmSync(partial, { recursive: true, force: true });
});

const q = (sql: string, params: unknown[] = []) => admin.pool.query(sql, params);
const rejects = async (p: Promise<unknown>, code: string) => {
  const err = (await p.then(
    () => undefined,
    (e: unknown) => e,
  )) as { code?: string } | undefined;
  expect(err, '거절되어야 한다').toBeDefined();
  expect(err!.code).toBe(code);
};

async function newOrder(o: { status?: string; fulfillment?: string | null; slot?: string | null } = {}): Promise<string> {
  const id = randomUUID();
  await q("insert into merch_order (id, account_id, promoter_id, status, pg_store, shipping_fee, ordered_at, amount, fulfillment, pickup_slot_id, stock_reserved_until) values ($1, $2, $3, $4, 'STANDARD', 0, now(), 1000, $5, $6, now())", [
    id,
    randomUUID(),
    SELLER,
    o.status ?? 'CREATED',
    o.fulfillment === undefined ? 'WALLET' : o.fulfillment,
    o.slot ?? null,
  ]);
  return id;
}

describe('굿즈 주문 마이그레이션 0027·0028(실제 PostgreSQL)', () => {
  test('P-T56 ① 0027이 옛 상태 값을 옮긴다: PENDING → CREATED, CANCELLED·REFUNDED → PAID, PAID는 그대로', async () => {
    const r = await q('select id, status from merch_order where id = any($1)', [Object.values(OLD)]);
    const by = Object.fromEntries(r.rows.map((x: { id: string; status: string }) => [x.id, x.status]));
    expect(by).toEqual({ [OLD.pending]: 'CREATED', [OLD.paid]: 'PAID', [OLD.cancelled]: 'PAID', [OLD.refunded]: 'PAID' });
    const nullable = await q("select column_name, is_nullable from information_schema.columns where table_name = 'merch_order' and column_name in ('buyer_name','buyer_phone','pg') order by column_name");
    expect(nullable.rows).toEqual([
      { column_name: 'buyer_name', is_nullable: 'YES' },
      { column_name: 'buyer_phone', is_nullable: 'YES' },
      { column_name: 'pg', is_nullable: 'YES' },
    ]);
  });

  test('P-T56 ① merch_order 상태 CHECK는 정본 다섯 값만 받고 목록 밖 값마다 거절한다', async () => {
    for (const s of ['CREATED', 'AWAITING_DEPOSIT', 'PAID', 'EXPIRED', 'FAILED']) expect(await newOrder({ status: s })).toBeTruthy();
    for (const s of ['PENDING', 'CANCELLED', 'REFUNDED', 'created', '']) await rejects(newOrder({ status: s }), '23514');
  });

  test('P-T56 ⑦ 수령 시간대 CHECK: 현장 수령은 시간대가 있어야 하고, 다른 수령 방식은 시간대가 없어야 한다', async () => {
    const productId = randomUUID();
    await q("insert into product (id, promoter_id, type, name, status, price, ticket_linked, fulfillments, transferable, attributes, version, updated_at) values ($1, $2, 'MERCH', '시험', 'PUBLISHED', 1000, false, '{PICKUP}', false, '{}'::jsonb, 1, now())", [
      productId,
      SELLER,
    ]);
    const slot = randomUUID();
    await q('insert into pickup_slot (id, product_id, event_id, starts_at, ends_at) values ($1, $2, $3, now(), now() + interval \'1 hour\')', [slot, productId, EVENT]);
    expect(await newOrder({ fulfillment: 'PICKUP', slot })).toBeTruthy();
    expect(await newOrder({ fulfillment: 'DELIVERY', slot: null })).toBeTruthy();
    await rejects(newOrder({ fulfillment: 'PICKUP', slot: null }), '23514');
    await rejects(newOrder({ fulfillment: 'DELIVERY', slot }), '23514');
    await rejects(newOrder({ fulfillment: 'WALLET', slot }), '23514');
    // 시간대는 끝이 시작보다 뒤여야 한다
    await rejects(q('insert into pickup_slot (id, product_id, event_id, starts_at, ends_at) values ($1, $2, $3, now(), now())', [randomUUID(), productId, EVENT]), '23514');
  });

  test('V-T46 ① 0028이 상품 유형 표에 기본 유형 둘 MERCH·PARKING을 판 1로 켜 둔다', async () => {
    const r = await q('select code, latest_schema_version, enabled from product_type order by code');
    expect(r.rows).toEqual([
      { code: 'MERCH', latest_schema_version: 1, enabled: true },
      { code: 'PARKING', latest_schema_version: 1, enabled: true },
    ]);
  });

  test('P-T42 ③ 결제 시도는 주문마다 READY 하나·ACCEPTED 하나만 둘 수 있다(부분 유일 인덱스 둘) [ASVS v5.0.0-2.3.4]', async () => {
    const orderId = await newOrder();
    const attempt = (no: number, status: string) =>
      q("insert into merch_payment_attempt (id, order_id, attempt_no, pg, status, created_at) values ($1, $2, $3, 'SIMULATOR', $4, now())", [randomUUID(), orderId, no, status]);
    await attempt(1, 'READY');
    await rejects(attempt(2, 'READY'), '23505');
    await attempt(2, 'SUPERSEDED');
    await attempt(3, 'SUPERSEDED');
    await attempt(4, 'ACCEPTED');
    await rejects(attempt(5, 'ACCEPTED'), '23505');
    // 같은 순번은 두 번 넣지 못한다
    await rejects(attempt(1, 'FAILED'), '23505');
    // 다른 주문은 따로 센다
    const other = await newOrder();
    await q("insert into merch_payment_attempt (id, order_id, attempt_no, pg, status, created_at) values ($1, $2, 1, 'SIMULATOR', 'READY', now())", [randomUUID(), other]);
    for (const s of ['PENDING', 'DONE', '']) await rejects(attempt(9, s), '23514');
  });

  test('P-T57 ① 항목 cancel_reason CHECK는 UNCLAIMED만 받는다(NULL은 받음)', async () => {
    const orderId = await newOrder({ status: 'PAID' });
    const item = (reason: string | null) =>
      q(
        "insert into merch_order_item (id, order_id, promoter_id, event_id, product_id, product_name, quantity, unit_amount, commission_rate_bp, status, fulfillment, ticket_linked, cancel_reason) values ($1, $2, $3, $4, $5, '응원봉', 1, 1000, 1000, 'CANCELLED', 'WALLET', false, $6)",
        [randomUUID(), orderId, SELLER, EVENT, randomUUID(), reason],
      );
    await item('UNCLAIMED');
    await item(null);
    for (const r of ['BUYER', 'unclaimed', '']) await rejects(item(r), '23514');
  });

  test('P-T57 ③ 환급 행은 정본 상태 넷만 받고 금액이 0보다 커야 한다', async () => {
    const orderId = await newOrder({ status: 'PAID' });
    const refund = (status: string, amount: number) =>
      q("insert into merch_refund (id, order_id, item_ids, amount, reason, status, created_at, updated_at) values ($1, $2, '{}', $3, 'UNCLAIMED', $4, now(), now())", [randomUUID(), orderId, amount, status]);
    for (const s of ['REQUESTED', 'CANCEL_PENDING', 'CANCELLED', 'REJECTED']) await refund(s, 1);
    await rejects(refund('REFUNDED', 1), '23514');
    await rejects(refund('REQUESTED', 0), '23514');
  });

  test('P-T56 ⑥ 새 표는 core_app만 읽고 쓰며 core_partner는 결제 시도·승인 명령 작업·환급·유형·수령 시간대 표를 읽지 못한다 [ASVS v5.0.0-8.2.2]', async () => {
    const orderId = await newOrder();
    await appDb.pool.query("insert into merch_payment_attempt (id, order_id, attempt_no, pg, status, created_at) values ($1, $2, 1, 'SIMULATOR', 'READY', now())", [randomUUID(), orderId]);
    await appDb.pool.query(
      "insert into merch_confirm_job (order_id, attempt_id, attempt_no, pg, payment_ref, amount, authenticated_at, next_at) values ($1, $2, 1, 'SIMULATOR', '{}'::jsonb, 1000, now(), now())",
      [orderId, randomUUID()],
    );
    await appDb.pool.query("insert into merch_refund (id, order_id, item_ids, amount, reason, status, created_at, updated_at) values ($1, $2, '{}', 1000, 'UNCLAIMED', 'REQUESTED', now(), now())", [randomUUID(), orderId]);
    for (const t of ['merch_payment_attempt', 'merch_confirm_job', 'merch_refund']) {
      expect((await appDb.pool.query(`select count(*)::int as n from ${t} where order_id = $1`, [orderId])).rows[0].n, t).toBe(1);
      expect((await appDb.pool.query(`delete from ${t} where order_id = $1`, [orderId])).rowCount, t).toBe(1);
    }
    expect((await appDb.pool.query('select count(*)::int as n from product_type')).rows[0].n).toBe(2);
    await appDb.pool.query('select count(*) from pickup_slot');
    for (const t of ['merch_payment_attempt', 'merch_confirm_job', 'merch_refund', 'product_type', 'pickup_slot']) await rejects(partnerDb.pool.query(`select count(*) from ${t}`), '42501');
  });
});
