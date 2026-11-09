// 좌석 저장소를 실제 Valkey 8.1로 돈다(test/hold-cases.ts의 사례를 메모리 저장소와 똑같이). 홀드 Lua의 모양(#!lua, KEYS·ARGV 차례,
// 한 해시 슬롯)은 노드 하나짜리 클러스터 모드 컨테이너에서 CLUSTER KEYSLOT으로 본다(단일 노드는 'cluster support disabled'라 이 명령이 없다).
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import {
  createHotRedis,
  fakeClock,
  type HotRedis,
  PlatformMetrics,
  RedisConnectError,
  RedisDeadlineError,
  type RedisScript,
  systemClock,
  uuidv7,
} from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  EXPIRE_LUA,
  ExpirySweeper,
  HOLD_LUA,
  HOLD_TTL_MS,
  MemorySeatMap,
  OPEN_SALE_LUA,
  PromSeatSignals,
  RedisSeatStore,
  RedisSweepLeases,
  SeatEpochWatch,
  SeatStoreUnavailable,
  seatKeys,
  seatLuaErrorOf,
  slotOf,
} from '../src/modules/inventory/index.js';
import { type EpochBumpHarness, epochBumpCases, OLD_PRIMARY } from '../test/epoch-bump-cases.js';
import { bugOf, type ExpiryHarness, expireSeatsOf, expiryCases, okOf } from '../test/expiry-cases.js';
import { ACCOUNT_A, ACCOUNT_B, ACCOUNT_C, ACCOUNT_D, DAY, expectBug, fingerprintOf, held, holdCases, holdInput, idx, newEvent, ref as refOf, SEAT_COUNT, SEAT_DEFS, type SeatHarness } from '../test/hold-cases.js';
import { type ShardSubscriber, shardSubscriber, startValkey, type ValkeyContainer } from './valkey.js';

const CONFIG_EPOCH = 3;
let valkey: ValkeyContainer | undefined;
let cluster: ValkeyContainer | undefined;
let redis: HotRedis;
let clusterRedis: HotRedis;
let sub: ShardSubscriber | undefined;
/** 클러스터 모드 컨테이너의 샤드 Pub/Sub 구독 연결(세대 올리기 사례의 델타, PRF-168 리뷰 고침 H1) */
let clusterSub: ShardSubscriber | undefined;
let myId: string;

beforeAll(async () => {
  // 하나가 실패해도 이미 뜬 컨테이너는 afterAll이 지우게, 둘을 따로 받는다
  const [a, b] = await Promise.allSettled([startValkey(), startValkey({ cluster: true, configEpoch: CONFIG_EPOCH })]);
  if (a.status === 'fulfilled') valkey = a.value;
  if (b.status === 'fulfilled') cluster = b.value;
  if (!valkey || !cluster) throw (a.status === 'rejected' ? a.reason : (b as PromiseRejectedResult).reason) as Error;
  [redis, clusterRedis, sub, clusterSub] = await Promise.all([
    createHotRedis({ url: valkey.url }),
    createHotRedis({ url: cluster.url }),
    shardSubscriber(valkey.url),
    shardSubscriber(cluster.url),
  ]);
  myId = String(await clusterRedis.command(['CLUSTER', 'MYID'], { key: 'x' }));
});

