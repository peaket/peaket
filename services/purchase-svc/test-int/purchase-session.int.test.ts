// 구매 세션 저장소·시작 사건을 실제 Valkey 8.1로 돈다(test/purchase-session-cases.ts의 사례를 메모리 저장소와 똑같이).
// 열기·일련번호 올리기 Lua의 모양(#!lua, 두 키가 한 해시 슬롯)은 노드 하나짜리 클러스터 모드 컨테이너에서 본다.
import 'reflect-metadata';
import { createHotRedis, type HotRedis } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  ADVANCE_SESSION_LUA,
  APPEND_SESSION_STARTED_LUA,
  MARK_SESSION_STARTED_LUA,
  OPEN_SESSION_LUA,
  RedisPurchaseSessionStore,
  RedisSessionStartedLog,
  SESSION_KEY_GRACE_MS,
  SESSION_STARTED_KEEP_MS,
  SESSION_STARTED_TYPE,
  seatKeys,
  sessionKeys,
  slotOf,
  toPurchaseSessionStarted,
} from '../src/modules/inventory/index.js';
import { CLIENT_KEY, newJti, openInput, purchaseSessionStoreCases, type SessionHarness } from '../test/purchase-session-cases.js';
import { startValkey, type ValkeyContainer } from './valkey.js';

let valkey: ValkeyContainer | undefined;
let cluster: ValkeyContainer | undefined;
let redis: HotRedis;
let clusterRedis: HotRedis;
/** Valkey 시계 − 시험 프로세스 시계(밀리초). 컨테이너 시계가 조금 달라도 기한 경계를 정확히 잡으려고 한 번 잰다 */
let offsetMs = 0;

const timeMs = async (r: HotRedis): Promise<number> => {
  const t = (await r.command(['TIME'], {})) as unknown[];
  return Number(t[0]) * 1000 + Math.floor(Number(t[1]) / 1000);
};

beforeAll(async () => {
  const [a, b] = await Promise.allSettled([startValkey(), startValkey({ cluster: true, configEpoch: 3 })]);
  if (a.status === 'fulfilled') valkey = a.value;
  if (b.status === 'fulfilled') cluster = b.value;
  if (!valkey || !cluster) throw (a.status === 'rejected' ? a.reason : (b as PromiseRejectedResult).reason) as Error;
  [redis, clusterRedis] = await Promise.all([createHotRedis({ url: valkey.url }), createHotRedis({ url: cluster.url })]);
  const samples: number[] = [];
  for (let i = 0; i < 5; i++) {
    const before = Date.now();
    const t = await timeMs(redis);
    samples.push(t - Math.round((before + Date.now()) / 2));
  }
  offsetMs = samples.sort((x, y) => x - y)[2]!;
});

afterAll(async () => {
  await Promise.all([redis?.close(), clusterRedis?.close()]);
  valkey?.stop();
  cluster?.stop();
});

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function harness(r: HotRedis = redis): SessionHarness {
  return {
    store: new RedisPurchaseSessionStore(r),
    now: () => Date.now() + offsetMs,
    pass: (ms) => sleep(ms),
    end: async (jti) => {
      const key = sessionKeys.session(jti);
      await r.command(['DEL', key], { key });
    },
    skewMs: 3_000,
  };
}

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
const pexpireTime = async (r: HotRedis, key: string) => Number(await r.command(['PEXPIRETIME', key], { key }));

describe('RedisPurchaseSessionStore (저장소 계약 사례, 실제 Valkey 8.1)', () => {
  purchaseSessionStoreCases(() => harness());
});

