// 좌석 묶기·결제 실패 해제(BUILD_ORDER PRF-142)를 실제 Valkey 8.1의 RedisSeatStore로 돈다(test/pin-cases.ts의 사례를 메모리 저장소와 똑같이).
// 상태는 Redis 명령으로 직접 읽는다(seat-store.int.test.ts의 도구와 같은 방식). Redis에서만 보는 것: Lua의 모양(#!lua·KEYS·ARGV·한 슬롯),
// 샤드 Pub/Sub(SSUBSCRIBE)로 받은 델타 글, 만료 반복(ExpirySweeper) 틱이 묶은 좌석을 건드리지 않음.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { createHotRedis, fakeClock, type HotRedis, type RedisScript, systemClock } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  EXPIRY_BATCH_SIZE,
  ExpirySweeper,
  HOLD_TTL_MS,
  MemorySeatMap,
  PIN_LUA,
  RedisSeatStore,
  RedisSweepLeases,
  RELEASE_FAILED_LUA,
  seatKeys,
  slotOf,
} from '../src/modules/inventory/index.js';
import { expireSeatsOf, okOf } from '../test/expiry-cases.js';
import { ACCOUNT_A, ACCOUNT_B, DAY, held, holdInput, idx, newEvent, ref, SEAT_COUNT, SEAT_DEFS } from '../test/hold-cases.js';
import { type PinHarness, pinCases } from '../test/pin-cases.js';
import { type ShardSubscriber, shardSubscriber, startValkey, type ValkeyContainer } from './valkey.js';

let valkey: ValkeyContainer | undefined;
let redis: HotRedis;
let sub: ShardSubscriber | undefined;

beforeAll(async () => {
  valkey = await startValkey();
  [redis, sub] = await Promise.all([createHotRedis({ url: valkey.url }), shardSubscriber(valkey.url)]);
});

afterAll(async () => {
  sub?.close();
  await redis?.close();
  valkey?.stop();
});

/** 시험 좌석맵 판의 구역 색인들(구독할 구역 채널) */
const SECTIONS = [...new Set(SEAT_DEFS.map((d) => d.sectionIndex))];

/** HGETALL 응답(RESP2 평평한 배열, RESP3 객체·Map)을 글 사전으로 */
function hash(v: unknown): Record<string, string> {
  if (v instanceof Map) return Object.fromEntries([...v].map(([k, x]) => [String(k), String(x)]));
  if (Array.isArray(v)) {
    const o: Record<string, string> = {};
    for (let i = 0; i + 1 < v.length; i += 2) o[String(v[i])] = String(v[i + 1]);
    return o;
  }
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, String(x)]));
  return {};
}
/** ZRANGE … WITHSCORES 응답(RESP2 평평한 배열, RESP3 짝 배열·Map)을 멤버 → 점수로 */
function scores(v: unknown): Record<string, number> {
  if (v instanceof Map) return Object.fromEntries([...v].map(([k, x]) => [String(k), Number(x)]));
  if (!Array.isArray(v)) return {};
  if (v.every((x) => Array.isArray(x))) return Object.fromEntries((v as unknown[][]).map((p) => [String(p[0]), Number(p[1])]));
  const o: Record<string, number> = {};
  for (let i = 0; i + 1 < v.length; i += 2) o[String(v[i])] = Number(v[i + 1]);
  return o;
}
const numOrNull = (v: unknown) => (v === null || v === undefined ? null : Number(v));
/** PEXPIRETIME의 −1(만료 없음)·−2(키 없음)는 null */
const timeOrNull = (v: unknown) => {
  const t = Number(v);
  return t < 0 ? null : t;
};

