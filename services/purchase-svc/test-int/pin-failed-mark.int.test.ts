// 실패 해제의 실패 표시와 늦은 묶기 거절(BUILD_ORDER PRF-165)을 실제 Valkey 8.1의 RedisSeatStore로 돈다.
// 정본: docs/features/payment.md §2 'Saga 1단계의 첫 구현'(실패 해제와 늦은 묶기, 좌석 묶기 입력의 구매 세션 ID), docs/data.md §3 s:{event:E}:failed:{holdId}
// (글 1, 수명 10분 [가정]), docs/features/seat-hold.md §6 '실패 표시', inventory adapters/pin-lua.ts '실패 표시의 계약'(두 Lua의 KEYS 끝에 표시 키 하나,
// RELEASE_FAILED_LUA는 NOT_READY가 아닐 때 푼 좌석 수와 상관없이 남김, PIN_LUA는 검사 1 바로 뒤에 보고 FAILED_HOLD), domain/pin.ts FAILED_HOLD_MARK_TTL_MS.
//
// 약속:
// - 상태는 Redis 명령으로 직접 읽는다(pin.int.test.ts와 같은 방식). 키 이름은 data.md §3을 시험이 따로 적는다(운영 seatKeys에 기대지 않는다).
// - 시계: 수명은 Valkey TIME 기준으로 잰다(PEXPIRETIME − TIME). Docker 엔진 VM과 이 PC 시계 차이를 보지 않으려고 앱 시계를 쓰지 않는다.
//
// 정본 모호:
// - 실패 표시의 수명을 ARGV로 넘기는지 Lua에 박는지 정본에 없다. 여기서는 KEYS 끝에 표시 키가 하나 붙는 것과 ARGV 앞부분(기존 차례)이 그대로인 것만 본다.
// - FAILED_HOLD 묶기는 실패 표시의 수명을 늘리지 않는다고 본다('아무것도 쓰지 않는다').
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { createHotRedis, type HotRedis, type RedisScript } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { FAILED_HOLD_MARK_TTL_MS } from '../src/modules/inventory/domain/pin.js';
import { PIN_LUA, RedisSeatStore, RELEASE_FAILED_LUA, seatKeys, slotOf } from '../src/modules/inventory/index.js';
import { ACCOUNT_A, ACCOUNT_B, DAY, held, holdInput, idx, newEvent, SEAT_COUNT } from '../test/hold-cases.js';
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

/** 실패 표시 키(data.md §3을 시험이 따로 적은 것) */
const failedKey = (e: string, holdId: string) => `s:{event:${e}}:failed:${holdId}`;
const cmd = (key: string, args: string[]) => redis.command(args, { key });
async function redisNowMs(): Promise<number> {
  const t = (await redis.command(['TIME'], {})) as unknown[];
  return Number(t[0]) * 1000 + Math.floor(Number(t[1]) / 1000);
}
/** 표시 키의 값과 남은 수명(ms, Valkey TIME 기준). 없으면 null */
async function markOf(e: string, holdId: string): Promise<{ value: string; ttlMs: number } | null> {
  const k = failedKey(e, holdId);
  const v = await cmd(k, ['GET', k]);
  if (v === null || v === undefined) return null;
  const at = Number(await cmd(k, ['PEXPIRETIME', k]));
  return { value: String(v), ttlMs: at < 0 ? at : at - (await redisNowMs()) };
}

