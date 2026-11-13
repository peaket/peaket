// 좌석 홀드 쓰임새(HoldSeats.execute, docs/features/seat-hold.md §3~§5)를 메모리 조립으로 본다. 저장소 계약 사례(test/hold-cases.ts)를 메모리 저장소로 돌리고,
// 홀드 지문·시험 대역(좌석맵 판·구매 세션·시도 기록)의 계약도 본다. 앱 쪽 시각은 모두 주입한 가짜 시계다.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { ForbiddenException, HttpException } from '@nestjs/common';
import { COOKIE_CHALLENGE, Deadline, type FakeClock, fakeClock, HotPathMetrics, PlatformMetrics, type Principal, PROBLEM_TYPE_BASE, ProblemError, RequestValidationError, uuidv7Time } from '@peaket/platform';
import type { FastifyRequest } from 'fastify';
import { describe, expect, test } from 'vitest';
import {
  HOLD_PROBLEMS,
  HOLD_TTL_MS,
  HoldError,
  type HoldErrorCode,
  type HoldErrorDetails,
  type HoldCommand,
  type HoldInput,
  type HoldResult,
  HoldSeats,
  IDEM_TTL_MS,
  KEEP_AFTER_SALE_END_MS,
  type MemoryHoldHash,
  MemoryPurchaseSessions,
  type MemorySeatDef,
  MemorySeatMap,
  MemorySeatStore,
  MemorySweepLeases,
  RecordingHoldAttempts,
  type ResolvedPurchaseSessionInfo,
  SEAT_CALL_CAP_MS,
  SEAT_CALL_MIN_REMAINING_MS,
  SEAT_STORE_RETRY_AFTER_SEC,
  type SeatCallOptions,
  type SeatLuaErrorCode,
  type SeatLuaScript,
  type SeatMap,
  type SeatSignals,
  type SeatStore,
  SeatStoreUnavailable,
  holdFingerprint,
  seatKeys,
  storeUnavailableError,
  throwHoldProblem,
} from '../src/modules/inventory/index.js';
import { type ExpiryHarness, expiryCases, okOf } from './expiry-cases.js';
import {
  ACCOUNT_A,
  ACCOUNT_B,
  DAY,
  expectBug,
  fingerprintOf,
  holdCases,
  holdInput,
  newEvent,
  ref,
  type ReplayInput,
  type ReplayPort,
  type ReplayResult,
  replayOf,
  SEAT_COUNT,
  SEAT_DEFS,
  type SeatHarness,
} from './hold-cases.js';

const NOW = Date.parse('2026-11-04T03:00:00.000Z');
const KEY = Buffer.alloc(32, 7);
const JNY_A = '0190f3a1-7c2e-7a00-8000-0000000000aa';
const JNY_B = '0190f3a1-7c2e-7a00-8000-0000000000bb';
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function memoryHarness(): SeatHarness {
  const clock = fakeClock({ now: NOW });
  const store = new MemorySeatStore(clock);
  const ev = (e: string) => store.db.event(e);
  const strings = (o: object) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, String(v)]));
  return {
    store,
    clock,
    skewMs: 0,
    tick: async () => clock.advance(1),
    passIdemTtl: async () => clock.advance(IDEM_TTL_MS + 1),
    setFence: async (e, v) => void (ev(e).fence = v ?? undefined),
    setCtl: async (e, f) => {
      for (const [k, v] of Object.entries(f)) ev(e).ctl.set(k, v);
    },
    setRel: async (e, a, i, at) => {
      const m = ev(e).rel.get(a) ?? new Map<number, number>();
      m.set(i, at);
      ev(e).rel.set(a, m);
    },
    setQuota: async (e, a, q) => void ev(e).quota.set(a, q),
    clearBit: async (e, i) => void ev(e).bits.delete(i),
    dropEpoch: async (e) => void (ev(e).epoch = undefined),
    setStaleHold: async (e, i, extra) =>
      void ev(e).holds.set(i, { holdId: 'old', owner: 'old', psid: 'old', fence: '1', heldAt: 1, exp: 2, kind: 'FAN', ext: '1', ...extra } as MemoryHoldHash),
    bit: async (e, i) => (ev(e).bits.has(i) ? 1 : 0),
    holdHash: async (e, i) => {
      const x = ev(e).holds.get(i);
      return x ? strings(x) : null;
    },
    expiryScore: async (e, i) => ev(e).expiry.get(i) ?? null,
    quota: async (e, a) => ev(e).quota.get(a) ?? null,
    fence: async (e) => ev(e).fence ?? null,
    secver: async (e) => Object.fromEntries([...ev(e).secver].map(([k, v]) => [String(k), v])),
    stream: async (e) => ev(e).stream.map((r) => ({ ...r })),
    idem: async (e, a, k) => {
      const r = ev(e).idem.get(`${a}:${k}`);
      return r ? { fp: r.fp, resp: r.resp } : null;
    },
    idemTtlMs: async (e, a, k) => {
      const r = ev(e).idem.get(`${a}:${k}`);
      return r ? r.expiresAtMs - clock.now() : null;
    },
    expireAt: async (e, key) => ev(e).expireAt.get(key) ?? null,
    epoch: async (e) => {
      const x = ev(e).epoch;
      return x ? { epoch: x.epoch, node: x.node } : null;
    },
    inCtlEvents: async (e) => store.db.ctlEvents.has(e),
    bitmapBits: async (e) => ev(e).seatCount ?? null,
    published: async (e) => ev(e).published.map((p) => ({ ...p })),
  };
}

holdCases('메모리', async () => memoryHarness());

/** 만료 사례용 메모리 도구(memoryHarness에 만료 Hash·만료 인덱스·rel·secver 칸·임대를 직접 쓰고 읽는 것을 더한다) */
function memoryExpiryHarness(): ExpiryHarness {
  const h = memoryHarness();
  const store = h.store as MemorySeatStore;
  const clock = h.clock as FakeClock;
  const ev = (e: string) => store.db.event(e);
  // 메모리 Hash의 시각 칸은 수다(MemoryHoldHash)
  const typed = (fields: Record<string, string>) => Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, k === 'heldAt' || k === 'exp' ? Number(v) : v]));
  const live = (e: string) => {
    const s = ev(e).sweep;
    return s && clock.now() < s.expiresAtMs ? s : undefined;
  };
  return {
    ...h,
    store,
    leases: new MemorySweepLeases(store.db, clock),
    relSlackMs: 0,
    setHoldRaw: async (e, i, fields) => {
      if (fields === null) ev(e).holds.delete(i);
      else ev(e).holds.set(i, typed(fields) as unknown as MemoryHoldHash);
    },
    setHoldField: async (e, i, field, value) => void ev(e).holds.set(i, { ...(ev(e).holds.get(i) ?? {}), ...typed({ [field]: value }) } as unknown as MemoryHoldHash),
    setExpiry: async (e, member, score) => void ev(e).expiry.set(Number(member), score),
    removeExpiry: async (e, i) => void ev(e).expiry.delete(i),
    setSecverRaw: async (e, s, v) => void ev(e).secver.set(s, v as number),
    setQuotaRaw: async (e, a, text) => void ev(e).quota.set(a, text as unknown as number),
    rel: async (e, a) => Object.fromEntries([...(ev(e).rel.get(a) ?? new Map<number, number>())].map(([k, v]) => [String(k), v])),
    lease: async (e) => live(e)?.owner ?? null,
    leaseTtlMs: async (e) => {
      const s = live(e);
      return s ? s.expiresAtMs - clock.now() : null;
    },
    shortenLease: async (e, ms) => {
      const s = ev(e).sweep;
      if (s) s.expiresAtMs = clock.now() + ms;
    },
    passLeaseTtl: async (e) => {
      const s = ev(e).sweep;
      if (s) s.expiresAtMs = clock.now();
    },
    addCtlEvent: async (raw) => void store.db.ctlEvents.add(raw),
  };
}

expiryCases('메모리', async () => memoryExpiryHarness());

/** 좌석 Lua 지표 기록(seat_lua_errors_total 대신) */
function recordingSignals(): SeatSignals & { calls: [SeatLuaScript, SeatLuaErrorCode][] } {
  const calls: [SeatLuaScript, SeatLuaErrorCode][] = [];
  return { calls, luaError: (script, code) => void calls.push([script, code]) };
}

// ---- 쓰임새 조립 ----

/** 다른 회차의 좌석맵 판(이 판에만 있는 C01) */
const OTHER_SEAT: MemorySeatDef = { seatId: 'C01', index: 0, sectionId: 'SEC-C', sectionIndex: 0, seatOffset: 0, tierId: 'R' };

interface WorldOptions {
  /** 주입 시계(기본은 NOW·단조 50에서 시작하는 가짜 시계) */
  clock?: FakeClock;
  saleEndsAtMs?: number;
  limit?: number;
  /** 회차 좌석맵 판·판매 열기를 하지 않는다(설정 없음 503) */
  noConfig?: boolean;
  /** 저장소 hold 대역(기본은 메모리 저장소) */
  hold?: (i: HoldInput, ctx: { inner: MemorySeatStore; clock: FakeClock }) => Promise<HoldResult>;
  /** 저장소 replay 대역(기본은 메모리 저장소) */
  replay?: (i: ReplayInput, ctx: { inner: MemorySeatStore; clock: FakeClock }) => Promise<ReplayResult>;
  /** 저장소 autoCursor 대역(기본은 메모리 저장소) */
  autoCursor?: (eventId: string, field: string) => Promise<number>;
  /** 핫패스 구간 진단(BAT-027) */
  hotPath?: HotPathMetrics;
}

