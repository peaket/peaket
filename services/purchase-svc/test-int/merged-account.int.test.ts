// 계정 묶음(merged_account) 실제 PostgreSQL 통합 시험(F-07-2 IR-02, docs/data.md §4 경계 9, asyncapi identity.accounts-merged).
// 확인: 같은 병합 사건을 두 번 처리해도 한 행(흡수 계정 PK), 대표 계정으로 흡수 계정 주문 목록·상세 조회, 묶음 밖 404,
// 섞인 목록의 커서·정렬. Kafka 없이 소비자 처리기(AccountMergedHandler)와 저장소(DrizzleMergedAccounts)를 실제 DB에 붙인다.
import { createDatabase, type Database, systemClock, uuidv7 } from '@peaket/platform';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { migratePurchase } from '../scripts/migrate.mjs';
import { AccountMergedHandler, DrizzleMergedAccounts, DrizzleOrderHistory, type OrderHistoryOrder } from '../src/modules/booking/index.js';
import { type PostgresContainer, startPostgres } from './postgres.js';

const APP = 'purchase-svc-merged-account-int';
const EVENT = '0192f0aa-0001-7000-8000-000000000001';
const PRIMARY = '0192f0aa-0002-7000-8000-000000000002';
const ABSORBED = '0192f0aa-0003-7000-8000-000000000003';
const OTHER = '0192f0aa-0004-7000-8000-000000000004';
const MERGE_ID = '0192f0aa-0005-7000-8000-000000000005';
/** 병합 사슬 시험(A→B, B→C)의 계정 셋. OUTSIDER는 묶음 밖이다 */
const CHAIN_A = '0192f0aa-0006-7000-8000-000000000006';
const CHAIN_B = '0192f0aa-0007-7000-8000-000000000007';
const CHAIN_C = '0192f0aa-0008-7000-8000-000000000008';
const OUTSIDER = '0192f0aa-0009-7000-8000-000000000009';
const MERGE_AB = '0192f0aa-000a-7000-8000-00000000000a';
const MERGE_BC = '0192f0aa-000b-7000-8000-00000000000b';
const CONFIRMED_AT = new Date('2026-11-24T03:00:00.000Z');
const BASE = Date.parse('2026-10-14T03:00:00.000Z');

let server: PostgresContainer;
let database: Database;
let history: DrizzleOrderHistory;
let merged: DrizzleMergedAccounts;

beforeAll(async () => {
  server = await startPostgres();
  await migratePurchase(server.url);
  database = createDatabase({ url: server.url, profile: 'general', max: 8, applicationName: APP });
  history = new DrizzleOrderHistory({ database });
  merged = new DrizzleMergedAccounts({ database });
});
afterAll(async () => {
  await database?.close();
  server?.stop();
});
beforeEach(async () => {
  // 시험 사이에만 쓰는 정리다(운영 코드는 지우지 않는다)
  await database.db.execute(sql`truncate table order_cancellation, order_item, purchase_order, merged_account restart identity cascade`);
});

/** 주문 한 행(검사에 필요한 칸만). created_at이 목록 정렬의 기준이다 */
async function insertOrder(o: { accountId: string; createdAt: Date; status?: string }): Promise<string> {
  const id = uuidv7(systemClock);
  const status = o.status ?? 'CONFIRMED';
  // 상태 이력 지연 제약(order_status_has_event)이 있으므로 주문 행과 이력 1을 같은 트랜잭션에 쓴다.
  // 시험은 주문 상태 전이 함수를 부르지 않으므로 DB가 요구하는 이력 행만 직접 넣는다(검사 대상은 목록·상세 SQL이다)
  await database.transaction(async (tx) => {
    await tx.execute(sql`
      insert into purchase_order (id, account_id, event_id, status, amount, event_seq, payment_event_seq, idempotency_key, consent_version, seat_assignment, created_at, hold_id, purchase_session_id)
      values (${id}::uuid, ${o.accountId}::uuid, ${EVENT}::uuid, ${status}, 132000, 1, 0, ${`idem-${id}`}, 'v1', 'PICK', ${o.createdAt.toISOString()}::timestamptz, ${uuidv7(systemClock)}::uuid, ${`psid-${id}`})`);
    await tx.execute(sql`
      insert into order_event (order_id, seq, from_status, to_status, cause, actor, occurred_at)
      values (${id}::uuid, 1, null, ${status}, 'T1', 'system:merged-account-int', ${o.createdAt.toISOString()}::timestamptz)`);
  });
  return id;
}