afterAll(async () => {
  sub?.close();
  clusterSub?.close();
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

/** INFO commandstats의 cmdstat_cluster|info calls(스크립트 안에서 부른 것도 센다). 없으면 0 */
async function clusterInfoCalls(r: HotRedis): Promise<number> {
  const text = String(await r.command(['INFO', 'commandstats'], { key: 'x' }));
  return Number(/cmdstat_cluster\|info:calls=(\d+)/.exec(text)?.[1] ?? '0');
}

/**
 * 세대 올리기 사례용 Valkey 도구(쓰는 Lua가 그 자리에서 세대를 올림, BUILD_ORDER PRF-168 리뷰 고침 H1, ADR-0210).
 * 클러스터 모드(노드 하나)는 표지가 '{CLUSTER MYID}:{설정 세대 3}'이고, CLUSTER INFO를 부른 수로 견주기 비용을 본다
 */
function epochHarness(r: HotRedis, s: () => ShardSubscriber | undefined, me: () => string, o: { cluster: boolean }): EpochBumpHarness {
  const cmd = (key: string, args: string[]) => r.command(args, { key });
  const subscriber = () => {
    const x = s();
    if (!x) throw new Error('구독 연결이 없다');
    return x;
  };
  return {
    store: new RedisSeatStore(r),
    clock: systemClock,
    me,
    serverSec: async () => Number(((await r.command(['TIME'], { key: 'x' })) as unknown[])[0]),
    setEpoch: async (e, f) => {
      const k = seatKeys.epoch(e);
      const pairs = Object.entries(f).flatMap(([field, v]) => (v === undefined ? [] : [field, v]));
      await cmd(k, ['HSET', k, ...pairs]);
    },
    epoch: async (e) => {
      const h = hash(await cmd(seatKeys.epoch(e), ['HGETALL', seatKeys.epoch(e)]));
      return h.epoch === undefined ? null : { epoch: Number(h.epoch), node: String(h.node), chk: h.chk === undefined ? null : Number(h.chk) };
    },
    epochRaw: async (e) => {
      const h = hash(await cmd(seatKeys.epoch(e), ['HGETALL', seatKeys.epoch(e)]));
      return Object.keys(h).length ? h : null;
    },
    stream: async (e) => ((await cmd(seatKeys.stream(e), ['XRANGE', seatKeys.stream(e), '-', '+'])) as unknown[]).map((x) => hash((x as unknown[])[1])),
    prepare: async (e) => subscriber().subscribe(SECTIONS.map((x) => seatKeys.section(e, String(x)))),
    published: async (e) => {
      const x = subscriber();
      await x.sync();
      return x.messages.filter((m) => m.channel.startsWith(seatKeys.section(e, ''))).map((m) => ({ ...m }));
    },
    backdate: async (e, i, at) => {
      await cmd(seatKeys.hold(e, i), ['HSET', seatKeys.hold(e, i), 'exp', String(at)]);
      await cmd(seatKeys.expiry(e), ['ZADD', seatKeys.expiry(e), String(at), String(i)]);
    },
    pause: async (e) => void (await cmd(seatKeys.ctl(e), ['HSET', seatKeys.ctl(e), 'paused', '1'])),
    corrupt: async (e, what, a) => {
      const k = what === 'fence' ? seatKeys.fence(e) : seatKeys.quota(e, a);
      await cmd(k, ['SET', k, what === 'fence' ? 'x1' : '1.5', 'KEEPTTL']);
    },
    ...(o.cluster ? { fullChecks: () => clusterInfoCalls(r) } : {}),
  };
}

epochBumpCases('Valkey 단일 노드', async () => epochHarness(redis, () => sub, () => 'standalone', { cluster: false }), { configPart: false });
epochBumpCases('Valkey 클러스터 모드(노드 하나)', async () => epochHarness(clusterRedis, () => clusterSub, () => `${myId}:${CONFIG_EPOCH}`, { cluster: true }), { configPart: true });

describe('노드 표지를 구하지 못하면 아무것도 쓰지 않고 NODE_ID로 끝난다(PRF-168 리뷰 고침 중간 2·낮음 b, ADR-0210 결과, docs/infra.md 저장소 인증 계층)', () => {
  /** ACL로 cluster 명령을 뺀 사용자의 연결(queue-svc test-int/entry-store.int.test.ts와 같은 방식) */
  async function noClusterRedis(user: string, r: HotRedis, url: string, deny: string): Promise<HotRedis> {
    await r.command(['ACL', 'SETUSER', user, 'reset', 'on', '>pw-test-only', '~*', '&*', '+@all', deny], { key: 'x' });
    return createHotRedis({ url: url.replace('redis://', `redis://${user}:pw-test-only@`) });
  }
  /** 저장소 호출이 일시 장애가 아닌 Error로 끝나고 글에 PEAKET_NODE_ID가 있으며 지표 갈래가 NODE_ID인지 본다 */
  async function expectNodeIdError(what: string, p: Promise<unknown>): Promise<void> {
    const err = await bugOf(p, { what });
    expect.soft({ what, msg: err.message }).toMatchObject({ what, msg: expect.stringContaining('PEAKET_NODE_ID') });
    expect.soft({ what, code: seatLuaErrorOf(err)?.code }).toEqual({ what, code: 'NODE_ID' });
  }

  test('ST26_리뷰 고침 중간 2_ 단일 노드 Valkey에서도 cluster 명령을 뺀 사용자의 스크립트 안 CLUSTER MYID는 권한 오류다(cluster support disabled가 아니다). 그 사용자로 부르면 홀드·만료·묶기·실패 해제·세대 올리기가 회차 키를 하나도 바꾸지 않고(세대 키의 chk 포함) PEAKET_NODE_ID(지표 갈래 NODE_ID)로 끝나고, 판매 열기는 비트맵도 만들지 않는다(낮음 b) [ASVS v5.0.0-16.5.3] [ASVS v5.0.0-13.2.2] [S-T26]', async () => {
    const limited = await noClusterRedis('seat-nocluster', redis, valkey!.url, '-cluster');
    try {
      // 먼저 확인: 권한 오류(NOPERM 갈래)다. standalone으로 넘어가지 않는다
      const probe = await limited.command(['EVAL', "return redis.pcall('CLUSTER', 'MYID')", '0'], { key: 'x' }).then(
        (v) => `풀렸다: ${String(v)}`,
        (x: unknown) => String((x as Error).message),
      );
      expect(probe).toContain('cluster|myid');
      expect(probe).not.toContain('cluster support disabled');

      const store = new RedisSeatStore(redis);
      const denied = new RedisSeatStore(limited);
      const e = newEvent();
      const keepUntilMs = Date.now() + 2 * DAY;
      await store.openSale({ eventId: e, seatCount: SEAT_COUNT, keepUntilMs });
      const holdId = uuidv7(systemClock);
      held(await store.hold(holdInput(e, ['A01'], { holdId, purchaseSessionId: 'ps-a', keepUntilMs })));
      held(await store.hold(holdInput(e, ['B01'], { accountId: ACCOUNT_B, keepUntilMs })));
      await backdate(redis, e, ['B01']);
      const due = expireSeatsOf(await store.dueExpiries({ eventId: e, nowMs: Date.now(), limit: 100 }));
      // 지난 chk: 세대 확인이 쓰기 전에 실패하는지(chk도 쓰지 않는지) 본다
      await redis.command(['HSET', seatKeys.epoch(e), 'chk', '1'], { key: seatKeys.epoch(e) });
      const before = await rawState(redis, e);
      const pinIn = { eventId: e, accountId: ACCOUNT_A, purchaseSessionId: 'ps-a', holdId, seats: ['A01', 'A03'].map(refOf), limit: 4, orderGen: 1, keepUntilMs };
      await expectNodeIdError('홀드', denied.hold(holdInput(e, ['A02'], { keepUntilMs })));
      await expectNodeIdError('홀드 거절(이미 잡힌 좌석)', denied.hold(holdInput(e, ['B01'], { keepUntilMs })));
      await expectNodeIdError('만료', denied.expire({ eventId: e, keepUntilMs, seats: due }));
      await expectNodeIdError('묶기', denied.pin(pinIn));
      await expectNodeIdError('실패 해제', denied.releaseFailed({ eventId: e, accountId: ACCOUNT_A, holdId, seats: [refOf('A01')], keepUntilMs }));
      await expectNodeIdError('세대 올리기', denied.bumpEpoch(e));
      expect(await rawState(redis, e)).toEqual(before);

      // 판매 열기(낮음 b): 표지를 비트맵보다 먼저 구한다. 회차 슬롯의 키를 하나도 만들지 않는다(회차 목록 s:ctl:events는 다른 슬롯이라 Lua 앞에서 넣는다)
      const fresh = newEvent();
      await expectNodeIdError('판매 열기', denied.openSale({ eventId: fresh, seatCount: SEAT_COUNT, keepUntilMs }));
      expect(await rawState(redis, fresh)).toEqual({});
    } finally {
      await limited.close();
      await redis.command(['ACL', 'DELUSER', 'seat-nocluster'], { key: 'x' });
    }
  });

  test('ST26_리뷰 고침 중간 2_ 클러스터 모드에서 CLUSTER INFO만 막힌 사용자도 설정 세대를 견주는 때(지난 chk) 아무것도 쓰지 않고 PEAKET_NODE_ID로 끝난다(권한 오류가 갈래 OTHER로 새지 않는다) [ASVS v5.0.0-16.5.3] [S-T26]', async () => {
    const limited = await noClusterRedis('seat-noinfo', clusterRedis, cluster!.url, '-cluster|info');
    try {
      const store = new RedisSeatStore(clusterRedis);
      const denied = new RedisSeatStore(limited);
      const e = newEvent();
      const keepUntilMs = Date.now() + 2 * DAY;
      await store.openSale({ eventId: e, seatCount: SEAT_COUNT, keepUntilMs });
      await clusterRedis.command(['HSET', seatKeys.epoch(e), 'chk', '1'], { key: seatKeys.epoch(e) });
      const before = await rawState(clusterRedis, e);
      await expectNodeIdError('홀드', denied.hold(holdInput(e, ['A02'], { keepUntilMs })));
      await expectNodeIdError('세대 올리기', denied.bumpEpoch(e));
      expect(await rawState(clusterRedis, e)).toEqual(before);
    } finally {
      await limited.close();
      await clusterRedis.command(['ACL', 'DELUSER', 'seat-noinfo'], { key: 'x' });
    }
  });
});

describe('세대 올리기 감시가 쓰는 Lua의 올리기를 센다(PRF-168 리뷰 고침 중간 1, docs/observability.md seat_epoch_bumps_total)', () => {
  test('ST26_리뷰 고침 중간 1_ 승격 흉내 뒤 홀드 Lua가 그 자리에서 세대를 올리면(bumps 1) 다음 감시 틱은 올리지 않지만(SAME) 그 한 번을 세어 seat_epoch_bumps_total이 1이고 info 한 줄(회차 ID·새 세대·올린 수)이다. 그 뒤 틱은 다시 세지 않는다 [S-T26] [ASVS v5.0.0-16.2.5]', async () => {
    const store = new RedisSeatStore(redis);
    const e = newEvent();
    const keepUntilMs = Date.now() + 2 * DAY;
    await store.openSale({ eventId: e, seatCount: SEAT_COUNT, keepUntilMs });
    const metrics = new PlatformMetrics('purchase-svc');
    const signals = new PromSeatSignals().register(metrics.registry);
    const infos: object[] = [];
    // 이 회차만 본다(같은 Valkey의 다른 시험 회차가 지표를 바꾸지 않게)
    const watch = new SeatEpochWatch({
      store: { saleEvents: async () => [e], bumpEpoch: (id) => store.bumpEpoch(id) },
      leader: { isLeader: () => true },
      signals,
      logger: { warn: () => undefined, info: (o) => void infos.push(o) },
    });
    const counter = async () => Number(/^seat_epoch_bumps_total (\S+)$/m.exec(await metrics.registry.metrics())?.[1] ?? 'NaN');
    expect(await watch.tick()).toEqual({ checked: 1, bumped: [], notReady: [], failed: [] });
    expect(await counter()).toBe(0);

    await redis.command(['HSET', seatKeys.epoch(e), 'node', OLD_PRIMARY], { key: seatKeys.epoch(e) });
    held(await store.hold(holdInput(e, ['A01'], { keepUntilMs })));
    const ep = hash(await redis.command(['HGETALL', seatKeys.epoch(e)], { key: seatKeys.epoch(e) }));
    expect(ep).toMatchObject({ node: 'standalone', bumps: '1' });
    expect(await watch.tick()).toEqual({ checked: 1, bumped: [], notReady: [], failed: [] });
    expect(await counter()).toBe(1);
    expect(infos).toEqual([{ kind: 'seat-epoch-watch', eventId: e, epoch: Number(ep.epoch), bumps: 1 }]);
    await watch.tick();
    expect(await counter()).toBe(1);
  });
});

/** ZRANGE … WITHSCORES 응답(RESP2 평평한 배열, RESP3 짝 배열·Map)을 멤버 → 점수로 */
function scores(v: unknown): Record<string, number> {
  if (v instanceof Map) return Object.fromEntries([...v].map(([k, x]) => [String(k), Number(x)]));
  if (!Array.isArray(v)) return {};
  if (v.every((x) => Array.isArray(x))) return Object.fromEntries((v as unknown[][]).map((p) => [String(p[0]), Number(p[1])]));
  const o: Record<string, number> = {};
  for (let i = 0; i + 1 < v.length; i += 2) o[String(v[i])] = Number(v[i + 1]);
  return o;
}

/** 만료 사례용 Valkey 도구(harness에 홀드 Hash·만료 인덱스·secver 칸·rel·임대를 직접 쓰고 읽는 것을 더한다) */
function expiryHarness(r: HotRedis = redis): ExpiryHarness {
  const cmd = (key: string, args: string[]) => r.command(args, { key });
  return {
    ...harness(r),
    store: new RedisSeatStore(r),
    leases: new RedisSweepLeases(r),
    // 스크립트 안 PEXPIRE는 스크립트를 시작한 때의 시각을 쓴다(TIME과 1ms 안팎 차이)
    relSlackMs: 5,
    setHoldRaw: async (e, i, fields) => {
      const k = seatKeys.hold(e, i);
      await cmd(k, ['DEL', k]);
      if (fields && Object.keys(fields).length > 0) await cmd(k, ['HSET', k, ...Object.entries(fields).flat()]);
    },
    setHoldField: async (e, i, field, value) => void (await cmd(seatKeys.hold(e, i), ['HSET', seatKeys.hold(e, i), field, value])),
    setExpiry: async (e, member, score) => void (await cmd(seatKeys.expiry(e), ['ZADD', seatKeys.expiry(e), String(score), member])),
    removeExpiry: async (e, i) => void (await cmd(seatKeys.expiry(e), ['ZREM', seatKeys.expiry(e), String(i)])),
    setSecverRaw: async (e, s, v) => void (await cmd(seatKeys.secver(e), ['HSET', seatKeys.secver(e), String(s), String(v)])),
    setQuotaRaw: async (e, a, text) => void (await cmd(seatKeys.quota(e, a), ['SET', seatKeys.quota(e, a), text])),
    rel: async (e, a) => scores(await cmd(seatKeys.rel(e, a), ['ZRANGE', seatKeys.rel(e, a), '0', '-1', 'WITHSCORES'])),
    lease: async (e) => {
      const v = await cmd(seatKeys.sweep(e), ['GET', seatKeys.sweep(e)]);
      return v === null || v === undefined ? null : String(v);
    },
    leaseTtlMs: async (e) => timeOrNull(await cmd(seatKeys.sweep(e), ['PTTL', seatKeys.sweep(e)])),
    shortenLease: async (e, ms) => void (await cmd(seatKeys.sweep(e), ['PEXPIRE', seatKeys.sweep(e), String(ms)])),
    passLeaseTtl: async (e) => void (await cmd(seatKeys.sweep(e), ['DEL', seatKeys.sweep(e)])),
    addCtlEvent: async (raw) => void (await cmd(seatKeys.ctlEvents(), ['SADD', seatKeys.ctlEvents(), raw])),
  };
}

expiryCases('Valkey Lua', async () => expiryHarness());

/**
 * 그 회차 슬롯의 키 전부(형·만료 시각·값). 형이 틀린 키도 읽는다. 세대 키의 chk·bumps 칸도 본다: 좌석을 쓰는 Lua의 세대 확인은 오류로 끝나는 검사를
 * 모두 지난 뒤에 쓰므로(BUILD_ORDER PRF-168 리뷰 고침 결함 1) 오류로 끝난 호출은 chk도 바꾸지 않는다
 */
async function rawState(r: HotRedis, e: string) {
  const cmd = (key: string, args: string[], binary = false) => r.command(args, { key, binary });
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
    out[k] = { type, at, value };
  }
  return out;
}

/** 좌석들의 홀드 Hash exp·만료 인덱스 점수를 1분 전으로(시간이 지난 홀드) */
async function backdate(r: HotRedis, e: string, seatIds: readonly string[]) {
  const at = Date.now() - 60_000;
  for (const id of seatIds) {
    await r.command(['HSET', seatKeys.hold(e, idx(id)), 'exp', String(at)], { key: seatKeys.hold(e, idx(id)) });
    await r.command(['ZADD', seatKeys.expiry(e), String(at), String(idx(id))], { key: seatKeys.expiry(e) });
  }
  return at;
}

describe('만료 Lua의 모양(ADR-0086, seat-hold.md §5 키 목록·입력값)', () => {
  test('ST6_ 만료 Lua는 #!lua로 시작하고 MAXLEN·allow-oom을 쓰지 않으며, KEYS(5 + n + 2m)·ARGV(4 + m + 9n)가 정본 차례이고 KEYS와 임대 키가 모두 한 해시 슬롯이다(CLUSTER KEYSLOT) [ASVS v5.0.0-15.4.4]', async () => {
    const rec = recording(clusterRedis);
    const store = new RedisSeatStore(rec.redis);
    const e = newEvent();
    const keepUntilMs = Date.now() + 2 * DAY;
    await store.openSale({ eventId: e, seatCount: SEAT_COUNT, keepUntilMs });
    const ia = holdInput(e, ['A01', 'A02'], { accountId: ACCOUNT_A, keepUntilMs });
    const ib = holdInput(e, ['B01'], { accountId: ACCOUNT_B, keepUntilMs });
    const ra = held(await store.hold(ia));
    const rb = held(await store.hold(ib));
    await backdate(clusterRedis, e, ['A01', 'A02', 'B01']);
    rec.calls.splice(0);
    const d = await store.dueExpiries({ eventId: e, nowMs: Date.now(), limit: 100 });
    expect(rec.calls).toHaveLength(0);
    const r = okOf(await store.expire({ eventId: e, keepUntilMs, seats: expireSeatsOf(d) }));
    expect(r.released).toBe(3);
    expect(rec.calls).toHaveLength(1);
    const { script, keys, args } = rec.calls[0]!;
    expect(script.source).toBe(EXPIRE_LUA);
    expect(EXPIRE_LUA.split('\n')[0]).toMatch(/^#!lua(\s|$)/);
    // XADD에 길이 상한을 두지 않고(지우기는 릴레이의 XTRIM … MINID), 메모리 부족에도 돌게 하는 표시를 쓰지 않는다(RB-06)
    expect(EXPIRE_LUA).not.toMatch(/MAXLEN/i);
    expect(EXPIRE_LUA).not.toMatch(/allow-oom/i);
    expect(keys).toEqual([
      seatKeys.bitmap(e),
      seatKeys.expiry(e),
      seatKeys.stream(e),
      seatKeys.epoch(e),
      seatKeys.secver(e),
      seatKeys.hold(e, idx('A01')),
      seatKeys.hold(e, idx('A02')),
      seatKeys.hold(e, idx('B01')),
      seatKeys.quota(e, ACCOUNT_A),
      seatKeys.quota(e, ACCOUNT_B),
      seatKeys.rel(e, ACCOUNT_A),
      seatKeys.rel(e, ACCOUNT_B),
      seatKeys.ordered(e),
    ]);
    expect(args).toEqual([
      '30000',
      seatKeys.section(e, ''),
      String(keepUntilMs),
      '2',
      '',
      ACCOUNT_A,
      ACCOUNT_B,
      ...['0', ia.holdId, String(ra.fencingToken), '1', '0', '0', 'A01', 'R', 'SEC-A'],
      ...['1', ia.holdId, String(ra.fencingToken), '1', '0', '1', 'A02', 'R', 'SEC-A'],
      ...['20', ib.holdId, String(rb.fencingToken), '2', '1', '0', 'B01', 'S', 'SEC-B'],
    ]);
    const slots = await Promise.all([...keys, seatKeys.sweep(e)].map((k) => clusterRedis.command(['CLUSTER', 'KEYSLOT', k], { key: k })));
    expect(new Set(slots.map(String)).size).toBe(1);
    // 임대도 클러스터에서 된다
    expect(await new RedisSweepLeases(clusterRedis).acquire(e, 'pod-a', 3000)).toBe(true);
  });

  test('ST26_③ 세대 키에 epoch 칸이 없으면(node만 있어도) 만료도 NOT_READY이고 아무것도 쓰지 않는다 [ASVS v5.0.0-16.3.4]', async () => {
    const store = new RedisSeatStore(redis);
    const e = newEvent();
    const keepUntilMs = Date.now() + 2 * DAY;
    await store.openSale({ eventId: e, seatCount: SEAT_COUNT, keepUntilMs });
    held(await store.hold(holdInput(e, ['A01'], { keepUntilMs })));
    await backdate(redis, e, ['A01']);
    const seats = expireSeatsOf(await store.dueExpiries({ eventId: e, nowMs: Date.now(), limit: 100 }));
    await redis.command(['HDEL', seatKeys.epoch(e), 'epoch'], { key: seatKeys.epoch(e) });
    const before = await rawState(redis, e);
    expect(await store.expire({ eventId: e, keepUntilMs, seats })).toEqual({ kind: 'NOT_READY' });
    expect(await rawState(redis, e)).toEqual(before);
  });

  test('ST4_ 만료 Lua: 키 전체의 형이 틀리면(expiry zset·stream·secver hash, M2에서 좌석 격리 밖) PEAKET_CORRUPT_KEY(그 키)이고 회차 키가 하나도 바뀌지 않는다 [ASVS v5.0.0-16.5.3]', async () => {
    const targets: [string, (e: string) => string, string[]][] = [
      ['expiry', (e) => seatKeys.expiry(e), ['SET', 'x']],
      ['stream', (e) => seatKeys.stream(e), ['SET', 'x']],
      ['secver', (e) => seatKeys.secver(e), ['SET', 'x']],
    ];
    for (const [what, keyOf, write] of targets) {
      const store = new RedisSeatStore(redis);
      const e = newEvent();
      const keepUntilMs = Date.now() + 2 * DAY;
      await store.openSale({ eventId: e, seatCount: SEAT_COUNT, keepUntilMs });
      held(await store.hold(holdInput(e, ['A01'], { accountId: ACCOUNT_A, keepUntilMs })));
      await backdate(redis, e, ['A01']);
      const seats = expireSeatsOf(await store.dueExpiries({ eventId: e, nowMs: Date.now(), limit: 100 }));
      const k = keyOf(e);
      await redis.command(['DEL', k], { key: k });
      await redis.command([write[0]!, k, ...write.slice(1)], { key: k });
      const before = await rawState(redis, e);
      const err = await bugOf(store.expire({ eventId: e, keepUntilMs, seats }), { wrongType: what });
      expect.soft({ what, msg: err.message }).toMatchObject({ what, msg: expect.stringContaining('PEAKET_CORRUPT_KEY') });
      expect.soft({ what, msg: err.message }).toMatchObject({ what, msg: expect.stringContaining(k) });
      expect.soft({ what, s: await rawState(redis, e) }).toEqual({ what, s: before });
    }
  });
});

describe('메모리 부족(maxmemory, noeviction, ADR-0109, seat-hold.md §9)', () => {
  test('NFR015_ 메모리가 차면 홀드·만료 Lua·임대가 SeatStoreUnavailable(reason oom)이고 아무것도 쓰지 않으며, 읽기(재생 읽기·1단계·회차 목록)는 된다 [ASVS v5.0.0-16.3.4] [ASVS v5.0.0-16.5.3]', async () => {
    const policy = await redis.command(['CONFIG', 'GET', 'maxmemory-policy'], { key: 'x' });
    expect(JSON.stringify(policy)).toContain('noeviction');
    const store = new RedisSeatStore(redis);
    const leases = new RedisSweepLeases(redis);
    const e = newEvent();
    const keepUntilMs = Date.now() + 2 * DAY;
    await store.openSale({ eventId: e, seatCount: SEAT_COUNT, keepUntilMs });
    const first = holdInput(e, ['A01'], { keepUntilMs });
    const r1 = held(await store.hold(first));
    await backdate(redis, e, ['A01']);
    const seats = expireSeatsOf(await store.dueExpiries({ eventId: e, nowMs: Date.now(), limit: 100 }));
    const before = await rawState(redis, e);
    await redis.command(['CONFIG', 'SET', 'maxmemory', '1'], { key: 'x' });
    try {
      for (const [what, p] of [
        ['hold', store.hold(holdInput(e, ['A02'], { keepUntilMs }))],
        ['expire', store.expire({ eventId: e, keepUntilMs, seats })],
        ['lease', leases.acquire(e, 'pod-a', 3000)],
      ] as const) {
        const x = await (p as Promise<unknown>).then(
          () => null,
          (err: unknown) => err,
        );
        expect({ what, unavailable: x instanceof SeatStoreUnavailable, reason: (x as SeatStoreUnavailable | null)?.reason }).toEqual({ what, unavailable: true, reason: 'oom' });
        expect({ what, oom: /^OOM\b/.test(String(((x as Error | null)?.cause as Error | undefined)?.message)) }).toEqual({ what, oom: true });
      }
      expect(await store.replay({ eventId: e, accountId: first.accountId, idempotencyKey: first.idempotencyKey, fingerprint: first.fingerprint })).toEqual({ kind: 'IDEM_REPLAY', ...r1 });
      expect((await store.dueExpiries({ eventId: e, nowMs: Date.now(), limit: 100 })).map((d) => d.index)).toEqual([idx('A01')]);
      expect(await store.saleEvents()).toContain(e);
    } finally {
      await redis.command(['CONFIG', 'SET', 'maxmemory', '0'], { key: 'x' });
    }
    expect(await rawState(redis, e)).toEqual(before);
    expect(await redis.command(['GET', seatKeys.sweep(e)], { key: seatKeys.sweep(e) })).toBeNull();
    // 메모리가 돌아오면 그대로 받는다
    expect(okOf(await store.expire({ eventId: e, keepUntilMs, seats })).released).toBe(1);
  });
});

describe('배치 규칙의 슬롯 계산(placement.ts slotOf, ADR-0176 결정 3)', () => {
  test('NFR021_ slotOf는 실제 Valkey CLUSTER KEYSLOT과 같다(해시 태그 경계·회차 키·큰 회차 태그 모양·여러 글)', async () => {
    const keys = ['123456789', 'foo', '', 'x', '{user1000}.following', 'foo{}{bar}', 'foo{{bar}}zap', '{}', '{{}}', 'a{b', '}{x}', '{a}{b}', '{한}', 'event:ev-1:7', '{event:ev-1:7}:bitmap'];
    const e = newEvent();
    keys.push(
      seatKeys.bitmap(e),
      seatKeys.hold(e, 3),
      seatKeys.quota(e, ACCOUNT_A),
      seatKeys.rel(e, ACCOUNT_A),
      seatKeys.idem(e, ACCOUNT_A, '9a1f0c3e-4b2d-4c8e-9f00-000000000001'),
      seatKeys.sweep(e),
      seatKeys.section(e, '2'),
      seatKeys.ctlEvents(),
    );
    for (let i = 0; i < 100; i++) keys.push(`k-${i}-${(i * 104_729).toString(36)}{t${i % 7}}`);
    for (const k of keys.filter((x) => x !== '')) {
      const real = Number(await clusterRedis.command(['CLUSTER', 'KEYSLOT', k], { key: 'x' }));
      expect({ k, slot: slotOf(k) }).toEqual({ k, slot: real });
    }
  });
});

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

  /** 그 회차 슬롯의 키 전부(형·만료 시각·값, 세대 키의 chk·bumps 칸까지)와 받은 샤드 Pub/Sub 수. 형이 틀린 키도 읽는다 */
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

describe('새 맥락 리뷰 결함의 재현(추천 적용 2026-11-04, PRF-135 L1·L2·M3·M4)', () => {
  test('ST4_ 만료 Lua는 bitmap 키의 형(string)도 쓰기 전에 본다: 형이 틀리면 PEAKET_CORRUPT_KEY(bitmap 키)이고 고아 ZREM을 포함해 아무것도 쓰지 않는다(L1) [ASVS v5.0.0-16.5.3]', async () => {
    for (const write of [
      ['HSET', 'f', '1'],
      ['ZADD', '1', 'm'],
    ]) {
      const store = new RedisSeatStore(redis);
      const e = newEvent();
      const keepUntilMs = Date.now() + 2 * DAY;
      await store.openSale({ eventId: e, seatCount: SEAT_COUNT, keepUntilMs });
      held(await store.hold(holdInput(e, ['A01'], { keepUntilMs })));
      await backdate(redis, e, ['A01']);
      // 고아 멤버(홀드 Hash 없음): 형 검사보다 먼저 지워지면 안 된다
      await redis.command(['ZADD', seatKeys.expiry(e), String(Date.now() - 60_000), '36'], { key: seatKeys.expiry(e) });
      const seats = expireSeatsOf(await store.dueExpiries({ eventId: e, nowMs: Date.now(), limit: 100 }));
      expect(seats.map((s) => s.index)).toEqual([idx('A01'), 36]);
      const k = seatKeys.bitmap(e);
      await redis.command(['DEL', k], { key: k });
      await redis.command([write[0]!, k, ...write.slice(1)], { key: k });
      const before = await rawState(redis, e);
      const err = await bugOf(store.expire({ eventId: e, keepUntilMs, seats }), { bitmap: write[0] });
      expect.soft({ write: write[0], msg: err.message }).toMatchObject({ write: write[0], msg: expect.stringContaining('PEAKET_CORRUPT_KEY') });
      expect.soft({ write: write[0], msg: err.message }).toMatchObject({ write: write[0], msg: expect.stringContaining(k) });
      expect.soft({ write: write[0], s: await rawState(redis, e) }).toEqual({ write: write[0], s: before });
    }
  });

  test('ST4_ 만료 Lua: 좌석·계정 한 몫의 키 형이 틀리면(hold가 Hash 아님·quota가 문자열 아님·rel이 정렬 집합 아님) 묶음 전체 오류가 아니라 그 좌석·그 계정 좌석만 건너뛰고(corrupt) 다른 좌석은 푼다. 형이 틀린 키와 건너뛴 좌석 몫은 그대로다(M2) [ASVS v5.0.0-16.5.3]', async () => {
    const store = new RedisSeatStore(redis);
    const e = newEvent();
    const keepUntilMs = Date.now() + 2 * DAY;
    await store.openSale({ eventId: e, seatCount: SEAT_COUNT, keepUntilMs });
    held(await store.hold(holdInput(e, ['A01'], { accountId: ACCOUNT_A, keepUntilMs })));
    held(await store.hold(holdInput(e, ['A02'], { accountId: ACCOUNT_B, keepUntilMs })));
    held(await store.hold(holdInput(e, ['A03'], { accountId: ACCOUNT_C, keepUntilMs })));
    const rd = held(await store.hold(holdInput(e, ['A04'], { accountId: ACCOUNT_D, keepUntilMs })));
    await backdate(redis, e, ['A01', 'A02', 'A03', 'A04']);
    const seats = expireSeatsOf(await store.dueExpiries({ eventId: e, nowMs: Date.now(), limit: 100 }));
    expect(seats.map((s) => s.index)).toEqual(['A01', 'A02', 'A03', 'A04'].map(idx));
    // 1단계 뒤에 망가뜨린다: A01의 홀드 키는 문자열, B의 보유 수 키는 Hash, C의 방금 놓은 좌석 키는 문자열
    const wrong: [string, string[]][] = [
      [seatKeys.hold(e, idx('A01')), ['SET', 'x']],
      [seatKeys.quota(e, ACCOUNT_B), ['HSET', 'f', '1']],
      [seatKeys.rel(e, ACCOUNT_C), ['SET', 'x']],
    ];
    for (const [k, write] of wrong) {
      await redis.command(['DEL', k], { key: k });
      await redis.command([write[0]!, k, ...write.slice(1)], { key: k });
    }
    const before = await rawState(redis, e);
    const out = await store.expire({ eventId: e, keepUntilMs, seats }).then(
      (r) => okOf(r),
      (err: unknown) => `던졌다: ${String(err)}`,
    );
    if (typeof out === 'string') {
      expect(out).toBe('OK');
      return;
    }
    expect({ released: out.released, corrupt: (out as { corrupt?: number }).corrupt, skipped: out.skipped, orphans: out.orphans, expired: out.expired }).toEqual({
      released: 1,
      corrupt: 3,
      skipped: 0,
      orphans: 0,
      expired: [{ index: idx('A04'), fencingToken: rd.fencingToken }],
    });
    const after = await rawState(redis, e);
    // 형이 틀린 키·건너뛴 좌석의 홀드 Hash·그 계정의 보유 수는 그대로다
    for (const k of [...wrong.map(([key]) => key), seatKeys.hold(e, idx('A02')), seatKeys.hold(e, idx('A03')), seatKeys.quota(e, ACCOUNT_A), seatKeys.quota(e, ACCOUNT_C)]) {
      expect.soft({ k, v: after[k] }).toEqual({ k, v: before[k] });
    }
    const bit = async (id: string) => Number(await redis.command(['GETBIT', seatKeys.bitmap(e), String(idx(id))], { key: seatKeys.bitmap(e) }));
    expect([await bit('A01'), await bit('A02'), await bit('A03'), await bit('A04')]).toEqual([1, 1, 1, 0]);
    // 건너뛴 좌석은 만료 인덱스에 남고(다음 틱에 다시 본다) 푼 좌석만 빠진다
    const left = scores(await redis.command(['ZRANGE', seatKeys.expiry(e), '0', '-1', 'WITHSCORES'], { key: seatKeys.expiry(e) }));
    expect(Object.keys(left).sort()).toEqual(['A01', 'A02', 'A03'].map((id) => String(idx(id))).sort());
    expect(after[seatKeys.quota(e, ACCOUNT_D)]).toBeUndefined();
  });

  test('NFR025_ 임대 잡기는 한 번에 끝난다: 내 임대를 읽은 뒤 키가 사라지고 다른 파드가 잡아도 남의 임대를 늘리지 않는다(L2, 호출 한 번) [ASVS v5.0.0-15.4.2]', async () => {
    const e = newEvent();
    const key = seatKeys.sweep(e);
    await redis.command(['SET', key, 'pod-a', 'PX', '3000'], { key });
    let calls = 0;
    let interfered = false;
    // GET 답을 돌려준 바로 뒤에 다른 파드가 끼어든다(내 임대가 사라지고 pod-b가 1초짜리로 잡음)
    const racing: HotRedis = {
      command: async (args, o) => {
        calls += 1;
        const r = await redis.command(args, o);
        if (!interfered && args[0] === 'GET' && args[1] === key) {
          interfered = true;
          await redis.command(['DEL', key], { key });
          await redis.command(['SET', key, 'pod-b', 'PX', '1000'], { key });
        }
        return r;
      },
      evalScript: (s, k, a, o) => {
        calls += 1;
        return redis.evalScript(s, k, a, o);
      },
      sendCommand: (a) => redis.sendCommand(a),
      close: async () => {},
    };
    const ok = await new RedisSweepLeases(racing).acquire(e, 'pod-a', 3000);
    const owner = String(await redis.command(['GET', key], { key }));
    const ttl = Number(await redis.command(['PTTL', key], { key }));
    // 남의 임대를 늘렸다면: 값은 pod-b인데 수명이 1초보다 길고, 잡았다고 답했다
    expect({ ok, owner, extendedOthers: owner === 'pod-b' && ttl > 1000 }).toEqual(owner === 'pod-b' ? { ok: false, owner, extendedOthers: false } : { ok: true, owner: 'pod-a', extendedOthers: false });
    expect(calls).toBe(1);
  });

  test('FR010_FR042_ 큰 색인의 비트 차례: 좌석 수 50,000 회차의 색인 0·7·8·49,999를 홀드 Lua가 켜고 만료 Lua가 끄며, 바이트·GETBIT·BITFIELD로 본 비트 차례가 SETBIT과 같다(M3·M4)', async () => {
    const store = new RedisSeatStore(redis);
    const e = newEvent();
    const keepUntilMs = Date.now() + 2 * DAY;
    await store.openSale({ eventId: e, seatCount: 50_000, keepUntilMs });
    const indexes = [0, 7, 8, 49_999];
    const seats = indexes.map((i) => ({ seatId: `S${String(i).padStart(5, '0')}`, index: i, sectionId: 'SEC-0', sectionIndex: 0, seatOffset: i, tierId: 'R' }));
    const r = held(
      await store.hold({
        eventId: e,
        accountId: ACCOUNT_A,
        purchaseSessionId: 'ps-big',
        holdId: uuidv7(systemClock),
        idempotencyKey: randomUUID(),
        fingerprint: fingerprintOf(seats.map((s) => s.seatId)),
        seats,
        limit: 4,
        keepUntilMs,
      }),
    );
    const k = seatKeys.bitmap(e);
    const ref = `s:{event:${e}}:ref-bits`;
    for (const i of indexes) await redis.command(['SETBIT', ref, String(i), '1'], { key: ref });
    const bytes = async (key: string) => Buffer.from((await redis.command(['GET', key], { key, binary: true })) as Uint8Array);
    const held1 = await bytes(k);
    expect(held1.length).toBe(6_250);
    expect([held1[0], held1[1], held1[6_249]]).toEqual([0x81, 0x80, 0x01]);
    expect(held1.equals(await bytes(ref))).toBe(true);
    for (const i of indexes) expect({ i, bit: Number(await redis.command(['GETBIT', k, String(i)], { key: k })) }).toEqual({ i, bit: 1 });
    expect(Number(await redis.command(['GETBIT', k, '49998'], { key: k }))).toBe(0);
    expect(((await redis.command(['BITFIELD', k, 'GET', 'u1', '#49999', 'GET', 'u1', '#49998', 'GET', 'u8', '#0'], { key: k })) as unknown[]).map(Number)).toEqual([1, 0, 0x81]);
    expect(Number(await redis.command(['BITCOUNT', k], { key: k }))).toBe(4);
    // 만료 Lua가 같은 자리를 끈다
    const at = Date.now() - 60_000;
    for (const i of indexes) {
      await redis.command(['HSET', seatKeys.hold(e, i), 'exp', String(at)], { key: seatKeys.hold(e, i) });
      await redis.command(['ZADD', seatKeys.expiry(e), String(at), String(i)], { key: seatKeys.expiry(e) });
    }
    const d = await store.dueExpiries({ eventId: e, nowMs: Date.now(), limit: 100 });
    const out = okOf(await store.expire({ eventId: e, keepUntilMs, seats: d.map((x) => ({ index: x.index, expected: x.hold, seat: seats.find((s) => s.index === x.index)! })) }));
    expect(out.released).toBe(4);
    expect(out.expired.map((x) => x.fencingToken)).toEqual([r.fencingToken, r.fencingToken, r.fencingToken, r.fencingToken]);
    const freed = await bytes(k);
    expect(freed.length).toBe(6_250);
    expect(Number(await redis.command(['BITCOUNT', k], { key: k }))).toBe(0);
  });
});

describe('최종 검토 결함의 재현(추천 적용 2026-11-04, PRF-135 A2·B1)', () => {
  test('ST4_ST5_ 1단계 읽기 전에 홀드 키의 형이 틀리거나(문자열) fence가 어긋나도(abc·2^53 − 1 초과) dueExpiries는 던지지 않고 그 좌석만 corrupt이며, 반복(tick)은 나머지를 풀고 회차가 BACKOFF에 들어가지 않는다(B1·A2) [ASVS v5.0.0-16.5.3]', async () => {
    const store = new RedisSeatStore(redis);
    const e = newEvent();
    const keepUntilMs = Date.now() + 2 * DAY;
    await store.openSale({ eventId: e, seatCount: SEAT_COUNT, keepUntilMs });
    // A01(A)·A02(B)·A03(C)·A04(D)·A05(A, 보유 2): 앞의 셋을 망가뜨린다
    const owners = [ACCOUNT_A, ACCOUNT_B, ACCOUNT_C, ACCOUNT_D, ACCOUNT_A];
    const ids = ['A01', 'A02', 'A03', 'A04', 'A05'];
    const made: Record<string, { holdId: string; fencingToken: number }> = {};
    for (const [k, id] of ids.entries()) {
      const i = holdInput(e, [id], { accountId: owners[k]!, keepUntilMs });
      made[id] = { holdId: i.holdId, fencingToken: held(await store.hold(i)).fencingToken };
    }
    const at = await backdate(redis, e, ids);
    // 1단계 읽기 '전에' 망가뜨린다(이미 있는 시험은 읽은 뒤에 망가뜨린다)
    const key1 = seatKeys.hold(e, idx('A01'));
    await redis.command(['DEL', key1], { key: key1 });
    await redis.command(['SET', key1, 'x'], { key: key1 });
    await redis.command(['HSET', seatKeys.hold(e, idx('A02')), 'fence', 'abc'], { key: seatKeys.hold(e, idx('A02')) });
    await redis.command(['HSET', seatKeys.hold(e, idx('A03')), 'fence', '9007199254740992'], { key: seatKeys.hold(e, idx('A03')) });

    const due = await store.dueExpiries({ eventId: e, nowMs: Date.now(), limit: 100 }).then(
      (d) => d,
      (err: unknown) => `던졌다: ${String(err)}`,
    );
    const normal = (id: string, owner: string) => ({ index: idx(id), expiresAtMs: at, hold: { holdId: made[id]!.holdId, fencingToken: String(made[id]!.fencingToken), owner } });
    expect(due).toEqual([
      { index: idx('A01'), expiresAtMs: at, hold: null, corrupt: true },
      { index: idx('A02'), expiresAtMs: at, hold: null, corrupt: true },
      { index: idx('A03'), expiresAtMs: at, hold: null, corrupt: true },
      normal('A04', ACCOUNT_D),
      normal('A05', ACCOUNT_A),
    ]);

    // 반복: 만료 반복을 끝까지 돌린다(회차 목록 → 임대 → 1단계 → 만료 Lua)
    const clock = fakeClock({ now: Date.now() });
    const seatMap = new MemorySeatMap();
    seatMap.put({ eventId: e, layoutVersion: 'v1', seatCount: SEAT_COUNT, perAccountLimit: 4, saleEndsAtMs: Date.now() + DAY }, SEAT_DEFS);
    const luaErrors: [string, string][] = [];
    const sweeper = new ExpirySweeper({ expiries: store, seatMap, leases: new RedisSweepLeases(redis), clock, podId: 'pod-b1', signals: { luaError: (s, c) => void luaErrors.push([s, c]) } });
    type Tick = Awaited<ReturnType<ExpirySweeper['tick']>>;
    const mine = (t: Tick) => t.events.find((x) => x.eventId === e);
    const t1 = await sweeper.tick();
    expect(mine(t1)).toMatchObject({ outcome: 'DRAINED', released: 2, corrupt: 3 });
    const bit = async (id: string) => Number(await redis.command(['GETBIT', seatKeys.bitmap(e), String(idx(id))], { key: seatKeys.bitmap(e) }));
    expect(await Promise.all(ids.map(bit))).toEqual([1, 1, 1, 0, 0]);
    // 망가진 키는 그대로 두고(다음 틱에 다시 본다) 정상 좌석의 보유 수만 내려갔다
    expect(String(await redis.command(['TYPE', key1], { key: key1 }))).toBe('string');
    expect(String(await redis.command(['HGET', seatKeys.hold(e, idx('A02')), 'fence'], { key: seatKeys.hold(e, idx('A02')) }))).toBe('abc');
    expect(String(await redis.command(['HGET', seatKeys.hold(e, idx('A03')), 'fence'], { key: seatKeys.hold(e, idx('A03')) }))).toBe('9007199254740992');
    const q = async (a: string) => {
      const v = await redis.command(['GET', seatKeys.quota(e, a)], { key: seatKeys.quota(e, a) });
      return v === null || v === undefined ? null : Number(v);
    };
    expect([await q(ACCOUNT_A), await q(ACCOUNT_B), await q(ACCOUNT_C), await q(ACCOUNT_D)]).toEqual([1, 1, 1, null]);
    expect(luaErrors).toEqual([['expire', 'CORRUPT_KEY']]);

    // 다음 틱: 남은 것은 망가진 좌석뿐이라 회차는 BACKOFF(쉬는 중)가 아니라 보낼 것 없음(NO_PROGRESS)이다
    clock.advance(1_000);
    const t2 = await sweeper.tick();
    expect(mine(t2)).toMatchObject({ outcome: 'NO_PROGRESS', corrupt: 3 });
  });

  test('ST4_ 만료 인덱스에 앞 0이 붙은 멤버 \'007\'이 정상 멤버 \'7\'과 함께 있으면 색인 겹침 RangeError가 아니라 PEAKET_CORRUPT_KEY(expiry 키)로 던지고, 반복(tick)은 그 회차를 ERROR로 센다(최종 검토 낮음 1) [ASVS v5.0.0-16.5.3]', async () => {
    const store = new RedisSeatStore(redis);
    const e = newEvent();
    const keepUntilMs = Date.now() + 2 * DAY;
    await store.openSale({ eventId: e, seatCount: SEAT_COUNT, keepUntilMs });
    const expiry = seatKeys.expiry(e);
    const past = Date.now() - 10_000;
    for (const member of ['007', '7']) await redis.command(['ZADD', expiry, String(past), member], { key: expiry });

    const err = await store.dueExpiries({ eventId: e, nowMs: Date.now(), limit: 100 }).then(
      () => undefined,
      (x: unknown) => x,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(RangeError);
    expect((err as Error).message).toBe(`PEAKET_CORRUPT_KEY ${expiry}`);

    const seatMap = new MemorySeatMap();
    seatMap.put({ eventId: e, layoutVersion: 'v1', seatCount: SEAT_COUNT, perAccountLimit: 4, saleEndsAtMs: Date.now() + DAY }, SEAT_DEFS);
    const sweeper = new ExpirySweeper({ expiries: store, seatMap, leases: new RedisSweepLeases(redis), clock: fakeClock({ now: Date.now() }), podId: 'pod-low1' });
    const t = await sweeper.tick();
    expect(t.events.find((x) => x.eventId === e)).toMatchObject({ outcome: 'ERROR' });
    // 두 멤버 모두 그대로다(건드리지 않았다)
    expect(Number(await redis.command(['ZCARD', expiry], { key: expiry }))).toBe(2);
  });
});