describe('RedisPurchaseSessionStore (키와 수명)', () => {
  test('ST28_ASVS8.2.1_열면 표지 s:jti:{jti}(값 = 연 시각)와 세션 상태 s:session:{jti}가 정해진 칸으로 생긴다. 세션 상태의 수명은 exp + 60초 [가정], 표지는 같은 jti로 다시 받을 수 있는 가장 늦은 토큰의 exp + 60초다 [ASVS v5.0.0-8.2.1]', async () => {
    const h = harness();
    const jti = newJti();
    const i = openInput(h, jti, { priorityGrantId: 'grant-1' });
    const r = await h.store.open(i);
    if (r.kind !== 'CREATED') throw new Error('CREATED여야 한다');
    const marker = sessionKeys.marker(jti);
    const session = sessionKeys.session(jti);
    expect(String(await redis.command(['GET', marker], { key: marker }))).toBe(String(r.startedAtMs));
    const f = hash(await redis.command(['HGETALL', session], { key: session }));
    expect(f).toEqual({
      acct: i.accountId,
      login: i.loginSessionId,
      event: i.eventId,
      jny: i.journeyId,
      cpk: CLIENT_KEY,
      seq: '0',
      idle: String(r.startedAtMs + 5 * 60_000),
      started: String(r.startedAtMs),
      max: String(i.expiresAtMs),
      prio: 'grant-1',
    });
    expect(await pexpireTime(redis, marker)).toBe(i.reissueUntilMs + SESSION_KEY_GRACE_MS);
    expect(await pexpireTime(redis, session)).toBe(i.expiresAtMs + SESSION_KEY_GRACE_MS);
  });

  test('ADR0183_8_세션 상태가 사라진 뒤에도 표지는 다시 받은 토큰의 exp까지 남아, 그 토큰으로 세션을 새로 열지 못한다(ENDED). 표지가 세션 상태보다 먼저 사라지지 않는다', async () => {
    const h = harness();
    const jti = newJti();
    const a = openInput(h, jti);
    await h.store.open(a);
    expect(await pexpireTime(redis, sessionKeys.marker(jti))).toBeGreaterThan(await pexpireTime(redis, sessionKeys.session(jti)));
    // 처음 세션이 끝난 뒤(키가 사라짐) 다시 받은 토큰으로 열어도 ENDED다
    await h.end(jti);
    const b = openInput(h, jti, { expiresAtMs: a.expiresAtMs + 40 * 60_000, reissueUntilMs: a.reissueUntilMs + 40 * 60_000 });
    expect(await h.store.open(b)).toEqual({ kind: 'ENDED' });
  });

  test('ADR0183_8_더 늦은 exp의 토큰으로 REPLAY하면 표지의 수명만 그 토큰이 다시 받을 수 있는 가장 늦은 exp + 60초로 늘고(세션 상태 수명은 그대로), 같거나 이른 토큰은 수명을 줄이지 않는다', async () => {
    const h = harness();
    const jti = newJti();
    const a = openInput(h, jti);
    await h.store.open(a);
    const marker = sessionKeys.marker(jti);
    const session = sessionKeys.session(jti);
    const m0 = await pexpireTime(redis, marker);
    const s0 = await pexpireTime(redis, session);
    // 같은 토큰·더 이른 토큰: 수명은 그대로
    expect((await h.store.open(a)).kind).toBe('REPLAY');
    expect((await h.store.open({ ...a, expiresAtMs: a.expiresAtMs - 1_000, reissueUntilMs: a.reissueUntilMs - 1_000 })).kind).toBe('REPLAY');
    expect(await pexpireTime(redis, marker)).toBe(m0);
    // 더 늦은 exp: 표지만 늘어난다
    const b = { ...a, expiresAtMs: a.expiresAtMs + 40 * 60_000, reissueUntilMs: a.reissueUntilMs + 40 * 60_000 };
    expect((await h.store.open(b)).kind).toBe('REPLAY');
    expect(await pexpireTime(redis, marker)).toBe(b.reissueUntilMs + SESSION_KEY_GRACE_MS);
    expect(await pexpireTime(redis, session)).toBe(s0);
    // 다시 이른 토큰이 오면 줄이지 않는다
    expect((await h.store.open(a)).kind).toBe('REPLAY');
    expect(await pexpireTime(redis, marker)).toBe(b.reissueUntilMs + SESSION_KEY_GRACE_MS);
  });

  test('ST28_ASVS8.2.1_markStarted는 세션 상태에 sev 칸 하나만 쓰고 수명·다른 칸은 그대로다. 세션이 없으면 키를 만들지 않는다 [ASVS v5.0.0-8.2.1]', async () => {
    const h = harness();
    const jti = newJti();
    const session = sessionKeys.session(jti);
    expect(await h.store.markStarted(jti)).toBe(false);
    expect(Number(await redis.command(['EXISTS', session], { key: session }))).toBe(0);
    await h.store.open(openInput(h, jti));
    const before = hash(await redis.command(['HGETALL', session], { key: session }));
    const ttl = await pexpireTime(redis, session);
    expect(await h.store.markStarted(jti)).toBe(true);
    const after = hash(await redis.command(['HGETALL', session], { key: session }));
    expect(after).toEqual({ ...before, sev: '1' });
    expect(await pexpireTime(redis, session)).toBe(ttl);
  });

  test('ASVS9.1.1_일련번호를 올려도 세션 키의 수명은 그대로이고 seq·idle 칸만 바뀐다 [ASVS v5.0.0-9.1.1]', async () => {
    const h = harness();
    const jti = newJti();
    const i = openInput(h, jti);
    await h.store.open(i);
    const session = sessionKeys.session(jti);
    const before = hash(await redis.command(['HGETALL', session], { key: session }));
    await sleep(20);
    expect(await h.store.advance(jti, 9)).toBe(true);
    const after = hash(await redis.command(['HGETALL', session], { key: session }));
    expect({ ...after, seq: '', idle: '' }).toEqual({ ...before, seq: '', idle: '' });
    expect(after.seq).toBe('9');
    expect(Number(after.idle)).toBeGreaterThanOrEqual(Number(before.idle));
    expect(await pexpireTime(redis, session)).toBe(i.expiresAtMs + SESSION_KEY_GRACE_MS);
  });

  test('ASVS9.1.1_seq 칸이 망가졌으면(10진 정수가 아님) 일련번호를 올리는 Lua가 PEAKET_CORRUPT_KEY로 거절한다: 일시 장애가 아닌 오류다 [ASVS v5.0.0-9.1.1]', async () => {
    const h = harness();
    const jti = newJti();
    await h.store.open(openInput(h, jti));
    const session = sessionKeys.session(jti);
    await redis.command(['HSET', session, 'seq', 'abc'], { key: session });
    await expect(h.store.advance(jti, 1)).rejects.toThrow(/PEAKET_CORRUPT_KEY/);
    await redis.command(['HSET', session, 'seq', '0123'], { key: session });
    await expect(h.store.advance(jti, 1)).rejects.toThrow(/PEAKET_CORRUPT_KEY/);
  });

  test('ST28_세션 키 형이 틀려도(문자열) 열기는 일시 장애로 숨기지 않고 오류로 던진다', async () => {
    const h = harness();
    const jti = newJti();
    const marker = sessionKeys.marker(jti);
    await redis.command(['SET', marker, '1'], { key: marker });
    const session = sessionKeys.session(jti);
    await redis.command(['SET', session, 'x'], { key: session });
    await expect(h.store.open(openInput(h, jti))).rejects.toThrow();
  });

  test('ST28_세션 키의 형이 틀린 채 처음 열면 오류를 던지되 재사용 차단 표지를 남기지 않는다: 키를 고친 뒤 같은 입장 토큰으로 열면 CREATED다(ENDED가 아니다)', async () => {
    const h = harness();
    const jti = newJti();
    const marker = sessionKeys.marker(jti);
    const session = sessionKeys.session(jti);
    await redis.command(['SET', session, 'x'], { key: session });
    await expect(h.store.open(openInput(h, jti))).rejects.toThrow(/WRONGTYPE/);
    expect(Number(await redis.command(['EXISTS', marker], { key: marker }))).toBe(0);
    expect(String(await redis.command(['GET', session], { key: session }))).toBe('x');
    await redis.command(['DEL', session], { key: session });
    expect((await h.store.open(openInput(h, jti))).kind).toBe('CREATED');
  });
});

