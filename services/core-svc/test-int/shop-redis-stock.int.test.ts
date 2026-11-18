// 굿즈 한정 재고 Redis 어댑터 실제 Valkey 시험(BUILD_ORDER LCH-010, BAT-600, ADR-0300 결정 3, docs/data.md §3 굿즈 재고 키).
// 공개 어댑터 RedisMerchStock의 Lua 다섯(RESERVE·RELEASE·EXTEND·CLEAR_UNPAID·다시 만들기)과 due·defer·clearCounter를 실제 Valkey 8.1로 돌리고,
// 상품 슬롯의 키 넷(shop:{product:P}:stock·resv·resv_qty·unpaid)을 redis 명령으로 직접 읽어 정확한 값을 단언한다.
// 키 이름은 정본(ADR-0300 결정 3) 그대로 시험에 적는다(어댑터의 merchStockKeys를 쓰지 않는다).
import { createHotRedis, type HotRedis } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { RedisMerchStock } from '../src/modules/shop/index.js';
import { startValkey, type ValkeyContainer } from '../../queue-svc/test-int/valkey.js';

let valkey: ValkeyContainer;
let redis: HotRedis;
let stock: RedisMerchStock;

beforeAll(async () => {
  valkey = await startValkey();
  redis = await createHotRedis({ url: valkey.url });
  stock = new RedisMerchStock(redis);
});
afterAll(async () => {
  await redis?.close();
  valkey?.stop();
});

/** 정본의 키 이름(ADR-0300 결정 3) */
const keys = (p: string) => ({ stock: `shop:{product:${p}}:stock`, resv: `shop:{product:${p}}:resv`, qty: `shop:{product:${p}}:resv_qty`, unpaid: `shop:{product:${p}}:unpaid` });
const cmd = (args: string[]) => redis.command(args, { key: args[1]! });
const counter = async (p: string) => (await cmd(['GET', keys(p).stock])) as string | null;
const resv = async (p: string) => {
  const raw = (await cmd(['ZRANGE', keys(p).resv, '0', '-1', 'WITHSCORES'])) as unknown[];
  const out: Record<string, number> = {};
  // RESP3는 [원소, 점수] 짝의 배열, RESP2는 평평한 배열로 온다
  if (raw.length > 0 && Array.isArray(raw[0])) for (const [m, s] of raw as [unknown, unknown][]) out[String(m)] = Number(s);
  else for (let i = 0; i < raw.length; i += 2) out[String(raw[i])] = Number(raw[i + 1]);
  return out;
};
const hash = async (key: string) => {
  const flat = (await cmd(['HGETALL', key])) as string[] | Record<string, string>;
  if (!Array.isArray(flat)) return { ...flat };
  const out: Record<string, string> = {};
  for (let i = 0; i < flat.length; i += 2) out[String(flat[i])] = String(flat[i + 1]);
  return out;
};
const snapshot = async (p: string) => ({ stock: await counter(p), resv: await resv(p), qty: await hash(keys(p).qty), unpaid: await hash(keys(p).unpaid) });
const exists = async (p: string) => Number(await cmd(['EXISTS', keys(p).stock, keys(p).resv, keys(p).qty, keys(p).unpaid]));

/** 시험 수명(초): 코드의 기본 수명(1일·30일)과 다른 값 */
const TTL_S = 7_777;
const UNTIL = 1_900_000_000_000;

/** 카운터를 stock으로 만든다(다시 만들기 Lua, 예약 없음) */
async function fresh(stockValue: number): Promise<string> {
  const p = randomUUID();
  expect(await stock.rebuild(p, stockValue, [], TTL_S)).toBe(true);
  return p;
}
const reserve = (p: string, orderId: string, accountId: string, quantity: number, untilMs = UNTIL) => stock.reserve({ productId: p, orderId, accountId, quantity, untilMs, ttlSeconds: TTL_S });

