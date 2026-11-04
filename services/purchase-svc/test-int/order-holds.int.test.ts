// 주문 생성의 홀드 확인(inventory RedisOrderHolds·ORDER_HOLD_LUA)을 실제 Valkey 8.1로 돈다(BUILD_ORDER PRF-161).
// 정본: docs/features/payment.md §2 '주문 생성의 첫 구현' 홀드 확인, docs/features/seat-hold.md §2(구매 세션 s:session:{sid}의 h:{holdId})·§3(홀드 Hash 칸),
// inventory domain/ports.ts OrderHoldReader·adapters/order-hold-lua.ts의 계약.
//
// 약속:
// - 홀드는 실제 홀드 Lua(RedisSeatStore.hold, seat-store.int.test.ts와 같은 꼴)로 잡고, 구매 세션의 홀드 목록은 실제 세션 저장소(RedisPurchaseSessionStore.open·recordHold)로 적는다.
// - 시각은 Redis TIME이다(어댑터가 시계를 받지 않는다). 만료는 seat-store.int.test.ts처럼 홀드 Hash의 exp를 지난 시각으로 고쳐 흉내 낸다.
// - 해제는 해제 Lua(HOT-070) 전이라, 해제가 지우는 홀드 Hash를 직접 지워 흉내 낸다.
// - 회차마다 새 회차 ID·새 jti를 쓰고 Valkey를 비우지 않는다.
import 'reflect-metadata';
import { createHotRedis, type HotRedis, type RedisScript, redisScript, uuidv7, systemClock } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  MemorySeatMap,
  ORDER_HOLD_LUA,
  RedisOrderHolds,
  RedisPurchaseSessionStore,
  RedisSeatStore,
  type OrderHoldCheck,
  seatKeys,
  sessionKeys,
  slotOf,
} from '../src/modules/inventory/index.js';
import { ACCOUNT_A, ACCOUNT_B, DAY, held, holdInput, idx, newEvent, SEAT_COUNT, SEAT_DEFS } from '../test/hold-cases.js';
import { newJti, openInput } from '../test/purchase-session-cases.js';
import { startValkey, type ValkeyContainer } from './valkey.js';

let valkey: ValkeyContainer | undefined;
let redis: HotRedis;

beforeAll(async () => {
  valkey = await startValkey();
  redis = await createHotRedis({ url: valkey.url });
});

afterAll(async () => {
  await redis?.close();
  valkey?.stop();
});

/** 스크립트 호출을 적는 겉(seat-store.int.test.ts의 recording과 같은 꼴). 다른 명령도 센다 */
function recording(inner: HotRedis) {
  const scripts: { script: RedisScript; keys: string[]; args: string[] }[] = [];
  const commands: string[][] = [];
  const r: HotRedis = {
    command: (a, o) => {
      commands.push([...a]);
      return inner.command(a, o);
    },
    sendCommand: (a) => {
      commands.push([...a].map(String));
      return inner.sendCommand(a);
    },
    evalScript: (s, k, a, o) => {
      scripts.push({ script: s, keys: [...k], args: [...a] });
      return inner.evalScript(s, k, a, o);
    },
    close: () => inner.close(),
  };
  return { redis: r, scripts, commands };
}

const cmd = (key: string, args: string[]) => redis.command(args, { key });
const redisNowMs = async (): Promise<number> => {
  const t = (await redis.command(['TIME'], {})) as unknown[];
  return Number(t[0]) * 1000 + Math.floor(Number(t[1]) / 1000);
};

/** 시험 좌석맵 판(구역 A 등급 R, 구역 B 등급 S)과 판매 설정 */
function seatMapWith(...eventIds: string[]): MemorySeatMap {
  const m = new MemorySeatMap();
  for (const eventId of eventIds) m.put({ eventId, layoutVersion: 'v1', seatCount: SEAT_COUNT, perAccountLimit: 4, saleEndsAtMs: Date.now() + DAY }, SEAT_DEFS);
  return m;
}

const sessions = () => new RedisPurchaseSessionStore(redis);