describe('Lua 모양 (노드 하나짜리 클러스터 모드)', () => {
  test('ST28_ASVS8.2.1_네 Lua는 #!lua로 시작하고, 표지와 세션 키는 같은 해시 슬롯이며 회차 Stream과는 다른 슬롯이다 [ASVS v5.0.0-8.2.1]', async () => {
    for (const lua of [OPEN_SESSION_LUA, ADVANCE_SESSION_LUA, APPEND_SESSION_STARTED_LUA, MARK_SESSION_STARTED_LUA]) expect(lua.startsWith('#!lua\n')).toBe(true);
    const jti = newJti();
    const slot = async (key: string) => Number(await clusterRedis.command(['CLUSTER', 'KEYSLOT', key], { key: 'x' }));
    const marker = await slot(sessionKeys.marker(jti));
    expect(marker).toBe(await slot(sessionKeys.session(jti)));
    expect(marker).toBe(slotOf(sessionKeys.marker(jti)));
    expect(await slot(sessionKeys.stream('ev-1'))).toBe(slotOf(sessionKeys.stream('ev-1')));
    expect(marker).not.toBe(await slot(sessionKeys.stream('ev-1')));
  });

  test('ST28_클러스터 모드에서도 열기·읽기·일련번호 올리기가 같은 슬롯 안에서 돈다', async () => {
    const h = harness(clusterRedis);
    const jti = newJti();
    expect((await h.store.open(openInput(h, jti))).kind).toBe('CREATED');
    expect((await h.store.open(openInput(h, jti))).kind).toBe('REPLAY');
    expect(await h.store.advance(jti, 1)).toBe(true);
    expect((await h.store.read(jti))?.lastSeq).toBe(1);
  });
});

