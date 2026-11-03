// 좌석 저장소를 실제 Valkey 8.1로 돈다(test/hold-cases.ts의 사례를 메모리 저장소와 똑같이). 홀드 Lua의 모양(#!lua, KEYS·ARGV 차례,
// 한 해시 슬롯)은 노드 하나짜리 클러스터 모드 컨테이너에서 CLUSTER KEYSLOT으로 본다(단일 노드는 'cluster support disabled'라 이 명령이 없다).
import 'reflect-metadata';
import {
  createHotRedis,
  type HotRedis,
  RedisConnectError,
  RedisDeadlineError,
  type RedisScript,
  systemClock,
} from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { HOLD_LUA, HOLD_TTL_MS, OPEN_SALE_LUA, RedisSeatStore, SeatStoreUnavailable, seatKeys } from '../src/modules/inventory/index.js';
import { ACCOUNT_A, ACCOUNT_B, DAY, expectBug, holdCases, holdInput, idx, newEvent, SEAT_COUNT, SEAT_DEFS, type SeatHarness } from '../test/hold-cases.js';
import { type ShardSubscriber, shardSubscriber, startValkey, type ValkeyContainer } from './valkey.js';

const CONFIG_EPOCH = 3;
let valkey: ValkeyContainer | undefined;
let cluster: ValkeyContainer | undefined;
let redis: HotRedis;
let clusterRedis: HotRedis;
let sub: ShardSubscriber | undefined;
let myId: string;

beforeAll(async () => {
  // 하나가 실패해도 이미 뜬 컨테이너는 afterAll이 지우게, 둘을 따로 받는다
  const [a, b] = await Promise.allSettled([startValkey(), startValkey({ cluster: true, configEpoch: CONFIG_EPOCH })]);
  if (a.status === 'fulfilled') valkey = a.value;
  if (b.status === 'fulfilled') cluster = b.value;
  if (!valkey || !cluster) throw (a.status === 'rejected' ? a.reason : (b as PromiseRejectedResult).reason) as Error;
  [redis, clusterRedis, sub] = await Promise.all([createHotRedis({ url: valkey.url }), createHotRedis({ url: cluster.url }), shardSubscriber(valkey.url)]);
  myId = String(await clusterRedis.command(['CLUSTER', 'MYID'], { key: 'x' }));
});