/**
 * 회차 하나를 열고(세대 키), 계정 account가 구매 세션 jti를 연 뒤 좌석 seatIds를 실제 홀드 Lua로 잡고 그 구매 세션의 홀드 목록에 적는다(HoldSeats와 같은 차례: 정렬한 좌석 ID)
 */
async function heldWorld(o: { eventId?: string; seatIds?: string[]; accountId?: string } = {}) {
  const eventId = o.eventId ?? newEvent();
  const accountId = o.accountId ?? ACCOUNT_A;
  const seatIds = [...(o.seatIds ?? ['A01', 'B01'])].sort();
  const keepUntilMs = Date.now() + 2 * DAY;
  const store = new RedisSeatStore(redis);
  await store.openSale({ eventId, seatCount: SEAT_COUNT, keepUntilMs });
  const jti = newJti();
  await sessions().open(openInput({ now: () => Date.now() }, jti, { accountId, eventId }));
  const holdId = uuidv7(systemClock);
  const h = held(await store.hold(holdInput(eventId, seatIds, { accountId, purchaseSessionId: jti, holdId, keepUntilMs })));
  expect(await sessions().recordHold(jti, holdId, seatIds)).not.toBeNull();
  return { eventId, accountId, jti, holdId, seatIds, heldAtMs: h.heldAtMs, keepUntilMs };
}
type World = Awaited<ReturnType<typeof heldWorld>>;

const query = (w: World, over: Partial<{ eventId: string; purchaseSessionId: string; accountId: string; holdId: string }> = {}) => ({
  eventId: w.eventId,
  purchaseSessionId: w.jti,
  accountId: w.accountId,
  holdId: w.holdId,
  ...over,
});

/** 시험 좌석맵 판의 등급·구역(SEAT_DEFS: A?? = R·SEC-A, B?? = S·SEC-B) */
const seatOf = (seatId: string) => {
  const d = SEAT_DEFS.find((x) => x.seatId === seatId)!;
  return { seatId, tierId: d.tierId, sectionId: d.sectionId };
};

const NOT_FOUND: OrderHoldCheck = { status: 'NOT_FOUND' };
const STORE_UNAVAILABLE: OrderHoldCheck = { status: 'STORE_UNAVAILABLE' };

/** 그 회차 슬롯의 키와 구매 세션 키를 DUMP한 값(바이트 hex)과 만료 시각. 읽기 전용인지 견줄 때 쓴다 */
async function dumpAll(w: World): Promise<Record<string, { dump: string | null; at: number }>> {
  const keys = ((await cmd(seatKeys.epoch(w.eventId), ['KEYS', `s:{event:${w.eventId}}:*`])) as unknown[]).map(String);
  keys.push(sessionKeys.session(w.jti));
  const out: Record<string, { dump: string | null; at: number }> = {};
  for (const k of keys.sort()) {
    const d = await redis.command(['DUMP', k], { key: k, binary: true });
    out[k] = { dump: d === null || d === undefined ? null : Buffer.from(d as Uint8Array).toString('hex'), at: Number(await cmd(k, ['PEXPIRETIME', k])) };
  }
  return out;
}