describe('굿즈 한정 재고 Redis(실제 Valkey)', () => {
  test('P-T57 ③ RESERVE는 남은 수가 수량과 같으면 받아 남은 수 0을 돌려주고 키 넷에 그 주문을 넣는다 [ASVS v5.0.0-2.3.4]', async () => {
    const p = await fresh(3);
    const [o, a] = [randomUUID(), randomUUID()];
    expect(await reserve(p, o, a, 3)).toEqual({ kind: 'OK', remaining: 0 });
    expect(await snapshot(p)).toEqual({ stock: '0', resv: { [o]: UNTIL }, qty: { [o]: '3' }, unpaid: { [a]: o } });
  });

  test('P-T57 ③ RESERVE는 남은 수가 수량보다 1 적으면 SOLD_OUT과 남은 수를 돌려주고 키 넷을 바꾸지 않는다 [ASVS v5.0.0-2.3.4]', async () => {
    const p = await fresh(2);
    const before = await snapshot(p);
    expect(await reserve(p, randomUUID(), randomUUID(), 3)).toEqual({ kind: 'SOLD_OUT', remaining: 2 });
    expect(await snapshot(p)).toEqual(before);
    expect(before).toEqual({ stock: '2', resv: {}, qty: {}, unpaid: {} });
  });

  test('P-T57 ⑤ RESERVE는 카운터 키가 없으면 NO_COUNTER이고 아무 키도 만들지 않는다', async () => {
    const p = randomUUID();
    expect(await reserve(p, randomUUID(), randomUUID(), 1)).toEqual({ kind: 'NO_COUNTER' });
    expect(await exists(p)).toBe(0);
  });

  test('P-T42 ④ RESERVE는 같은 계정의 다른 주문 예약이 남아 있으면 PREV와 그 주문 ID를 돌려주고 키 넷을 바꾸지 않는다 [ASVS v5.0.0-2.3.4]', async () => {
    const p = await fresh(5);
    const [o1, o2, a] = [randomUUID(), randomUUID(), randomUUID()];
    expect(await reserve(p, o1, a, 2)).toEqual({ kind: 'OK', remaining: 3 });
    const before = await snapshot(p);
    expect(await reserve(p, o2, a, 1)).toEqual({ kind: 'PREV', orderId: o1 });
    expect(await snapshot(p)).toEqual(before);
    expect(before).toEqual({ stock: '3', resv: { [o1]: UNTIL }, qty: { [o1]: '2' }, unpaid: { [a]: o1 } });
    // 다른 계정은 막지 않는다
    const b = randomUUID();
    expect(await reserve(p, randomUUID(), b, 1)).toEqual({ kind: 'OK', remaining: 2 });
  });

  test('P-T42 ④ 앞 주문의 예약 원소가 이미 풀렸으면 RESERVE가 남은 unpaid 칸을 풀린 칸으로 보고 새 주문으로 덮어쓴다', async () => {
    const p = await fresh(4);
    const [o1, o2, a] = [randomUUID(), randomUUID(), randomUUID()];
    await reserve(p, o1, a, 1);
    // 계정을 모르는 풀기(DB에 없는 주문 흉내): 원소·수량만 지우고 unpaid 칸은 남는다
    expect(await stock.release(p, o1, true)).toEqual({ removed: true, restored: 1 });
    expect(await hash(keys(p).unpaid)).toEqual({ [a]: o1 });
    expect(await reserve(p, o2, a, 1)).toEqual({ kind: 'OK', remaining: 3 });
    expect(await snapshot(p)).toEqual({ stock: '3', resv: { [o2]: UNTIL }, qty: { [o2]: '1' }, unpaid: { [a]: o2 } });
  });

  test('P-T57 ③ 같은 주문을 다시 RESERVE하면 두 번 깎지 않고 OK와 지금 남은 수다', async () => {
    const p = await fresh(5);
    const [o, a] = [randomUUID(), randomUUID()];
    expect(await reserve(p, o, a, 2)).toEqual({ kind: 'OK', remaining: 3 });
    expect(await reserve(p, o, a, 2)).toEqual({ kind: 'OK', remaining: 3 });
    expect(await snapshot(p)).toEqual({ stock: '3', resv: { [o]: UNTIL }, qty: { [o]: '2' }, unpaid: { [a]: o } });
  });

  test('P-T57 ③ RESERVE는 키 넷 모두에 받은 수명을 다시 건다(모든 키에 TTL, docs/data.md §3)', async () => {
    const p = await fresh(5);
    // 다시 만들기가 건 수명을 줄여 두고 예약이 다시 거는지 본다
    for (const k of Object.values(keys(p))) await cmd(['EXPIRE', k, '100']);
    await reserve(p, randomUUID(), randomUUID(), 1);
    for (const k of Object.values(keys(p))) {
      const pttl = Number(await cmd(['PTTL', k]));
      expect(pttl, k).toBeGreaterThan(TTL_S * 1000 - 5_000);
      expect(pttl, k).toBeLessThanOrEqual(TTL_S * 1000);
    }
  });

  test('P-T57 ② RELEASE(restore=1)는 원소·수량 칸·그 주문을 가리키는 unpaid 칸을 지우고 카운터를 수량만큼 돌린다. 두 번째는 아무것도 돌리지 않는다 [ASVS v5.0.0-2.3.4]', async () => {
    const p = await fresh(5);
    const [o, a] = [randomUUID(), randomUUID()];
    const [o2, b] = [randomUUID(), randomUUID()];
    await reserve(p, o, a, 3);
    await reserve(p, o2, b, 1);
    expect(await stock.release(p, o, true, a)).toEqual({ removed: true, restored: 3 });
    expect(await snapshot(p)).toEqual({ stock: '4', resv: { [o2]: UNTIL }, qty: { [o2]: '1' }, unpaid: { [b]: o2 } });
    expect(await stock.release(p, o, true, a)).toEqual({ removed: false, restored: 0 });
    expect(await snapshot(p)).toEqual({ stock: '4', resv: { [o2]: UNTIL }, qty: { [o2]: '1' }, unpaid: { [b]: o2 } });
  });

  test('P-T57 ① RELEASE(restore=0)는 원소·수량 칸·unpaid 칸을 지우고 카운터를 돌리지 않는다 [ASVS v5.0.0-2.3.4]', async () => {
    const p = await fresh(3);
    const [o, a] = [randomUUID(), randomUUID()];
    await reserve(p, o, a, 2);
    expect(await stock.release(p, o, false, a)).toEqual({ removed: true, restored: 0 });
    expect(await snapshot(p)).toEqual({ stock: '1', resv: {}, qty: {}, unpaid: {} });
  });

  test('P-T42 ⑤ RELEASE는 unpaid 칸이 다른 주문을 가리키면 그 칸을 지우지 않는다', async () => {
    const p = await fresh(5);
    const [o1, o2, a] = [randomUUID(), randomUUID(), randomUUID()];
    await reserve(p, o1, a, 1);
    await stock.release(p, o1, true);
    await reserve(p, o2, a, 1);
    // 늦게 온 o1 풀기(계정 있음): 원소가 없어 돌리지 않고, o2를 가리키는 칸도 그대로다
    expect(await stock.release(p, o1, true, a)).toEqual({ removed: false, restored: 0 });
    expect(await snapshot(p)).toEqual({ stock: '4', resv: { [o2]: UNTIL }, qty: { [o2]: '1' }, unpaid: { [a]: o2 } });
  });

  test('P-T42 ② EXTEND는 원소 점수를 지금 값과 새 값 가운데 큰 쪽으로 바꾸고 unpaid에서 그 주문을 지운다', async () => {
    const p = await fresh(5);
    const [o, a] = [randomUUID(), randomUUID()];
    await reserve(p, o, a, 1, 1_000_000);
    expect(await stock.extend(p, o, 2_000_000, a)).toBe(true);
    expect(await snapshot(p)).toEqual({ stock: '4', resv: { [o]: 2_000_000 }, qty: { [o]: '1' }, unpaid: {} });
    // 더 이른 값으로는 줄이지 않는다
    expect(await stock.extend(p, o, 1_500_000, a)).toBe(true);
    expect(await resv(p)).toEqual({ [o]: 2_000_000 });
  });

  test('P-T42 ② EXTEND는 원소가 없으면 false이고 원소를 만들지 않는다', async () => {
    const p = await fresh(5);
    const [o, a] = [randomUUID(), randomUUID()];
    expect(await stock.extend(p, o, 2_000_000, a)).toBe(false);
    expect(await snapshot(p)).toEqual({ stock: '5', resv: {}, qty: {}, unpaid: {} });
  });

  test('P-T42 ④ CLEAR_UNPAID는 그 계정 칸이 그 주문을 가리킬 때만 지운다', async () => {
    const p = await fresh(5);
    const [o, a] = [randomUUID(), randomUUID()];
    await reserve(p, o, a, 1);
    expect(await stock.clearUnpaid(p, a, randomUUID())).toBe(false);
    expect(await hash(keys(p).unpaid)).toEqual({ [a]: o });
    expect(await stock.clearUnpaid(p, a, o)).toBe(true);
    expect(await snapshot(p)).toEqual({ stock: '4', resv: { [o]: UNTIL }, qty: { [o]: '1' }, unpaid: {} });
  });

  test('P-T57 ⑤ 다시 만들기는 카운터 = stock − 예약 합으로 넣고 예약 원소·수량·unpaid 칸을 넣는다', async () => {
    const p = randomUUID();
    const [o1, a1, o2, a2] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    expect(
      await stock.rebuild(
        p,
        7,
        [
          { orderId: o1, accountId: a1, quantity: 2, untilMs: 1_111_000 },
          { orderId: o2, accountId: a2, quantity: 3, untilMs: 2_222_000 },
        ],
        TTL_S,
      ),
    ).toBe(true);
    expect(await snapshot(p)).toEqual({ stock: '2', resv: { [o1]: 1_111_000, [o2]: 2_222_000 }, qty: { [o1]: '2', [o2]: '3' }, unpaid: { [a1]: o1, [a2]: o2 } });
    for (const k of Object.values(keys(p))) expect(Number(await cmd(['PTTL', k])), k).toBeGreaterThan(TTL_S * 1000 - 5_000);
  });

  test('P-T57 ⑤ 다시 만들기는 카운터가 이미 있으면 false이고 아무것도 바꾸지 않는다(SET NX 꼴)', async () => {
    const p = await fresh(4);
    const [o, a] = [randomUUID(), randomUUID()];
    await reserve(p, o, a, 1, 5_000_000);
    const before = await snapshot(p);
    expect(await stock.rebuild(p, 10, [{ orderId: randomUUID(), accountId: randomUUID(), quantity: 1, untilMs: 9_000_000 }], TTL_S)).toBe(false);
    expect(await snapshot(p)).toEqual(before);
  });

  test('P-T57 ⑤ 다시 만들기는 이미 있는 예약 원소의 점수·수량·unpaid 칸을 덮지 않는다', async () => {
    const p = randomUUID();
    const [o, a] = [randomUUID(), randomUUID()];
    // 카운터만 사라진 상태: 원소는 남아 있다
    await cmd(['ZADD', keys(p).resv, '3000000', o]);
    await cmd(['HSET', keys(p).qty, o, '2']);
    await cmd(['HSET', keys(p).unpaid, a, o]);
    expect(await stock.rebuild(p, 20, [{ orderId: o, accountId: a, quantity: 9, untilMs: 8_000_000 }], TTL_S)).toBe(true);
    // 카운터는 DB 값(stock 20 − 예약 합 9)이고, 남아 있던 원소의 점수·수량·칸은 그대로다
    expect(await snapshot(p)).toEqual({ stock: '11', resv: { [o]: 3_000_000 }, qty: { [o]: '2' }, unpaid: { [a]: o } });
  });

  test('P-T42 ① due는 점수가 지금 이하인 원소만 돌려준다(같은 시각은 포함, 1ms 뒤는 뺌)', async () => {
    const p = await fresh(10);
    const [o1, o2, o3] = [randomUUID(), randomUUID(), randomUUID()];
    await reserve(p, o1, randomUUID(), 1, 1_000);
    await reserve(p, o2, randomUUID(), 1, 2_000);
    await reserve(p, o3, randomUUID(), 1, 2_001);
    expect(await stock.due(p, 1_999, 100)).toEqual([o1]);
    expect(await stock.due(p, 2_000, 100)).toEqual([o1, o2]);
    expect(await stock.due(p, 2_000, 1)).toEqual([o1]);
  });

  test('P-T42 ② defer는 원소가 있을 때만 점수를 바꾼다', async () => {
    const p = await fresh(10);
    const o = randomUUID();
    await reserve(p, o, randomUUID(), 1, 1_000);
    await stock.defer(p, o, 61_000);
    expect(await resv(p)).toEqual({ [o]: 61_000 });
    const gone = randomUUID();
    await stock.defer(p, gone, 61_000);
    expect(await resv(p)).toEqual({ [o]: 61_000 });
  });

  test('P-T57 ⑧ clearCounter는 카운터 키만 지우고 예약 원소·수량·unpaid 칸은 남긴다', async () => {
    const p = await fresh(3);
    const [o, a] = [randomUUID(), randomUUID()];
    await reserve(p, o, a, 1);
    await stock.clearCounter(p);
    expect(await snapshot(p)).toEqual({ stock: null, resv: { [o]: UNTIL }, qty: { [o]: '1' }, unpaid: { [a]: o } });
  });
});