/** 회차 하나의 키를 모두 덤프한 것(아무것도 쓰지 않았는지 견준다). 키 이름 → [형, 값] */
async function snapshot(e: string): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  let cursor = '0';
  const keys: string[] = [];
  do {
    const [next, items] = (await cmd(seatKeys.epoch(e), ['SCAN', cursor, 'MATCH', `s:{event:${e}}:*`, 'COUNT', '1000'])) as [unknown, unknown[]];
    for (const x of items) keys.push(String(x));
    cursor = String(next);
  } while (cursor !== '0');
  for (const k of keys.sort()) {
    const type = String(await cmd(k, ['TYPE', k]));
    const ttl = Number(await cmd(k, ['PEXPIRETIME', k]));
    let v: unknown;
    if (type === 'string') v = String(await cmd(k, ['GET', k]));
    else if (type === 'hash') {
      // epoch의 chk는 '마지막으로 epoch를 확인한 초'다(hold-lua ENSURE_EPOCH). 핀처럼 epoch를 다시 확인하는 요청은
      // 초가 바뀌면 chk만 새로 쓴다. 이 시험이 보는 '아무것도 쓰지 않았다'는 좌석·홀드·쿼터·표시가 그대로라는 뜻이므로
      // chk는 비교에서 뺀다(PRF-142, 2026-11-14 CI 타이밍 플레이크).
      const hash = (await cmd(k, ['HGETALL', k])) as string[];
      const kept: string[] = [];
      for (let i = 0; i < hash.length; i += 2) if (hash[i] !== 'chk') kept.push(hash[i]!, hash[i + 1]!);
      v = kept;
    }
    else if (type === 'zset') v = await cmd(k, ['ZRANGE', k, '0', '-1', 'WITHSCORES']);
    else if (type === 'stream') v = Number(await cmd(k, ['XLEN', k]));
    else v = type;
    out[k] = [type, ttl, v];
  }
  return out;
}

/** 판매를 연 회차와 계정 A의 홀드(A01·A02), 그 묶기·해제 입력 */
async function opened(o: { psid?: string } = {}) {
  const store = new RedisSeatStore(redis);
  const e = newEvent();
  const keepUntilMs = Date.now() + 2 * DAY;
  await store.openSale({ eventId: e, seatCount: SEAT_COUNT, keepUntilMs });
  const psid = o.psid ?? randomUUID();
  const h = holdInput(e, ['A01', 'A02'], { accountId: ACCOUNT_A, purchaseSessionId: psid, keepUntilMs });
  held(await store.hold(h));
  const pinIn = { eventId: e, accountId: ACCOUNT_A, purchaseSessionId: psid, holdId: h.holdId, seats: h.seats, limit: 4, orderGen: 1, keepUntilMs };
  const releaseIn = { eventId: e, accountId: ACCOUNT_A, holdId: h.holdId, seats: h.seats, keepUntilMs };
  return { store, e, keepUntilMs, h, pinIn, releaseIn };
}