async function insertItem(orderId: string): Promise<void> {
  await database.db.execute(sql`insert into order_item (order_id, line_no, seat_id, tier, section_id, unit_price) values (${orderId}::uuid, 1, ${uuidv7(systemClock)}::uuid, 'R', 'A', 66000)`);
}

const ids = (rows: readonly OrderHistoryOrder[]) => rows.map((r) => r.orderId);

describe('계정 묶음과 주문 내역(IR-02)', () => {
  test('AM-T5 같은 병합 사건을 두 번 처리해도 흡수 계정 한 행이고, 양쪽 계정이 같은 묶음을 본다', async () => {
    const event = { mergeId: MERGE_ID, primaryAccountId: PRIMARY, mergedAccountId: ABSORBED, confirmedAt: CONFIRMED_AT };
    await merged.record(event);
    await merged.record(event);
    const count = await database.db.execute(sql`select count(*)::int as n from merged_account`);
    expect((count.rows[0] as { n: number }).n).toBe(1);
    expect(await merged.accountIdsOf(PRIMARY)).toEqual([PRIMARY, ABSORBED]);
    expect(await merged.accountIdsOf(ABSORBED)).toEqual([PRIMARY, ABSORBED]);
    expect(await merged.accountIdsOf(OTHER)).toEqual([OTHER]);
  });

  test('AM-T6 소비자가 같은 사건을 두 번 처리해도 한 행이다', async () => {
    const h = new AccountMergedHandler(merged);
    const message = {
      topic: 'identity.accounts-merged',
      partition: 0,
      offset: 7n,
      key: ABSORBED,
      value: Buffer.from(JSON.stringify({ mergeId: MERGE_ID, primaryAccountId: PRIMARY, mergedAccountId: ABSORBED, confirmedAt: CONFIRMED_AT.toISOString() }), 'utf8'),
      headers: {},
      timestamp: CONFIRMED_AT.getTime(),
    };
    const r = h.decode(message);
    if (r.kind !== 'event') throw new Error('event가 아니다');
    await h.handle(r, message);
    await h.handle(r, message);
    const count = await database.db.execute(sql`select count(*)::int as n from merged_account`);
    expect((count.rows[0] as { n: number }).n).toBe(1);
  });

  test('AM-T7 대표 계정은 흡수 계정 주문을 목록·상세에서 보고, 묶음 밖 주문은 상세에서 404다', async () => {
    await merged.record({ mergeId: MERGE_ID, primaryAccountId: PRIMARY, mergedAccountId: ABSORBED, confirmedAt: CONFIRMED_AT });
    const absorbedOrder = await insertOrder({ accountId: ABSORBED, createdAt: new Date(BASE + 60_000) });
    const primaryOrder = await insertOrder({ accountId: PRIMARY, createdAt: new Date(BASE + 120_000) });
    const outsiderOrder = await insertOrder({ accountId: OTHER, createdAt: new Date(BASE + 180_000) });
    await insertItem(absorbedOrder);

    const bundle = await merged.accountIdsOf(PRIMARY);
    expect(ids(await history.list(bundle, { limit: 10 }))).toEqual([primaryOrder, absorbedOrder]);
    expect((await history.find(absorbedOrder, bundle))?.orderId).toBe(absorbedOrder);
    expect(await history.find(outsiderOrder, bundle)).toBeUndefined();
    // 흡수 계정 세션도 대표 계정의 주문을 본다
    const asAbsorbed = await merged.accountIdsOf(ABSORBED);
    expect(ids(await history.list(asAbsorbed, { limit: 10 }))).toEqual([primaryOrder, absorbedOrder]);
    expect((await history.find(primaryOrder, asAbsorbed))?.orderId).toBe(primaryOrder);
    // 묶음 밖 계정은 자기 주문 하나만 본다
    expect(ids(await history.list([OTHER], { limit: 10 }))).toEqual([outsiderOrder]);
  });

  test('AM-T9 병합 사슬(A→B→C)을 접어 C가 A·B·C 주문을 모두 보고, A 행의 대표가 C다(IR-12)', async () => {
    const h = new AccountMergedHandler(merged);
    const mergedEvent = (mergeId: string, primaryAccountId: string, mergedAccountId: string) => ({
      topic: 'identity.accounts-merged',
      partition: 0,
      offset: 1n,
      key: mergedAccountId,
      value: Buffer.from(JSON.stringify({ mergeId, primaryAccountId, mergedAccountId, confirmedAt: CONFIRMED_AT.toISOString() }), 'utf8'),
      headers: {},
      timestamp: CONFIRMED_AT.getTime(),
    });
    // identity가 보내는 두 사건을 차례로 처리한다(A→B, 그다음 B→C). A→C 사건은 오지 않는다
    for (const m of [mergedEvent(MERGE_AB, CHAIN_B, CHAIN_A), mergedEvent(MERGE_BC, CHAIN_C, CHAIN_B)]) {
      const r = h.decode(m);
      if (r.kind !== 'event') throw new Error('event가 아니다');
      await h.handle(r, m);
    }

    // 표에는 A·B 두 행이 남고, 둘 다 최종 대표 C를 가리킨다(한 단계로 접힌다)
    const rows = await database.db.execute(sql`select absorbed_account_id, representative_account_id from merged_account order by absorbed_account_id`);
    expect(rows.rows).toEqual([
      { absorbed_account_id: CHAIN_A, representative_account_id: CHAIN_C },
      { absorbed_account_id: CHAIN_B, representative_account_id: CHAIN_C },
    ]);
    for (const id of [CHAIN_A, CHAIN_B, CHAIN_C]) {
      expect([...(await merged.accountIdsOf(id))].sort()).toEqual([CHAIN_A, CHAIN_B, CHAIN_C]);
    }

    // C(최종 대표)와 A(가장 오래된 흡수 계정)가 모두 A·B·C 주문을 본다
    const aOrder = await insertOrder({ accountId: CHAIN_A, createdAt: new Date(BASE + 60_000) });
    const bOrder = await insertOrder({ accountId: CHAIN_B, createdAt: new Date(BASE + 120_000) });
    const cOrder = await insertOrder({ accountId: CHAIN_C, createdAt: new Date(BASE + 180_000) });
    await insertOrder({ accountId: OUTSIDER, createdAt: new Date(BASE + 240_000) });
    for (const viewer of [CHAIN_C, CHAIN_A, CHAIN_B]) {
      const bundle = await merged.accountIdsOf(viewer);
      expect(ids(await history.list(bundle, { limit: 10 })), viewer).toEqual([cOrder, bOrder, aOrder]);
      expect((await history.find(aOrder, bundle))?.orderId, viewer).toBe(aOrder);
      expect((await history.find(cOrder, bundle))?.orderId, viewer).toBe(cOrder);
    }
  });

  test('AM-T8 묶인 계정의 주문이 섞여도 키셋 커서·최신순이 맞고 겹치지 않는다', async () => {
    await merged.record({ mergeId: MERGE_ID, primaryAccountId: PRIMARY, mergedAccountId: ABSORBED, confirmedAt: CONFIRMED_AT });
    const a = await insertOrder({ accountId: ABSORBED, createdAt: new Date(BASE + 60_000) });
    const b = await insertOrder({ accountId: PRIMARY, createdAt: new Date(BASE + 120_000) });
    const c = await insertOrder({ accountId: ABSORBED, createdAt: new Date(BASE + 180_000) });
    const bundle = await merged.accountIdsOf(PRIMARY);
    const page1 = await history.list(bundle, { limit: 2 });
    expect(ids(page1)).toEqual([c, b]);
    const last = page1.at(-1)!;
    const page2 = await history.list(bundle, { limit: 3, before: { createdAt: last.createdAt, orderId: last.orderId } });
    expect(ids(page2)).toEqual([a]);
  });
});