async function world(o: WorldOptions = {}) {
  const clock = o.clock ?? fakeClock({ now: NOW, monotonic: 50 });
  const inner = new MemorySeatStore(clock);
  const calls: HoldInput[] = [];
  /** 재생 읽기 호출(앱 쪽 거절 전, 추천 적용 2026-11-04) */
  const replays: ReplayInput[] = [];
  /** 저장소 호출의 둘째 인자(호출 마감, PRF-135) */
  const holdOpts: (SeatCallOptions | undefined)[] = [];
  const replayOpts: (SeatCallOptions | undefined)[] = [];
  const store: SeatStore & ReplayPort = {
    hold: async (i: HoldInput, opt?: SeatCallOptions) => {
      calls.push(i);
      holdOpts.push(opt);
      return o.hold ? o.hold(i, { inner, clock }) : inner.hold(i);
    },
    holdAuto: async (i, opt) => inner.holdAuto(i, opt),
    autoCursor: async (eventId, field) => (o.autoCursor ? o.autoCursor(eventId, field) : inner.autoCursor(eventId, field)),
    openSale: (i) => inner.openSale(i),
    replay: async (i: ReplayInput, opt?: SeatCallOptions) => {
      replays.push(i);
      replayOpts.push(opt);
      return o.replay ? o.replay(i, { inner, clock }) : replayOf(inner)(i);
    },
  };
  const signals = recordingSignals();
  const seatMap = new MemorySeatMap();
  const sessions = new MemoryPurchaseSessions();
  const attempts = new RecordingHoldAttempts();
  const eventId = newEvent();
  const otherEvent = newEvent();
  const saleEndsAtMs = o.saleEndsAtMs ?? NOW + DAY;
  const limit = o.limit ?? 4;
  if (!o.noConfig) {
    seatMap.put({ eventId, layoutVersion: 'v1', seatCount: SEAT_COUNT, perAccountLimit: limit, saleEndsAtMs }, SEAT_DEFS);
    await inner.openSale({ eventId, seatCount: SEAT_COUNT, keepUntilMs: saleEndsAtMs + KEEP_AFTER_SALE_END_MS });
  }
  seatMap.put({ eventId: otherEvent, layoutVersion: 'v1', seatCount: 10, perAccountLimit: 4, saleEndsAtMs: NOW + DAY }, [OTHER_SEAT]);
  await inner.openSale({ eventId: otherEvent, seatCount: 10, keepUntilMs: NOW + 2 * DAY });
  sessions.open({ sessionId: 'ps-a', accountId: ACCOUNT_A, eventId, journeyId: JNY_A, loginSessionId: 'ls-a', key: KEY });
  sessions.open({ sessionId: 'ps-b', accountId: ACCOUNT_B, eventId, journeyId: JNY_B, loginSessionId: 'ls-b', key: KEY });
  const uc = new HoldSeats(store, seatMap, sessions, attempts, clock, signals, undefined, undefined, undefined, o.hotPath, seatMap);
  /** A의 요청(c로 바꾼다). seatIds가 undefined면 본문은 c.body 또는 {} */
  const run = (seatIds: readonly string[] | undefined, c: Partial<HoldCommand> = {}) =>
    uc.execute({ eventId, accountId: ACCOUNT_A, purchaseSessionId: 'ps-a', idempotencyKey: randomUUID(), body: seatIds === undefined ? {} : { seatIds }, ...c });
  const asB = (seatIds: readonly string[], c: Partial<HoldCommand> = {}) => run(seatIds, { accountId: ACCOUNT_B, purchaseSessionId: 'ps-b', ...c });
  return { clock, inner, store, calls, replays, holdOpts, replayOpts, signals, seatMap, sessions, attempts, eventId, otherEvent, saleEndsAtMs, limit, uc, run, asB, ev: () => inner.db.event(eventId) };
}

async function rejects(p: Promise<unknown>, code: HoldErrorCode): Promise<HoldError> {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(HoldError);
  expect((e as HoldError).code).toBe(code);
  return e as HoldError;
}

/** 저장소가 정한 결과를 그대로 돌려주는 대역 */
const returns = (r: HoldResult) => async () => r;

/** f가 RangeError를 던지는지 본다(틀리면 실제로 던진 오류의 이름·글이 실패 메시지에 보인다) */
function expectRangeError(f: () => unknown, what?: unknown): void {
  let err: unknown = null;
  try {
    f();
  } catch (e) {
    err = e;
  }
  expect(err, `${JSON.stringify(what) ?? ''} 던진 것: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`).toBeInstanceOf(RangeError);
}