describe('실패 표시(RELEASE_FAILED_LUA가 남김)', () => {
  test('실패 해제는 그 holdId의 실패 표시(글 1, 수명 약 10분 [가정] = FAILED_HOLD_MARK_TTL_MS)를 남긴다 [ASVS v5.0.0-15.4.2]', async () => {
    const { store, e, h, releaseIn } = await opened();
    expect(await markOf(e, h.holdId)).toBeNull();

    expect(await store.releaseFailed(releaseIn)).toEqual({ kind: 'OK', released: 2 });

    const mark = await markOf(e, h.holdId);
    expect(mark?.value).toBe('1');
    expect(FAILED_HOLD_MARK_TTL_MS).toBe(10 * 60_000);
    // 수명: 10분에서 몇 초 안(Lua가 PX로 걸었다. 수명 없는 키(−1)나 다른 길이가 아니다)
    expect(mark!.ttlMs).toBeGreaterThan(FAILED_HOLD_MARK_TTL_MS - 5_000);
    expect(mark!.ttlMs).toBeLessThanOrEqual(FAILED_HOLD_MARK_TTL_MS);
  });

  test('푼 좌석이 0석이어도(묶기가 아직 오지 않았고 좌석이 비었거나 남의 것) 표시를 남긴다', async () => {
    const { store, e, keepUntilMs, h } = await opened();
    const ghost = randomUUID();
    // 계정 A의 다른 holdId: A01·A02는 h의 것이라 0석
    expect(await store.releaseFailed({ eventId: e, accountId: ACCOUNT_A, holdId: ghost, seats: h.seats, keepUntilMs })).toEqual({ kind: 'OK', released: 0 });
    expect((await markOf(e, ghost))?.value).toBe('1');
    // h의 홀드는 그대로이고 h의 표시는 없다
    expect(await markOf(e, h.holdId)).toBeNull();
    expect(Number(await cmd(seatKeys.bitmap(e), ['GETBIT', seatKeys.bitmap(e), String(idx('A01'))]))).toBe(1);
  });

  test('세대 키가 없으면(NOT_READY) 표시를 남기지 않는다', async () => {
    const { store, e, keepUntilMs, h, releaseIn } = await opened();
    // 세대 키가 있을 때는 남긴다(이 시험이 '언제나 남기지 않는' 구현에 헛돌지 않게)
    const ghost = randomUUID();
    expect(await store.releaseFailed({ ...releaseIn, holdId: ghost, keepUntilMs })).toEqual({ kind: 'OK', released: 0 });
    expect((await markOf(e, ghost))?.value).toBe('1');
    await cmd(seatKeys.epoch(e), ['DEL', seatKeys.epoch(e)]);
    expect(await store.releaseFailed(releaseIn)).toEqual({ kind: 'NOT_READY' });
    expect(await markOf(e, h.holdId)).toBeNull();
  });

  test('같은 실패 해제를 두 번 하면 두 번째는 0석이고 표시는 그대로 남는다', async () => {
    const { store, e, h, releaseIn } = await opened();
    expect(await store.releaseFailed(releaseIn)).toEqual({ kind: 'OK', released: 2 });
    expect(await store.releaseFailed(releaseIn)).toEqual({ kind: 'OK', released: 0 });
    expect((await markOf(e, h.holdId))?.value).toBe('1');
  });
});