describe('RedisOrderHolds.check: 맞는 홀드', () => {
  test('ST28_구매 세션의 홀드 목록에 있고 홀드 Hash의 holdId·owner·psid가 같고 만료 전이면 OK: heldAtMs는 홀드 Lua의 heldAt, 좌석은 목록 차례(좌석 ID 오름차순)에 좌석맵 판의 등급·구역을 붙인다 [ASVS v5.0.0-8.2.2]', async () => {
    const w = await heldWorld({ seatIds: ['B01', 'A01', 'A02'] });
    const holds = new RedisOrderHolds(redis, seatMapWith(w.eventId));

    const r = await holds.check(query(w));

    expect(r).toEqual({ status: 'OK', heldAtMs: w.heldAtMs, seats: ['A01', 'A02', 'B01'].map(seatOf) });
  });

  test('ST28_좌석 하나짜리 홀드도 OK이고, 마감(deadlineMs)을 넘겨도 결과가 같다', async () => {
    const w = await heldWorld({ seatIds: ['B07'] });
    const holds = new RedisOrderHolds(redis, seatMapWith(w.eventId));
    expect(await holds.check(query(w), { deadlineMs: 500 })).toEqual({ status: 'OK', heldAtMs: w.heldAtMs, seats: [seatOf('B07')] });
  });

  test('Lua 계약: 첫 줄이 #!lua flags=no-writes이고, 스크립트 한 번에 KEYS = [세대 키, hold:{색인} …(목록 차례)], ARGV = [holdId, 계정, 구매 세션]이며 KEYS가 모두 회차 슬롯 하나다', async () => {
    expect(ORDER_HOLD_LUA.split('\n')[0]).toBe('#!lua flags=no-writes');
    const w = await heldWorld({ seatIds: ['A03', 'B02'] });
    const rec = recording(redis);
    const holds = new RedisOrderHolds(rec.redis, seatMapWith(w.eventId));

    expect((await holds.check(query(w))).status).toBe('OK');

    expect(rec.scripts).toHaveLength(1);
    const call = rec.scripts[0]!;
    expect(call.script.source).toBe(ORDER_HOLD_LUA);
    expect(call.keys).toEqual([seatKeys.epoch(w.eventId), seatKeys.hold(w.eventId, idx('A03')), seatKeys.hold(w.eventId, idx('B02'))]);
    expect(call.args).toEqual([w.holdId, w.accountId, w.jti]);
    expect(new Set(call.keys.map(slotOf)).size).toBe(1);
  });

  test('읽기만 한다: 확인 전후로 회차 슬롯의 키와 구매 세션 키의 DUMP·만료 시각이 같다(OK·NOT_FOUND 모두) [ASVS v5.0.0-2.3.3]', async () => {
    const w = await heldWorld();
    const holds = new RedisOrderHolds(redis, seatMapWith(w.eventId));
    const before = await dumpAll(w);

    expect((await holds.check(query(w))).status).toBe('OK');
    expect(await holds.check(query(w, { accountId: ACCOUNT_B }))).toEqual(NOT_FOUND);
    expect(await holds.check(query(w, { holdId: uuidv7(systemClock) }))).toEqual(NOT_FOUND);

    expect(await dumpAll(w)).toEqual(before);
  });
});

