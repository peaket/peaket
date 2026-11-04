// 좌석 스냅샷 읽기를 실제 Valkey 8.1 Lua로 돈다(test/seat-snapshot-cases.ts의 사례를 메모리 저장소와 똑같이, 거기에 Lua의 모양·망가진 키·메모리 부족을 더한다).
// docs/features/seat-hold.md §2 '스냅샷 읽기 Lua', docs/data.md §3 s:{event:E}:bitmap·epoch·secver, src/modules/inventory/adapters/snapshot-lua.ts, BUILD_ORDER PRF-137.
// 메모리 부족 시험은 maxmemory를 바꾸므로 다른 시험과 나눠 쓰지 않는 별도 컨테이너에서 한다.
import 'reflect-metadata';
import { createHotRedis, type HotRedis, type RedisScript, systemClock } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { RedisSeatStore, SNAPSHOT_LUA, SeatStoreUnavailable, seatKeys, seatLuaErrorOf } from '../src/modules/inventory/index.js';
import { ACCOUNT_A, DAY, expectBug, holdInput, newEvent, SEAT_COUNT } from '../test/hold-cases.js';
import { hexOf, okOf, type SnapshotHarness, seatSnapshotCases } from '../test/seat-snapshot-cases.js';
import { startValkey, type ValkeyContainer } from './valkey.js';

let valkey: ValkeyContainer | undefined;
let cluster: ValkeyContainer | undefined;
let redis: HotRedis;
let clusterRedis: HotRedis;

beforeAll(async () => {
  const [a, b] = await Promise.allSettled([startValkey(), startValkey({ cluster: true, configEpoch: 3 })]);
  if (a.status === 'fulfilled') valkey = a.value;
  if (b.status === 'fulfilled') cluster = b.value;
  if (!valkey || !cluster) throw (a.status === 'rejected' ? a.reason : (b as PromiseRejectedResult).reason) as Error;
  [redis, clusterRedis] = await Promise.all([createHotRedis({ url: valkey.url }), createHotRedis({ url: cluster.url })]);
});

afterAll(async () => {
  await Promise.all([redis?.close(), clusterRedis?.close()]);
  valkey?.stop();
  cluster?.stop();
});

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

/** 그 회차 슬롯의 키 전부(형·만료 시각·값). 형이 틀린 키도 읽는다 */
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

/** 스냅샷 읽기 사례용 Valkey 도구 */
function harness(r: HotRedis = redis): SnapshotHarness {
  const cmd = (key: string, args: string[]) => r.command(args, { key });
  return {
    store: new RedisSeatStore(r),
    clock: systemClock,
    setBitmapBytes: async (e, bytes) => {
      const key = seatKeys.bitmap(e);
      await cmd(key, ['DEL', key]);
      for (let k = 0; k < bytes.length * 8; k++) if ((bytes[k >> 3]! & (0x80 >> (k & 7))) !== 0) await cmd(key, ['SETBIT', key, String(k), '1']);
      // 길이를 바이트 수 그대로 맞춘다(끝 비트가 0이어도)
      if (bytes.length > 0) await cmd(key, ['SETBIT', key, String(bytes.length * 8 - 1), bytes[bytes.length - 1]! & 1 ? '1' : '0']);
    },
    dropBitmap: async (e) => void (await cmd(seatKeys.bitmap(e), ['DEL', seatKeys.bitmap(e)])),
    dropEpoch: async (e) => void (await cmd(seatKeys.epoch(e), ['DEL', seatKeys.epoch(e)])),
    setSecver: async (e, s, v) => void (await cmd(seatKeys.secver(e), ['HSET', seatKeys.secver(e), String(s), String(v)])),
    dropSecver: async (e) => void (await cmd(seatKeys.secver(e), ['DEL', seatKeys.secver(e)])),
    bit: async (e, i) => Number(await cmd(seatKeys.bitmap(e), ['GETBIT', seatKeys.bitmap(e), String(i)])),
    secver: async (e) => Object.fromEntries(Object.entries(hash(await cmd(seatKeys.secver(e), ['HGETALL', seatKeys.secver(e)]))).map(([k, v]) => [k, Number(v)])),
    dump: (e) => rawState(r, e),
  };
}