describe('RedisSessionStartedLog (SESSION_STARTED Stream 항목)', () => {
  const entryOf = (eventId: string, jti: string) => ({ eventId, purchaseSessionId: jti, admissionJti: jti, journeyId: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b', startedAtMs: Date.now(), maxStayUntilMs: Date.now() + 45 * 60_000 });
  const entries = async (eventId: string) => {
    const key = seatKeys.stream(eventId);
    return (await redis.command(['XRANGE', key, '-', '+'], { key })) as unknown[];
  };
  /** XRANGE 한 항목 → 칸 사전 (RESP3은 [id, [k, v, …]], 객체 꼴이면 그대로) */
  const fieldsOf = (e: unknown): Record<string, string> => {
    const body = Array.isArray(e) ? e[1] : (e as { message?: unknown })?.message;
    return hash(body);
  };

  test('ADR0183_11_ST35_항목 하나를 회차 Stream에 더하고 칸이 PurchaseSessionStarted로 바뀐다. 스트림이 없었으면 수명을 exp + 1일 [가정]로 건다', async () => {
    const log = new RedisSessionStartedLog(redis);
    const eventId = `ev-${newJti()}`;
    const jti = newJti();
    const e = entryOf(eventId, jti);
    await log.appendStarted(e);
    const got = await entries(eventId);
    expect(got).toHaveLength(1);
    const f = fieldsOf(got[0]);
    expect(f).toEqual({ type: SESSION_STARTED_TYPE, purchaseSessionId: jti, admissionJti: jti, journeyId: e.journeyId, startedAtMs: String(e.startedAtMs), maxStayUntilMs: String(e.maxStayUntilMs) });
    expect(toPurchaseSessionStarted(eventId, f)).toMatchObject({ eventId, purchaseSessionId: jti, admissionJti: jti, journeyId: e.journeyId });
    expect(await pexpireTime(redis, seatKeys.stream(eventId))).toBe(e.maxStayUntilMs + SESSION_STARTED_KEEP_MS);
  });

  test('ADR0183_11_이미 더 늦은 수명이 있으면 그대로 두고, 더 이르면 늘린다(홀드·만료 Lua와 같은 규칙)', async () => {
    const log = new RedisSessionStartedLog(redis);
    const late = `ev-${newJti()}`;
    const lateKey = seatKeys.stream(late);
    await redis.command(['XADD', lateKey, '*', 'type', 'HELD'], { key: lateKey });
    const far = Date.now() + 30 * 24 * 3600_000;
    await redis.command(['PEXPIREAT', lateKey, String(far)], { key: lateKey });
    await log.appendStarted(entryOf(late, newJti()));
    expect(await pexpireTime(redis, lateKey)).toBe(far);
    expect(await entries(late)).toHaveLength(2);

    const early = `ev-${newJti()}`;
    const earlyKey = seatKeys.stream(early);
    await redis.command(['XADD', earlyKey, '*', 'type', 'HELD'], { key: earlyKey });
    await redis.command(['PEXPIREAT', earlyKey, String(Date.now() + 60_000)], { key: earlyKey });
    const e = entryOf(early, newJti());
    await log.appendStarted(e);
    expect(await pexpireTime(redis, earlyKey)).toBe(e.maxStayUntilMs + SESSION_STARTED_KEEP_MS);
  });

  test('ASVS1.2.4_회차 ID가 키 조각 모양이 아니면 RangeError이고 Stream을 만들지 않는다 [ASVS v5.0.0-1.2.4]', async () => {
    const log = new RedisSessionStartedLog(redis);
    await expect(log.appendStarted(entryOf('a}b', newJti()))).rejects.toThrow(RangeError);
    await expect(log.appendStarted({ ...entryOf('ev-ok', newJti()), journeyId: 'nope' })).rejects.toThrow(RangeError);
  });
});

// ── 구매 세션의 홀드 기록(PRF-137, docs/features/seat-hold.md §3 '구매 세션의 홀드 기록과 첫 홀드 표시', RECORD_HOLD_LUA) ─────────────────────────────────────────────
import { RECORD_HOLD_LUA } from '../src/modules/inventory/adapters/purchase-session-lua.js';
import { type HoldRecordHarness, sessionHoldRecordCases } from '../test/session-hold-record-cases.js';

/** 세션 상태 Hash의 h:{holdId} 칸과 fh 칸을 직접 읽는 도구를 더한 도구 */
function recordHarness(r: HotRedis = redis): HoldRecordHarness {
  const keyOf = sessionKeys.session;
  return {
    ...harness(r),
    holds: async (jti) => {
      const key = keyOf(jti);
      const entries = Object.entries(hash(await r.command(['HGETALL', key], { key }))).filter(([k]) => k.startsWith('h:'));
      return entries.length ? new Map(entries.map(([k, v]) => [k.slice(2), v.split(',')] as [string, string[]])) : undefined;
    },
    exists: async (jti) => Number(await r.command(['EXISTS', keyOf(jti)], { key: keyOf(jti) })) === 1,
    fh: async (jti) => {
      const key = keyOf(jti);
      const v = await r.command(['HGET', key, 'fh'], { key });
      return v === null || v === undefined ? undefined : String(v);
    },
    expireAt: async (jti) => {
      const t = await pexpireTime(r, keyOf(jti));
      return t >= 0 ? t : undefined;
    },
  };
}

describe('RedisPurchaseSessionStore.recordHold (홀드 기록 계약 사례, 실제 Valkey 8.1)', () => {
  sessionHoldRecordCases(() => recordHarness());

  test('ST35_ADR0171_세션 상태 Hash에는 h:{holdId} 칸(좌석 ID들을 쉼표로 이은 글)과 첫 홀드 표시 fh(처음 한 번 1)만 더해지고, 다른 칸과 키 수명은 그대로다', async () => {
    const h = recordHarness();
    const jti = newJti();
    const i = openInput(h, jti);
    await h.store.open(i);
    const session = sessionKeys.session(jti);
    const before = hash(await redis.command(['HGETALL', session], { key: session }));
    const life = await pexpireTime(redis, session);
    expect(life).toBe(i.expiresAtMs + SESSION_KEY_GRACE_MS);
    expect(Object.keys(before).some((k) => k.startsWith('h:') || k === 'fh')).toBe(false);

    expect(await h.store.recordHold(jti, 'hold-1', ['B02', 'A01', 'A02'])).toBe(true);
    expect(hash(await redis.command(['HGETALL', session], { key: session }))).toEqual({ ...before, 'h:hold-1': 'B02,A01,A02', fh: '1' });
    expect(await pexpireTime(redis, session)).toBe(life);

    expect(await h.store.recordHold(jti, 'hold-2', ['C01'])).toBe(false);
    expect(hash(await redis.command(['HGETALL', session], { key: session }))).toEqual({ ...before, 'h:hold-1': 'B02,A01,A02', 'h:hold-2': 'C01', fh: '1' });
    expect(await pexpireTime(redis, session)).toBe(life);
  });

  test('ASVS8.2.2_세션이 없으면 세션 키도 재사용 차단 표지도 만들지 않는다(null) [ASVS v5.0.0-8.2.2]', async () => {
    const h = recordHarness();
    const jti = newJti();
    expect(await h.store.recordHold(jti, 'hold-1', ['A01'])).toBeNull();
    const session = sessionKeys.session(jti);
    const marker = sessionKeys.marker(jti);
    expect(Number(await redis.command(['EXISTS', session], { key: session }))).toBe(0);
    expect(Number(await redis.command(['EXISTS', marker], { key: marker }))).toBe(0);
  });

  test('ST28_홀드 기록 Lua는 #!lua로 시작하고 세션 키 하나만 쓴다: 노드 하나짜리 클러스터 모드에서도 돈다', async () => {
    expect(RECORD_HOLD_LUA.startsWith('#!lua\n')).toBe(true);
    const h = recordHarness(clusterRedis);
    const jti = newJti();
    expect((await h.store.open(openInput(h, jti))).kind).toBe('CREATED');
    expect(await h.store.recordHold(jti, 'hold-1', ['A01', 'A02'])).toBe(true);
    expect(await h.store.recordHold(jti, 'hold-2', ['A03'])).toBe(false);
    expect((await h.holds(jti))?.get('hold-1')).toEqual(['A01', 'A02']);
    expect(await h.fh?.(jti)).toBe('1');
  });

  describe('노드 하나짜리 클러스터 모드', () => {
    sessionHoldRecordCases(() => recordHarness(clusterRedis));
  });
});

// ── 구매 세션 종료와 정리(PRF-138, docs/features/seat-hold.md §2 '구매 세션 종료와 정리', END_SESSION_LUA·SWEEP_SESSION_LUA·PAY_SESSION_LUA) ─────────────────────────
import {
  APPEND_SESSION_ENDED_LUA,
  END_SESSION_LUA,
  PAY_SESSION_LUA,
  SESSION_IDLE_MS,
  SeatStoreUnavailable,
  SWEEP_SESSION_LUA,
  seatLuaErrorOf,
} from '../src/modules/inventory/index.js';
import { type EndHarness, sessionEndCases } from '../test/session-end-cases.js';

/** 세션 상태의 유휴 시한 칸을 직접 쓰는 시험 전용 도구를 더한 도구(유휴 5분을 실제로 기다릴 수 없다) */
function endHarness(r: HotRedis = redis): EndHarness {
  return {
    ...harness(r),
    setIdle: async (jti, ms) => {
      const key = sessionKeys.session(jti);
      if (Number(await r.command(['EXISTS', key], { key })) !== 1) throw new Error('세션이 있을 때만 유휴 시한 칸을 쓴다');
      await r.command(['HSET', key, 'idle', String(ms)], { key });
    },
  };
}

const exists = async (r: HotRedis, key: string) => Number(await r.command(['EXISTS', key], { key })) === 1;
const session = (jti: string) => sessionKeys.session(jti);
const allFields = async (r: HotRedis, jti: string) => hash(await r.command(['HGETALL', session(jti)], { key: session(jti) }));
/** 시험마다 다른 회차 ID(회차 Stream·정리 색인 키가 시험끼리 섞이지 않게) */
const eventOf = () => `ev-${newJti()}`;

describe('RedisPurchaseSessionStore.end·sweep·setPaying (종료·정리 계약 사례, 실제 Valkey 8.1)', () => {
  sessionEndCases(() => endHarness());

  test('QT11_ASVS8.2.1_end는 세션 상태 키만 지운다: 재사용 차단 표지 s:jti는 값·수명 그대로 남고, 회차 Stream·정리 색인은 만들지도 건드리지도 않는다 [ASVS v5.0.0-8.2.1]', async () => {
    const h = endHarness();
    const jti = newJti();
    const eventId = eventOf();
    await h.store.open(openInput(h, jti, { eventId }));
    const marker = sessionKeys.marker(jti);
    const markerValue = String(await redis.command(['GET', marker], { key: marker }));
    const markerExpire = await pexpireTime(redis, marker);
    expect(await h.store.end(jti)).toEqual({ eventId, journeyId: openInput(h, jti).journeyId });
    expect(await exists(redis, session(jti))).toBe(false);
    expect(await exists(redis, marker)).toBe(true);
    expect(String(await redis.command(['GET', marker], { key: marker }))).toBe(markerValue);
    expect(await pexpireTime(redis, marker)).toBe(markerExpire);
    expect(await exists(redis, seatKeys.stream(eventId))).toBe(false);
    expect(await exists(redis, seatKeys.sessions(eventId))).toBe(false);
    // 세션이 없는 jti의 end는 어떤 키도 만들지 않는다
    const ghost = newJti();
    expect(await h.store.end(ghost)).toBeNull();
    expect(await exists(redis, session(ghost))).toBe(false);
    expect(await exists(redis, sessionKeys.marker(ghost))).toBe(false);
  });

  test('QT11_ASVS9.2.1_sweep: LIVE는 칸도 키 수명도 바꾸지 않고, 끝낼 때(MAX_STAY·IDLE)는 세션 상태 키만 지운다(표지 그대로, 회차 Stream·정리 색인은 건드리지 않는다: 사건은 appendEnded가 따로 더한다) [ASVS v5.0.0-9.2.1]', async () => {
    const h = endHarness();
    const eventId = eventOf();
    const live = newJti();
    const i = openInput(h, live, { eventId });
    await h.store.open(i);
    const before = await allFields(redis, live);
    const expireAt = await pexpireTime(redis, session(live));
    expect(expireAt).toBe(i.expiresAtMs + SESSION_KEY_GRACE_MS);
    expect((await h.store.sweep(live)).kind).toBe('LIVE');
    expect(await allFields(redis, live)).toEqual(before);
    expect(await pexpireTime(redis, session(live))).toBe(expireAt);

    // 유휴로 끝낸다
    await h.setIdle!(live, h.now() - 1_000);
    expect((await h.store.sweep(live)).kind).toBe('ENDED');
    expect(await exists(redis, session(live))).toBe(false);
    expect(await exists(redis, sessionKeys.marker(live))).toBe(true);

    // 최대 체류로 끝낸다
    const late = newJti();
    const j = openInput(h, late, { eventId, expiresAtMs: h.now() + 1_000 });
    await h.store.open(j);
    await sleep(1_150);
    expect((await h.store.sweep(late)).kind).toBe('ENDED');
    expect(await exists(redis, session(late))).toBe(false);
    expect(await exists(redis, sessionKeys.marker(late))).toBe(true);
    expect(await exists(redis, seatKeys.stream(eventId))).toBe(false);
    expect(await exists(redis, seatKeys.sessions(eventId))).toBe(false);
  });

  test('POL009_ADR0183_11_setPaying(true)는 pay 칸 하나만 "1"로 더하고(유휴 시한을 바꾸지 않는다), setPaying(false)는 pay 칸을 지우고 idle 칸만 지금 + 5분으로 다시 쓴다. 세션 키 수명은 둘 다 그대로다', async () => {
    const h = endHarness();
    const jti = newJti();
    const i = openInput(h, jti);
    await h.store.open(i);
    const before = await allFields(redis, jti);
    const life = await pexpireTime(redis, session(jti));
    expect(Object.keys(before)).not.toContain('pay');

    expect(await h.store.setPaying(jti, true)).toBe(true);
    expect(await allFields(redis, jti)).toEqual({ ...before, pay: '1' });
    expect(await pexpireTime(redis, session(jti))).toBe(life);
    expect(await h.store.setPaying(jti, true)).toBe(true);
    expect(await allFields(redis, jti)).toEqual({ ...before, pay: '1' });

    await sleep(30);
    expect(await h.store.setPaying(jti, false)).toBe(true);
    const after = await allFields(redis, jti);
    expect(Object.keys(after)).not.toContain('pay');
    expect({ ...after, idle: '' }).toEqual({ ...before, idle: '' });
    expect(Number(after.idle)).toBeGreaterThan(Number(before.idle));
    expect(Math.abs(Number(after.idle) - (h.now() + SESSION_IDLE_MS))).toBeLessThanOrEqual(3_000);
    expect(await pexpireTime(redis, session(jti))).toBe(life);
  });

  test('POL009_setPaying은 세션이 없으면 키를 만들지 않는다(pay 칸 하나짜리 해시도 idle 칸 하나짜리 해시도 남기지 않는다)', async () => {
    const h = endHarness();
    const jti = newJti();
    expect(await h.store.setPaying(jti, true)).toBe(false);
    expect(await h.store.setPaying(jti, false)).toBe(false);
    expect(await exists(redis, session(jti))).toBe(false);
    expect(await exists(redis, sessionKeys.marker(jti))).toBe(false);
  });

  test('QT11_sweep는 max 칸이 양의 10진 정수(16자리 이하)가 아니면 PEAKET_CORRUPT_KEY로 거절한다: 일시 장애가 아닌 오류(seatLuaErrorOf가 CORRUPT_KEY로 읽는다)이고 아무것도 지우거나 쓰지 않는다', async () => {
    const h = endHarness();
    for (const bad of ['abc', '1.5', '-5', '1e9', '0', '12345678901234567']) {
      const jti = newJti();
      await h.store.open(openInput(h, jti));
      await redis.command(['HSET', session(jti), 'max', bad], { key: session(jti) });
      const before = await allFields(redis, jti);
      const err = await h.store.sweep(jti).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err, `max ${bad}`).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(/PEAKET_CORRUPT_KEY/);
      expect(err).not.toBeInstanceOf(SeatStoreUnavailable);
      expect(seatLuaErrorOf(err)).toMatchObject({ code: 'CORRUPT_KEY' });
      expect(await allFields(redis, jti), `max ${bad}`).toEqual(before);
    }
  });

  test('QT11_sweep는 Active 세션의 idle 칸이 10진 정수가 아니면 PEAKET_CORRUPT_KEY로 거절한다(아무것도 지우거나 쓰지 않는다)', async () => {
    const h = endHarness();
    for (const bad of ['abc', '1.5', '-5', '1e9']) {
      const jti = newJti();
      await h.store.open(openInput(h, jti));
      await redis.command(['HSET', session(jti), 'idle', bad], { key: session(jti) });
      const before = await allFields(redis, jti);
      const err = await h.store.sweep(jti).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err, `idle ${bad}`).toBeInstanceOf(Error);
      expect(seatLuaErrorOf(err)).toMatchObject({ code: 'CORRUPT_KEY' });
      expect(err).not.toBeInstanceOf(SeatStoreUnavailable);
      expect(await allFields(redis, jti), `idle ${bad}`).toEqual(before);
    }
  });

  test('QT11_세션 키의 형이 틀리면(문자열) end·sweep·setPaying은 일시 장애로 숨기지 않고 WRONGTYPE 오류로 던진다', async () => {
    const h = endHarness();
    const jti = newJti();
    await redis.command(['SET', session(jti), 'x'], { key: session(jti) });
    for (const run of [() => h.store.end(jti), () => h.store.sweep(jti), () => h.store.setPaying(jti, true), () => h.store.setPaying(jti, false)]) {
      const err = await run().then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(SeatStoreUnavailable);
    }
    expect(String(await redis.command(['GET', session(jti)], { key: session(jti) }))).toBe('x');
  });

  describe('노드 하나짜리 클러스터 모드', () => {
    sessionEndCases(() => endHarness(clusterRedis));
  });
});