describe('RedisOrderHolds.check: 남의 것·없는 것·끝난 것은 가리지 않고 NOT_FOUND', () => {
  test('ST28_다른 구매 세션(같은 계정이 연 다른 세션)으로 물으면 그 세션의 목록에 없어 NOT_FOUND다 [ASVS v5.0.0-8.2.2]', async () => {
    const w = await heldWorld();
    const other = newJti();
    await sessions().open(openInput({ now: () => Date.now() }, other, { accountId: w.accountId, eventId: w.eventId }));
    const holds = new RedisOrderHolds(redis, seatMapWith(w.eventId));
    expect(await holds.check(query(w, { purchaseSessionId: other }))).toEqual(NOT_FOUND);
  });

  test('ST28_다른 구매 세션의 목록에 같은 holdId를 적어 두어도 홀드 Hash의 psid가 달라 NOT_FOUND다(Lua의 psid 비교) [ASVS v5.0.0-8.2.2]', async () => {
    const w = await heldWorld();
    const other = newJti();
    await sessions().open(openInput({ now: () => Date.now() }, other, { accountId: w.accountId, eventId: w.eventId }));
    await sessions().recordHold(other, w.holdId, w.seatIds);
    const holds = new RedisOrderHolds(redis, seatMapWith(w.eventId));
    expect(await holds.check(query(w, { purchaseSessionId: other }))).toEqual(NOT_FOUND);
  });

  test('ST28_다른 계정으로 물으면(같은 구매 세션·holdId) 홀드 Hash의 owner가 달라 NOT_FOUND다 [ASVS v5.0.0-8.2.2]', async () => {
    const w = await heldWorld();
    const holds = new RedisOrderHolds(redis, seatMapWith(w.eventId));
    expect(await holds.check(query(w, { accountId: ACCOUNT_B }))).toEqual(NOT_FOUND);
  });

  test('ST28_없는 holdId(모양은 맞는 새 UUIDv7)는 목록에 없어 NOT_FOUND다', async () => {
    const w = await heldWorld();
    const holds = new RedisOrderHolds(redis, seatMapWith(w.eventId));
    expect(await holds.check(query(w, { holdId: uuidv7(systemClock) }))).toEqual(NOT_FOUND);
  });

  test('ST28_다른 회차로 물으면(그 회차도 판매 중이고 같은 좌석맵 판) 그 회차의 홀드 Hash가 없어 NOT_FOUND다 [ASVS v5.0.0-8.2.2]', async () => {
    const w = await heldWorld();
    const other = newEvent();
    await new RedisSeatStore(redis).openSale({ eventId: other, seatCount: SEAT_COUNT, keepUntilMs: w.keepUntilMs });
    const holds = new RedisOrderHolds(redis, seatMapWith(w.eventId, other));
    expect(await holds.check(query(w, { eventId: other }))).toEqual(NOT_FOUND);
  });

  test.each([
    ['빈 글', ''],
    ['해시 태그를 깨는 }', 'a}b'],
    ['해시 태그를 여는 {', '{x'],
    ['칸 구분자 :', 'h:1'],
    ['65자', 'a'.repeat(65)],
    ['빈칸', 'a b'],
  ])('ASVS1.2.4_holdId 모양이 키 조각이 아니면(%s) 좌석 Redis를 부르지 않고 NOT_FOUND다 [ASVS v5.0.0-1.2.4]', async (_label, holdId) => {
    const w = await heldWorld();
    const rec = recording(redis);
    const holds = new RedisOrderHolds(rec.redis, seatMapWith(w.eventId));
    expect(await holds.check(query(w, { holdId }))).toEqual(NOT_FOUND);
    expect(rec.commands).toEqual([]);
    expect(rec.scripts).toEqual([]);
  });

  test.each([
    ['회차 ID', { eventId: 'e}v' }],
    ['구매 세션 ID', { purchaseSessionId: 'j}ti' }],
  ])('ASVS1.2.4_%s 모양이 키 조각이 아니면 좌석 Redis를 부르지 않고 NOT_FOUND다 [ASVS v5.0.0-1.2.4]', async (_label, over) => {
    const w = await heldWorld();
    const rec = recording(redis);
    const holds = new RedisOrderHolds(rec.redis, seatMapWith(w.eventId));
    expect(await holds.check(query(w, over))).toEqual(NOT_FOUND);
    expect(rec.commands).toEqual([]);
    expect(rec.scripts).toEqual([]);
  });

  test('해제된 홀드(해제가 지우는 홀드 Hash가 모두 없음)는 목록에 남아 있어도 NOT_FOUND다', async () => {
    const w = await heldWorld();
    for (const s of w.seatIds) await cmd(seatKeys.hold(w.eventId, idx(s)), ['DEL', seatKeys.hold(w.eventId, idx(s))]);
    const holds = new RedisOrderHolds(redis, seatMapWith(w.eventId));
    expect(await holds.check(query(w))).toEqual(NOT_FOUND);
  });

  test('좌석 하나의 홀드 Hash만 없어도(일부 해제) NOT_FOUND다', async () => {
    const w = await heldWorld({ seatIds: ['A01', 'A02'] });
    await cmd(seatKeys.hold(w.eventId, idx('A02')), ['DEL', seatKeys.hold(w.eventId, idx('A02'))]);
    const holds = new RedisOrderHolds(redis, seatMapWith(w.eventId));
    expect(await holds.check(query(w))).toEqual(NOT_FOUND);
  });

  test('해제 뒤 다른 계정이 같은 좌석을 다시 잡았으면(홀드 Hash의 holdId·owner가 바뀜) 처음 홀드는 NOT_FOUND다', async () => {
    const w = await heldWorld({ seatIds: ['A05'] });
    await cmd(seatKeys.hold(w.eventId, idx('A05')), ['DEL', seatKeys.hold(w.eventId, idx('A05'))]);
    await cmd(seatKeys.bitmap(w.eventId), ['SETBIT', seatKeys.bitmap(w.eventId), String(idx('A05')), '0']);
    const jtiB = newJti();
    await sessions().open(openInput({ now: () => Date.now() }, jtiB, { accountId: ACCOUNT_B, eventId: w.eventId }));
    held(await new RedisSeatStore(redis).hold(holdInput(w.eventId, ['A05'], { accountId: ACCOUNT_B, purchaseSessionId: jtiB, keepUntilMs: w.keepUntilMs })));
    const holds = new RedisOrderHolds(redis, seatMapWith(w.eventId));
    expect(await holds.check(query(w))).toEqual(NOT_FOUND);
  });

  test('만료 시각이 지난 홀드(exp를 Redis TIME 1분 전으로)는 NOT_FOUND다. 좌석 하나만 지나도 NOT_FOUND다', async () => {
    const w = await heldWorld({ seatIds: ['A07', 'A08'] });
    const holds = new RedisOrderHolds(redis, seatMapWith(w.eventId));
    const past = (await redisNowMs()) - 60_000;
    await cmd(seatKeys.hold(w.eventId, idx('A08')), ['HSET', seatKeys.hold(w.eventId, idx('A08')), 'exp', String(past)]);
    expect(await holds.check(query(w))).toEqual(NOT_FOUND);
  });

  test('만료 시각은 Redis TIME과 견준다: exp가 지금보다 1분 뒤면 OK, 지금(Redis TIME) 이하면 NOT_FOUND다(exp ≤ now)', async () => {
    const w = await heldWorld({ seatIds: ['A09'] });
    const holds = new RedisOrderHolds(redis, seatMapWith(w.eventId));
    const key = seatKeys.hold(w.eventId, idx('A09'));
    await cmd(key, ['HSET', key, 'exp', String((await redisNowMs()) + 60_000)]);
    expect((await holds.check(query(w))).status).toBe('OK');
    // 지금 시각으로 두면 Lua가 읽는 TIME은 그보다 같거나 늦다
    await cmd(key, ['HSET', key, 'exp', String(await redisNowMs())]);
    expect(await holds.check(query(w))).toEqual(NOT_FOUND);
  });

  test('좌석마다 heldAt이 같지 않으면(한 홀드는 한 번에 잡혀 같아야 한다) NOT_FOUND다', async () => {
    const w = await heldWorld({ seatIds: ['A10', 'A11'] });
    const key = seatKeys.hold(w.eventId, idx('A11'));
    await cmd(key, ['HSET', key, 'heldAt', String(w.heldAtMs - 1)]);
    const holds = new RedisOrderHolds(redis, seatMapWith(w.eventId));
    expect(await holds.check(query(w))).toEqual(NOT_FOUND);
  });

  // 리뷰 고침 L4(2026-11-05): 일반 홀드(kind FAN)만 주문으로 받는다. 우선 구매(PRIORITY) 홀드의 주문은 GAT-135다
  test.each(['PRIORITY', 'fan', 'OTHER', ''])("홀드 Hash의 kind가 FAN이 아니면('%s') NOT_FOUND다", async (kind) => {
    const w = await heldWorld({ seatIds: ['A18', 'A19'] });
    const key = seatKeys.hold(w.eventId, idx('A19'));
    expect(await cmd(key, ['HGET', key, 'kind'])).toBe('FAN');
    await cmd(key, ['HSET', key, 'kind', kind]);
    const holds = new RedisOrderHolds(redis, seatMapWith(w.eventId));
    expect(await holds.check(query(w))).toEqual(NOT_FOUND);
  });

  test.each(['holdId', 'owner', 'psid', 'heldAt', 'exp', 'kind'])('홀드 Hash에 %s 칸이 없으면 NOT_FOUND다', async (field) => {
    const w = await heldWorld({ seatIds: ['A12'] });
    const key = seatKeys.hold(w.eventId, idx('A12'));
    await cmd(key, ['HDEL', key, field]);
    const holds = new RedisOrderHolds(redis, seatMapWith(w.eventId));
    expect(await holds.check(query(w))).toEqual(NOT_FOUND);
  });

  test('목록의 좌석이 좌석맵 판에 없으면(판이 바뀌어 빠진 좌석) NOT_FOUND다', async () => {
    const w = await heldWorld({ seatIds: ['A13'] });
    const key = sessionKeys.session(w.jti);
    await cmd(key, ['HSET', key, `h:${w.holdId}`, 'A13,Z99']);
    const holds = new RedisOrderHolds(redis, seatMapWith(w.eventId));
    expect(await holds.check(query(w))).toEqual(NOT_FOUND);
  });
});