function harness(r: HotRedis = redis): PinHarness {
  const cmd = (key: string, args: string[]) => r.command(args, { key });
  return {
    store: new RedisSeatStore(r),
    clock: systemClock,
    // Docker 엔진 VM의 시계와 이 PC 시계의 차이
    skewMs: 5_000,
    prepare: async (e) => {
      if (!sub) throw new Error('구독 연결이 없다');
      await sub.subscribe(SECTIONS.map((s) => seatKeys.section(e, String(s))));
    },
    published: async (e) => {
      if (!sub) throw new Error('구독 연결이 없다');
      await sub.sync();
      return sub.messages.filter((m) => m.channel.startsWith(seatKeys.section(e, ''))).map((m) => ({ ...m }));
    },
    setQuota: async (e, a, q) => void (await cmd(seatKeys.quota(e, a), ['SET', seatKeys.quota(e, a), String(q)])),
    setFence: async (e, v) => void (await cmd(seatKeys.fence(e), ['SET', seatKeys.fence(e), v])),
    setCtl: async (e, f) => void (await cmd(seatKeys.ctl(e), ['HSET', seatKeys.ctl(e), ...Object.entries(f).flat()])),
    dropEpoch: async (e) => void (await cmd(seatKeys.epoch(e), ['DEL', seatKeys.epoch(e)])),
    setGen: async (e, g) => {
      const k = seatKeys.epoch(e);
      await cmd(k, g === null ? ['HDEL', k, 'gen'] : ['HSET', k, 'gen', String(g)]);
    },
    setHoldRaw: async (e, i, fields) => {
      const k = seatKeys.hold(e, i);
      await cmd(k, ['DEL', k]);
      if (fields && Object.keys(fields).length > 0) await cmd(k, ['HSET', k, ...Object.entries(fields).flat()]);
    },
    setHoldField: async (e, i, field, value) => void (await cmd(seatKeys.hold(e, i), ['HSET', seatKeys.hold(e, i), field, value])),
    setExpiry: async (e, member, score) => void (await cmd(seatKeys.expiry(e), ['ZADD', seatKeys.expiry(e), String(score), member])),
    bit: async (e, i) => Number(await cmd(seatKeys.bitmap(e), ['GETBIT', seatKeys.bitmap(e), String(i)])),
    holdHash: async (e, i) => {
      const h = hash(await cmd(seatKeys.hold(e, i), ['HGETALL', seatKeys.hold(e, i)]));
      return Object.keys(h).length ? h : null;
    },
    expiryScore: async (e, i) => numOrNull(await cmd(seatKeys.expiry(e), ['ZSCORE', seatKeys.expiry(e), String(i)])),
    quota: async (e, a) => numOrNull(await cmd(seatKeys.quota(e, a), ['GET', seatKeys.quota(e, a)])),
    fence: async (e) => {
      const v = await cmd(seatKeys.fence(e), ['GET', seatKeys.fence(e)]);
      return v === null || v === undefined ? null : String(v);
    },
    secver: async (e) => Object.fromEntries(Object.entries(hash(await cmd(seatKeys.secver(e), ['HGETALL', seatKeys.secver(e)]))).map(([k, v]) => [k, Number(v)])),
    stream: async (e) => ((await cmd(seatKeys.stream(e), ['XRANGE', seatKeys.stream(e), '-', '+'])) as unknown[]).map((x) => hash((x as unknown[])[1])),
    rel: async (e, a) => scores(await cmd(seatKeys.rel(e, a), ['ZRANGE', seatKeys.rel(e, a), '0', '-1', 'WITHSCORES'])),
    expireAt: async (_e, key) => timeOrNull(await cmd(key, ['PEXPIRETIME', key])),
    epoch: async (e) => {
      const h = hash(await cmd(seatKeys.epoch(e), ['HGETALL', seatKeys.epoch(e)]));
      return h.epoch === undefined ? null : { epoch: Number(h.epoch), node: String(h.node) };
    },
    gen: async (e) => numOrNull(await cmd(seatKeys.epoch(e), ['HGET', seatKeys.epoch(e), 'gen'])),
  };
}

pinCases(async () => harness());