describe('종료·정리 Lua 모양', () => {
  test('ST28_QT11_새 Lua 넷(세션 끝내기·정리 점검·Paying 표시·종료 사건 더하기)은 첫 줄이 #!lua뿐이다(allow-oom 같은 표시가 없어 메모리 부족이면 시작 전에 거절된다)', () => {
    for (const lua of [END_SESSION_LUA, SWEEP_SESSION_LUA, PAY_SESSION_LUA, APPEND_SESSION_ENDED_LUA]) {
      expect(lua.startsWith('#!lua\n')).toBe(true);
      expect(lua.split('\n')[0]).toBe('#!lua');
      expect(lua).not.toContain('allow-oom');
    }
  });
});

describe('종료·정리 Lua: 망가진 칸과 경계(PRF-138 시험 검토)', () => {
  test('ST28_QT11_event·jny가 없는 찌꺼기 해시에 end를 부르면 null이고 그 키를 지운다. sweep은 event 칸이 없으면 GONE이고 키를 건드리지 않는다(키 수명이 지운다)', async () => {
    const h = endHarness();
    const trash = newJti();
    await redis.command(['HSET', session(trash), 'acct', 'x'], { key: session(trash) });
    expect(await h.store.end(trash)).toBeNull();
    expect(await exists(redis, session(trash))).toBe(false);

    const gone = newJti();
    await redis.command(['HSET', session(gone), 'acct', 'x'], { key: session(gone) });
    expect(await h.store.sweep(gone)).toEqual({ kind: 'GONE' });
    expect(await exists(redis, session(gone))).toBe(true);
  });

  test('ASVS16.2.5_event만 있고 jny·max·idle이 빠진 해시에 sweep을 부르면 PEAKET_CORRUPT_KEY로 거절하고 키를 그대로 둔다. Paying(pay=1)이어도 idle이 10진 정수가 아니면 같다 [ASVS v5.0.0-16.2.5]', async () => {
    const h = endHarness();
    const half = newJti();
    await redis.command(['HSET', session(half), 'event', 'ev-1'], { key: session(half) });
    await expect(h.store.sweep(half)).rejects.toThrow(/PEAKET_CORRUPT_KEY/);
    expect(await exists(redis, session(half))).toBe(true);

    const jti = newJti();
    expect((await h.store.open(openInput(h, jti))).kind).toBe('CREATED');
    expect(await h.store.setPaying(jti, true)).toBe(true);
    await redis.command(['HSET', session(jti), 'idle', 'abc'], { key: session(jti) });
    await expect(h.store.sweep(jti)).rejects.toThrow(/PEAKET_CORRUPT_KEY/);
    expect(await exists(redis, session(jti))).toBe(true);
  });

  test('POL009_정리 점검 Lua의 경계: 지금 ≥ 최대 체류와 지금 ≥ 유휴 시한이 같은 밀리초에서도 끝난다(>=). Redis 시각을 시험이 정할 수 없어 Lua 원문의 비교식을 고정한다', async () => {
    expect(SWEEP_SESSION_LUA).toContain('if now >= max then');
    expect(SWEEP_SESSION_LUA).toContain('if now >= idle then');
    // 최대 체류 검사가 Paying 검사보다 먼저다(Paying이어도 최대 체류에는 끝난다)
    expect(SWEEP_SESSION_LUA.indexOf('if now >= max then')).toBeLessThan(SWEEP_SESSION_LUA.indexOf("if h[5] == '1' then"));
  });
});