seatSnapshotCases('Valkey Lua', async () => harness());

/** evalScript·command를 부를 때마다 적는다 */
function recording(inner: HotRedis) {
  const evals: { script: RedisScript; keys: string[]; args: string[]; options: unknown }[] = [];
  const commands: string[][] = [];
  const redis: HotRedis = {
    command: (a, o) => {
      commands.push([...a]);
      return inner.command(a, o);
    },
    sendCommand: (a) => inner.sendCommand(a),
    evalScript: (s, k, a, o) => {
      evals.push({ script: s, keys: [...k], args: [...a], options: o });
      return inner.evalScript(s, k, a, o);
    },
    close: () => inner.close(),
  };
  return { redis, evals, commands };
}

async function opened(r: HotRedis, seatCount = SEAT_COUNT) {
  const store = new RedisSeatStore(r);
  const eventId = newEvent();
  const keepUntilMs = Date.now() + 2 * DAY;
  const o = await store.openSale({ eventId, seatCount, keepUntilMs });
  return { store, eventId, keepUntilMs, seatEpoch: o.seatEpoch };
}

describe('스냅샷 읽기 Lua의 모양(seat-hold.md §2 스냅샷 읽기 Lua)', () => {
  test('FR009_ST27_ 스냅샷 읽기 Lua의 첫 줄은 정확히 #!lua flags=no-writes다(쓰기 없는 스크립트라 메모리 부족에도 거절되지 않는다)', () => {
    expect(SNAPSHOT_LUA.split('\n')[0]).toBe('#!lua flags=no-writes');
  });

  test('FR009_ST27_ 읽기는 Lua 한 번뿐이다(다른 명령 없음): KEYS는 비트맵·세대 키·구역 일련번호 차례, ARGV는 첫 바이트·끝 바이트(포함)·구역 색인들이며 모두 한 해시 슬롯이다(CLUSTER KEYSLOT)', async () => {
    const rec = recording(clusterRedis);
    const { store, eventId } = await opened(rec.redis);
    rec.evals.splice(0);
    rec.commands.splice(0);
    okOf(await store.read({ eventId, firstBit: 0, bitCount: SEAT_COUNT, sectionIndexes: [0, 1] }));
    okOf(await store.read({ eventId, firstBit: 9, bitCount: 20, sectionIndexes: [300] }));
    expect(rec.commands).toEqual([]);
    expect(rec.evals).toHaveLength(2);
    for (const c of rec.evals) {
      expect(c.script.source).toBe(SNAPSHOT_LUA);
      expect(c.keys).toEqual([seatKeys.bitmap(eventId), seatKeys.epoch(eventId), seatKeys.secver(eventId)]);
    }
    // 40비트 = 바이트 0 ~ 4, 비트 9 ~ 28 = 바이트 1 ~ 3
    expect(rec.evals[0]!.args).toEqual(['0', '4', '0', '1']);
    expect(rec.evals[1]!.args).toEqual(['1', '3', '300']);
    const slots = await Promise.all(rec.evals[0]!.keys.map((k) => clusterRedis.command(['CLUSTER', 'KEYSLOT', k], { key: k })));
    expect(new Set(slots.map(String)).size).toBe(1);
  });

  test('FR009_ST27_ 노드 하나짜리 클러스터 모드에서도 돈다: 홀드 뒤 읽으면 비트·구역 일련번호·세대가 맞다', async () => {
    const h = harness(clusterRedis);
    const { store, eventId, keepUntilMs, seatEpoch } = await opened(clusterRedis);
    expect((await store.hold(holdInput(eventId, ['A01', 'B01'], { accountId: ACCOUNT_A, keepUntilMs }))).kind).toBe('OK');
    const r = okOf(await store.read({ eventId, firstBit: 0, bitCount: SEAT_COUNT, sectionIndexes: [0, 1] }));
    expect(hexOf(r.bytes)).toBe('8000080000');
    expect(r.sectionVersions).toEqual([1, 1]);
    expect(r.seatEpoch).toBe(seatEpoch);
    expect(await h.secver(eventId)).toEqual({ '0': 1, '1': 1 });
  });

  test('FR009_ST27_ EVAL_RO로도 돈다(no-writes 표시가 맞다): 답은 [OK, 세대, 비트맵 바이트들, 구역 일련번호…]이고 세대 키가 없으면 [NOT_READY]다', async () => {
    const { eventId } = await opened(redis);
    const keys = [seatKeys.bitmap(eventId), seatKeys.epoch(eventId), seatKeys.secver(eventId)];
    const run = async () => (await redis.command(['EVAL_RO', SNAPSHOT_LUA, '3', ...keys, '0', '4', '0', '1'], { key: keys[0]! })) as unknown[];
    const ok = await run();
    expect(String(ok[0])).toBe('OK');
    expect(Number(ok[1])).toBeGreaterThan(0);
    expect(ok).toHaveLength(5);
    expect(String(ok[3])).toBe('0');
    expect(String(ok[4])).toBe('0');
    await redis.command(['DEL', keys[1]!], { key: keys[1]! });
    const notReady = await run();
    expect(notReady.map(String)).toEqual(['NOT_READY']);
  });

  test('FR009_ST27_ 인자 오류로 거절한 읽기는 좌석 Redis를 부르지 않는다(RangeError는 호출 전)', async () => {
    const rec = recording(redis);
    const { store, eventId } = await opened(rec.redis);
    rec.evals.splice(0);
    rec.commands.splice(0);
    for (const bad of [{ eventId: 'a}b' }, { bitCount: 0 }, { firstBit: -1 }, { sectionIndexes: [] }, { sectionIndexes: [1, 1] }, { sectionIndexes: [65536] }]) {
      await expect(store.read({ eventId, firstBit: 0, bitCount: 8, sectionIndexes: [0], ...bad }), JSON.stringify(bad)).rejects.toBeInstanceOf(RangeError);
    }
    expect(rec.evals).toHaveLength(0);
    expect(rec.commands).toHaveLength(0);
  });

  test('FR009_NFR012_ 5만 석 회차: 전체 읽기는 6,250바이트이고 마지막 좌석(색인 49999)의 비트가 마지막 바이트 안에 있다', async () => {
    const { store, eventId } = await opened(redis, 50_000);
    await redis.command(['SETBIT', seatKeys.bitmap(eventId), '49999', '1'], { key: seatKeys.bitmap(eventId) });
    await redis.command(['SETBIT', seatKeys.bitmap(eventId), '0', '1'], { key: seatKeys.bitmap(eventId) });
    const r = okOf(await store.read({ eventId, firstBit: 0, bitCount: 50_000, sectionIndexes: [0] }));
    expect(r.bytes.length).toBe(6250);
    expect(r.bytes[0]).toBe(0x80);
    // 49999 = 6249 × 8 + 7 → 마지막 바이트의 맨 아래 비트(0x01)
    expect(r.bytes[6249]).toBe(0x01);
    const tail = okOf(await store.read({ eventId, firstBit: 49_990, bitCount: 10, sectionIndexes: [0] }));
    // 49990 = 6248 × 8 + 6 → 바이트 6248과 6249 두 바이트
    expect(hexOf(tail.bytes)).toBe('0001');
  });
});

