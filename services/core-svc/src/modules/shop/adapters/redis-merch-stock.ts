// 굿즈 한정 재고 Redis 어댑터(세션·캐시 클러스터 PEAKET_SHOP_REDIS_URL, ADR-0300 결정 3, docs/data.md §3 굿즈 재고 키).
// 상품마다 같은 해시 슬롯({product:P})에 키 넷을 둔다:
//   shop:{product:P}:stock    판매 가능 수 = product_stock.stock − 결제 접수 전 예약 수량 합
//   shop:{product:P}:resv     정렬 집합(원소 주문 ID, 점수 예약 만료 시각 ms)
//   shop:{product:P}:resv_qty 해시(주문 ID → 수량)
//   shop:{product:P}:unpaid   해시(계정 ID → 결제 전 주문 ID)
// 스크립트마다 네 키를 모두 넘긴다(한 슬롯 안에서 차례로 돈다). 실패는 StockUnavailable로 던진다.
import { type HotRedis, redisScript } from '@peaket/platform';
import { type MerchStock, type RebuildReservation, type ReserveInput, type ReserveResult, StockUnavailable } from '../domain/merch-ports.js';

/** 상품 슬롯의 키 넷(차례: stock, resv, resv_qty, unpaid) */
export function merchStockKeys(productId: string): [string, string, string, string] {
  const tag = `shop:{product:${productId}}`;
  return [`${tag}:stock`, `${tag}:resv`, `${tag}:resv_qty`, `${tag}:unpaid`];
}

/**
 * 예약(RESERVE). ARGV: 주문 ID, 계정 ID, 수량, 만료 시각(ms), 수명(초).
 * unpaid에 그 계정의 다른 주문이 있고 그 주문의 예약 원소가 아직 있으면 PREV(원소가 없으면 이미 풀린 칸이라 덮어쓴다), 카운터가 없으면 NO_COUNTER,
 * 모자라면 SOLD_OUT(아무것도 바꾸지 않음). 같은 주문의 원소가 이미 있으면 바꾸지 않고 OK. 아니면 깎고 세 집합에 넣고 네 키의 수명을 다시 건다
 */
const RESERVE = redisScript(`
local prev = redis.call('HGET', KEYS[4], ARGV[2])
if prev and prev ~= ARGV[1] and redis.call('ZSCORE', KEYS[2], prev) then return {'PREV', prev} end
local s = redis.call('GET', KEYS[1])
if not s then return {'NO_COUNTER', '0'} end
if redis.call('ZSCORE', KEYS[2], ARGV[1]) then return {'OK', s} end
local q = tonumber(ARGV[3])
if tonumber(s) < q then return {'SOLD_OUT', s} end
local left = redis.call('DECRBY', KEYS[1], q)
redis.call('ZADD', KEYS[2], ARGV[4], ARGV[1])
redis.call('HSET', KEYS[3], ARGV[1], ARGV[3])
redis.call('HSET', KEYS[4], ARGV[2], ARGV[1])
for i = 1, 4 do redis.call('EXPIRE', KEYS[i], ARGV[5]) end
return {'OK', tostring(left)}
`);

/**
 * 풀기(RELEASE). ARGV: 주문 ID, restore(0·1), 계정 ID(모르면 빈 글).
 * resv에서 지웠을 때만(ZREM 1) resv_qty를 지우고, restore가 1이고 카운터가 있으면 그 수량만큼 돌린다. 원소가 없으면 아무것도 돌리지 않는다.
 * 계정 ID가 있고 unpaid가 그 주문을 가리키면 지운다. 답: {지웠음 0·1, 돌린 수}
 */
const RELEASE = redisScript(`
local removed = redis.call('ZREM', KEYS[2], ARGV[1])
local restored = 0
if removed == 1 then
  local q = redis.call('HGET', KEYS[3], ARGV[1])
  redis.call('HDEL', KEYS[3], ARGV[1])
  if ARGV[2] == '1' and q and redis.call('EXISTS', KEYS[1]) == 1 then
    redis.call('INCRBY', KEYS[1], q)
    restored = tonumber(q)
  end
end
if ARGV[3] ~= '' and redis.call('HGET', KEYS[4], ARGV[3]) == ARGV[1] then redis.call('HDEL', KEYS[4], ARGV[3]) end
return {removed, restored}
`);

/** 연장(EXTEND). ARGV: 주문 ID, 새 만료 시각(ms), 계정 ID. 원소가 있으면 점수를 큰 쪽으로 바꾸고 unpaid에서 그 주문을 지운다. 원소가 없으면 0 */
const EXTEND = redisScript(`
local cur = redis.call('ZSCORE', KEYS[2], ARGV[1])
if not cur then return 0 end
if tonumber(ARGV[2]) > tonumber(cur) then redis.call('ZADD', KEYS[2], 'XX', ARGV[2], ARGV[1]) end
if ARGV[3] ~= '' and redis.call('HGET', KEYS[4], ARGV[3]) == ARGV[1] then redis.call('HDEL', KEYS[4], ARGV[3]) end
return 1
`);

/** unpaid 칸 지우기(CLEAR_UNPAID). ARGV: 계정 ID, 주문 ID. 그 주문을 가리킬 때만 지운다 */
const CLEAR_UNPAID = redisScript(`
if redis.call('HGET', KEYS[4], ARGV[1]) == ARGV[2] then redis.call('HDEL', KEYS[4], ARGV[1]) return 1 end
return 0
`);