afterAll(async () => {
  sub?.close();
  await Promise.all([redis?.close(), clusterRedis?.close()]);
  valkey?.stop();
  cluster?.stop();
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
const numOrNull = (v: unknown) => (v === null || v === undefined ? null : Number(v));
/** PTTL·PEXPIRETIME의 −1(만료 없음)·−2(키 없음)는 null */
const timeOrNull = (v: unknown) => {
  const t = Number(v);
  return t < 0 ? null : t;
};

function harness(r: HotRedis = redis): SeatHarness {
  const cmd = (key: string, args: string[]) => r.command(args, { key });
  return {
    store: new RedisSeatStore(r),
    clock: systemClock,
    // Docker 엔진 VM의 시계와 이 PC 시계의 차이
    skewMs: 5_000,
    tick: async () => {},
    passIdemTtl: async (e, a, k) => void (await cmd(seatKeys.idem(e, a, k), ['DEL', seatKeys.idem(e, a, k)])),
    setFence: async (e, v) => {
      const k = seatKeys.fence(e);
      await cmd(k, v === null ? ['DEL', k] : ['SET', k, v]);
    },
    setCtl: async (e, f) => void (await cmd(seatKeys.ctl(e), ['HSET', seatKeys.ctl(e), ...Object.entries(f).flat()])),
    setRel: async (e, a, i, at) => void (await cmd(seatKeys.rel(e, a), ['ZADD', seatKeys.rel(e, a), String(at), String(i)])),
    setQuota: async (e, a, q) => void (await cmd(seatKeys.quota(e, a), ['SET', seatKeys.quota(e, a), String(q)])),
    clearBit: async (e, i) => void (await cmd(seatKeys.bitmap(e), ['SETBIT', seatKeys.bitmap(e), String(i), '0'])),
    dropEpoch: async (e) => void (await cmd(seatKeys.epoch(e), ['DEL', seatKeys.epoch(e)])),
    setStaleHold: async (e, i, extra) => {
      const k = seatKeys.hold(e, i);
      await cmd(k, ['HSET', k, 'holdId', 'old', 'owner', 'old', 'psid', 'old', 'fence', '1', 'heldAt', '1', 'exp', '2', 'kind', 'FAN', 'ext', '1', ...Object.entries(extra).flat()]);
    },
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
    idem: async (e, a, k) => {
      const h = hash(await cmd(seatKeys.idem(e, a, k), ['HGETALL', seatKeys.idem(e, a, k)]));
      return Object.keys(h).length ? { fp: h.fp!, resp: h.resp! } : null;
    },
    idemTtlMs: async (e, a, k) => timeOrNull(await cmd(seatKeys.idem(e, a, k), ['PTTL', seatKeys.idem(e, a, k)])),
    expireAt: async (_e, key) => timeOrNull(await cmd(key, ['PEXPIRETIME', key])),
    epoch: async (e) => {
      const h = hash(await cmd(seatKeys.epoch(e), ['HGETALL', seatKeys.epoch(e)]));
      return h.epoch === undefined ? null : { epoch: Number(h.epoch), node: String(h.node) };
    },
    inCtlEvents: async (e) => Number(await cmd(seatKeys.ctlEvents(), ['SISMEMBER', seatKeys.ctlEvents(), e])) === 1,
    bitmapBits: async (e) => {
      const n = Number(await cmd(seatKeys.bitmap(e), ['STRLEN', seatKeys.bitmap(e)]));
      return n === 0 ? null : n * 8;
    },
    // 샤드 Pub/Sub는 단일 노드 컨테이너의 구독 연결로 받는다(holdCases는 단일 노드에서 돈다)
    prepare: async (e) => {
      if (r !== redis || !sub) throw new Error('구독 연결은 단일 노드 Valkey에만 있다');
      await sub.subscribe(SECTIONS.map((s) => seatKeys.section(e, String(s))));
    },
    published: async (e) => {
      if (r !== redis || !sub) throw new Error('구독 연결은 단일 노드 Valkey에만 있다');
      await sub.sync();
      return sub.messages.filter((m) => m.channel.startsWith(seatKeys.section(e, ''))).map((m) => ({ ...m }));
    },
  };
}

holdCases('Valkey Lua', async () => harness());

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

describe('홀드 Lua의 모양(ADR-0086, seat-hold.md §3 키 목록·입력값)', () => {
  test('FR010_ 홀드 Lua는 #!lua로 시작하고 KEYS는 정본 차례(10 + 좌석 수)이며 모두 한 해시 슬롯이다(CLUSTER KEYSLOT). ARGV도 정본 차례다', async () => {
    const rec = recording(clusterRedis);
    const store = new RedisSeatStore(rec.redis);
    const e = newEvent();
    const keepUntilMs = Date.now() + 2 * DAY;
    await store.openSale({ eventId: e, seatCount: SEAT_COUNT, keepUntilMs });
    const opens = rec.calls.splice(0);
    expect(opens).toHaveLength(1);
    expect(opens[0]!.script.source).toBe(OPEN_SALE_LUA);
    expect(OPEN_SALE_LUA.split('\n')[0]).toMatch(/^#!lua(\s|$)/);
    const i = holdInput(e, ['B02', 'A01'], { accountId: ACCOUNT_A, purchaseSessionId: 'ps-a', limit: 4, keepUntilMs });
    expect((await store.hold(i)).kind).toBe('OK');
    expect(rec.calls).toHaveLength(1);
    const { script, keys, args } = rec.calls[0]!;
    expect(script.source).toBe(HOLD_LUA);
    expect(HOLD_LUA.split('\n')[0]).toMatch(/^#!lua(\s|$)/);
    // Stream 지우기는 릴레이의 XTRIM … MINID가 한다. 홀드 Lua의 XADD는 MAXLEN을 쓰지 않는다(seat-hold.md §3 쓰기 7·'PoC와 다른 점').
    // 큰 MAXLEN(예 ~ 100000)은 시험 규모에서 행동으로 드러나지 않아 원문으로 본다
    expect(HOLD_LUA).not.toMatch(/MAXLEN/i);
    expect(keys).toEqual([
      seatKeys.bitmap(e),
      seatKeys.expiry(e),
      seatKeys.quota(e, ACCOUNT_A),
      seatKeys.stream(e),
      seatKeys.idem(e, ACCOUNT_A, i.idempotencyKey),
      seatKeys.epoch(e),
      seatKeys.ctl(e),
      seatKeys.rel(e, ACCOUNT_A),
      seatKeys.secver(e),
      seatKeys.fence(e),
      seatKeys.hold(e, idx('A01')),
      seatKeys.hold(e, idx('B02')),
    ]);
    expect(args).toEqual([
      ACCOUNT_A,
      'ps-a',
      i.holdId,
      i.fingerprint,
      '4',
      String(HOLD_TTL_MS),
      String(keepUntilMs),
      seatKeys.section(e, ''),
      ...['0', '0', '0', 'A01', 'R', 'SEC-A'],
      ...['21', '1', '1', 'B02', 'S', 'SEC-B'],
    ]);
    const slots = await Promise.all([...keys, ...opens[0]!.keys].map((k) => clusterRedis.command(['CLUSTER', 'KEYSLOT', k], { key: k })));
    expect(new Set(slots.map(String)).size).toBe(1);
  });

  test('FR010_ 클러스터 모드(노드 하나)에서도 판매 열기·홀드가 되고, 세대 키의 node는 {CLUSTER MYID}:{설정 세대}다', async () => {
    const h = harness(clusterRedis);
    const e = newEvent();
    const keepUntilMs = Date.now() + 2 * DAY;
    const o = await h.store.openSale({ eventId: e, seatCount: SEAT_COUNT, keepUntilMs });
    expect(await h.epoch(e)).toEqual({ epoch: o.seatEpoch, node: `${myId}:${CONFIG_EPOCH}` });
    const r = await h.store.hold(holdInput(e, ['A01', 'A02', 'B01'], { keepUntilMs }));
    expect(r.kind).toBe('OK');
    expect(await h.bit(e, idx('B01'))).toBe(1);
  });

  test('ST26_③ 세대 키에 epoch 칸이 없으면(node만 있어도) NOT_READY이고 좌석을 잡지 않는다', async () => {
    const h = harness();
    const e = newEvent();
    const keepUntilMs = Date.now() + 2 * DAY;
    await h.store.openSale({ eventId: e, seatCount: SEAT_COUNT, keepUntilMs });
    await redis.command(['HDEL', seatKeys.epoch(e), 'epoch'], { key: seatKeys.epoch(e) });
    expect(await h.store.hold(holdInput(e, ['A01'], { keepUntilMs }))).toEqual({ kind: 'NOT_READY' });
    expect(await h.bit(e, idx('A01'))).toBe(0);
    expect(await h.stream(e)).toHaveLength(0);
  });
});

describe('망가진 키는 쓰기 전에 거절한다(전부 안 됨, 추천 적용 2026-11-04)', () => {
  const cmd = (key: string, args: string[], binary = false) => redis.command(args, { key, binary });

  /** 그 회차 슬롯의 키 전부(형·만료 시각·값)와 받은 샤드 Pub/Sub 수. 형이 틀린 키도 읽는다 */
  async function raw(h: SeatHarness, e: string) {
    const keys = ((await cmd(seatKeys.bitmap(e), ['KEYS', `s:{event:${e}}:*`])) as unknown[]).map(String).sort();
    const out: Record<string, unknown> = {};
    for (const k of keys) {
      const type = String(await cmd(k, ['TYPE', k]));
      const at = Number(await cmd(k, ['PEXPIRETIME', k]));
      let value: unknown;
      if (type === 'string') value = Buffer.from((await cmd(k, ['GET', k], true)) as Uint8Array).toString('hex');
      else if (type === 'hash') value = hash(await cmd(k, ['HGETALL', k]));
      else if (type === 'zset') value = await cmd(k, ['ZRANGE', k, '0', '-1', 'WITHSCORES']);
      else if (type === 'stream') value = await cmd(k, ['XRANGE', k, '-', '+']);
      else if (type === 'list') value = await cmd(k, ['LRANGE', k, '0', '-1']);
      else if (type === 'set') value = ((await cmd(k, ['SMEMBERS', k])) as unknown[]).map(String).sort();
      out[k] = { type, at, value };
    }
    return { keys: out, published: (await h.published(e)).length };
  }

  /** 판매를 열고 다른 계정의 홀드 하나로 stream·secver·expiry·fence가 있는 회차 */
  async function opened() {
    const h = harness();
    const e = newEvent();
    await h.prepare!(e);
    const keepUntilMs = Date.now() + 2 * DAY;
    await h.store.openSale({ eventId: e, seatCount: SEAT_COUNT, keepUntilMs });
    expect((await h.store.hold(holdInput(e, ['B05'], { accountId: ACCOUNT_B, keepUntilMs }))).kind).toBe('OK');
    return { h, e, keepUntilMs };
  }

  test('POL011_ST4_ 보유 수가 10진 정수 글(^%d+$)이 아니면 일시 장애가 아닌 Error이고 회차 키가 하나도 바뀌지 않는다 [ASVS v5.0.0-2.2.3]', async () => {
    for (const bad of ['1.5', 'abc', '-1', '1e3', ' 2', '0x1', '']) {
      const { h, e, keepUntilMs } = await opened();
      const q = seatKeys.quota(e, ACCOUNT_A);
      await cmd(q, ['SET', q, bad]);
      const before = await raw(h, e);
      await expectBug(h.store.hold(holdInput(e, ['A01', 'B01'], { accountId: ACCOUNT_A, keepUntilMs })), { quota: bad });
      expect.soft({ quota: bad, s: await raw(h, e) }).toEqual({ quota: bad, s: before });
    }
  });

  test('ST4_ expiry·stream·secver·hold 키의 형이 틀리면(문자열) 일시 장애가 아닌 Error이고 회차 키가 하나도 바뀌지 않는다 [ASVS v5.0.0-2.2.3]', async () => {
    const targets: [string, (e: string) => string][] = [
      ['expiry', (e) => seatKeys.expiry(e)],
      ['stream', (e) => seatKeys.stream(e)],
      ['secver', (e) => seatKeys.secver(e)],
      ['hold', (e) => seatKeys.hold(e, idx('A01'))],
    ];
    for (const [what, keyOf] of targets) {
      const { h, e, keepUntilMs } = await opened();
      const k = keyOf(e);
      await cmd(k, ['DEL', k]);
      await cmd(k, ['SET', k, 'x']);
      const before = await raw(h, e);
      await expectBug(h.store.hold(holdInput(e, ['A01', 'B01'], { accountId: ACCOUNT_A, keepUntilMs })), { wrongType: what });
      expect.soft({ what, s: await raw(h, e) }).toEqual({ what, s: before });
    }
  });
});

describe('RedisSeatStore 오류 가르기(가짜 연결)', () => {
  function fake(o: { fail?: unknown; reply?: unknown }): HotRedis {
    const go = async () => (o.fail !== undefined ? Promise.reject(o.fail) : o.reply);
    return { command: go, evalScript: go, sendCommand: go, close: async () => {} };
  }
  const input = () => holdInput('ev-fake', ['A01'], { keepUntilMs: Date.now() + DAY });

  test('FR010_ 마감 초과·연결 실패·클러스터 재구성 같은 일시 장애는 SeatStoreUnavailable로 바꾼다(홀드·판매 열기)', async () => {
    for (const err of [new RedisDeadlineError(100), new RedisConnectError(), new Error('CLUSTERDOWN The cluster is down'), new Error('TRYAGAIN rehashing')]) {
      const store = new RedisSeatStore(fake({ fail: err }));
      await expect(store.hold(input())).rejects.toBeInstanceOf(SeatStoreUnavailable);
      await expect(store.openSale({ eventId: 'ev-fake', seatCount: 10, keepUntilMs: Date.now() + DAY })).rejects.toBeInstanceOf(SeatStoreUnavailable);
    }
  });

  test('FR010_ 스크립트 오류 같은 버그는 바꾸지 않고 던지고, 모르는 결과 값과 안전한 정수가 아닌 토큰은 Error다', async () => {
    const bug = new Error('ERR Error running script');
    await expect(new RedisSeatStore(fake({ fail: bug })).hold(input())).rejects.toBe(bug);
    for (const reply of [['WHAT'], ['OK', '9007199254740992', 1_793_761_200_000, 1_793_761_620_000]]) {
      const err = await new RedisSeatStore(fake({ reply }))
        .hold(input())
        .then(
          () => null,
          (x: unknown) => x,
        );
      expect({ reply, isError: err instanceof Error, unavailable: err instanceof SeatStoreUnavailable }).toEqual({ reply, isError: true, unavailable: false });
    }
  });
});