describe('망가진 키와 키 형(PEAKET_CORRUPT_KEY, WRONGTYPE)', () => {
  const setHash = (key: string, field: string, value: string) => redis.command(['HSET', key, field, value], { key });

  test('ST4_ASVS16.5.3_ 구역 일련번호 칸이 표준 10진 정수가 아니거나 2^32 이상이면 PEAKET_CORRUPT_KEY(일시 장애가 아닌 오류, 지표 갈래 CORRUPT_KEY)이고 아무것도 쓰지 않는다 [ASVS v5.0.0-16.5.3]', async () => {
    const { store, eventId } = await opened(redis);
    const bads = ['007', '-1', '1.5', ' 5', '5 ', '', 'abc', '1e3', '+5', '0x10', '4294967296', '99999999999999999999', '18446744073709551616'];
    for (const bad of bads) {
      await setHash(seatKeys.secver(eventId), '3', bad);
      const before = await rawState(redis, eventId);
      const err = await store.read({ eventId, firstBit: 0, bitCount: 8, sectionIndexes: [0, 3] }).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect({ bad, isError: err instanceof Error, unavailable: err instanceof SeatStoreUnavailable }).toEqual({ bad, isError: true, unavailable: false });
      expect({ bad, msg: (err as Error).message }).toMatchObject({ bad, msg: expect.stringContaining('PEAKET_CORRUPT_KEY') });
      expect.soft({ bad, info: seatLuaErrorOf(err) }).toMatchObject({ bad, info: { code: 'CORRUPT_KEY', keyKind: 'secver' } });
      expect(await rawState(redis, eventId)).toEqual(before);
    }
  });

  test('FR009_ 표준 10진 정수의 끝값은 받는다: 0 · 1 · 4294967295(2^32 − 1)', async () => {
    const { store, eventId } = await opened(redis);
    for (const [section, text] of [[0, '0'], [1, '1'], [2, '4294967295']] as const) await setHash(seatKeys.secver(eventId), String(section), text);
    const r = okOf(await store.read({ eventId, firstBit: 0, bitCount: 8, sectionIndexes: [0, 1, 2] }));
    expect(r.sectionVersions).toEqual([0, 1, 4294967295]);
  });

  test('FR009_ 읽지 않는 구역 칸이 망가져 있어도 요청한 구역만 읽는다(그 구역 칸만 본다)', async () => {
    const { store, eventId } = await opened(redis);
    await setHash(seatKeys.secver(eventId), '5', 'garbage');
    await setHash(seatKeys.secver(eventId), '0', '8');
    expect(okOf(await store.read({ eventId, firstBit: 0, bitCount: 8, sectionIndexes: [0, 1] })).sectionVersions).toEqual([8, 0]);
    await expect(store.read({ eventId, firstBit: 0, bitCount: 8, sectionIndexes: [5] })).rejects.toThrow(/PEAKET_CORRUPT_KEY/);
  });

  test('ST26_ASVS16.5.3_ 세대가 0 ~ 2^32 − 1의 표준 10진 정수가 아니면(2^32·음수·소수·앞 0·글자·빈 글) 같은 PEAKET_CORRUPT_KEY다(일시 장애가 아님). 끝값 0과 4294967295는 받는다 [ASVS v5.0.0-16.5.3]', async () => {
    const { store, eventId } = await opened(redis);
    const epochOf = async () => okOf(await store.read({ eventId, firstBit: 0, bitCount: 8, sectionIndexes: [0] })).seatEpoch;
    for (const [text, value] of [['0', 0], ['4294967295', 4294967295], ['1762226400', 1762226400]] as const) {
      await setHash(seatKeys.epoch(eventId), 'epoch', text);
      expect(await epochOf()).toBe(value);
    }
    for (const bad of ['4294967296', '99999999999999999999', '-1', '1.5', '007', 'abc', ' 5', '1e3', '+5']) {
      await setHash(seatKeys.epoch(eventId), 'epoch', bad);
      const before = await rawState(redis, eventId);
      const err = await store.read({ eventId, firstBit: 0, bitCount: 8, sectionIndexes: [0] }).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect({ bad, isError: err instanceof Error, unavailable: err instanceof SeatStoreUnavailable }).toEqual({ bad, isError: true, unavailable: false });
      expect.soft({ bad, info: seatLuaErrorOf(err) }).toMatchObject({ bad, info: { code: 'CORRUPT_KEY', keyKind: 'epoch' } });
      expect(await rawState(redis, eventId)).toEqual(before);
    }
  });

  test('ST4_ 키 형이 틀리면(비트맵이 해시, 세대 키·구역 일련번호가 문자열) 일시 장애(SeatStoreUnavailable)가 아닌 오류(WRONGTYPE)이고 아무것도 쓰지 않는다', async () => {
    const targets: [string, (e: string) => string, string[]][] = [
      ['bitmap', (e) => seatKeys.bitmap(e), ['HSET', 'x', 'y']],
      ['epoch', (e) => seatKeys.epoch(e), ['SET', 'x']],
      ['secver', (e) => seatKeys.secver(e), ['SET', 'x']],
    ];
    for (const [what, keyOf, write] of targets) {
      const { store, eventId } = await opened(redis);
      const k = keyOf(eventId);
      await redis.command(['DEL', k], { key: k });
      await redis.command([write[0]!, k, ...write.slice(1)], { key: k });
      const before = await rawState(redis, eventId);
      await expectBug(store.read({ eventId, firstBit: 0, bitCount: 8, sectionIndexes: [0] }), { wrongType: what });
      const err = await store.read({ eventId, firstBit: 0, bitCount: 8, sectionIndexes: [0] }).then(
        () => undefined,
        (e: unknown) => e,
      );
      // 세대 키가 틀리면 읽지 못했으니 결과가 없고, 틀린 키는 읽다가 WRONGTYPE이 나야 한다(조용히 0으로 채우지 않는다)
      expect.soft({ what, isError: err instanceof Error }).toEqual({ what, isError: true });
      expect.soft({ what, msg: String((err as Error | undefined)?.message) }).toMatchObject({ what, msg: expect.stringMatching(/WRONGTYPE|PEAKET_CORRUPT_KEY/) });
      expect(await rawState(redis, eventId)).toEqual(before);
    }
  });
});