// 리뷰 고침(2026-11-05, B가 놓친 것): 만료 경계를 Redis TIME에 기대지 않고 정확히 본다. TIME 한 번을 ARGV 4(초)로 바꾼 사본을 부른다
describe('ORDER_HOLD_LUA: 만료 경계(TIME을 고정한 사본)', () => {
  const NEEDLE = "redis.call('TIME')";

  test('원문에 TIME 읽기가 정확히 한 번 있고, 그것을 고정한 사본에서 exp = 지금이면 NOT_FOUND, 지금 + 1ms면 OK, 지금 − 1ms면 NOT_FOUND다', async () => {
    expect(ORDER_HOLD_LUA.split(NEEDLE)).toHaveLength(2);
    const fixed = redisScript(ORDER_HOLD_LUA.replace(NEEDLE, "{ARGV[4], '0'}"));
    const w = await heldWorld({ seatIds: ['A20'] });
    const key = seatKeys.hold(w.eventId, idx('A20'));
    // 고정한 지금(초 단위로 맞춘 ms): 홀드 Lua가 쓴 exp보다 뒤라 경계는 아래 HSET으로만 정해진다
    const nowSec = Math.floor(Date.now() / 1000) + 3600;
    const nowMs = nowSec * 1000;
    const run = () => redis.evalScript(fixed, [seatKeys.epoch(w.eventId), key], [w.holdId, w.accountId, w.jti, String(nowSec)]);
    await cmd(key, ['HSET', key, 'exp', String(nowMs)]);
    expect(await run()).toEqual(['NOT_FOUND']);
    await cmd(key, ['HSET', key, 'exp', String(nowMs + 1)]);
    expect(await run()).toEqual(['OK', String(w.heldAtMs)]);
    await cmd(key, ['HSET', key, 'exp', String(nowMs - 1)]);
    expect(await run()).toEqual(['NOT_FOUND']);
  });
});