/**
 * 다시 만들기. ARGV: stock, 수명(초), 예약 수 n, 그 뒤 n개의 (주문 ID, 계정 ID, 수량, 만료 시각).
 * 카운터가 있으면 0(아무것도 바꾸지 않음). 없으면 카운터 = stock − 예약 합(0 아래면 0)을 넣고 예약 원소·수량·결제 전 칸을 없을 때만 넣는다
 */
const REBUILD = redisScript(`
if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
local n = tonumber(ARGV[3])
local sum = 0
for i = 0, n - 1 do
  local o = ARGV[4 + i * 4]
  local a = ARGV[5 + i * 4]
  local q = ARGV[6 + i * 4]
  local u = ARGV[7 + i * 4]
  sum = sum + tonumber(q)
  redis.call('ZADD', KEYS[2], 'NX', u, o)
  redis.call('HSETNX', KEYS[3], o, q)
  redis.call('HSETNX', KEYS[4], a, o)
end
local left = tonumber(ARGV[1]) - sum
if left < 0 then left = 0 end
redis.call('SET', KEYS[1], tostring(left), 'EX', ARGV[2])
for i = 2, 4 do redis.call('EXPIRE', KEYS[i], ARGV[2]) end
return 1
`);

/** 재고 Redis 호출 마감(ms). 핫패스 기본 100ms [가정] */
const STOCK_DEADLINE_MS = 100;

export class RedisMerchStock implements MerchStock {
  constructor(private readonly redis: HotRedis) {}

  async #eval(script: ReturnType<typeof redisScript>, productId: string, args: string[]): Promise<unknown> {
    try {
      return await this.redis.evalScript(script, merchStockKeys(productId), args, { deadlineMs: STOCK_DEADLINE_MS });
    } catch (e) {
      throw new StockUnavailable(e);
    }
  }

  async reserve(i: ReserveInput): Promise<ReserveResult> {
    const r = (await this.#eval(RESERVE, i.productId, [i.orderId, i.accountId, String(i.quantity), String(i.untilMs), String(i.ttlSeconds)])) as [string, string];
    const [kind, v] = [String(r[0]), String(r[1])];
    if (kind === 'PREV') return { kind, orderId: v };
    if (kind === 'NO_COUNTER') return { kind };
    if (kind === 'SOLD_OUT') return { kind, remaining: Number(v) };
    if (kind === 'OK') return { kind, remaining: Number(v) };
    throw new StockUnavailable(new Error(`예약 Lua가 모르는 답을 돌려줬다: ${kind}`));
  }

  async release(productId: string, orderId: string, restore: boolean, accountId = ''): Promise<{ removed: boolean; restored: number }> {
    const r = (await this.#eval(RELEASE, productId, [orderId, restore ? '1' : '0', accountId])) as [number, number];
    return { removed: Number(r[0]) === 1, restored: Number(r[1]) };
  }

  async extend(productId: string, orderId: string, untilMs: number, accountId = ''): Promise<boolean> {
    return Number(await this.#eval(EXTEND, productId, [orderId, String(untilMs), accountId])) === 1;
  }

  async clearUnpaid(productId: string, accountId: string, orderId: string): Promise<boolean> {
    return Number(await this.#eval(CLEAR_UNPAID, productId, [accountId, orderId])) === 1;
  }

  async rebuild(productId: string, stock: number, reservations: readonly RebuildReservation[], ttlSeconds: number): Promise<boolean> {
    const args = [String(stock), String(ttlSeconds), String(reservations.length)];
    for (const r of reservations) args.push(r.orderId, r.accountId, String(r.quantity), String(r.untilMs));
    return Number(await this.#eval(REBUILD, productId, args)) === 1;
  }

  async due(productId: string, nowMs: number, limit: number): Promise<string[]> {
    const [, resv] = merchStockKeys(productId);
    try {
      const r = (await this.redis.command(['ZRANGEBYSCORE', resv, '-inf', String(nowMs), 'LIMIT', '0', String(limit)], { key: resv, deadlineMs: STOCK_DEADLINE_MS })) as string[];
      return r.map(String);
    } catch (e) {
      throw new StockUnavailable(e);
    }
  }

  async defer(productId: string, orderId: string, untilMs: number): Promise<void> {
    const [, resv] = merchStockKeys(productId);
    try {
      await this.redis.command(['ZADD', resv, 'XX', String(untilMs), orderId], { key: resv, deadlineMs: STOCK_DEADLINE_MS });
    } catch (e) {
      throw new StockUnavailable(e);
    }
  }

  async clearCounter(productId: string): Promise<void> {
    const [stock] = merchStockKeys(productId);
    try {
      await this.redis.command(['DEL', stock], { key: stock, deadlineMs: STOCK_DEADLINE_MS });
    } catch (e) {
      throw new StockUnavailable(e);
    }
  }
}

/** 주소(PEAKET_SHOP_REDIS_URL)가 없을 때: 모든 호출이 StockUnavailable(한정 상품 주문만 503이고 나머지는 뜬다) */
export const unavailableMerchStock: MerchStock = {
  reserve: async () => {
    throw new StockUnavailable();
  },
  release: async () => {
    throw new StockUnavailable();
  },
  extend: async () => {
    throw new StockUnavailable();
  },
  clearUnpaid: async () => {
    throw new StockUnavailable();
  },
  rebuild: async () => {
    throw new StockUnavailable();
  },
  due: async () => {
    throw new StockUnavailable();
  },
  defer: async () => {
    throw new StockUnavailable();
  },
  clearCounter: async () => {
    throw new StockUnavailable();
  },
};