describe('HoldSeats.execute: 차례', () => {
  test('FR010_ 계정 모양이 키 조각(KEY_PART)이 아니거나, 구매 세션이 없거나 끝났거나, 다른 계정의 것이면 401(SESSION_NOT_FOUND)이고 저장소를 부르지 않으며 시도 기록을 남기지 않는다', async () => {
    const w = await world();
    await rejects(w.run(['A01'], { accountId: 'a{b}' }), 'SESSION_NOT_FOUND');
    await rejects(w.run(['A01'], { accountId: 'x'.repeat(65) }), 'SESSION_NOT_FOUND');
    // 그 계정으로 열린 구매 세션이 있어도 계정 모양이 틀리면 401이다(세션 대조가 아니라 모양 확인으로 막는다. Redis 키에 들어가기 때문)
    for (const [bad, sid] of [
      ['a{b}', 'ps-bad1'],
      ['x'.repeat(65), 'ps-bad2'],
      ['a:b', 'ps-bad3'],
    ] as const) {
      w.sessions.open({ sessionId: sid, accountId: bad, eventId: w.eventId, journeyId: JNY_A, loginSessionId: `ls-${sid}`, key: KEY });
      await rejects(w.run(['A01'], { accountId: bad, purchaseSessionId: sid }), 'SESSION_NOT_FOUND');
    }
    await rejects(w.run(['A01'], { purchaseSessionId: 'ps-none' }), 'SESSION_NOT_FOUND');
    await rejects(w.run(['A01'], { accountId: ACCOUNT_B }), 'SESSION_NOT_FOUND');
    w.sessions.end('ps-a');
    await rejects(w.run(['A01']), 'SESSION_NOT_FOUND');
    expect(w.calls).toHaveLength(0);
    expect(w.attempts.records).toHaveLength(0);
  });

  test('ST28_③ 구매 세션의 회차와 주소의 회차가 다르면 403(EVENT_MISMATCH)이고 저장소를 부르지 않으며 그 회차 좌석·보유 수에 변화가 없다 [ASVS v5.0.0-8.2.2]', async () => {
    const w = await world();
    await rejects(w.run(['C01'], { eventId: w.otherEvent }), 'EVENT_MISMATCH');
    // 403이 본문 검사(400)보다 먼저다
    await rejects(w.run(undefined, { eventId: w.otherEvent, body: { auto: { firstTierId: 'R', count: 1, wheelchair: false, allowSplit: false } } }), 'EVENT_MISMATCH');
    expect(w.calls).toHaveLength(0);
    const other = w.inner.db.event(w.otherEvent);
    expect(other.bits.size).toBe(0);
    expect(other.quota.size).toBe(0);
    expect(other.stream).toHaveLength(0);
    // 403 시도는 ERROR로 남는다(좌석을 판에서 찾기 전이라 등급 없음)
    expect(w.attempts.records[0]).toMatchObject({ eventId: w.otherEvent, accountId: ACCOUNT_A, purchaseSessionId: 'ps-a', journeyId: JNY_A, mode: 'PICK', seatIds: ['C01'], result: 'ERROR' });
    expect(w.attempts.records[0]!.tierId).toBeUndefined();
    expect(w.attempts.records[0]!.heldAtMs).toBeUndefined();
  });

  test('FR010_ seatIds와 auto가 함께 있으면 400(AUTO_AND_SEATS), seatIds가 없거나 비면 400(SEATS_REQUIRED)이고, 둘 다 회차 설정 확인보다 먼저이며 시도 기록을 남기지 않는다', async () => {
    const w = await world({ noConfig: true });
    const auto = { firstTierId: 'R', count: 2, wheelchair: false, allowSplit: false };
    await rejects(w.run(undefined, { body: { seatIds: ['A01'], auto } }), 'AUTO_AND_SEATS');
    await rejects(w.run(undefined), 'SEATS_REQUIRED');
    await rejects(w.run([]), 'SEATS_REQUIRED');
    expect(w.calls).toHaveLength(0);
    expect(w.attempts.records).toHaveLength(0);
  });

  test('FR010_ auto만 있고 회차 좌석맵 판이 없으면 503(NOT_READY)이고 저장소를 부르지 않으며 시도 기록 ERROR 하나다', async () => {
    const w = await world({ noConfig: true });
    await rejects(w.run(undefined, { body: { auto: { firstTierId: 'R', count: 2, wheelchair: false, allowSplit: false } } }), 'NOT_READY');
    expect(w.calls).toHaveLength(0);
    expect(w.attempts.records.map((a) => a.result)).toEqual(['ERROR']);
  });

  test('FR010_ 회차 좌석맵 판이 없으면 503(NOT_READY)이고 저장소를 부르지 않는다', async () => {
    const w = await world({ noConfig: true });
    await rejects(w.run(['A01']), 'NOT_READY');
    expect(w.calls).toHaveLength(0);
    expect(w.attempts.records.map((a) => a.result)).toEqual(['ERROR']);
  });

  test('FR010_ 판매 종료는 주입 시계로 본다: 종료 1ms 전은 잡고, 종료 시각과 같거나 뒤면 410(SALE_ENDED)이며 저장소를 부르지 않는다(좌석 확인보다 먼저)', async () => {
    const w = await world({ saleEndsAtMs: NOW + 1 });
    await w.run(['A01']);
    expect(w.calls).toHaveLength(1);
    w.clock.advance(1);
    await rejects(w.run(['A02']), 'SALE_ENDED');
    await rejects(w.run(['Z99']), 'SALE_ENDED');
    w.clock.advance(60_000);
    await rejects(w.run(['A03']), 'SALE_ENDED');
    expect(w.calls).toHaveLength(1);
    expect(w.ev().bits.has(ref('A02').index)).toBe(false);
    expect(w.attempts.records.slice(1).map((a) => [a.result, a.tierId])).toEqual([
      ['ERROR', undefined],
      ['ERROR', undefined],
      ['ERROR', undefined],
    ]);
  });

  test('ST30_①~⑤ 좌석맵 판에 없는 좌석·다른 회차의 좌석·판매 제외석·같은 좌석 두 번·정상 좌석과 섞은 요청은 모두 422(INVALID_SEAT)이고 저장소를 부르지 않으며 좌석·보유 수·Stream 변화가 0이다 [ASVS v5.0.0-2.2.1] [ASVS v5.0.0-2.2.2] [ASVS v5.0.0-8.3.1] [ASVS v5.0.0-1.2.4]', async () => {
    const w = await world();
    const bodies = [['Z99'], ['C01'], ['X01'], ['A02', 'A02'], ['A01', 'Z99'], ['A01', 'C01', 'A02'], ['A01', 'X01'], ['A01', 'A01', 'A02']];
    for (const seatIds of bodies) await rejects(w.run(seatIds), 'INVALID_SEAT');
    expect(w.calls).toHaveLength(0);
    expect(w.ev().bits.size).toBe(0);
    expect(w.ev().quota.size).toBe(0);
    expect(w.ev().stream).toHaveLength(0);
    // 시도 기록: 보낸 좌석 그대로(겹친 것도), 첫 좌석을 판에서 찾았으면 그 등급·구역
    expect(w.attempts.records.map((a) => ({ seatIds: a.seatIds, result: a.result, tierId: a.tierId, sectionId: a.sectionId }))).toEqual([
      { seatIds: ['Z99'], result: 'ERROR', tierId: undefined, sectionId: undefined },
      { seatIds: ['C01'], result: 'ERROR', tierId: undefined, sectionId: undefined },
      { seatIds: ['X01'], result: 'ERROR', tierId: undefined, sectionId: undefined },
      { seatIds: ['A02', 'A02'], result: 'ERROR', tierId: 'R', sectionId: 'SEC-A' },
      { seatIds: ['A01', 'Z99'], result: 'ERROR', tierId: 'R', sectionId: 'SEC-A' },
      { seatIds: ['A01', 'C01', 'A02'], result: 'ERROR', tierId: 'R', sectionId: 'SEC-A' },
      { seatIds: ['A01', 'X01'], result: 'ERROR', tierId: 'R', sectionId: 'SEC-A' },
      { seatIds: ['A01', 'A01', 'A02'], result: 'ERROR', tierId: 'R', sectionId: 'SEC-A' },
    ]);
  });

  test('FR010_ 저장소 입력: 좌석을 좌석 ID 오름차순으로 정렬하고, holdId는 주입 시계의 UUIDv7, 지문은 정렬한 좌석 ID의 SHA-256, 한도는 회차 설정, keepUntil은 판매 종료 + 1일로 한 번만 부른다', async () => {
    const w = await world({ limit: 3 });
    const key = randomUUID();
    await w.run(['B02', 'A03', 'A01'], { idempotencyKey: key });
    expect(w.calls).toHaveLength(1);
    const i = w.calls[0]!;
    expect(i).toEqual({
      eventId: w.eventId,
      accountId: ACCOUNT_A,
      purchaseSessionId: 'ps-a',
      holdId: i.holdId,
      idempotencyKey: key,
      fingerprint: fingerprintOf(['A01', 'A03', 'B02']),
      seats: [ref('A01'), ref('A03'), ref('B02')],
      limit: 3,
      keepUntilMs: w.saleEndsAtMs + KEEP_AFTER_SALE_END_MS,
    });
    expect(KEEP_AFTER_SALE_END_MS).toBe(DAY);
    expect(i.holdId).toMatch(UUID_V7);
    expect(uuidv7Time(i.holdId)).toBe(NOW);
  });

  test('FR010_POL012_ 잡으면 201 본문: holdId·좌석(오름차순)·expiresAt(잡은 시각 + 7분, ISO 8601 Z, 밀리초 셋째 자리)·extendable true·펜싱 토큰(안전한 정수)', async () => {
    const w = await world();
    const body = await w.run(['A03', 'A01']);
    expect(body).toEqual({
      holdId: w.calls[0]!.holdId,
      seatIds: ['A01', 'A03'],
      expiresAt: new Date(NOW + HOLD_TTL_MS).toISOString(),
      extendable: true,
      // 메모리 저장소: µs = 시계 × 1000, fence가 없으면 토큰 = µs
      fencingToken: NOW * 1000,
    });
    expect(body.expiresAt).toMatch(/T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(Number.isSafeInteger(body.fencingToken)).toBe(true);
  });

  test('FR010_ 201 본문은 저장소가 준 holdId·토큰·만료 시각을 쓴다(멱등 재생이면 처음 홀드의 값)', async () => {
    const stored = { holdId: '0190f3a1-7c2e-7a00-8000-00000000f001', fencingToken: 1_793_761_200_000_123, heldAtMs: NOW - 5_000, expiresAtMs: NOW - 5_000 + HOLD_TTL_MS };
    for (const kind of ['OK', 'IDEM_REPLAY'] as const) {
      const w = await world({ hold: returns({ kind, ...stored }) });
      expect(await w.run(['A02', 'A01'])).toEqual({ holdId: stored.holdId, seatIds: ['A01', 'A02'], expiresAt: new Date(stored.expiresAtMs).toISOString(), extendable: true, fencingToken: stored.fencingToken });
      // 시도 기록의 잡은 시각은 앱 시계가 아니라 저장소(Lua)가 준 heldAt이다. 재생은 남기지 않는다
      expect({ kind, recs: w.attempts.records.map((a) => [a.result, a.heldAtMs, a.occurredAtMs]) }).toEqual({ kind, recs: kind === 'OK' ? [['HELD', stored.heldAtMs, NOW]] : [] });
    }
  });

  test('ST24_① 같은 키로 다시 보내면 처음 응답을 그대로 받고 시도 기록은 처음 한 번만 남는다', async () => {
    const w = await world();
    const key = randomUUID();
    const a = await w.run(['A01', 'A02'], { idempotencyKey: key });
    w.clock.advance(1_000);
    const b = await w.run(['A02', 'A01'], { idempotencyKey: key });
    expect(b).toEqual(a);
    expect(w.calls).toHaveLength(2);
    expect(w.attempts.records.map((r) => r.result)).toEqual(['HELD']);
    expect(w.ev().quota.get(ACCOUNT_A)).toBe(2);
  });

  test('FR010_FR072_ 결과 대응: NOT_READY 503·IDEM_REUSED 422·PAUSED 423·CONFLICT 409·REHOLD_WAIT 409(좌석·다시 잡을 시각)·QUOTA_EXCEEDED 422, 시도 기록의 결과는 ERROR·ERROR·ERROR·CONFLICT·RECENTLY_RELEASED·LIMIT', async () => {
    const cases: [HoldResult, HoldErrorCode, HoldErrorDetails, string][] = [
      [{ kind: 'NOT_READY' }, 'NOT_READY', {}, 'ERROR'],
      [{ kind: 'IDEM_REUSED' }, 'IDEM_REUSED', {}, 'ERROR'],
      [{ kind: 'PAUSED' }, 'PAUSED', {}, 'ERROR'],
      [{ kind: 'CONFLICT', seatId: 'A01' }, 'CONFLICT', {}, 'CONFLICT'],
      [{ kind: 'REHOLD_WAIT', seatIds: ['A01', 'A02'], availableAtMs: NOW + 30_000 }, 'REHOLD_WAIT', { recentlyReleasedSeats: ['A01', 'A02'], reholdAvailableAtMs: NOW + 30_000 }, 'RECENTLY_RELEASED'],
      [{ kind: 'QUOTA_EXCEEDED' }, 'QUOTA_EXCEEDED', {}, 'LIMIT'],
    ];
    for (const [result, code, details, recorded] of cases) {
      const w = await world({ hold: returns(result) });
      const e = await rejects(w.run(['A01', 'A02']), code);
      expect({ code, details: e.details }).toMatchObject({ code, details });
      expect(w.calls).toHaveLength(1);
      expect({ code, results: w.attempts.records.map((a) => [a.result, a.heldAtMs]) }).toEqual({ code, results: [[recorded, undefined]] });
    }
  });

  test('FR010_ 저장소 일시 장애(SeatStoreUnavailable)는 503(STORE_UNAVAILABLE, cause 그대로)이고 다시 시도하지 않는다. 그 밖의 오류는 바꾸지 않고 던진다', async () => {
    const down = new SeatStoreUnavailable(new Error('down'));
    const w = await world({ hold: async () => Promise.reject(down) });
    const e = await rejects(w.run(['A01']), 'STORE_UNAVAILABLE');
    expect(e.details.cause ?? e.cause).toBe(down);
    expect(w.calls).toHaveLength(1);
    expect(w.attempts.records.map((a) => a.result)).toEqual(['ERROR']);
    const bug = new Error('스크립트 오류');
    const b = await world({ hold: async () => Promise.reject(bug) });
    await expect(b.run(['A01'])).rejects.toBe(bug);
    expect(b.calls).toHaveLength(1);
  });

  test('POL011_ 회차 한도를 넘는 좌석 수는 422(QUOTA_EXCEEDED)이고 아무 좌석도 잡지 않는다', async () => {
    const w = await world({ limit: 2 });
    await w.run(['A01']);
    await rejects(w.run(['A02', 'A03']), 'QUOTA_EXCEEDED');
    expect(w.ev().quota.get(ACCOUNT_A)).toBe(1);
    expect(w.ev().bits.has(ref('A02').index)).toBe(false);
    await w.run(['A02']);
    expect(w.ev().quota.get(ACCOUNT_A)).toBe(2);
  });

  test('ST33_④ 방금 놓은 좌석과 새 좌석을 함께 요청하면 409(REHOLD_WAIT, recentlyReleasedSeats·reholdAvailableAtMs)이고 부분 홀드가 0이다', async () => {
    const w = await world();
    w.ev().rel.set(ACCOUNT_A, new Map([[ref('A05').index, NOW + 30_000]]));
    const e = await rejects(w.run(['A06', 'A05']), 'REHOLD_WAIT');
    expect(e.details).toMatchObject({ recentlyReleasedSeats: ['A05'], reholdAvailableAtMs: NOW + 30_000 });
    expect(w.ev().bits.size).toBe(0);
    // 다른 사람은 바로 잡는다
    await w.asB(['A05']);
  });

  test('ST33_⑦ 놓은 좌석에 남의 홀드가 걸려 있으면 409(CONFLICT)가 먼저다', async () => {
    const w = await world();
    w.ev().rel.set(ACCOUNT_A, new Map([[ref('A05').index, NOW + 30_000]]));
    await w.asB(['A05']);
    await rejects(w.run(['A05']), 'CONFLICT');
  });

  test('FR010_ 판매 정지 사본(ctl)이 정지면 423(PAUSED)이다', async () => {
    const w = await world();
    w.ev().ctl.set('suspended', '1');
    await rejects(w.run(['A01']), 'PAUSED');
    expect(w.ev().bits.size).toBe(0);
  });

  test('ST26_③ 세대 키가 없으면 503(NOT_READY)이고 좌석을 잡지 않는다', async () => {
    const w = await world();
    w.ev().epoch = undefined;
    await rejects(w.run(['A01']), 'NOT_READY');
    expect(w.ev().bits.size).toBe(0);
  });
});

describe('HoldSeats.execute: 홀드 시도 기록(S-T35, ADR-0171)', () => {
  test('FR072_ST35_① 잡은 시도는 HELD·보낸 차례의 시도 좌석·Lua가 준 잡은 시각(Stream HELD occurredAtMs와 같다)·여정 ID·결과 시각·걸린 시간을 남긴다', async () => {
    // 저장소가 7ms 걸린 것으로 만든다(시계를 밀고 메모리 저장소를 부른다)
    const w = await world({
      hold: async (i, { inner, clock }) => {
        clock.advance(7);
        return inner.hold(i);
      },
    });
    await w.run(['A02', 'A01']);
    expect(w.attempts.records).toEqual([
      {
        eventId: w.eventId,
        accountId: ACCOUNT_A,
        purchaseSessionId: 'ps-a',
        journeyId: JNY_A,
        mode: 'PICK',
        seatIds: ['A02', 'A01'],
        tierId: 'R',
        sectionId: 'SEC-A',
        result: 'HELD',
        heldAtMs: NOW + 7,
        occurredAtMs: NOW + 7,
        latencyMs: 7,
      },
    ]);
    expect(w.ev().stream.map((s) => s.occurredAtMs)).toEqual([String(NOW + 7), String(NOW + 7)]);
  });

  test('FR072_ST35_② 경합에 진 시도는 CONFLICT와 요청한 좌석을 남기고 잡은 시각이 없다(여정 ID는 그 계정의 것)', async () => {
    const w = await world();
    await w.run(['A01', 'A02']);
    await rejects(w.asB(['A03', 'A01']), 'CONFLICT');
    const b = w.attempts.records[1]!;
    expect(b).toMatchObject({ accountId: ACCOUNT_B, purchaseSessionId: 'ps-b', journeyId: JNY_B, mode: 'PICK', seatIds: ['A03', 'A01'], tierId: 'R', sectionId: 'SEC-A', result: 'CONFLICT', occurredAtMs: NOW });
    expect(b.heldAtMs).toBeUndefined();
    expect(b.latencyMs).toBeGreaterThanOrEqual(0);
  });

  test('FR072_ST35_③ 한도를 넘는 시도는 LIMIT와 요청한 좌석을 남기고 잡은 시각이 없다', async () => {
    const w = await world({ limit: 4 });
    await rejects(w.asB(['B05', 'B01', 'B02', 'B03', 'B04']), 'QUOTA_EXCEEDED');
    const b = w.attempts.records[0]!;
    expect(b).toMatchObject({ accountId: ACCOUNT_B, journeyId: JNY_B, seatIds: ['B05', 'B01', 'B02', 'B03', 'B04'], tierId: 'S', sectionId: 'SEC-B', result: 'LIMIT' });
    expect(b.heldAtMs).toBeUndefined();
  });

  test('FR072_ST35_④ 방금 놓은 좌석을 다시 잡는 시도는 RECENTLY_RELEASED와 요청한 좌석을 남기고 잡은 시각이 없다', async () => {
    const w = await world();
    w.ev().rel.set(ACCOUNT_A, new Map([[ref('A04').index, NOW + 30_000]]));
    await rejects(w.run(['A04']), 'REHOLD_WAIT');
    const a = w.attempts.records[0]!;
    expect(a).toMatchObject({ accountId: ACCOUNT_A, journeyId: JNY_A, seatIds: ['A04'], result: 'RECENTLY_RELEASED', tierId: 'R' });
    expect(a.heldAtMs).toBeUndefined();
  });

  test('FR072_ST35_ 그 밖의 거절(403·503·410·422·423)은 ERROR이고, 401·400과 멱등 재생은 남기지 않는다. 시도 하나에 기록은 하나다', async () => {
    const w = await world();
    const key = randomUUID();
    await w.run(['A01'], { idempotencyKey: key });
    await w.run(['A01'], { idempotencyKey: key }); // 재생: 남기지 않는다
    await rejects(w.run(['A02'], { idempotencyKey: key }), 'IDEM_REUSED'); // 422
    await rejects(w.run(['Z99']), 'INVALID_SEAT'); // 422
    await rejects(w.run(['C01'], { eventId: w.otherEvent }), 'EVENT_MISMATCH'); // 403
    w.ev().ctl.set('paused', '1');
    await rejects(w.run(['A03']), 'PAUSED'); // 423
    w.ev().ctl.set('paused', '0');
    await rejects(w.run(['A03'], { purchaseSessionId: 'ps-none' }), 'SESSION_NOT_FOUND'); // 401: 남기지 않는다
    await rejects(w.run([]), 'SEATS_REQUIRED'); // 400: 남기지 않는다
    w.ev().epoch = undefined;
    await rejects(w.run(['A03']), 'NOT_READY'); // 503
    w.clock.advance(DAY);
    await rejects(w.run(['A03']), 'SALE_ENDED'); // 410
    expect(w.attempts.records.map((a) => a.result)).toEqual(['HELD', 'ERROR', 'ERROR', 'ERROR', 'ERROR', 'ERROR', 'ERROR']);
    expect(w.attempts.records.every((a, i) => i === 0 || a.heldAtMs === undefined)).toBe(true);
  });

  test('FR072_ST35_ 여러 등급이면 tierId·sectionId는 요청한 seatIds 첫 좌석의 것이다(정렬한 첫 좌석이 아니다)', async () => {
    const w = await world();
    await w.run(['B01', 'A01']);
    expect(w.attempts.records[0]).toMatchObject({ seatIds: ['B01', 'A01'], tierId: 'S', sectionId: 'SEC-B', result: 'HELD' });
  });

  test('FR072_ST35_ 걸린 시간은 단조 시계 차이다(그사이 벽시계를 1분 뒤로 고쳐도 latencyMs는 실제 걸린 7ms, occurredAtMs는 고친 벽시계)', async () => {
    const base = fakeClock({ now: NOW, monotonic: 50 });
    let wallShift = 0;
    const clock: FakeClock = { now: () => base.now() + wallShift, monotonicMs: () => base.monotonicMs(), advance: (ms) => base.advance(ms) };
    const w = await world({
      clock,
      hold: async (i, { inner }) => {
        base.advance(7);
        wallShift = -60_000;
        return inner.hold(i);
      },
    });
    await w.run(['A01']);
    expect(w.attempts.records.map((a) => [a.result, a.latencyMs, a.occurredAtMs])).toEqual([['HELD', 7, NOW + 7 - 60_000]]);
  });
});

describe('HoldSeats.execute: 앱 쪽 거절 전 멱등 재생(ST24, guidelines §4, 추천 적용 2026-11-04)', () => {
  /** 이 요청의 재생 읽기 입력(지문은 요청 좌석 ID를 정렬한 것) */
  const asked = (eventId: string, key: string, seatIds: string[], accountId = ACCOUNT_A): ReplayInput => ({ eventId, accountId, idempotencyKey: key, fingerprint: fingerprintOf(seatIds) });

  test('ST24_ 재현: 잡은 뒤 판매 종료가 지나 같은 키·같은 좌석으로 다시 보내면 410이 아니라 처음 201을 재생하고, 홀드 호출·시도 기록을 늘리지 않는다', async () => {
    const w = await world({ saleEndsAtMs: NOW + 60_000 });
    const key = randomUUID();
    const first = await w.run(['A02', 'A01'], { idempotencyKey: key });
    w.clock.advance(60_000);
    expect(await w.run(['A01', 'A02'], { idempotencyKey: key })).toEqual(first);
    expect(w.calls).toHaveLength(1);
    expect(w.replays).toEqual([asked(w.eventId, key, ['A01', 'A02'])]);
    expect(w.attempts.records.map((a) => a.result)).toEqual(['HELD']);
  });

  test('ST24_② 판매 종료 뒤 같은 키에 다른 좌석이면 422(IDEM_REUSED), 기록이 없는 새 키는 원래대로 410(SALE_ENDED)이다', async () => {
    const w = await world({ saleEndsAtMs: NOW + 60_000 });
    const key = randomUUID();
    await w.run(['A01'], { idempotencyKey: key });
    w.clock.advance(60_000);
    await rejects(w.run(['A03'], { idempotencyKey: key }), 'IDEM_REUSED');
    const fresh = randomUUID();
    await rejects(w.run(['A01'], { idempotencyKey: fresh }), 'SALE_ENDED');
    expect(w.calls).toHaveLength(1);
    expect(w.replays).toEqual([asked(w.eventId, key, ['A03']), asked(w.eventId, fresh, ['A01'])]);
    expect(w.attempts.records.map((a) => a.result)).toEqual(['HELD', 'ERROR', 'ERROR']);
  });

  test('ST24_ 좌석맵 판이 바뀌어 좌석이 사라진 뒤에도 같은 키·같은 좌석은 처음 201을 재생한다. 같은 키에 다른 좌석이면 422 idempotency-key-reused, 새 키는 422 invalid-seat다', async () => {
    const w = await world();
    const key = randomUUID();
    const first = await w.run(['A01', 'A02'], { idempotencyKey: key });
    w.seatMap.put({ eventId: w.eventId, layoutVersion: 'v2', seatCount: SEAT_COUNT, perAccountLimit: w.limit, saleEndsAtMs: w.saleEndsAtMs }, SEAT_DEFS.filter((d) => d.seatId !== 'A01'));
    expect(await w.run(['A02', 'A01'], { idempotencyKey: key })).toEqual(first);
    await rejects(w.run(['A01', 'A03'], { idempotencyKey: key }), 'IDEM_REUSED');
    await rejects(w.run(['A01']), 'INVALID_SEAT');
    expect(w.calls).toHaveLength(1);
    expect(w.replays.slice(0, 2)).toEqual([asked(w.eventId, key, ['A01', 'A02']), asked(w.eventId, key, ['A01', 'A03'])]);
    expect(w.replays).toHaveLength(3);
    expect(w.attempts.records.map((a) => a.result)).toEqual(['HELD', 'ERROR', 'ERROR']);
  });

  test('ST24_ 회차 좌석맵 판(설정)이 없어져도 같은 키·같은 좌석은 처음 201을 재생하고, 새 키는 503(NOT_READY)이다', async () => {
    const w = await world();
    const key = randomUUID();
    const first = await w.run(['A01'], { idempotencyKey: key });
    let gone = false;
    const map: SeatMap = { config: async (e) => (gone ? undefined : w.seatMap.config(e)), resolve: (e, ids) => w.seatMap.resolve(e, ids) };
    const uc = new HoldSeats(w.store, map, w.sessions, w.attempts, w.clock);
    gone = true;
    const cmd = (k: string): HoldCommand => ({ eventId: w.eventId, accountId: ACCOUNT_A, purchaseSessionId: 'ps-a', idempotencyKey: k, body: { seatIds: ['A01'] } });
    expect(await uc.execute(cmd(key))).toEqual(first);
    await rejects(uc.execute(cmd(randomUUID())), 'NOT_READY');
    expect(w.calls).toHaveLength(1);
    expect(w.replays[0]).toEqual(asked(w.eventId, key, ['A01']));
    expect(w.attempts.records.map((a) => a.result)).toEqual(['HELD', 'ERROR']);
  });

  test('ST24_ 세션 401·회차 403·auto 400·좌석 없음 400은 멱등 범위 밖이라 재생보다 먼저다(재생 읽기를 부르지 않는다)', async () => {
    const w = await world();
    const key = randomUUID();
    await w.run(['A01'], { idempotencyKey: key });
    await rejects(w.run(['A01'], { idempotencyKey: key, purchaseSessionId: 'ps-none' }), 'SESSION_NOT_FOUND');
    await rejects(w.run(['A01'], { idempotencyKey: key, accountId: 'a{b}' }), 'SESSION_NOT_FOUND');
    await rejects(w.run(['A01'], { idempotencyKey: key, eventId: w.otherEvent }), 'EVENT_MISMATCH');
    await rejects(w.run(undefined, { idempotencyKey: key, body: { seatIds: ['A01'], auto: { firstTierId: 'R', count: 1, wheelchair: false, allowSplit: false } } }), 'AUTO_AND_SEATS');
    await rejects(w.run([], { idempotencyKey: key }), 'SEATS_REQUIRED');
    expect(w.replays).toHaveLength(0);
    expect(w.calls).toHaveLength(1);
  });

  test('ST24_ 거절하지 않는 요청은 재생 읽기를 따로 부르지 않는다(멱등은 홀드 Lua 안에서 본다)', async () => {
    const w = await world();
    const key = randomUUID();
    const a = await w.run(['A01'], { idempotencyKey: key });
    expect(await w.run(['A01'], { idempotencyKey: key })).toEqual(a);
    expect(w.replays).toHaveLength(0);
    expect(w.calls).toHaveLength(2);
  });
});

describe('HoldSeats.execute: 좌석 Redis 호출 마감(guidelines §5, seat-hold.md §3 좌석 Redis 호출 마감, PRF-135)', () => {
  test('NFR003_ 좌석 Redis를 부르기 전 남은 시간이 5ms 미만이면 504(DEADLINE_EXCEEDED)이고 저장소를 부르지 않으며 시도 기록 ERROR 하나다. 5ms면 부른다', async () => {
    expect(SEAT_CALL_MIN_REMAINING_MS).toBe(5);
    const w = await world();
    await rejects(w.run(['A01'], { deadline: Deadline.after(4, w.clock) }), 'DEADLINE_EXCEEDED');
    // 단조 시계로 잰다: 10ms 마감에서 6ms가 지나면 4ms 남는다
    const d = Deadline.after(10, w.clock);
    w.clock.advance(6);
    await rejects(w.run(['A01'], { deadline: d }), 'DEADLINE_EXCEEDED');
    expect(w.calls).toHaveLength(0);
    expect(w.replays).toHaveLength(0);
    expect(w.attempts.records.map((a) => a.result)).toEqual(['ERROR', 'ERROR']);
    expect(w.ev().bits.size).toBe(0);
    await w.run(['A01'], { deadline: Deadline.after(5, w.clock) });
    expect(w.calls).toHaveLength(1);
  });

  test('NFR003_ 504 경계는 남은 시간 그대로 5ms 미만이다: 4.99ms는 부르지 않고 504, 5ms·5.01ms는 부른다(반올림·올림하지 않는다)', async () => {
    const w = await world();
    /** 남은 시간이 remaining ms인 마감(쓰임새 시계와 따로 둔 단조 시계라 홀드 시각은 정수 그대로다) */
    const left = (remaining: number) => {
      const dc = fakeClock({ monotonic: 0 });
      const d = Deadline.after(10, dc);
      dc.advance(10 - remaining);
      return d;
    };
    await rejects(w.run(['A01'], { deadline: left(4.99) }), 'DEADLINE_EXCEEDED');
    expect(w.calls).toHaveLength(0);
    expect(w.attempts.records.map((a) => a.result)).toEqual(['ERROR']);
    await w.run(['A01'], { deadline: left(5) });
    await w.run(['A02'], { deadline: left(5.01) });
    expect(w.calls).toHaveLength(2);
  });

  test('NFR003_ 저장소를 부를 때 마감은 min(남은 시간, 100ms)이고, 요청 마감이 없으면 둘째 인자를 주지 않는다(플랫폼 기본 100ms)', async () => {
    expect(SEAT_CALL_CAP_MS).toBe(100);
    const w = await world();
    await w.run(['A01'], { deadline: Deadline.after(60, w.clock) });
    await w.run(['A02'], { deadline: Deadline.after(5_000, w.clock) });
    await w.run(['A03']);
    expect(w.holdOpts).toEqual([{ deadlineMs: 60 }, { deadlineMs: 100 }, undefined]);
    // 재생 읽기도 같다(판매 종료 뒤의 거절 앞)
    const s = await world({ saleEndsAtMs: NOW });
    await rejects(s.run(['A01'], { deadline: Deadline.after(30, s.clock) }), 'SALE_ENDED');
    await rejects(s.run(['A01'], { deadline: Deadline.after(15_000, s.clock) }), 'SALE_ENDED');
    await rejects(s.run(['A01']), 'SALE_ENDED');
    expect(s.replayOpts).toEqual([{ deadlineMs: 30 }, { deadlineMs: 100 }, undefined]);
  });

  test('NFR003_ 재생 읽기 앞에서도 마감을 본다: 거절할 요청(판매 종료·좌석맵에 없는 좌석·설정 없음)이 남은 시간 4ms면 재생 읽기를 부르지 않고 504다', async () => {
    const ended = await world({ saleEndsAtMs: NOW });
    await rejects(ended.run(['A01'], { deadline: Deadline.after(4, ended.clock) }), 'DEADLINE_EXCEEDED');
    const bad = await world();
    await rejects(bad.run(['Z99'], { deadline: Deadline.after(4, bad.clock) }), 'DEADLINE_EXCEEDED');
    const none = await world({ noConfig: true });
    await rejects(none.run(['A01'], { deadline: Deadline.after(4, none.clock) }), 'DEADLINE_EXCEEDED');
    for (const w of [ended, bad, none]) {
      expect(w.replays).toHaveLength(0);
      expect(w.calls).toHaveLength(0);
      expect(w.attempts.records.map((a) => a.result)).toEqual(['ERROR']);
    }
  });

  test('NFR003_ 세션 401·회차 403·auto 504·좌석 없음 400은 좌석 Redis를 부르지 않는 단계라 마감보다 먼저다', async () => {
    const w = await world();
    const deadline = Deadline.after(1, w.clock);
    await rejects(w.run(['A01'], { deadline, purchaseSessionId: 'ps-none' }), 'SESSION_NOT_FOUND');
    await rejects(w.run(['A01'], { deadline, eventId: w.otherEvent }), 'EVENT_MISMATCH');
    await rejects(w.run(undefined, { deadline, body: { auto: { firstTierId: 'R', count: 1, wheelchair: false, allowSplit: false } } }), 'DEADLINE_EXCEEDED');
    await rejects(w.run([], { deadline }), 'SEATS_REQUIRED');
    expect(w.calls).toHaveLength(0);
    expect(w.replays).toHaveLength(0);
  });

  test('NFR015_ 부르는 도중 마감을 넘겨 저장소가 SeatStoreUnavailable을 던지면 504가 아니라 503(STORE_UNAVAILABLE)이다', async () => {
    const late = new SeatStoreUnavailable(new Error('deadline'));
    const w = await world({ hold: async () => Promise.reject(late) });
    const e = await rejects(w.run(['A01'], { deadline: Deadline.after(50, w.clock) }), 'STORE_UNAVAILABLE');
    expect(e.details.cause ?? e.cause).toBe(late);
    expect(w.calls).toHaveLength(1);
  });
});

describe('HoldSeats.execute: 메모리 부족과 좌석 Lua 지표(seat_lua_errors_total, PRF-135)', () => {
  test('NFR015_ 메모리 부족(SeatStoreUnavailable reason oom)은 503(STORE_UNAVAILABLE, storeReason oom, cause 그대로)이고 지표 {hold, OOM}을 한 번 올린다. 일시 장애는 storeReason unavailable이고 지표를 올리지 않는다 [ASVS v5.0.0-16.3.4] [ASVS v5.0.0-16.5.3]', async () => {
    const oom = new SeatStoreUnavailable(new Error("OOM command not allowed when used memory > 'maxmemory'."), 'oom');
    const w = await world({ hold: async () => Promise.reject(oom) });
    const e = await rejects(w.run(['A01']), 'STORE_UNAVAILABLE');
    expect(e.details.storeReason).toBe('oom');
    expect(e.details.cause ?? e.cause).toBe(oom);
    expect(w.signals.calls).toEqual([['hold', 'OOM']]);
    expect(w.attempts.records.map((a) => a.result)).toEqual(['ERROR']);
    expect(w.calls).toHaveLength(1);
    const down = new SeatStoreUnavailable(new Error('down'));
    const u = await world({ hold: async () => Promise.reject(down) });
    const ue = await rejects(u.run(['A01']), 'STORE_UNAVAILABLE');
    expect(ue.details.storeReason).toBe('unavailable');
    expect(u.signals.calls).toEqual([]);
  });

  test('ST26_③ 홀드 Lua가 NOT_READY면 503이고 지표 {hold, NOT_READY}를 한 번 올린다. 업무 거절(경합·한도·정지·멱등 키 재사용)과 성공은 올리지 않는다 [ASVS v5.0.0-16.3.4]', async () => {
    const w = await world({ hold: returns({ kind: 'NOT_READY' }) });
    await rejects(w.run(['A01']), 'NOT_READY');
    expect(w.signals.calls).toEqual([['hold', 'NOT_READY']]);
    const others: HoldResult[] = [{ kind: 'CONFLICT', seatId: 'A01' }, { kind: 'QUOTA_EXCEEDED' }, { kind: 'PAUSED' }, { kind: 'IDEM_REUSED' }];
    for (const r of others) {
      const b = await world({ hold: returns(r) });
      await b.run(['A01']).catch(() => undefined);
      expect({ kind: r.kind, calls: b.signals.calls }).toEqual({ kind: r.kind, calls: [] });
    }
    const ok = await world();
    await ok.run(['A01']);
    expect(ok.signals.calls).toEqual([]);
  });

  test('ST4_ 홀드 Lua의 쓰기 전 지킴 오류는 바꾸지 않고 던지고, 지표 code를 오류 글로 가른다(CORRUPT_KEY·KEEP_UNTIL_PAST·FENCE_OVERFLOW·OTHER) [ASVS v5.0.0-16.5.3]', async () => {
    const cases: [Error, SeatLuaErrorCode][] = [
      [new Error(`ERR PEAKET_CORRUPT_KEY s:{event:ev-1}:quota:${ACCOUNT_A}`), 'CORRUPT_KEY'],
      [new Error('ERR PEAKET_KEEP_UNTIL_PAST keepUntil 1 now 2'), 'KEEP_UNTIL_PAST'],
      [new Error('ERR PEAKET_FENCE_OVERFLOW 9007199254740992'), 'FENCE_OVERFLOW'],
      [new Error('ERR Error running script'), 'OTHER'],
    ];
    for (const [bug, code] of cases) {
      const w = await world({ hold: async () => Promise.reject(bug) });
      await expect(w.run(['A01'])).rejects.toBe(bug);
      expect({ code, calls: w.signals.calls }).toEqual({ code, calls: [['hold', code]] });
      expect(w.attempts.records.map((a) => a.result)).toEqual(['ERROR']);
    }
  });

  test('NFR015_ 재생 읽기의 오류는 Lua 오류로 세지 않는다: 일시 장애는 503(STORE_UNAVAILABLE), 그 밖은 바꾸지 않고 던진다', async () => {
    const down = new SeatStoreUnavailable(new Error('down'));
    const w = await world({ saleEndsAtMs: NOW, replay: async () => Promise.reject(down) });
    const e = await rejects(w.run(['A01']), 'STORE_UNAVAILABLE');
    expect(e.details.cause ?? e.cause).toBe(down);
    expect(w.signals.calls).toEqual([]);
    const bug = new Error('멱등 기록 모양이 틀렸다');
    const b = await world({ saleEndsAtMs: NOW, replay: async () => Promise.reject(bug) });
    await expect(b.run(['A01'])).rejects.toBe(bug);
    expect(b.signals.calls).toEqual([]);
  });

  test('NFR015_ 재생 읽기가 일시 장애면 원래 거절(판매 종료 410·좌석맵에 없는 좌석 422·설정 없음 503 NOT_READY)이 아니라 503 STORE_UNAVAILABLE이다(처음 요청이 잡은 홀드를 잃지 않게, seat-hold §3)', async () => {
    const down = async () => Promise.reject(new SeatStoreUnavailable(new Error('down')));
    const ended = await world({ saleEndsAtMs: NOW, replay: down });
    await rejects(ended.run(['A01']), 'STORE_UNAVAILABLE');
    const bad = await world({ replay: down });
    await rejects(bad.run(['Z99']), 'STORE_UNAVAILABLE');
    const none = await world({ noConfig: true, replay: down });
    await rejects(none.run(['A01']), 'STORE_UNAVAILABLE');
    for (const x of [ended, bad, none]) {
      expect(x.calls).toHaveLength(0);
      expect(x.replays).toHaveLength(1);
      expect(x.attempts.records.map((a) => a.result)).toEqual(['ERROR']);
    }
  });
});

describe('메모리 저장소의 시각 경계(Valkey Lua는 Redis TIME을 정할 수 없어 hold-cases에 두지 못한다)', () => {
  test('ST6_FR042_ 만료 Lua의 지금 경계(메모리 시계): Hash exp = 지금이면 풀고 지금 + 1ms면 건너뛰며, rel 점수·수명은 정확히 지금 + 30초, keepUntil = 지금이면 PEAKET_KEEP_UNTIL_PAST다', async () => {
    const h = memoryExpiryHarness();
    const e = newEvent();
    const keepUntilMs = NOW + 2 * DAY;
    await h.store.openSale({ eventId: e, seatCount: SEAT_COUNT, keepUntilMs });
    expect((await h.store.hold(holdInput(e, ['A01'], { keepUntilMs, accountId: ACCOUNT_A }))).kind).toBe('OK');
    expect((await h.store.hold(holdInput(e, ['A02'], { keepUntilMs, accountId: ACCOUNT_B }))).kind).toBe('OK');
    await h.setHoldField(e, ref('A01').index, 'exp', String(NOW));
    await h.setExpiry(e, String(ref('A01').index), NOW);
    await h.setHoldField(e, ref('A02').index, 'exp', String(NOW + 1));
    await h.setExpiry(e, String(ref('A02').index), NOW);
    const d = await h.store.dueExpiries({ eventId: e, nowMs: NOW, limit: 100 });
    const seats = d.map((x) => ({ index: x.index, expected: x.hold, seat: ref(x.index === ref('A01').index ? 'A01' : 'A02') }));
    await expectBug(h.store.expire({ eventId: e, keepUntilMs: NOW, seats }), { keepUntil: '지금' });
    const r = okOf(await h.store.expire({ eventId: e, keepUntilMs, seats }));
    expect({ nowUs: r.nowUs, released: r.released, skipped: r.skipped }).toEqual({ nowUs: NOW * 1000, released: 1, skipped: 1 });
    expect(r.expired.map((x) => x.index)).toEqual([ref('A01').index]);
    expect(await h.rel(e, ACCOUNT_A)).toEqual({ [String(ref('A01').index)]: NOW + 30_000 });
    expect(await h.expireAt(e, seatKeys.rel(e, ACCOUNT_A))).toBe(NOW + 30_000);
  });

  test('FR010_ST4_ keepUntilMs가 저장소 시각과 같으면 일시 장애가 아닌 Error이고 아무것도 쓰지 않으며, 1ms 뒤면 잡는다', async () => {
    const h = memoryHarness();
    const e = newEvent();
    await h.store.openSale({ eventId: e, seatCount: SEAT_COUNT, keepUntilMs: NOW + DAY });
    const key = randomUUID();
    await expectBug(h.store.hold(holdInput(e, ['A01'], { keepUntilMs: NOW, idempotencyKey: key })), { keepUntil: '지금' });
    expect(await h.bit(e, ref('A01').index)).toBe(0);
    expect(await h.quota(e, ACCOUNT_A)).toBeNull();
    expect(await h.fence(e)).toBeNull();
    expect(await h.stream(e)).toHaveLength(0);
    expect(await h.idem(e, ACCOUNT_A, key)).toBeNull();
    expect(await h.expireAt(e, seatKeys.bitmap(e))).toBe(NOW + DAY);
    expect((await h.store.hold(holdInput(e, ['A01'], { keepUntilMs: NOW + 1 }))).kind).toBe('OK');
  });

  test('ST33_ 방금 놓은 좌석은 점수가 지금보다 클 때만 막는다: 점수 = 지금 + 1ms는 REHOLD_WAIT, 점수 = 지금은 잡는다', async () => {
    const h = memoryHarness();
    const e = newEvent();
    const keepUntilMs = NOW + 2 * DAY;
    await h.store.openSale({ eventId: e, seatCount: SEAT_COUNT, keepUntilMs });
    await h.setRel(e, ACCOUNT_A, ref('A01').index, NOW + 1);
    await h.setRel(e, ACCOUNT_A, ref('A02').index, NOW);
    expect(await h.store.hold(holdInput(e, ['A01'], { keepUntilMs }))).toEqual({ kind: 'REHOLD_WAIT', seatIds: ['A01'], availableAtMs: NOW + 1 });
    expect((await h.store.hold(holdInput(e, ['A02'], { keepUntilMs }))).kind).toBe('OK');
  });

  test('ST24_⑤ 멱등 기록은 7분에서 1ms 모자랄 때까지 재생하고, 7분이 지나면 새로 처리한다', async () => {
    const h = memoryHarness();
    const e = newEvent();
    const keepUntilMs = NOW + 2 * DAY;
    await h.store.openSale({ eventId: e, seatCount: SEAT_COUNT, keepUntilMs });
    const k = randomUUID();
    const first = await h.store.hold(holdInput(e, ['A01'], { keepUntilMs, idempotencyKey: k }));
    expect(first.kind).toBe('OK');
    (h.clock as FakeClock).advance(IDEM_TTL_MS - 1);
    expect((await h.store.hold(holdInput(e, ['A01'], { keepUntilMs, idempotencyKey: k }))).kind).toBe('IDEM_REPLAY');
    (h.clock as FakeClock).advance(2);
    // 수명이 지나 기록이 없으므로 새 홀드로 본다(A01은 자기가 잡은 좌석이라 경합)
    expect(await h.store.hold(holdInput(e, ['A01'], { keepUntilMs, idempotencyKey: k }))).toEqual({ kind: 'CONFLICT', seatId: 'A01' });
  });
});

describe('문제 상세 대응(throwHoldProblem, application/hold-error.ts의 대응표)', () => {
  function thrown(code: HoldErrorCode, details: HoldErrorDetails = {}) {
    const headers: [string, string][] = [];
    const e = new HoldError(code, '시험', details);
    let err: unknown;
    try {
      throwHoldProblem(e, { header: (n: string, v: string) => headers.push([n.toLowerCase(), v]) });
    } catch (x) {
      err = x;
    }
    // HTTP 오류(ProblemError·Nest 예외)가 아니면 그 오류를 그대로 드러낸다(돌아오지 않고 던져야 한다)
    if (!(err instanceof ProblemError || err instanceof HttpException)) throw err ?? new Error(`${code}: throwHoldProblem이 던지지 않았다`);
    return { e, err, headers };
  }

  test('FR010_ 이름 있는 거절은 ProblemError이고 type·status·Retry-After·정상 분기·detail·cause가 정해진 값이며 머리를 달지 않는다', () => {
    // [코드, 상태, problem 이름, Retry-After, 정상 분기(409만), detail]
    const named: [HoldErrorCode, number, string, number | undefined, boolean, string | undefined][] = [
      ['AUTO_NOT_SUPPORTED', 400, 'auto-assign-not-supported', undefined, false, '지금은 좌석 지정(seatIds)만 받습니다'],
      ['INVALID_SEAT', 422, 'invalid-seat', undefined, false, undefined],
      ['SALE_ENDED', 410, 'sale-ended', undefined, false, undefined],
      ['NOT_READY', 503, 'seat-store-unavailable', 2, false, undefined],
      ['STORE_UNAVAILABLE', 503, 'seat-store-unavailable', 2, false, undefined],
      ['IDEM_REUSED', 422, 'idempotency-key-reused', undefined, false, undefined],
      ['PAUSED', 423, 'sale-paused', undefined, false, undefined],
      ['CONFLICT', 409, 'seat-already-held', undefined, true, undefined],
      ['QUOTA_EXCEEDED', 422, 'purchase-limit-exceeded', undefined, false, undefined],
    ];
    for (const [code, status, slug, retry, normal, detail] of named) {
      const { e, err, headers } = thrown(code);
      expect({ code, isProblem: err instanceof ProblemError }).toEqual({ code, isProblem: true });
      const p = err as ProblemError;
      expect({ code, status: p.status, type: p.type, title: p.title, retry: p.retryAfterSeconds, normal: p.normalBranch, detail: p.detail, ext: p.extensions, causeIsHoldError: p.cause === e }).toEqual({
        code,
        status,
        type: `${PROBLEM_TYPE_BASE}${slug}`,
        title: HOLD_PROBLEMS[code].title,
        retry,
        normal,
        detail,
        ext: {},
        causeIsHoldError: true,
      });
      expect({ code, headers }).toEqual({ code, headers: [] });
    }
  });

  test('ST33_ REHOLD_WAIT는 409 seat-recently-released(정상 분기)이고 확장 칸 recentlyReleasedSeats·reholdAvailableAt(ISO 8601 Z, 밀리초 셋째 자리)을 싣는다', () => {
    const { e, err } = thrown('REHOLD_WAIT', { recentlyReleasedSeats: ['A01', 'A03'], reholdAvailableAtMs: NOW + 30_007 });
    expect(err).toBeInstanceOf(ProblemError);
    const p = err as ProblemError;
    expect({ status: p.status, type: p.type, normal: p.normalBranch, ext: p.extensions, cause: p.cause === e }).toEqual({
      status: 409,
      type: `${PROBLEM_TYPE_BASE}seat-recently-released`,
      normal: true,
      ext: { recentlyReleasedSeats: ['A01', 'A03'], reholdAvailableAt: '2026-11-04T03:00:30.007Z' },
      cause: true,
    });
  });

  test('PRF192_FR010_ 세션 없음은 WWW-Authenticate(Cookie realm="peaket")를 단 401 purchase-session-ended다(플랫폼 구매 요청 확인의 no_session과 같은 본문) [ASVS v5.0.0-8.2.1]', () => {
    const { e, err, headers } = thrown('SESSION_NOT_FOUND');
    expect(err).toBeInstanceOf(ProblemError);
    const p = err as ProblemError;
    expect({ status: p.status, type: p.type, title: p.title, detail: p.detail, normal: p.normalBranch, cause: p.cause === e }).toEqual({
      status: 401,
      type: `${PROBLEM_TYPE_BASE}purchase-session-ended`,
      title: '예매 시간이 끝났습니다',
      detail: undefined,
      normal: false,
      cause: true,
    });
    expect(headers).toEqual([['www-authenticate', COOKIE_CHALLENGE]]);
  });

  test('FR010_ 403은 Nest 403, 좌석 없음은 요청 검사 400이다(이름 없는 오류)', () => {
    const f = thrown('EVENT_MISMATCH');
    expect(f.err).toBeInstanceOf(ForbiddenException);
    expect(f.err).not.toBeInstanceOf(ProblemError);
    expect(f.headers).toEqual([]);
    const s = thrown('SEATS_REQUIRED');
    expect(s.err).toBeInstanceOf(RequestValidationError);
    expect(s.headers).toEqual([]);
  });

  test('NFR003_ DEADLINE_EXCEEDED는 504 deadline-exceeded(플랫폼 deadlineExceeded와 같은 제목, Retry-After 없음, 정상 분기 아님)이다', () => {
    const { e, err, headers } = thrown('DEADLINE_EXCEEDED');
    expect(err).toBeInstanceOf(ProblemError);
    const p = err as ProblemError;
    expect({ status: p.status, type: p.type, title: p.title, retry: p.retryAfterSeconds, normal: p.normalBranch, ext: p.extensions, cause: p.cause === e }).toEqual({
      status: 504,
      type: `${PROBLEM_TYPE_BASE}deadline-exceeded`,
      title: '남은 처리 시간이 모자라 요청을 끝내지 못했습니다',
      retry: undefined,
      normal: false,
      ext: {},
      cause: true,
    });
    expect(headers).toEqual([]);
  });

  test('NFR015_ storeUnavailableError는 까닭과 관계없이 STORE_UNAVAILABLE·같은 메시지이고 storeReason·cause를 싣는다. 응답은 까닭 oom이어도 503 seat-store-unavailable·Retry-After 2이고 까닭을 싣지 않는다 [ASVS v5.0.0-16.3.4]', () => {
    const oom = new SeatStoreUnavailable(new Error('OOM command not allowed'), 'oom');
    const down = new SeatStoreUnavailable(new Error('down'));
    const a = storeUnavailableError(oom);
    const b = storeUnavailableError(down);
    expect({ code: a.code, msg: a.message, reason: a.details.storeReason, cause: a.details.cause === oom }).toEqual({ code: 'STORE_UNAVAILABLE', msg: '좌석 Redis를 잠시 쓸 수 없다', reason: 'oom', cause: true });
    expect({ code: b.code, msg: b.message, reason: b.details.storeReason, cause: b.details.cause === down }).toEqual({ code: 'STORE_UNAVAILABLE', msg: '좌석 Redis를 잠시 쓸 수 없다', reason: 'unavailable', cause: true });
    const shape = (x: ProblemError) => ({ status: x.status, type: x.type, title: x.title, retry: x.retryAfterSeconds, ext: x.extensions, detail: x.detail });
    const pa = thrown('STORE_UNAVAILABLE', a.details).err as ProblemError;
    const pb = thrown('STORE_UNAVAILABLE', b.details).err as ProblemError;
    expect(shape(pa)).toEqual(shape(pb));
    expect(shape(pa)).toEqual({ status: 503, type: `${PROBLEM_TYPE_BASE}seat-store-unavailable`, title: HOLD_PROBLEMS.STORE_UNAVAILABLE.title, retry: SEAT_STORE_RETRY_AFTER_SEC, ext: {}, detail: undefined });
    expect(JSON.stringify(shape(pa))).not.toMatch(/oom/i);
  });
});

describe('홀드 지문(holdFingerprint, seat-hold.md §3 멱등키의 지문)', () => {
  test('FR010_ST24_ 지문은 좌석 ID를 문자 코드 순으로 정렬해 LF로 이은 UTF-8의 SHA-256 소문자 hex 64자이고, 보낸 차례와 관계없으며 입력을 바꾸지 않는다', () => {
    const ids = ['B02', 'A01', 'A03'];
    // 'A01\nA03\nB02'의 SHA-256(파이썬 hashlib로 따로 계산)
    expect(holdFingerprint(ids)).toBe('97a53bd1cb8b049f0e44d40ae5f8499fa728e72267039102833f38e8977b3528');
    expect(holdFingerprint(['A03', 'B02', 'A01'])).toBe('97a53bd1cb8b049f0e44d40ae5f8499fa728e72267039102833f38e8977b3528');
    expect(ids).toEqual(['B02', 'A01', 'A03']);
    expect(holdFingerprint(['A01'])).toBe('e98ed8057af14fe0a3b3899dd1bb049470a22373e84adc596dea6edb03a270dc');
    // 문자 코드 순: '-'(45) < 'B'(66) < '_'(95) < 'a'(97). 지역 정렬(localeCompare)이 아니다
    expect(holdFingerprint(['a', 'B', '_', '-'])).toBe('f18b14a4e118bcd08bdd718da26f2ba2bcabf3924a2ba0bafe754968a7fd2760');
    expect(holdFingerprint(['A01', 'A03', 'B02'])).toBe(fingerprintOf(['B02', 'A03', 'A01']));
  });

  test('FR010_ 빈 좌석 목록의 지문은 RangeError다', () => {
    expectRangeError(() => holdFingerprint([]));
  });
});

describe('시험 대역의 계약', () => {
  const cfg = (eventId: string, seatCount = 2) => ({ eventId, layoutVersion: 'v1', seatCount, perAccountLimit: 2, saleEndsAtMs: NOW + DAY });
  const seat = (o: Partial<MemorySeatDef> = {}): MemorySeatDef => ({ seatId: 'A01', index: 0, sectionId: 'SEC-A', sectionIndex: 0, seatOffset: 0, tierId: 'R', ...o });

  test('FR010_ 좌석맵 판은 좌석 ID·색인 겹침, 색인 범위(0 ~ seatCount − 1) 밖, 0 이상의 정수가 아닌 구역 색인·구역 안 거리, 모양이 틀린 좌석 ID를 RangeError로 막는다 [ASVS v5.0.0-1.3.3] [ASVS v5.0.0-1.4.2] [ASVS v5.0.0-15.3.5]', () => {
    const m = new MemorySeatMap();
    const bad: MemorySeatDef[][] = [
      [seat(), seat({ index: 1 })],
      [seat(), seat({ seatId: 'A02' })],
      [seat({ index: -1 })],
      [seat({ index: 2 })],
      [seat({ index: 0.5 })],
      [seat({ index: Number.NaN })],
      [seat({ sectionIndex: -1 })],
      [seat({ sectionIndex: 1.5 })],
      [seat({ seatOffset: -1 })],
      [seat({ seatOffset: 0.5 })],
      [seat({ seatId: 'A 1' })],
      [seat({ seatId: '' })],
      [seat({ seatId: 'x'.repeat(65) })],
      [seat({ seatId: 's:{event:e}' })],
    ];
    for (const seats of bad) expectRangeError(() => m.put(cfg('ev-bad'), seats), seats);
    // 경계: 마지막 색인 seatCount − 1, 64자 좌석 ID는 된다
    expect(() => m.put(cfg('ev-ok'), [seat(), seat({ seatId: `B${'x'.repeat(63)}`, index: 1 })])).not.toThrow();
  });

  test('FR010_ 좌석맵 판의 resolve는 같은 길이·차례이고, 없는 좌석·판매 제외석·다른 회차 좌석·넣지 않은 회차는 undefined, 같은 ID 두 번은 두 자리 모두 같은 좌석이며 판매 제외 표시를 싣지 않는다', async () => {
    const m = new MemorySeatMap();
    const a = cfg('ev-a', SEAT_COUNT);
    m.put(a, [...SEAT_DEFS.filter((d) => d.seatId !== 'A01'), { ...ref('A01'), saleExcluded: false }]);
    m.put(cfg('ev-b', 10), [OTHER_SEAT]);
    expect(await m.resolve('ev-a', ['B01', 'Z99', 'A01', 'X01', 'C01', 'A01'])).toStrictEqual([ref('B01'), undefined, ref('A01'), undefined, undefined, ref('A01')]);
    expect(await m.resolve('ev-none', ['A01', 'A02'])).toEqual([undefined, undefined]);
    expect(await m.config('ev-a')).toEqual(a);
    expect(await m.config('ev-none')).toBeUndefined();
    // 다시 넣으면 통째로 바꾼다
    m.put(cfg('ev-a', SEAT_COUNT), [ref('A02')]);
    expect(await m.resolve('ev-a', ['A01', 'A02'])).toEqual([undefined, ref('A02')]);
  });

  test('FR042_ 좌석맵 판의 byIndex는 같은 길이·차례이고, 판매 제외석도 좌석을 주며(제외 표시 없이), 판에 없는 색인·넣지 않은 회차는 undefined, 같은 색인 두 번은 두 자리 모두 같은 좌석이다. 다시 넣으면 바뀐 판을 본다', async () => {
    const m = new MemorySeatMap();
    m.put(cfg('ev-a', SEAT_COUNT), SEAT_DEFS);
    const x01 = SEAT_DEFS.find((d) => d.seatId === 'X01')!;
    const { saleExcluded: _x, ...x01Ref } = x01;
    expect(await m.byIndex('ev-a', [ref('B01').index, 35, x01.index, ref('A01').index, 40, -1, ref('A01').index])).toStrictEqual([
      ref('B01'),
      undefined,
      x01Ref,
      ref('A01'),
      undefined,
      undefined,
      ref('A01'),
    ]);
    expect(await m.byIndex('ev-none', [0, 1])).toEqual([undefined, undefined]);
    expect(await m.byIndex('ev-a', [])).toEqual([]);
    m.put(cfg('ev-a', SEAT_COUNT), [ref('A02')]);
    expect(await m.byIndex('ev-a', [ref('A01').index, ref('A02').index])).toEqual([undefined, ref('A02')]);
  });

  test('FR010_ 구매 세션 대역: 열기·읽기(상태 칸만 사본)·일련번호 올리기·플랫폼 resolve·끝내기', async () => {
    const s = new MemoryPurchaseSessions();
    s.open({ sessionId: 'ps-1', accountId: ACCOUNT_A, eventId: 'ev-1', journeyId: JNY_A, loginSessionId: 'ls-1', key: KEY });
    expect(await s.get('ps-1')).toStrictEqual({ sessionId: 'ps-1', accountId: ACCOUNT_A, eventId: 'ev-1', journeyId: JNY_A });
    expect(s.lastSeq('ps-1')).toBe(0);
    expect(await s.advance('ps-1', 1)).toBe(true);
    expect(await s.advance('ps-1', 1)).toBe(false);
    expect(await s.advance('ps-1', 0)).toBe(false);
    expect(await s.advance('ps-1', 5)).toBe(true);
    expect(s.lastSeq('ps-1')).toBe(5);
    expect(await s.advance('ps-none', 9)).toBe(false);
    expect(s.lastSeq('ps-none')).toBeUndefined();
    const me = { accountId: ACCOUNT_A, sessionId: 'ls-1', aud: 'fan', scopes: [] } as Principal;
    const req = {} as FastifyRequest;
    const found = await s.resolve(req, me);
    expect(found?.ref).toBe('ps-1');
    expect(Buffer.from(found!.key as Uint8Array).equals(KEY)).toBe(true);
    expect(await s.resolve(req, { ...me, sessionId: 'ls-2' })).toBeUndefined();
    expect(await s.resolve(req, { ...me, accountId: ACCOUNT_B })).toBeUndefined();
    // 같은 계정·로그인 세션에 다른 구매 세션은 열 수 없다. 같은 ID는 바꾼다
    expect(() => s.open({ sessionId: 'ps-2', accountId: ACCOUNT_A, eventId: 'ev-1', journeyId: JNY_A, loginSessionId: 'ls-1', key: KEY })).toThrow(RangeError);
    s.open({ sessionId: 'ps-1', accountId: ACCOUNT_A, eventId: 'ev-2', journeyId: JNY_A, loginSessionId: 'ls-1', key: KEY });
    expect((await s.get('ps-1'))?.eventId).toBe('ev-2');
    s.end('ps-1');
    s.end('ps-none');
    expect(await s.get('ps-1')).toBeUndefined();
    expect(await s.resolve(req, me)).toBeUndefined();
  });

  test('FR072_ 시도 기록 대역은 받은 차례대로 사본을 쌓는다', () => {
    const r = new RecordingHoldAttempts();
    const a = { eventId: 'e', accountId: ACCOUNT_A, purchaseSessionId: 'ps', journeyId: JNY_A, mode: 'PICK' as const, seatIds: ['A01'], result: 'HELD' as const, heldAtMs: NOW, occurredAtMs: NOW, latencyMs: 1 };
    r.record(a);
    r.record({ ...a, result: 'CONFLICT', heldAtMs: undefined });
    // 넘긴 객체를 나중에 바꿔도 쌓인 기록은 그대로다(겉 칸 사본)
    a.latencyMs = 99;
    expect(r.records.map((x) => [x.result, x.latencyMs])).toEqual([
      ['HELD', 1],
      ['CONFLICT', 1],
    ]);
    expect(r.records[0]).not.toBe(a);
  });
});

describe('HoldSeats.execute: 인증 세션 재사용(BAT-028, HOT-463)', () => {
  const resolved = (w: Awaited<ReturnType<typeof world>>, over: Partial<ResolvedPurchaseSessionInfo> = {}): ResolvedPurchaseSessionInfo => ({
    sessionId: 'ps-a',
    accountId: ACCOUNT_A,
    eventId: w.eventId,
    journeyId: JNY_A,
    ...over,
  });

  test('BAT028_인증이_읽은_세션을_넘기면_sessions.get을_부르지_않고_같은_홀드를_한다', async () => {
    const w = await world();
    const innerGet = w.sessions.get.bind(w.sessions);
    let gets = 0;
    w.sessions.get = async (id: string) => {
      gets += 1;
      return innerGet(id);
    };
    const r = await w.run([SEAT_DEFS[0]!.seatId], { session: resolved(w) });
    expect(r.seatIds).toEqual([SEAT_DEFS[0]!.seatId]);
    expect(gets).toBe(0);
  });

  test('BAT028_넘긴_세션도_계정과_회차를_다시_대조한다', async () => {
    const w = await world();
    await rejects(w.run([SEAT_DEFS[0]!.seatId], { accountId: ACCOUNT_B, purchaseSessionId: 'ps-b', session: resolved(w) }), 'SESSION_NOT_FOUND');
    await rejects(w.run([SEAT_DEFS[0]!.seatId], { session: resolved(w, { eventId: w.otherEvent }) }), 'EVENT_MISMATCH');
  });

  test('BAT028_최대체류경계는_넘긴_세션에서도_다시_본다', async () => {
    const w = await world();
    await rejects(w.run([SEAT_DEFS[0]!.seatId], { session: resolved(w, { maxStayUntilMs: NOW }) }), 'SESSION_NOT_FOUND');
    const r = await w.run([SEAT_DEFS[0]!.seatId], { session: resolved(w, { maxStayUntilMs: NOW + 1 }) });
    expect(r.seatIds).toEqual([SEAT_DEFS[0]!.seatId]);
  });

  test('BAT028_세션을_넘기지_않으면_기존처럼_sessions.get을_한_번_부른다', async () => {
    const w = await world();
    const innerGet = w.sessions.get.bind(w.sessions);
    let gets = 0;
    w.sessions.get = async (id: string) => {
      gets += 1;
      return innerGet(id);
    };
    await w.run([SEAT_DEFS[0]!.seatId]);
    expect(gets).toBe(1);
  });
});

describe('HoldSeats.execute: 자동 배정(BUILD_ORDER HOT-080) [S-T19] [S-T20] [ASVS v5.0.0-2.2.1] [ASVS v5.0.0-2.2.2] [ASVS v5.0.0-2.2.3]', () => {
  const auto = (over: Record<string, unknown> = {}) => ({ firstTierId: 'R', count: 2, wheelchair: false, allowSplit: false, ...over });

  test('연석 후보를 잡고 assignResult FIRST·mode AUTO로 시도 기록을 남긴다', async () => {
    const w = await world();
    const r = await w.run(undefined, { body: { auto: auto() } });
    expect(r.assignResult).toBe('FIRST');
    expect(r.seatIds).toEqual(['A01', 'A02']);
    expect(w.attempts.records[0]).toMatchObject({ mode: 'AUTO', result: 'HELD', seatIds: ['A01', 'A02'], tierId: 'R', sectionId: 'SEC-A' });
    // 직접 선택 홀드 경로는 부르지 않는다
    expect(w.calls).toHaveLength(0);
    expect([...w.ev().bits].sort((a, b) => a - b)).toEqual([0, 1]);
  });

  test('1순위가 모두 차면 2순위 등급으로 내려간다', async () => {
    const w = await world();
    for (let i = 0; i < 20; i++) w.ev().bits.add(i);
    const r = await w.run(undefined, { body: { auto: auto({ secondTierId: 'S' }) } });
    expect(r.assignResult).toBe('SECOND');
    expect(r.seatIds).toEqual(['B01', 'B02']);
  });

  test('연석이 없고 분리 허용이면 분리 후보로 잡는다', async () => {
    const w = await world();
    for (const i of [0, 2, 4, 6, 8, 10, 12, 14, 16, 18]) w.ev().bits.add(i);
    const r = await w.run(undefined, { body: { auto: auto({ allowSplit: true }) } });
    expect(r.assignResult).toBe('FIRST_SPLIT');
    expect(r.seatIds).toEqual(['A02', 'A04']);
  });

  test('후보가 모두 차면 409 manual-selection-required이고 아무 좌석도 잡지 않는다', async () => {
    const w = await world();
    for (let i = 0; i < 30; i++) w.ev().bits.add(i);
    await rejects(w.run(undefined, { body: { auto: auto({ secondTierId: 'S' }) } }), 'MANUAL_SELECTION_REQUIRED');
    expect(w.attempts.records.map((a) => a.result)).toEqual(['ERROR']);
    expect(w.ev().bits.size).toBe(30);
    expect(w.calls).toHaveLength(0);
  });

  test('같은 멱등 키·같은 조건이면 처음 응답을 재생하고 새 홀드를 만들지 않는다', async () => {
    const w = await world();
    const key = randomUUID();
    const first = await w.run(undefined, { idempotencyKey: key, body: { auto: auto() } });
    const second = await w.run(undefined, { idempotencyKey: key, body: { auto: auto() } });
    expect(second).toEqual(first);
    expect(w.ev().bits.size).toBe(2);
    expect(w.attempts.records.filter((a) => a.result === 'HELD')).toHaveLength(1);
  });

  test('매수 초과·같은 등급·없는 등급·휠체어석 없는 등급을 가른다', async () => {
    const w = await world();
    await rejects(w.run(undefined, { body: { auto: auto({ count: 5 }) } }), 'QUOTA_EXCEEDED');
    await rejects(w.run(undefined, { body: { auto: auto({ secondTierId: 'R' }) } }), 'AUTO_CONDITION_INVALID');
    await rejects(w.run(undefined, { body: { auto: auto({ firstTierId: 'NOPE' }) } }), 'AUTO_TIER_UNKNOWN');
    await rejects(w.run(undefined, { body: { auto: auto({ wheelchair: true }) } }), 'AUTO_CONDITION_INVALID');
    expect(w.ev().bits.size).toBe(0);
  });

  test('자동 배정 커서 읽기가 좌석 Redis 일시 장애면 503(STORE_UNAVAILABLE)이고 좌석을 잡지 않는다', async () => {
    const down = new SeatStoreUnavailable(new Error('down'));
    const w = await world({ autoCursor: async () => Promise.reject(down) });
    const e = await rejects(w.run(undefined, { body: { auto: auto() } }), 'STORE_UNAVAILABLE');
    expect(e.details.cause ?? e.cause).toBe(down);
    expect(w.ev().bits.size).toBe(0);
  });
});

describe('HoldSeats.execute: 핫패스 구간 진단(BAT-027, HOT-462)', () => {
  test('BAT027_ 성공과 409 경합을 각각 outcome으로 세고, 구간 시간(hold.total·hold.lua)을 남긴다', async () => {
    const registry = new PlatformMetrics('purchase-svc').registry;
    const hotPath = new HotPathMetrics('purchase-svc').register(registry);
    let conflict = false;
    const w = await world({
      hotPath,
      hold: async (i, { inner }) => (conflict ? { kind: 'CONFLICT', seatId: i.seats[0]!.seatId } : inner.hold(i)),
    });

    await w.run([SEAT_DEFS[0]!.seatId]);
    conflict = true;
    await rejects(w.run([SEAT_DEFS[0]!.seatId]), 'CONFLICT');

    const text = await registry.metrics();
    expect(text).toContain('hot_path_outcomes_total{service="purchase-svc",outcome="ok"} 1');
    expect(text).toContain('hot_path_outcomes_total{service="purchase-svc",outcome="conflict"} 1');
    expect(text).toContain('hot_path_stage_seconds_count{service="purchase-svc",stage="hold.total"} 2');
    expect(text).toContain('hot_path_stage_seconds_count{service="purchase-svc",stage="hold.lua"} 2');
    expect(text).toContain('hot_path_stage_seconds_count{service="purchase-svc",stage="hold.session"} 2');
    // 계정·회차·좌석 ID는 이름표에 없다(카디널리티 규칙, docs/observability.md §8)
    expect(text).not.toContain(ACCOUNT_A);
    expect(text).not.toContain(w.eventId);
    expect(text).not.toContain(SEAT_DEFS[0]!.seatId);
  });
});
