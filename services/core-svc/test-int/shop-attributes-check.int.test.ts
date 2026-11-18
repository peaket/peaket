// 상품 속성 검증 잡 통합 시험(BUILD_ORDER LCH-010, BAT-600, V-T46 ③, ADR-0300 결정 2).
// 실제 PostgreSQL 18에 상품 행을 직접 넣고(파트너 검사를 거치지 않은 옛 행·고쳐진 행을 흉내) 정비 일 product-attributes-check(ProductAttributesCheck)를
// 앱 역할 연결(core_app)의 DrizzleShopOrderStore로 돌린다. 단언 값은 정본에서: SEV3 경고 한 줄(kind hygiene, 상품 ID·유형·판만, 속성 값 없음),
// 게이지 shop_product_attributes_invalid(마지막 실행의 건수), 상품을 고치지 않음, 기본 키 차례로 1,000건 [가정]씩 모두 읽음, 04:40 KST [가정] 뒤에 돈다.
import { createDatabase, ensureOutboxPartitions, fakeClock, systemClock, type Database } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { migrateCore } from '../scripts/migrate.mjs';
import { DrizzleShopOrderStore, ProductAttributesCheck, ShopSignals, type ShopLogger } from '../src/modules/shop/index.js';
import { startPostgres, type PostgresContainer } from './postgres.js';
import { loginFor } from './roles.js';

let pgc: PostgresContainer;
let admin: Database;
let appDb: Database;

const PROMOTER = randomUUID();
/** 기본 키 차례의 맨 끝(틀린 행을 마지막 쪽에 두어 둘째 쪽 이후도 읽는지 본다) */
const LAST_ID = 'ffffffff-ffff-4fff-bfff-ffffffffffff';
/** 틀린 속성 값(경고 줄에 실리면 안 된다) */
const SECRET = 'SECRET-속성값-7731';
/** 맞는 상품 수: 한 번에 읽는 1,000건 [가정]을 넘긴다 */
const VALID_ROWS = 2_344;
/** 04:40 KST = 전날 19:40Z */
const RUN_AT = Date.parse('2027-03-02T19:40:00.000Z');

beforeAll(async () => {
  pgc = await startPostgres();
  await migrateCore(pgc.url);
  admin = createDatabase({ url: pgc.url, applicationName: 'core-svc-shop-attributes-int', max: 4 });
  await ensureOutboxPartitions(admin, systemClock);
  appDb = await loginFor(admin, pgc, 'core_app_login', 'core_app', 2);
});
afterAll(async () => {
  await appDb?.close();
  await admin?.close();
  pgc?.stop();
});

beforeEach(async () => {
  await admin.pool.query('delete from product');
  // 맞는 행: MERCH 판 1(한도·옵션), PARKING 판 1(차량 안내)
  await admin.pool.query(
    `insert into product (id, promoter_id, type, schema_version, name, status, price, fulfillments, attributes, updated_at)
     select gen_random_uuid(), $1, case when g % 2 = 0 then 'MERCH' else 'PARKING' end, 1, '상품 ' || g, 'PUBLISHED', 10000, '{DELIVERY}',
       case when g % 2 = 0 then '{"perAccountLimit": 2, "options": [{"name": "색", "values": ["검정", "흰색"]}]}'::jsonb
            else '{"vehicleNotice": "승용차만 들어옵니다"}'::jsonb end,
       '2027-01-01T00:00:00Z'
     from generate_series(1, $2::int) g`,
    [PROMOTER, VALID_ROWS],
  );
});

interface Line {
  level: 'info' | 'warn' | 'error';
  o: Record<string, unknown>;
}
function capture(): { logger: ShopLogger; lines: Line[] } {
  const lines: Line[] = [];
  const push = (level: Line['level']) => (o: object) => {
    lines.push({ level, o: o as Record<string, unknown> });
  };
  return { logger: { info: push('info'), warn: push('warn'), error: push('error') }, lines };
}
const gauge = async (s: ShopSignals) => (await s.attributesInvalid.get()).values[0]?.value;

async function insertRaw(id: string, type: string, schemaVersion: number, attributes: unknown): Promise<void> {
  await admin.pool.query(
    `insert into product (id, promoter_id, type, schema_version, name, status, price, fulfillments, attributes, updated_at)
     values ($1, $2, $3, $4, '틀린 상품', 'PUBLISHED', 10000, '{DELIVERY}', $5::jsonb, '2027-01-01T00:00:00Z')`,
    [id, PROMOTER, type, schemaVersion, JSON.stringify(attributes)],
  );
}
const rowOf = async (id: string) => (await admin.pool.query('select * from product where id = $1', [id])).rows[0];