describe('늦은 묶기 거절(PIN_LUA가 실패 표시를 보고 FAILED_HOLD)', () => {
  test('실패 해제 뒤 같은 holdId의 묶기는 FAILED_HOLD이고 아무것도 쓰지 않는다(풀린 빈 좌석을 다시 잡지 않는다, PRF-142가 넘긴 누수) [ASVS v5.0.0-15.4.2]', async () => {
    const { store, e, h, pinIn, releaseIn } = await opened();
    expect(await store.releaseFailed(releaseIn)).toEqual({ kind: 'OK', released: 2 });
    const before = await snapshot(e);

    expect(await store.pin(pinIn)).toEqual({ kind: 'FAILED_HOLD' });

    expect(await snapshot(e)).toEqual(before);
    for (const id of ['A01', 'A02']) {
      expect(Number(await cmd(seatKeys.bitmap(e), ['GETBIT', seatKeys.bitmap(e), String(idx(id))])), id).toBe(0);
      expect(Number(await cmd(seatKeys.hold(e, idx(id)), ['EXISTS', seatKeys.hold(e, idx(id))])), id).toBe(0);
    }
    // 표시는 그대로 하나(아무것도 쓰지 않았다)
    expect((await markOf(e, h.holdId))?.value).toBe('1');
  });

  test('묶기가 먼저 OK였어도 실패 해제 뒤 다시 온 같은 묶기는 FAILED_HOLD다(다시 잡지 않는다)', async () => {
    const { store, e, pinIn, releaseIn } = await opened();
    expect(await store.pin(pinIn)).toEqual({ kind: 'OK', gen: 1, regrabbed: 0 });
    expect(await store.releaseFailed(releaseIn)).toEqual({ kind: 'OK', released: 2 });
    expect(await store.pin(pinIn)).toEqual({ kind: 'FAILED_HOLD' });
    expect(Number(await cmd(seatKeys.quota(e, ACCOUNT_A), ['EXISTS', seatKeys.quota(e, ACCOUNT_A)]))).toBe(0);
  });

  test('다른 holdId는 영향이 없다: 같은 계정의 다른 홀드 묶기는 OK다', async () => {
    const { store, e, keepUntilMs, h, releaseIn } = await opened();
    expect(await store.releaseFailed(releaseIn)).toEqual({ kind: 'OK', released: 2 });
    expect((await markOf(e, h.holdId))?.value).toBe('1');
    const psid = randomUUID();
    const other = holdInput(e, ['A05'], { accountId: ACCOUNT_A, purchaseSessionId: psid, keepUntilMs });
    held(await store.hold(other));
    expect(await store.pin({ eventId: e, accountId: ACCOUNT_A, purchaseSessionId: psid, holdId: other.holdId, seats: other.seats, limit: 4, orderGen: 1, keepUntilMs })).toEqual({
      kind: 'OK',
      gen: 1,
      regrabbed: 0,
    });
  });

  test('다른 holdId는 영향이 없다: 풀린 좌석을 다른 계정이 잡아 묶는 것도 OK다', async () => {
    const { store, e, keepUntilMs, h, releaseIn } = await opened();
    expect(await store.releaseFailed(releaseIn)).toEqual({ kind: 'OK', released: 2 });
    expect((await markOf(e, h.holdId))?.value).toBe('1');
    const psid = randomUUID();
    const b = holdInput(e, ['A01', 'A02'], { accountId: ACCOUNT_B, purchaseSessionId: psid, keepUntilMs });
    held(await store.hold(b));
    expect(await store.pin({ eventId: e, accountId: ACCOUNT_B, purchaseSessionId: psid, holdId: b.holdId, seats: b.seats, limit: 4, orderGen: 1, keepUntilMs })).toMatchObject({ kind: 'OK' });
  });

  test('세대 키가 없으면 표시가 있어도 NOT_READY다(검사 1이 먼저)', async () => {
    const { store, e, h, pinIn, releaseIn } = await opened();
    expect(await store.releaseFailed(releaseIn)).toEqual({ kind: 'OK', released: 2 });
    expect((await markOf(e, h.holdId))?.value).toBe('1');
    await cmd(seatKeys.epoch(e), ['DEL', seatKeys.epoch(e)]);
    expect(await store.pin(pinIn)).toEqual({ kind: 'NOT_READY' });
  });

  test('표시의 수명(10분)이 지나 키가 사라지면 같은 holdId의 묶기는 다시 판정을 받는다(빈 좌석이면 다시 잡는다)', async () => {
    const { store, e, h, pinIn, releaseIn } = await opened();
    expect(await store.releaseFailed(releaseIn)).toEqual({ kind: 'OK', released: 2 });
    expect(await store.pin(pinIn)).toEqual({ kind: 'FAILED_HOLD' });
    // 수명이 다 된 것을 흉내: 키를 지운다
    await cmd(failedKey(e, h.holdId), ['DEL', failedKey(e, h.holdId)]);
    expect(await store.pin(pinIn)).toMatchObject({ kind: 'OK', regrabbed: 2 });
  });
});