describe('RedisOrderHolds.check: 저장소를 쓸 수 없음(STORE_UNAVAILABLE)', () => {
  test('세대 키가 없으면(회차 좌석 저장소가 준비되지 않음, Lua NOT_READY) STORE_UNAVAILABLE이다', async () => {
    const w = await heldWorld();
    await cmd(seatKeys.epoch(w.eventId), ['DEL', seatKeys.epoch(w.eventId)]);
    const holds = new RedisOrderHolds(redis, seatMapWith(w.eventId));
    expect(await holds.check(query(w))).toEqual(STORE_UNAVAILABLE);
  });

  test('그 회차의 좌석맵 판이 없으면 Lua를 부르지 않고 STORE_UNAVAILABLE이다', async () => {
    const w = await heldWorld();
    const rec = recording(redis);
    const holds = new RedisOrderHolds(rec.redis, seatMapWith(newEvent()));
    expect(await holds.check(query(w))).toEqual(STORE_UNAVAILABLE);
    expect(rec.scripts).toEqual([]);
  });

  test('좌석 Redis가 마감 안에 답하지 않으면(CLIENT PAUSE로 멈춤, deadlineMs 50) 던지지 않고 STORE_UNAVAILABLE이다', async () => {
    const w = await heldWorld();
    const holds = new RedisOrderHolds(redis, seatMapWith(w.eventId));
    // 다른 연결로 모든 클라이언트를 1초 멈춘다
    const pauser = await createHotRedis({ url: valkey!.url });
    try {
      await pauser.command(['CLIENT', 'PAUSE', '1000', 'ALL'], {});
      expect(await holds.check(query(w), { deadlineMs: 50 })).toEqual(STORE_UNAVAILABLE);
    } finally {
      await pauser.command(['CLIENT', 'UNPAUSE'], {}).catch(() => undefined);
      // 멈춤이 풀릴 때까지(길어야 1초) PING이 답할 때까지 다시 본다
      for (let i = 0; i < 40; i += 1) {
        if (await redis.command(['PING'], {}).then(() => true, () => false)) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      await pauser.close();
    }
    // 멈춤이 풀리면 다시 OK다
    expect((await holds.check(query(w))).status).toBe('OK');
  });
});

// 정본 모호: order-hold-lua.ts의 검사 2는 'exp ≤ now → NOT_FOUND'와 'heldAt·exp 형식 틀림 → PEAKET_CORRUPT_KEY'의 앞뒤를 적지 않았다.
// 형식이 틀린 값은 비교하지 않고(tonumber로 바꿔 견주지 않고) 망가진 키로 본다고 가정한다('-5'도 지난 시각이 아니라 망가진 값이다).
// 오류 글은 CORRUPT_KEY를 담는다고만 본다(어댑터가 seatLuaErrorOf로 바꿔 던져도 같은 이름이 남는다고 가정)
describe('RedisOrderHolds.check: 망가진 키는 숨기지 않고 던진다', () => {
  test.each(['abc', '0123', '-5', '1.5', ''])("홀드 Hash의 heldAt이 앞 0 없는 0 이상 10진 정수 글이 아니면('%s') PEAKET_CORRUPT_KEY 오류다(STORE_UNAVAILABLE이 아니다)", async (bad) => {
    const w = await heldWorld({ seatIds: ['A14'] });
    const key = seatKeys.hold(w.eventId, idx('A14'));
    await cmd(key, ['HSET', key, 'heldAt', bad]);
    const holds = new RedisOrderHolds(redis, seatMapWith(w.eventId));
    await expect(holds.check(query(w))).rejects.toThrow(/CORRUPT_KEY/);
  });

  test.each(['abc', '0123', '-5'])("홀드 Hash의 exp가 10진 정수 글이 아니면('%s') PEAKET_CORRUPT_KEY 오류다", async (bad) => {
    const w = await heldWorld({ seatIds: ['A15'] });
    const key = seatKeys.hold(w.eventId, idx('A15'));
    await cmd(key, ['HSET', key, 'exp', bad]);
    const holds = new RedisOrderHolds(redis, seatMapWith(w.eventId));
    await expect(holds.check(query(w))).rejects.toThrow(/CORRUPT_KEY/);
  });

  test('홀드 키의 형이 틀리면(문자열) WRONGTYPE 오류가 그대로 나간다(일시 장애로 숨기지 않는다)', async () => {
    const w = await heldWorld({ seatIds: ['A16'] });
    const key = seatKeys.hold(w.eventId, idx('A16'));
    await cmd(key, ['DEL', key]);
    await cmd(key, ['SET', key, 'x']);
    const holds = new RedisOrderHolds(redis, seatMapWith(w.eventId));
    await expect(holds.check(query(w))).rejects.toThrow(/WRONGTYPE/);
  });

  test.each([
    ['빈 글', ''],
    ['좌석 ID 모양이 아님', 'A01,a}b'],
    ['빈 조각', 'A01,,A02'],
  ])('구매 세션의 h:{holdId} 칸이 망가졌으면(%s) Error다(NOT_FOUND로 숨기지 않는다)', async (_label, value) => {
    const w = await heldWorld({ seatIds: ['A17'] });
    const holds = new RedisOrderHolds(redis, seatMapWith(w.eventId));
    // 망가뜨리기 전에는 OK다
    expect((await holds.check(query(w))).status).toBe('OK');
    const key = sessionKeys.session(w.jti);
    await cmd(key, ['HSET', key, `h:${w.holdId}`, value]);
    await expect(holds.check(query(w))).rejects.toThrow(Error);
  });
});