describe('메모리 부족(maxmemory, noeviction, ADR-0109, seat-hold.md §9)', () => {
  test('NFR015_ST27_ maxmemory를 넘겨 홀드 Lua가 OOM으로 거절되는 상태에서도 스냅샷 읽기는 거절되지 않고 같은 값을 준다(스크립트가 이미 올라 있든 아니든). 끝나면 maxmemory를 되돌리고 컨테이너를 지운다 [ASVS v5.0.0-16.3.4]', async () => {
    // 이 시험만 쓰는 별도 컨테이너: maxmemory를 바꾸므로 다른 시험과 나눠 쓰지 않는다
    const own = await startValkey();
    const r = await createHotRedis({ url: own.url });
    try {
      const policy = await r.command(['CONFIG', 'GET', 'maxmemory-policy'], { key: 'x' });
      expect(JSON.stringify(policy)).toContain('noeviction');
      const { store, eventId, keepUntilMs } = await opened(r);
      expect((await store.hold(holdInput(eventId, ['A01'], { accountId: ACCOUNT_A, keepUntilMs }))).kind).toBe('OK');
      const input = { eventId, firstBit: 0, bitCount: SEAT_COUNT, sectionIndexes: [0, 1] };
      const before = okOf(await store.read(input));
      expect(hexOf(before.bytes)).toBe('8000000000');
      const state = await rawState(r, eventId);
      await r.command(['CONFIG', 'SET', 'maxmemory', '1'], { key: 'x' });
      try {
        // 홀드 Lua는 OOM으로 거절된다(쓰기가 있는 스크립트)
        const refused = await store.hold(holdInput(eventId, ['A02'], { accountId: ACCOUNT_A, keepUntilMs })).then(
          () => undefined,
          (e: unknown) => e,
        );
        expect(refused).toBeInstanceOf(SeatStoreUnavailable);
        expect((refused as SeatStoreUnavailable).reason).toBe('oom');
        // 스냅샷 읽기는 된다
        const during = okOf(await store.read(input));
        expect({ ...during, bytes: hexOf(during.bytes) }).toEqual({ ...before, bytes: hexOf(before.bytes) });
        // 스크립트 캐시를 비워 EVALSHA가 NOSCRIPT → EVAL로 가는 길도 OOM에 거절되지 않는다
        await r.command(['SCRIPT', 'FLUSH'], { key: 'x' });
        const afterFlush = okOf(await store.read(input));
        expect(hexOf(afterFlush.bytes)).toBe('8000000000');
        // 세대 키가 없는 회차의 읽기도 NOT_READY로 답한다(OOM으로 거절하지 않는다)
        const e2 = newEvent();
        expect(await store.read({ ...input, eventId: e2 })).toEqual({ kind: 'NOT_READY' });
      } finally {
        await r.command(['CONFIG', 'SET', 'maxmemory', '0'], { key: 'x' });
      }
      expect(await rawState(r, eventId)).toEqual(state);
      // 메모리가 돌아오면 홀드도 된다
      expect((await store.hold(holdInput(eventId, ['A02'], { accountId: ACCOUNT_A, keepUntilMs }))).kind).toBe('OK');
    } finally {
      await r.close();
      own.stop();
    }
  });
});