/** evalScript를 부를 때마다 스크립트·KEYS·ARGV를 적는다 */
function recording(inner: HotRedis): { redis: HotRedis; calls: { script: RedisScript; keys: string[]; args: string[] }[] } {
  const calls: { script: RedisScript; keys: string[]; args: string[] }[] = [];
  return {
    calls,
    redis: {
      command: (a, o) => inner.command(a, o),
      sendCommand: (a) => inner.sendCommand(a),
      evalScript: (s, k, a, o) => {
        calls.push({ script: s, keys: [...k], args: [...a] });
        return inner.evalScript(s, k, a, o);
      },
      close: () => inner.close(),
    },
  };
}

describe('묶기·실패 해제 Lua의 모양(pin-lua.ts 계약, ADR-0086)', () => {
  test('pin_releaseFailed_ PIN_LUA·RELEASE_FAILED_LUA는 #!lua로 시작하고 MAXLEN을 쓰지 않으며, 한 번 부를 때 Lua 한 번이고 KEYS·ARGV가 정본 차례이며 KEYS가 모두 한 해시 슬롯이다 [ASVS v5.0.0-15.4.2]', async () => {
    for (const src of [PIN_LUA, RELEASE_FAILED_LUA]) {
      expect(src.split('\n')[0]).toMatch(/^#!lua(\s|$)/);
      expect(src).not.toMatch(/MAXLEN/i);
    }
    const rec = recording(redis);
    const store = new RedisSeatStore(rec.redis);
    const e = newEvent();
    const keepUntilMs = Date.now() + 2 * DAY;
    await store.openSale({ eventId: e, seatCount: SEAT_COUNT, keepUntilMs });
    const i = holdInput(e, ['B02', 'A01'], { accountId: ACCOUNT_A, purchaseSessionId: randomUUID(), keepUntilMs });
    held(await store.hold(i));
    const seatArgs = [...['0', '0', '0', 'A01', 'R', 'SEC-A'], ...['21', '1', '1', 'B02', 'S', 'SEC-B']];
    rec.calls.splice(0);
    expect((await store.pin({ eventId: e, accountId: ACCOUNT_A, purchaseSessionId: i.purchaseSessionId, holdId: i.holdId, seats: i.seats, limit: 4, orderGen: 1, keepUntilMs })).kind).toBe('OK');
    expect(rec.calls).toHaveLength(1);
    const p = rec.calls[0]!;
    expect(p.script.source).toBe(PIN_LUA);
    expect(p.keys).toEqual([
      seatKeys.bitmap(e),
      seatKeys.expiry(e),
      seatKeys.quota(e, ACCOUNT_A),
      seatKeys.stream(e),
      seatKeys.epoch(e),
      seatKeys.secver(e),
      seatKeys.fence(e),
      seatKeys.hold(e, idx('A01')),
      seatKeys.hold(e, idx('B02')),
      // 실패 표시 키(PRF-165, pin-lua.ts '실패 표시의 계약': 두 Lua의 KEYS 끝에 하나를 더한다)
      `s:{event:${e}}:failed:${i.holdId}`,
    ]);
    // 정본 모호: 표시 수명을 ARGV로 넘기는지 정본에 없다. 기존 ARGV 차례는 그대로라고 본다
    expect(p.args).toEqual([ACCOUNT_A, i.purchaseSessionId, i.holdId, '4', '1', String(HOLD_TTL_MS), String(keepUntilMs), seatKeys.section(e, ''), ...seatArgs]);
    rec.calls.splice(0);
    expect(await store.releaseFailed({ eventId: e, accountId: ACCOUNT_A, holdId: i.holdId, seats: i.seats, keepUntilMs })).toEqual({ kind: 'OK', released: 2 });
    expect(rec.calls).toHaveLength(1);
    const r = rec.calls[0]!;
    expect(r.script.source).toBe(RELEASE_FAILED_LUA);
    expect(r.keys).toEqual([
      seatKeys.bitmap(e),
      seatKeys.expiry(e),
      seatKeys.quota(e, ACCOUNT_A),
      seatKeys.stream(e),
      seatKeys.epoch(e),
      seatKeys.secver(e),
      seatKeys.hold(e, idx('A01')),
      seatKeys.hold(e, idx('B02')),
      `s:{event:${e}}:failed:${i.holdId}`,
    ]);
    expect(r.args).toEqual([ACCOUNT_A, i.holdId, String(keepUntilMs), seatKeys.section(e, ''), ...seatArgs]);
    expect(new Set([...p.keys, ...r.keys].map(slotOf)).size).toBe(1);
  });
});

describe('샤드 Pub/Sub 델타(실제 SSUBSCRIBE, hold-lua.ts 델타 모양)', () => {
  test('pin_releaseFailed_ 홀드(상태 1) → 만료(상태 0) → 묶기의 다시 잡기(상태 1) → 실패 해제(상태 0)의 글이 같은 모양이고 구역 번호가 1씩 이어진다. 내 홀드만인 묶기·거절된 묶기·0석 해제는 글을 보내지 않는다', async () => {
    const h = harness();
    const e = newEvent();
    await h.prepare!(e);
    const keepUntilMs = Date.now() + 2 * DAY;
    const { seatEpoch } = await h.store.openSale({ eventId: e, seatCount: SEAT_COUNT, keepUntilMs });
    const psid = randomUUID();
    const i = holdInput(e, ['A01', 'A02'], { accountId: ACCOUNT_A, purchaseSessionId: psid, keepUntilMs });
    const pinIn = { eventId: e, accountId: ACCOUNT_A, purchaseSessionId: psid, holdId: i.holdId, seats: i.seats, limit: 4, orderGen: 1, keepUntilMs };
    const r1 = held(await h.store.hold(i));
    // 만료: Hash exp·만료 인덱스 점수를 1분 전으로 → 1단계 → 만료 Lua
    const at = Date.now() - 60_000;
    for (const id of ['A01', 'A02']) {
      await h.setHoldField(e, idx(id), 'exp', String(at));
      await h.setExpiry(e, String(idx(id)), at);
    }
    const x = okOf(await h.store.expire({ eventId: e, keepUntilMs, seats: expireSeatsOf(await h.store.dueExpiries({ eventId: e, nowMs: Date.now(), limit: EXPIRY_BATCH_SIZE })) }));
    expect(x.released).toBe(2);
    const tExpire = Math.floor(x.nowUs / 1000);
    const p = await h.store.pin(pinIn);
    expect(p).toMatchObject({ kind: 'OK', regrabbed: 2 });
    const tPin = Number((await h.holdHash(e, idx('A01')))?.heldAt);
    // 보내지 않는 셋: 내 홀드만인 묶기, 남이 가진 좌석이 섞인 묶기(TAKEN), 다른 holdId의 해제(0석)
    expect(await h.store.pin(pinIn)).toEqual({ kind: 'OK', gen: 1, regrabbed: 0 });
    held(await h.store.hold(holdInput(e, ['A03'], { accountId: ACCOUNT_B, keepUntilMs })));
    expect((await h.store.pin({ ...pinIn, seats: [...i.seats, ref('A03')] })).kind).toBe('TAKEN');
    expect(await h.store.releaseFailed({ eventId: e, accountId: ACCOUNT_A, holdId: randomUUID(), seats: i.seats, keepUntilMs })).toEqual({ kind: 'OK', released: 0 });
    expect(await h.store.releaseFailed({ eventId: e, accountId: ACCOUNT_A, holdId: i.holdId, seats: i.seats, keepUntilMs })).toEqual({ kind: 'OK', released: 2 });
    const release = (await h.stream(e)).filter((s) => s.type === 'RELEASED');
    const tRelease = Number(release[0]?.occurredAtMs);
    const ch = seatKeys.section(e, '0');
    // 구역 0의 글(B의 A03 홀드는 번호 4)
    expect(await h.published(e)).toEqual([
      { channel: ch, message: `1 ${seatEpoch} 0 1 ${r1.heldAtMs} 0:1 1:1` },
      { channel: ch, message: `1 ${seatEpoch} 0 2 ${tExpire} 0:0 1:0` },
      { channel: ch, message: `1 ${seatEpoch} 0 3 ${tPin} 0:1 1:1` },
      { channel: ch, message: `1 ${seatEpoch} 0 4 ${(await h.holdHash(e, idx('A03')))?.heldAt} 2:1` },
      { channel: ch, message: `1 ${seatEpoch} 0 5 ${tRelease} 0:0 1:0` },
    ]);
  });
});

describe('만료 반복과 묶은 좌석(seat-hold.md §6 묶기 쓰기, 명세 inv_noOversell)', () => {
  test('pin_inv_noOversell_ 홀드 시간이 지난 뒤 만료 반복(ExpirySweeper) 틱이 돌아도 만료 Lua는 묶은 좌석을 건드리지 않고(비트·Hash·보유 수 그대로, EXPIRED 없음), 묶지 않은 이웃 홀드만 푼다 [ASVS v5.0.0-2.3.4] [ASVS v5.0.0-15.4.2]', async () => {
    const h = harness();
    const store = h.store;
    const e = newEvent();
    const keepUntilMs = Date.now() + 2 * DAY;
    await store.openSale({ eventId: e, seatCount: SEAT_COUNT, keepUntilMs });
    const psid = randomUUID();
    const mine = holdInput(e, ['A01', 'A02'], { accountId: ACCOUNT_A, purchaseSessionId: psid, keepUntilMs });
    held(await store.hold(mine));
    held(await store.hold(holdInput(e, ['A05'], { accountId: ACCOUNT_B, keepUntilMs })));
    expect(await store.pin({ eventId: e, accountId: ACCOUNT_A, purchaseSessionId: psid, holdId: mine.holdId, seats: mine.seats, limit: 4, orderGen: 1, keepUntilMs })).toEqual({ kind: 'OK', gen: 1, regrabbed: 0 });
    // 셋 다 홀드 시간이 지났다(묶은 좌석은 Hash exp만 지난 시각으로. 만료 인덱스에 다시 넣지 않는다)
    const at = Date.now() - 60_000;
    for (const id of ['A01', 'A02', 'A05']) await h.setHoldField(e, idx(id), 'exp', String(at));
    await h.setExpiry(e, String(idx('A05')), at);
    // 비교할 묶은 좌석의 Hash는 exp를 고친 뒤에 받아 둔다(시험이 고친 칸까지 같은지 본다, 구현 담당이 찾은 시험 결함)
    const pinned = await Promise.all(['A01', 'A02'].map((id) => h.holdHash(e, idx(id))));
    const seatMap = new MemorySeatMap();
    seatMap.put({ eventId: e, layoutVersion: 'v1', seatCount: SEAT_COUNT, perAccountLimit: 4, saleEndsAtMs: Date.now() + DAY }, SEAT_DEFS);
    // 앱 시계는 홀드 시간(7분)을 넘긴 지금: 1단계가 아직 시간이 남은 멤버까지 읽어도 만료 Lua가 Redis TIME으로 다시 가른다
    const sweeper = new ExpirySweeper({ expiries: store, seatMap, leases: new RedisSweepLeases(redis), clock: fakeClock({ now: Date.now() + HOLD_TTL_MS + 60_000 }), podId: 'pod-pin' });
    const t = await sweeper.tick();
    expect(t.events.find((x) => x.eventId === e)).toMatchObject({ released: 1, corrupt: 0 });
    expect([await h.bit(e, idx('A01')), await h.bit(e, idx('A02')), await h.bit(e, idx('A05'))]).toEqual([1, 1, 0]);
    expect(await Promise.all(['A01', 'A02'].map((id) => h.holdHash(e, idx(id))))).toEqual(pinned);
    expect(await h.quota(e, ACCOUNT_A)).toBe(2);
    expect((await h.stream(e)).filter((s) => s.type === 'EXPIRED').map((s) => s.seatId)).toEqual(['A05']);
  });
});