function job(now = RUN_AT) {
  const signals = new ShopSignals();
  const { logger, lines } = capture();
  const check = new ProductAttributesCheck({ store: new DrizzleShopOrderStore(appDb, fakeClock({ now })), clock: fakeClock({ now }), signals, logger });
  return { check, signals, lines };
}

describe('상품 속성 검증 잡(실제 PostgreSQL)', () => {
  test('V-T46 ③ 속성이 틀린 상품 하나에 SEV3 경고 한 줄(상품 ID·유형·판만)과 게이지 1이고 상품 행은 그대로다', async () => {
    await insertRaw(LAST_ID, 'MERCH', 1, { perAccountLimit: 2, colorCode: SECRET });
    const before = await rowOf(LAST_ID);
    const { check, signals, lines } = job();
    expect(await check.run()).toEqual({ checked: VALID_ROWS + 1, invalid: 1 });
    expect(lines).toHaveLength(1);
    expect(lines[0]!.level).toBe('warn');
    expect(lines[0]!.o).toMatchObject({ kind: 'hygiene', severity: 'SEV3' });
    expect(lines[0]!.o.products).toEqual([{ productId: LAST_ID, type: 'MERCH', schemaVersion: 1 }]);
    // 속성 값(칸 이름과 값)은 싣지 않는다
    expect(JSON.stringify(lines[0]!.o)).not.toContain(SECRET);
    expect(JSON.stringify(lines[0]!.o)).not.toContain('colorCode');
    expect(await gauge(signals)).toBe(1);
    // 상품을 고치지 않는다
    expect(await rowOf(LAST_ID)).toEqual(before);
    expect(Number((await admin.pool.query('select count(*)::int as n from product')).rows[0].n)).toBe(VALID_ROWS + 1);
  });

  test('V-T46 ③ 틀린 상품을 지우고 다시 돌리면 경고가 없고 게이지가 0이다', async () => {
    await insertRaw(LAST_ID, 'MERCH', 1, { perAccountLimit: 100 });
    const first = job();
    expect(await first.check.run()).toEqual({ checked: VALID_ROWS + 1, invalid: 1 });
    expect(await gauge(first.signals)).toBe(1);

    await admin.pool.query('delete from product where id = $1', [LAST_ID]);
    // 같은 잡(같은 게이지)을 다시 돌린다: 마지막 실행의 건수라 0으로 내려온다
    expect(first.lines).toHaveLength(1);
    first.lines.length = 0;
    expect(await first.check.run()).toEqual({ checked: VALID_ROWS, invalid: 0 });
    expect(first.lines).toHaveLength(0);
    expect(await gauge(first.signals)).toBe(0);
  });

  test('V-T46 ③ 모르는 유형과 모르는 판(판 10)도 틀린 상품으로 세고, 1,000건을 넘는 둘째·셋째 쪽까지 모두 본다', async () => {
    const firstId = '00000000-0000-4000-8000-000000000001';
    await insertRaw(firstId, 'VIP', 1, {});
    // 판 10: 글자로 견주면 판 1과 헷갈리는 두 자리 판
    await insertRaw(LAST_ID, 'MERCH', 10, {});
    const { check, signals, lines } = job();
    expect(await check.run()).toEqual({ checked: VALID_ROWS + 2, invalid: 2 });
    expect(lines).toHaveLength(1);
    expect(lines[0]!.o).toMatchObject({ kind: 'hygiene', severity: 'SEV3' });
    expect(lines[0]!.o.products).toEqual([
      { productId: firstId, type: 'VIP', schemaVersion: 1 },
      { productId: LAST_ID, type: 'MERCH', schemaVersion: 10 },
    ]);
    expect(await gauge(signals)).toBe(2);
  });

  test('V-T46 ③ 04:40 KST − 1ms에는 미루고 04:40 KST에 돈다', async () => {
    await insertRaw(LAST_ID, 'PARKING', 1, { vehicleNotice: '' });
    const early = job(RUN_AT - 1);
    expect(await early.check.run()).toEqual({ deferred: true });
    expect(early.lines).toHaveLength(0);
    expect(await gauge(early.signals)).toBe(0);
    const onTime = job(RUN_AT);
    expect(await onTime.check.run()).toEqual({ checked: VALID_ROWS + 1, invalid: 1 });
    expect(onTime.lines[0]!.o.products).toEqual([{ productId: LAST_ID, type: 'PARKING', schemaVersion: 1 }]);
    expect(await gauge(onTime.signals)).toBe(1);
  });
});