describe('좌석 묶기 입력의 구매 세션 ID(payment §2: UUID가 아니라 입장 토큰 jti와 같은 키 조각 모양 1~64자 영문·숫자·_·-)', () => {
  test.each(['jti_9f2c-AB', 'a', 'x'.repeat(64), '0190f3a1_7c2e'])('구매 세션 ID %s(UUID 아님)로 빈 좌석을 다시 잡는 묶기가 OK이고 홀드 Hash psid에 그대로 쓴다', async (psid) => {
    const store = new RedisSeatStore(redis);
    const e = newEvent();
    const keepUntilMs = Date.now() + 2 * DAY;
    await store.openSale({ eventId: e, seatCount: SEAT_COUNT, keepUntilMs });
    const h = holdInput(e, ['B01'], { accountId: ACCOUNT_A, purchaseSessionId: psid, keepUntilMs });
    // 빈 좌석(홀드 없이)을 묶기가 다시 잡는다
    const r = await store.pin({ eventId: e, accountId: ACCOUNT_A, purchaseSessionId: psid, holdId: h.holdId, seats: h.seats, limit: 4, orderGen: 1, keepUntilMs });
    expect(r).toMatchObject({ kind: 'OK', gen: 1, regrabbed: 1 });
    expect(String(await cmd(seatKeys.hold(e, idx('B01')), ['HGET', seatKeys.hold(e, idx('B01')), 'psid']))).toBe(psid);
  });

  test.each(['', 'x'.repeat(65), 'jti:1', 'jti 1', 'jti{1}', '한글'])('키 조각이 아닌 구매 세션 ID(%j)는 RangeError이고 Redis에 가지 않는다 [ASVS v5.0.0-2.2.1]', async (psid) => {
    const { store, e, pinIn } = await opened();
    // 키 조각 모양이면 받는다(무엇이든 RangeError인 지금 UUID 검사가 통과하지 않게). 모두 내 홀드라 다시 잡지 않는다
    expect(await store.pin({ ...pinIn, purchaseSessionId: 'jti_ok-1' })).toEqual({ kind: 'OK', gen: 1, regrabbed: 0 });
    const before = await snapshot(e);
    await expect(store.pin({ ...pinIn, purchaseSessionId: psid })).rejects.toThrow(RangeError);
    expect(await snapshot(e)).toEqual(before);
  });
});

describe('두 Lua의 모양(pin-lua.ts 실패 표시 계약: KEYS 끝에 표시 키 하나, 한 해시 슬롯)', () => {
  /** evalScript를 부를 때마다 스크립트·KEYS·ARGV를 적는다(pin.int.test.ts와 같은 꼴) */
  function recording(inner: HotRedis) {
    const calls: { script: RedisScript; keys: string[]; args: string[] }[] = [];
    const r: HotRedis = {
      command: (a, o) => inner.command(a, o),
      sendCommand: (a) => inner.sendCommand(a),
      evalScript: (s, k, a, o) => {
        calls.push({ script: s, keys: [...k], args: [...a] });
        return inner.evalScript(s, k, a, o);
      },
      close: () => inner.close(),
    };
    return { redis: r, calls };
  }

  test('pin_releaseFailed_ 묶기·실패 해제 KEYS의 마지막이 그 holdId의 실패 표시 키이고, 모든 KEYS가 회차 슬롯 하나다 [ASVS v5.0.0-15.4.2]', async () => {
    const { e, h, pinIn, releaseIn } = await opened();
    const rec = recording(redis);
    const store = new RedisSeatStore(rec.redis);
    expect((await store.pin(pinIn)).kind).toBe('OK');
    expect(await store.releaseFailed(releaseIn)).toEqual({ kind: 'OK', released: 2 });
    expect(rec.calls.map((c) => c.script.source)).toEqual([PIN_LUA, RELEASE_FAILED_LUA]);
    for (const c of rec.calls) {
      expect(c.keys.at(-3)).toBe(failedKey(e, h.holdId));
      expect(new Set(c.keys.map(slotOf)).size).toBe(1);
    }
    // 앞 KEYS는 기존 차례(bitmap·expiry·quota·stream·epoch·secver(·fence)·hold…) 그대로다
    expect(rec.calls[0]!.keys.slice(0, 7)).toEqual([
      seatKeys.bitmap(e),
      seatKeys.expiry(e),
      seatKeys.quota(e, ACCOUNT_A),
      seatKeys.stream(e),
      seatKeys.epoch(e),
      seatKeys.secver(e),
      seatKeys.fence(e),
    ]);
    expect(rec.calls[1]!.keys.slice(0, 6)).toEqual([seatKeys.bitmap(e), seatKeys.expiry(e), seatKeys.quota(e, ACCOUNT_A), seatKeys.stream(e), seatKeys.epoch(e), seatKeys.secver(e)]);
  });
});
