// 구매 세션 정리 반복(SessionSweeper, BUILD_ORDER PRF-138, docs/features/seat-hold.md §2 '구매 세션 종료와 정리'의 '정리 색인과 1초 반복', docs/data.md §3 s:{event:E}:sessions·sesweep,
// 상태 기계 docs/planning/03 §2.2 T4·T5·T10~T12, POL-009 무활동 5분 [가정], ADR-0183 결정 11, Q-T11). 메모리 저장소·메모리 임대·메모리 정리 색인으로 조립하고,
// 시각은 주입한 가짜 시계, 반복은 손으로 tick()을 부른다(고정 sleep 없음). 만료 반복 시험(test/expiry-sweeper.test.ts)과 같은 방식이다.
import { type FakeClock, fakeClock } from '@peaket/platform';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  EndPurchaseSession,
  MemoryPurchaseSessionStore,
  MemorySeatStore,
  MemorySweepLeases,
  RecordingSessionStartedLog,
  type SeatExpiries,
  type SeatSignals,
  SeatStoreUnavailable,
  SESSION_IDLE_MS,
  SESSION_SWEEP_BACKOFF_MS,
  SESSION_SWEEP_BATCH,
  SESSION_SWEEP_LEASE_TTL_MS,
  SESSION_SWEEP_MAX_BATCHES,
  SESSION_SWEEP_POISON_RETRY_MS,
  SESSION_SWEEP_TICK_MS,
  type SessionEndReason,
  type SessionIndex,
  SessionSweeper,
  type SessionSweeperDeps,
  type SessionSweepEventReport,
  type SweepLane,
  type SweepLeases,
  type SweepSessionResult,
  type SweepTimer,
} from '../src/modules/inventory/index.js';
import { newEvent } from './hold-cases.js';
import { JOURNEY, newJti, openInput } from './purchase-session-cases.js';

const NOW = Date.parse('2026-11-04T03:00:00.000Z');
const MIN = 60_000;

/** 손으로 부르는 반복 타이머(SweepTimer: every(ms, run) → { cancel() }) */
function manualTimer() {
  const regs: { everyMs: number; run: () => void; cancelled: number }[] = [];
  const timer: SweepTimer = {
    every(everyMs, run) {
      const r = { everyMs, run, cancelled: 0 };
      regs.push(r);
      return { cancel: () => void (r.cancelled += 1) };
    },
  };
  return { timer, regs };
}

/** 미뤄 둔 약속 */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((ok) => {
    resolve = ok;
  });
  return { promise, resolve };
}

/** 지금 쌓인 약속 작업을 한 바퀴 돌린다(시간을 기다리지 않는다) */
const flush = () => new Promise<void>((r) => setImmediate(r));
/** 조건이 설 때까지 쌓인 작업을 한 바퀴씩 돌린다(400바퀴까지) */
async function settle(ok: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !ok(); i++) await flush();
}

/** 로그 줄 하나 */
interface LogLine {
  level: 'warn' | 'error';
  obj: unknown;
  msg: string;
}

/**
 * 메모리 조립 하나. store·index·expiries·leases는 메모리 구현을 감싸 호출을 적고, fail로 갈래마다 실패를 끼운다.
 * 같은 world의 sweeper 여럿은 같은 저장소·같은 임대·같은 색인을 나눈다(파드 여럿). 정리 색인은 시작 사건 기록(appendStarted)에 기대지 않고 시험이 직접 채운다
 */
function world(o: { clock?: FakeClock } = {}) {
  const clock = o.clock ?? fakeClock({ now: NOW, monotonic: 0 });
  const seats = new MemorySeatStore(clock);
  const sessions = new MemoryPurchaseSessionStore(clock);
  const log = new RecordingSessionStartedLog();
  const leasesInner = new MemorySweepLeases(seats.db, clock);
  const metrics: SessionEndReason[] = [];
  const signals: Pick<SeatSignals, 'sessionEnded'> = { sessionEnded: (r) => void metrics.push(r) };
  const lines: LogLine[] = [];
  const logger = {
    warn: (obj: object, msg: string) => void lines.push({ level: 'warn', obj, msg }),
    error: (obj: object, msg: string) => void lines.push({ level: 'error', obj, msg }),
  };
  const ending = new EndPurchaseSession({ store: sessions, ended: log, clock, signals, logger });
  const calls = {
    saleEvents: 0,
    sweep: [] as string[],
    due: [] as [string, number, number][],
    requeue: [] as [string, string, number][],
    drop: [] as [string, string][],
    acquire: [] as [string, string, number, SweepLane | undefined][],
  };
  /** 갈래마다 끼울 실패(부를 때마다 그 함수를 부르고, 값을 돌려주면 그것을 던진다) */
  const fail: {
    saleEvents?: () => unknown;
    acquire?: (eventId: string) => unknown;
    due?: (eventId: string) => unknown;
    sweep?: (jti: string) => unknown;
    requeue?: () => unknown;
    drop?: () => unknown;
  } = {};
  /** 점검 결과를 시험이 정한다(undefined를 돌려주면 메모리 저장소의 결과) */
  const script: { sweep?: (jti: string) => SweepSessionResult | undefined; afterSweep?: (jti: string, r: SweepSessionResult) => void } = {};
  /** 갈래마다 잠시 붙잡기 */
  const wait: { saleEvents?: () => Promise<void>; due?: () => Promise<void> } = {};
  const expiries: Pick<SeatExpiries, 'saleEvents'> = {
    saleEvents: async () => {
      calls.saleEvents += 1;
      await wait.saleEvents?.();
      const x = fail.saleEvents?.();
      if (x !== undefined) throw x;
      return seats.saleEvents();
    },
  };
  const leases: SweepLeases = {
    acquire: async (e, owner, ttl, lane) => {
      calls.acquire.push([e, owner, ttl, lane]);
      const x = fail.acquire?.(e);
      if (x !== undefined) throw x;
      return leasesInner.acquire(e, owner, ttl, lane);
    },
  };
  const store = {
    sweep: async (jti: string): Promise<SweepSessionResult> => {
      calls.sweep.push(jti);
      const x = fail.sweep?.(jti);
      if (x !== undefined) throw x;
      const r = script.sweep?.(jti) ?? (await sessions.sweep(jti));
      script.afterSweep?.(jti, r);
      return r;
    },
  };
  const index: SessionIndex = {
    due: async (e, nowMs, limit) => {
      calls.due.push([e, nowMs, limit]);
      await wait.due?.();
      const x = fail.due?.(e);
      if (x !== undefined) throw x;
      return log.due(e, nowMs, limit);
    },
    requeue: async (e, jti, atMs) => {
      calls.requeue.push([e, jti, atMs]);
      const x = fail.requeue?.();
      if (x !== undefined) throw x;
      return log.requeue(e, jti, atMs);
    },
    drop: async (e, jti) => {
      calls.drop.push([e, jti]);
      const x = fail.drop?.();
      if (x !== undefined) throw x;
      return log.drop(e, jti);
    },
  };
  const sweeper = (podId = 'pod-a', over: Partial<SessionSweeperDeps> = {}) => new SessionSweeper({ store, index, expiries, leases, ending, clock, podId, logger, ...over });

  /** 판매 중인 회차(회차 목록 s:ctl:events에 넣는다) */
  const addEvent = (eventId = newEvent()) => {
    seats.db.ctlEvents.add(eventId);
    return eventId;
  };
  /** 구매 세션을 열고 정리 색인에 넣는다(점수 기본 = min(최대 체류, 지금 + 유휴 5분)) */
  async function openSession(eventId: string, p: { maxStayMs?: number; indexAt?: number } = {}): Promise<string> {
    const jti = newJti();
    const maxStayUntilMs = clock.now() + (p.maxStayMs ?? 45 * MIN);
    const r = await sessions.open(openInput(clock, jti, { eventId, expiresAtMs: maxStayUntilMs, reissueUntilMs: maxStayUntilMs + 45 * MIN }));
    expect(r.kind).toBe('CREATED');
    const m = log.index.get(eventId) ?? new Map<string, number>();
    m.set(jti, p.indexAt ?? Math.min(maxStayUntilMs, clock.now() + SESSION_IDLE_MS));
    log.index.set(eventId, m);
    return jti;
  }
  const score = (eventId: string, jti: string) => log.index.get(eventId)?.get(jti);
  const indexSize = (eventId: string) => log.index.get(eventId)?.size ?? 0;
  const errorLines = () => lines.filter((l) => l.level === 'error');
  return { clock, seats, sessions, log, leasesInner, metrics, lines, calls, fail, script, wait, expiries, leases, store, index, ending, sweeper, addEvent, openSession, score, indexSize, errorLines };
}

/** 회차 하나의 틱 결과(기본값 0) */
const report = (eventId: string, outcome: SessionSweepEventReport['outcome'], o: Partial<Omit<SessionSweepEventReport, 'eventId' | 'outcome'>> = {}): SessionSweepEventReport => ({
  eventId,
  outcome,
  checked: 0,
  ended: 0,
  gone: 0,
  ...o,
});
const outcomes = (events: readonly SessionSweepEventReport[]) => Object.fromEntries(events.map((e) => [e.eventId, e.outcome]));
const endedOf = (w: ReturnType<typeof world>, jti: string) => w.log.endedEntries.filter((e) => e.purchaseSessionId === jti);

afterEach(() => {
  vi.useRealTimers();
});

describe('SessionSweeper.tick: 점검할 세션을 고르고 끝내거나 다시 놓는다', () => {
  test('QT11_POL009_ 점검 시각이 안 된 세션은 건드리지 않는다: 색인은 지금 이하만 100개까지 읽고 세션 점검도 사건도 없다(DRAINED)', async () => {
    const w = world();
    const eventId = w.addEvent();
    const jti = await w.openSession(eventId);
    const at = w.score(eventId, jti);
    w.clock.advance(SESSION_IDLE_MS - 1);
    const t = await w.sweeper().tick();
    expect(t).toMatchObject({ overlapped: false, events: [report(eventId, 'DRAINED')] });
    expect(t.listFailed).toBeUndefined();
    expect(w.calls.due.length).toBeGreaterThanOrEqual(1);
    expect(w.calls.due.every(([e, nowMs, limit]) => e === eventId && nowMs === NOW + SESSION_IDLE_MS - 1 && limit === SESSION_SWEEP_BATCH)).toBe(true);
    expect(w.calls.sweep).toEqual([]);
    expect(w.score(eventId, jti)).toBe(at);
    expect(await w.sessions.read(jti)).toBeDefined();
    expect(w.log.endedEntries).toEqual([]);
    expect(w.metrics).toEqual([]);
  });

  test('QT11_POL009_T11_ 점검 시각이 되고 무활동 5분이 지났으면 store.sweep으로 점검해 IDLE로 끝내고 SESSION_ENDED(IDLE)를 더하며 색인에서 빠진다. 지표도 한 번이다', async () => {
    const w = world();
    const eventId = w.addEvent();
    const jti = await w.openSession(eventId);
    const keep = await w.openSession(eventId, { indexAt: NOW + 60 * MIN });
    w.clock.advance(SESSION_IDLE_MS);
    const t = await w.sweeper().tick();
    expect(t.events).toMatchObject([report(eventId, 'DRAINED', { checked: 1, ended: 1 })]);
    expect(w.calls.sweep).toEqual([jti]);
    expect(await w.sessions.read(jti)).toBeUndefined();
    expect(w.log.endedEntries).toEqual([{ eventId, purchaseSessionId: jti, admissionJti: jti, reason: 'IDLE', endedAtMs: NOW + SESSION_IDLE_MS }]);
    expect(w.score(eventId, jti)).toBeUndefined();
    // 점검 시각이 안 된 다른 세션은 그대로
    expect(w.score(eventId, keep)).toBe(NOW + 60 * MIN);
    expect(await w.sessions.read(keep)).toBeDefined();
    expect(w.metrics).toEqual(['IDLE']);
  });

  test('QT11_POL009_T12_ 최대 체류에 닿은 세션은 MAX_STAY로 끝낸다(점검 시각은 최대 체류, 1ms 전에는 건드리지 않는다)', async () => {
    const w = world();
    const eventId = w.addEvent();
    const jti = await w.openSession(eventId, { maxStayMs: 3 * MIN });
    expect(w.score(eventId, jti)).toBe(NOW + 3 * MIN);
    w.clock.advance(3 * MIN - 1);
    expect((await w.sweeper().tick()).events).toMatchObject([report(eventId, 'DRAINED')]);
    expect(w.calls.sweep).toEqual([]);
    w.clock.advance(1);
    expect((await w.sweeper().tick()).events).toMatchObject([report(eventId, 'DRAINED', { checked: 1, ended: 1 })]);
    expect(w.log.endedEntries).toEqual([{ eventId, purchaseSessionId: jti, admissionJti: jti, reason: 'MAX_STAY', endedAtMs: NOW + 3 * MIN }]);
    expect(await w.sessions.read(jti)).toBeUndefined();
    expect(w.score(eventId, jti)).toBeUndefined();
    expect(w.metrics).toEqual(['MAX_STAY']);
  });

  test('QT11_POL009_T4_ 요청이 있어 유휴 시한이 밀린 세션은 살아 있음(LIVE)이라 끝나지 않고, 색인 점수가 다음 점검 시각(min(최대 체류, 유휴 시한))으로 바뀐다. 그 시각이 되면 끝난다', async () => {
    const w = world();
    const eventId = w.addEvent();
    const jti = await w.openSession(eventId);
    w.clock.advance(4 * MIN);
    expect(await w.sessions.advance(jti, 1)).toBe(true);
    w.clock.advance(1 * MIN);
    const s = w.sweeper();
    expect((await s.tick()).events).toMatchObject([report(eventId, 'DRAINED', { checked: 1 })]);
    expect(w.calls.sweep).toEqual([jti]);
    expect(w.calls.requeue).toEqual([[eventId, jti, NOW + 9 * MIN]]);
    expect(w.score(eventId, jti)).toBe(NOW + 9 * MIN);
    expect(await w.sessions.read(jti)).toBeDefined();
    expect(w.log.endedEntries).toEqual([]);
    // 같은 시각에 다시 돌아도 점검할 것이 없다
    expect((await s.tick()).events).toMatchObject([report(eventId, 'DRAINED')]);
    expect(w.calls.sweep).toEqual([jti]);
    w.clock.advance(4 * MIN);
    expect((await s.tick()).events).toMatchObject([report(eventId, 'DRAINED', { checked: 1, ended: 1 })]);
    expect(endedOf(w, jti)).toEqual([{ eventId, purchaseSessionId: jti, admissionJti: jti, reason: 'IDLE', endedAtMs: NOW + 9 * MIN }]);
  });

  test('QT11_POL009_ 살아 있는 세션을 다시 놓는 것은 ZADD XX라 그사이 색인에서 빠진 세션(나가기가 먼저 끝냄)은 되살리지 않는다', async () => {
    const w = world();
    const eventId = w.addEvent();
    const jti = await w.openSession(eventId);
    w.clock.advance(4 * MIN);
    await w.sessions.advance(jti, 1);
    w.clock.advance(1 * MIN);
    // 점검 Lua가 살아 있다고 답한 바로 뒤에 나가기가 세션을 끝내고 색인에서 뺀다
    w.script.afterSweep = (id, r) => {
      if (id === jti && r.kind === 'LIVE') w.log.index.get(eventId)!.delete(jti);
    };
    const t = await w.sweeper().tick();
    expect(t.events[0]).toMatchObject({ eventId, outcome: 'DRAINED', checked: 1 });
    expect(w.calls.requeue).toHaveLength(1);
    expect(w.score(eventId, jti)).toBeUndefined();
    expect(w.log.index.get(eventId)?.has(jti)).toBe(false);
  });

  test('QT11_세션이 이미 없으면(GONE) 색인에서 뺀다(drop). 끝내는 사건은 더하지 않고 지표도 올리지 않으며 gone으로 센다', async () => {
    const w = world();
    const eventId = w.addEvent();
    const jti = await w.openSession(eventId);
    // 세션 상태가 키 수명으로 사라졌다(색인 멤버만 남았다)
    w.sessions.endSession(jti);
    w.clock.advance(SESSION_IDLE_MS);
    const t = await w.sweeper().tick();
    expect(t.events).toMatchObject([report(eventId, 'DRAINED', { checked: 1, gone: 1, ended: 0 })]);
    expect(w.calls.drop).toEqual([[eventId, jti]]);
    expect(w.score(eventId, jti)).toBeUndefined();
    expect(w.log.endedEntries).toEqual([]);
    expect(w.metrics).toEqual([]);
    expect(w.calls.requeue).toEqual([]);
  });

  test('QT11_POL009_ 한 틱에 끝난 것·살아 있는 것·이미 없는 것이 섞이면 checked 3, ended 1, gone 1로 세고 각자 알맞게 다룬다', async () => {
    const w = world();
    const eventId = w.addEvent();
    const ends = await w.openSession(eventId);
    const lives = await w.openSession(eventId);
    const gone = await w.openSession(eventId);
    w.sessions.endSession(gone);
    w.clock.advance(4 * MIN);
    await w.sessions.advance(lives, 1);
    w.clock.advance(1 * MIN);
    const t = await w.sweeper().tick();
    expect(t.events).toMatchObject([report(eventId, 'DRAINED', { checked: 3, ended: 1, gone: 1 })]);
    expect([...w.calls.sweep].sort()).toEqual([ends, lives, gone].sort());
    expect(endedOf(w, ends)).toHaveLength(1);
    expect(w.score(eventId, ends)).toBeUndefined();
    expect(w.score(eventId, gone)).toBeUndefined();
    expect(w.score(eventId, lives)).toBe(NOW + 9 * MIN);
    expect(w.metrics).toEqual(['IDLE']);
  });

  test('QT11_ SESSION_ENDED의 끝낸 시각은 점검 결과의 endedAtMs(저장소 시각) 그대로이고 회차는 점검 결과의 회차다', async () => {
    const w = world();
    const eventId = w.addEvent();
    const jti = await w.openSession(eventId);
    w.clock.advance(SESSION_IDLE_MS);
    w.script.sweep = (id) => (id === jti ? { kind: 'ENDED', reason: 'IDLE', eventId, journeyId: JOURNEY, endedAtMs: NOW + SESSION_IDLE_MS - 555 } : undefined);
    await w.sweeper().tick();
    expect(w.log.endedEntries).toEqual([{ eventId, purchaseSessionId: jti, admissionJti: jti, reason: 'IDLE', endedAtMs: NOW + SESSION_IDLE_MS - 555 }]);
  });

  test('QT11_POL009_T5_T10_ 결제 중(Paying) 세션은 유휴 시한이 지나도 끝나지 않고 5분마다 다시 점검한다. 최대 체류에 닿으면 MAX_STAY로 끝난다', async () => {
    const w = world();
    const eventId = w.addEvent();
    const jti = await w.openSession(eventId);
    expect(await w.sessions.setPaying(jti, true)).toBe(true);
    const s = w.sweeper();
    w.clock.advance(SESSION_IDLE_MS);
    expect((await s.tick()).events).toMatchObject([report(eventId, 'DRAINED', { checked: 1, ended: 0 })]);
    expect(await w.sessions.read(jti)).toBeDefined();
    expect(w.log.endedEntries).toEqual([]);
    // Paying이어도 5분마다 다시 본다: 다음 점검 = min(최대 체류, 지금 + 유휴 5분)
    expect(w.score(eventId, jti)).toBe(NOW + 2 * SESSION_IDLE_MS);
    // 유휴 시한을 한참 넘겨도 끝내지 않고 5분마다 다시 놓는다
    for (let k = 0; k < 6; k++) {
      w.clock.advance(SESSION_IDLE_MS);
      expect((await s.tick()).events).toMatchObject([report(eventId, 'DRAINED', { checked: 1, ended: 0 })]);
      expect(await w.sessions.read(jti)).toBeDefined();
    }
    w.clock.advance(45 * MIN - 7 * SESSION_IDLE_MS);
    expect((await s.tick()).events).toMatchObject([report(eventId, 'DRAINED', { checked: 1, ended: 1 })]);
    expect(endedOf(w, jti)).toEqual([{ eventId, purchaseSessionId: jti, admissionJti: jti, reason: 'MAX_STAY', endedAtMs: NOW + 45 * MIN }]);
    expect(await w.sessions.read(jti)).toBeUndefined();
    expect(w.metrics).toEqual(['MAX_STAY']);
  });

  test('QT11_회차 목록에 있는 회차마다 돌고, 회차가 없으면 아무것도 부르지 않는다. 회차 사이에 세션이 섞이지 않는다', async () => {
    const w = world();
    expect(await w.sweeper().tick()).toEqual({ overlapped: false, events: [] });
    expect(w.calls.acquire).toEqual([]);
    const a = w.addEvent(newEvent());
    const b = w.addEvent(newEvent());
    const sa = await w.openSession(a);
    const sb = await w.openSession(b);
    w.clock.advance(SESSION_IDLE_MS);
    const t = await w.sweeper().tick();
    expect(outcomes(t.events)).toEqual({ [a]: 'DRAINED', [b]: 'DRAINED' });
    expect(endedOf(w, sa)).toEqual([expect.objectContaining({ eventId: a, reason: 'IDLE' })]);
    expect(endedOf(w, sb)).toEqual([expect.objectContaining({ eventId: b, reason: 'IDLE' })]);
  });
});

describe('SessionSweeper.tick: 회차별 정리 임대(s:{event:E}:sesweep, 만료 임대와 다른 줄)', () => {
  test('QT11_ADR0183_11_ 임대는 session 줄로 3초 수명을 잡는다(SESSION_SWEEP_LEASE_TTL_MS)', async () => {
    const w = world();
    const eventId = w.addEvent();
    expect(SESSION_SWEEP_LEASE_TTL_MS).toBe(3000);
    await w.sweeper('pod-a').tick();
    expect(w.calls.acquire.length).toBeGreaterThanOrEqual(1);
    expect(w.calls.acquire.every((c) => c[0] === eventId && c[1] === 'pod-a' && c[2] === SESSION_SWEEP_LEASE_TTL_MS && c[3] === 'session')).toBe(true);
  });

  test('QT11_ADR0183_11_ 만료 임대(expiry 줄)를 다른 파드가 잡고 있어도 정리 임대는 따로 잡혀 이 파드가 점검한다', async () => {
    const w = world();
    const eventId = w.addEvent();
    const jti = await w.openSession(eventId);
    w.clock.advance(SESSION_IDLE_MS);
    expect(await w.leasesInner.acquire(eventId, 'pod-x', SESSION_SWEEP_LEASE_TTL_MS, 'expiry')).toBe(true);
    const t = await w.sweeper('pod-a').tick();
    expect(t.events).toMatchObject([report(eventId, 'DRAINED', { checked: 1, ended: 1 })]);
    expect(endedOf(w, jti)).toHaveLength(1);
    // 만료 줄은 그대로 pod-x의 것이다
    expect(await w.leasesInner.acquire(eventId, 'pod-a', SESSION_SWEEP_LEASE_TTL_MS, 'expiry')).toBe(false);
    expect(await w.leasesInner.acquire(eventId, 'pod-x', SESSION_SWEEP_LEASE_TTL_MS, 'expiry')).toBe(true);
  });

  test('QT11_NFR025_ 다른 파드가 정리 임대를 잡고 있으면 이 파드는 NOT_LEASED로 아무것도 점검하지 않고, 이 파드의 만료 임대는 그와 상관없이 잡힌다', async () => {
    const w = world();
    const eventId = w.addEvent();
    const jti = await w.openSession(eventId);
    w.clock.advance(SESSION_IDLE_MS);
    expect(await w.leasesInner.acquire(eventId, 'pod-b', SESSION_SWEEP_LEASE_TTL_MS, 'session')).toBe(true);
    const t = await w.sweeper('pod-a').tick();
    expect(t.events).toMatchObject([report(eventId, 'NOT_LEASED')]);
    expect(w.calls.due).toEqual([]);
    expect(w.calls.sweep).toEqual([]);
    expect(w.log.endedEntries).toEqual([]);
    expect(await w.sessions.read(jti)).toBeDefined();
    expect(w.score(eventId, jti)).toBe(NOW + SESSION_IDLE_MS);
    // 만료 반복 쪽 임대는 막히지 않는다
    expect(await w.leasesInner.acquire(eventId, 'pod-a', SESSION_SWEEP_LEASE_TTL_MS, 'expiry')).toBe(true);
  });

  test('QT11_NFR025_ 두 파드 가운데 정리 임대를 잡은 파드만 그 회차를 돌고, 잡은 파드가 멈추고 3초가 지난 틱에 다른 파드가 맡는다', async () => {
    const w = world();
    const eventId = w.addEvent();
    const a = w.sweeper('pod-a');
    const b = w.sweeper('pod-b');
    expect((await a.tick()).events[0]!.outcome).toBe('DRAINED');
    w.clock.advance(SESSION_SWEEP_TICK_MS);
    expect((await a.tick()).events[0]!.outcome).toBe('DRAINED');
    // a의 마지막 틱에서 3초가 되기 1ms 전까지는 b가 못 잡는다: 점검할 세션이 있어도 b는 아무것도 부르지 않는다
    const jti = await w.openSession(eventId, { indexAt: w.clock.now() });
    w.clock.advance(SESSION_SWEEP_LEASE_TTL_MS - 1);
    const duesBefore = w.calls.due.length;
    expect((await b.tick()).events).toMatchObject([report(eventId, 'NOT_LEASED')]);
    expect(w.calls.due.length).toBe(duesBefore);
    expect(w.calls.sweep).toEqual([]);
    // a가 멈추고 3초가 되면 b가 맡아 점검한다. 그 뒤로는 a가 NOT_LEASED다
    w.clock.advance(1);
    expect((await b.tick()).events).toMatchObject([report(eventId, 'DRAINED', { checked: 1 })]);
    expect(w.calls.sweep).toEqual([jti]);
    expect((await a.tick()).events).toMatchObject([report(eventId, 'NOT_LEASED')]);
  });
});

describe('SessionSweeper.tick: 묶음 상한', () => {
  test('QT11_NFR003_ 점검할 세션이 250개면 한 틱에 100·100·50 묶음으로 다 점검해 끝내고 DRAINED다(묶음은 SESSION_SWEEP_BATCH 100개 이하로 읽는다)', async () => {
    expect(SESSION_SWEEP_BATCH).toBe(100);
    expect(SESSION_SWEEP_MAX_BATCHES).toBe(5);
    const w = world();
    const eventId = w.addEvent();
    const jtis: string[] = [];
    for (let i = 0; i < 250; i++) jtis.push(await w.openSession(eventId));
    w.clock.advance(SESSION_IDLE_MS);
    const t = await w.sweeper().tick();
    expect(t.events).toMatchObject([report(eventId, 'DRAINED', { checked: 250, ended: 250 })]);
    expect(w.calls.due.every(([, , limit]) => limit === SESSION_SWEEP_BATCH)).toBe(true);
    expect(w.calls.due.length).toBeGreaterThanOrEqual(3);
    expect(new Set(w.calls.sweep).size).toBe(250);
    expect(w.log.endedEntries).toHaveLength(250);
    expect(w.indexSize(eventId)).toBe(0);
    expect(w.metrics).toHaveLength(250);
    expect(jtis.every((j) => endedOf(w, j).length === 1)).toBe(true);
  });

  test('QT11_NFR003_ 점검할 세션이 750개면 한 틱에 회차 하나는 5묶음(500개)까지만 돌고 BATCH_LIMIT이며, 남은 250개는 다음 틱에 점검해 DRAINED다', async () => {
    const w = world();
    const eventId = w.addEvent();
    for (let i = 0; i < 750; i++) await w.openSession(eventId);
    w.clock.advance(SESSION_IDLE_MS);
    const s = w.sweeper();
    const first = await s.tick();
    expect(first.events).toMatchObject([report(eventId, 'BATCH_LIMIT', { checked: SESSION_SWEEP_BATCH * SESSION_SWEEP_MAX_BATCHES, ended: 500 })]);
    expect(w.indexSize(eventId)).toBe(250);
    expect(w.log.endedEntries).toHaveLength(500);
    w.clock.advance(SESSION_SWEEP_TICK_MS);
    const second = await s.tick();
    expect(second.events).toMatchObject([report(eventId, 'DRAINED', { checked: 250, ended: 250 })]);
    expect(w.indexSize(eventId)).toBe(0);
    expect(w.log.endedEntries).toHaveLength(750);
    expect(new Set(w.log.endedEntries.map((e) => e.purchaseSessionId)).size).toBe(750);
  });

  test('QT11_NFR003_ 반복이 켜진 채 한 틱이 BATCH_LIMIT에 닿으면 1초를 기다리지 않고 다음 틱을 바로 잇고(타이머는 한 번만 부른다), 다 점검했으면 더 잇지 않는다 [seat-hold.md §2 정리 색인과 1초 반복: 만료 반복과 같은 규칙]', async () => {
    const w = world();
    const eventId = w.addEvent();
    for (let i = 0; i < 750; i++) await w.openSession(eventId);
    w.clock.advance(SESSION_IDLE_MS);
    // 색인 읽기마다 이벤트 루프를 한 바퀴 돌린다: 다 점검한 뒤에도 틱을 끝없이 잇는 구현이 마이크로태스크만으로 시험을 멈춰 세우지 않고 아래에서 걸리게
    w.wait.due = () => flush();
    const { timer, regs } = manualTimer();
    const s = w.sweeper('pod-a', { timer });
    s.start();
    regs[0]!.run();
    await settle(() => w.indexSize(eventId) === 0);
    expect(w.indexSize(eventId)).toBe(0);
    expect(w.log.endedEntries).toHaveLength(750);
    const listed = w.calls.saleEvents;
    for (let i = 0; i < 20; i++) await flush();
    expect(w.calls.saleEvents).toBe(listed);
    await s.stop();
  });
});

describe('SessionSweeper.tick: 실패', () => {
  test('QT11_NFR015_ store.sweep이 좌석 Redis 일시 장애면 그 회차는 UNAVAILABLE이고 그 멤버는 색인에 남으며, 다음 틱 5초(SESSION_SWEEP_BACKOFF_MS)는 BACKOFF로 건너뛰고 쉰 뒤 다시 점검한다 [ASVS v5.0.0-16.3.4]', async () => {
    expect(SESSION_SWEEP_BACKOFF_MS).toBe(5000);
    const w = world();
    const eventId = w.addEvent();
    const jti = await w.openSession(eventId);
    w.clock.advance(SESSION_IDLE_MS);
    const s = w.sweeper();
    w.fail.sweep = () => new SeatStoreUnavailable(new Error('down'));
    expect((await s.tick()).events).toMatchObject([{ eventId, outcome: 'UNAVAILABLE', ended: 0 }]);
    expect(w.score(eventId, jti)).toBe(NOW + SESSION_IDLE_MS);
    expect(await w.sessions.read(jti)).toBeDefined();
    expect(w.log.endedEntries).toEqual([]);
    expect(w.errorLines()).toEqual([]);
    w.fail.sweep = undefined;
    // 장애가 풀렸어도 쉬는 동안은 건너뛴다(색인도 점검도 부르지 않는다)
    w.clock.advance(SESSION_SWEEP_TICK_MS);
    const dues = w.calls.due.length;
    const sweeps = w.calls.sweep.length;
    expect((await s.tick()).events).toMatchObject([report(eventId, 'BACKOFF')]);
    expect(w.calls.due.length).toBe(dues);
    expect(w.calls.sweep.length).toBe(sweeps);
    // 실패한 때부터 5초가 지나면 그 멤버를 다시 본다
    w.clock.advance(SESSION_SWEEP_BACKOFF_MS - SESSION_SWEEP_TICK_MS + 1);
    expect((await s.tick()).events).toMatchObject([report(eventId, 'DRAINED', { checked: 1, ended: 1 })]);
    expect(endedOf(w, jti)).toHaveLength(1);
    expect(w.score(eventId, jti)).toBeUndefined();
  });

  test('QT11_NFR015_ 한 회차의 일시 장애는 다른 회차를 막지 않는다', async () => {
    const w = world();
    const bad = w.addEvent(newEvent());
    const good = w.addEvent(newEvent());
    await w.openSession(bad);
    const ok = await w.openSession(good);
    w.clock.advance(SESSION_IDLE_MS);
    w.fail.due = (e) => (e === bad ? new SeatStoreUnavailable(new Error('down')) : undefined);
    const t = await w.sweeper().tick();
    expect(outcomes(t.events)).toEqual({ [bad]: 'UNAVAILABLE', [good]: 'DRAINED' });
    expect(endedOf(w, ok)).toHaveLength(1);
  });

  test('QT11_NFR015_ 임대·색인 읽기·색인 고치기(다시 놓기·빼기)의 일시 장애도 던지지 않고 그 회차의 UNAVAILABLE이다', async () => {
    for (const where of ['acquire', 'due', 'requeue', 'drop'] as const) {
      const w = world();
      const eventId = w.addEvent();
      // requeue는 살아 있는 세션을, drop은 이미 없는 세션을 점검해야 닿는다
      const jti = await w.openSession(eventId);
      if (where === 'drop') w.sessions.endSession(jti);
      if (where === 'requeue') {
        w.clock.advance(4 * MIN);
        await w.sessions.advance(jti, 1);
        w.clock.advance(1 * MIN);
      } else {
        w.clock.advance(SESSION_IDLE_MS);
      }
      w.fail[where] = () => new SeatStoreUnavailable(new Error('down'));
      const t = await w.sweeper().tick();
      expect({ where, outcome: t.events[0]!.outcome }).toEqual({ where, outcome: 'UNAVAILABLE' });
      expect({ where, errors: w.errorLines() }).toEqual({ where, errors: [] });
    }
  });

  test('QT11_일시 장애가 아닌 점검 오류(세션 상태가 망가짐)는 그 멤버만 뒤로 미루고(회차는 DRAINED) logger.error 한 줄을 남기되 세션 ID·키 이름·오류 글은 싣지 않는다. 멤버는 색인에 남는다 [ASVS v5.0.0-16.2.5]', async () => {
    const w = world();
    const eventId = w.addEvent();
    const jti = await w.openSession(eventId);
    w.clock.advance(SESSION_IDLE_MS);
    w.fail.sweep = (id) => new Error(`ERR PEAKET_CORRUPT_KEY s:session:{${id}} boom-detail`);
    const t = await w.sweeper().tick();
    expect(t.events).toMatchObject([{ eventId, outcome: 'DRAINED' }]);
    expect(w.errorLines()).toHaveLength(1);
    const text = `${JSON.stringify(w.errorLines()[0]!.obj)}\n${w.errorLines()[0]!.msg}`;
    expect(text).not.toContain(jti);
    expect(text).not.toContain('s:{');
    expect(text).not.toContain('s:session');
    expect(text).not.toContain('boom-detail');
    expect(w.score(eventId, jti)).toBe(w.clock.now() + SESSION_SWEEP_POISON_RETRY_MS);
    expect(w.log.endedEntries).toEqual([]);
  });

  test('QT11_NFR015_ 회차 목록(saleEvents)을 읽지 못하면 listFailed(일시 장애 UNAVAILABLE, 그 밖 ERROR와 로그 한 줄)이고 회차를 돌지 않는다. 던지지 않는다', async () => {
    const w = world();
    w.addEvent();
    w.fail.saleEvents = () => new SeatStoreUnavailable(new Error('down'));
    expect(await w.sweeper().tick()).toEqual({ overlapped: false, listFailed: 'UNAVAILABLE', events: [] });
    expect(w.errorLines()).toEqual([]);
    w.fail.saleEvents = () => new Error('ERR unknown s:ctl:events detail-x');
    expect(await w.sweeper().tick()).toEqual({ overlapped: false, listFailed: 'ERROR', events: [] });
    expect(w.errorLines()).toHaveLength(1);
    expect(JSON.stringify(w.errorLines()[0])).not.toContain('detail-x');
    expect(w.calls.acquire).toEqual([]);
  });
});

describe('SessionSweeper.tick: 겹침', () => {
  test('QT11_NFR025_ 앞 틱이 아직 돌고 있으면 이번 틱은 아무것도 부르지 않고 overlapped다. 끝난 뒤에는 다시 돈다', async () => {
    const w = world();
    w.addEvent();
    const gate = deferred<void>();
    w.wait.saleEvents = () => gate.promise;
    const s = w.sweeper();
    const first = s.tick();
    await flush();
    expect(w.calls.saleEvents).toBe(1);
    expect(await s.tick()).toEqual({ overlapped: true, events: [] });
    expect(w.calls.saleEvents).toBe(1);
    expect(w.calls.acquire).toEqual([]);
    gate.resolve();
    expect((await first).overlapped).toBe(false);
    w.wait.saleEvents = undefined;
    expect((await s.tick()).overlapped).toBe(false);
  });
});

describe('SessionSweeper.start·stop', () => {
  test('QT11_NFR025_ start는 1초 주기 타이머 하나만 걸고 틱을 바로 부르지 않는다(첫 틱은 1초 뒤). 두 번 불러도 하나다. 타이머가 부르면 틱이 돈다', async () => {
    const w = world();
    w.addEvent();
    const { timer, regs } = manualTimer();
    const s = w.sweeper('pod-a', { timer });
    s.start();
    s.start();
    expect(regs.map((r) => r.everyMs)).toEqual([SESSION_SWEEP_TICK_MS]);
    expect(SESSION_SWEEP_TICK_MS).toBe(1000);
    expect(w.calls.saleEvents).toBe(0);
    regs[0]!.run();
    await flush();
    expect(w.calls.saleEvents).toBe(1);
    await s.stop();
  });

  test('QT11_NFR025_ 주입 타이머가 없으면 기본 시스템 타이머로 1초마다 돈다(첫 부름은 1초 뒤)', async () => {
    vi.useFakeTimers();
    const w = world();
    w.addEvent();
    const s = w.sweeper();
    s.start();
    await vi.advanceTimersByTimeAsync(SESSION_SWEEP_TICK_MS - 1);
    expect(w.calls.saleEvents).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(w.calls.saleEvents).toBe(1);
    await vi.advanceTimersByTimeAsync(SESSION_SWEEP_TICK_MS);
    expect(w.calls.saleEvents).toBe(2);
    await s.stop();
    await vi.advanceTimersByTimeAsync(5 * SESSION_SWEEP_TICK_MS);
    expect(w.calls.saleEvents).toBe(2);
  });

  test('QT11_NFR025_ stop은 타이머를 멈추고 돌고 있는 틱이 끝날 때까지 기다린다. 두 번 불러도 되고, 켜지 않았으면 바로 끝나며, 끈 뒤 다시 켤 수 있다', async () => {
    const w = world();
    w.addEvent();
    const { timer, regs } = manualTimer();
    const idle = w.sweeper('pod-b', { timer });
    await idle.stop();
    expect(regs).toHaveLength(0);
    const gate = deferred<void>();
    w.wait.saleEvents = () => gate.promise;
    const s = w.sweeper('pod-a', { timer });
    s.start();
    regs[0]!.run();
    await flush();
    let stopped = false;
    const p = s.stop().then(() => void (stopped = true));
    await flush();
    expect(regs[0]!.cancelled).toBeGreaterThanOrEqual(1);
    expect(stopped).toBe(false);
    gate.resolve();
    await p;
    expect(stopped).toBe(true);
    await s.stop();
    // 다시 켤 수 있다
    s.start();
    expect(regs).toHaveLength(2);
    await s.stop();
  });

  test('QT11_NFR025_ 타이머가 부른 틱 안의 오류(회차 목록·점검 실패)는 처리되지 않은 거부가 되지 않는다', async () => {
    const seen: unknown[] = [];
    const onRejection = (r: unknown) => void seen.push(r);
    process.on('unhandledRejection', onRejection);
    try {
      const w = world();
      const eventId = w.addEvent();
      await w.openSession(eventId);
      w.clock.advance(SESSION_IDLE_MS);
      const { timer, regs } = manualTimer();
      const s = w.sweeper('pod-a', { timer });
      s.start();
      w.fail.saleEvents = () => new Error('ERR boom');
      regs[0]!.run();
      await settle(() => w.calls.saleEvents >= 1);
      for (let i = 0; i < 5; i++) await flush();
      w.fail.saleEvents = undefined;
      w.fail.sweep = () => new Error('ERR boom 2');
      regs[0]!.run();
      await settle(() => w.calls.sweep.length >= 1);
      for (let i = 0; i < 5; i++) await flush();
      await s.stop();
      expect(seen).toEqual([]);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });
});

describe('SessionSweeper: 멈춤·쉬는 시간 경계·종료 사건이 빠진 뒤의 복구(PRF-138 시험 검토)', () => {
  test('QT11_ADR0183_11_stop()이 돌던 틱에 걸리면 그 회차는 다음 묶음을 읽지 않고 STOPPED로 멈추며 남은 세션은 색인에 그대로 남는다', async () => {
    const w = world();
    const first = w.addEvent();
    const eventIds = [first, w.addEvent(), w.addEvent(), w.addEvent(), w.addEvent()].sort();
    // 첫 회차에 세션 250개(점검 시각이 모두 지났다), 나머지 회차에도 세션 하나씩
    for (let i = 0; i < SESSION_SWEEP_BATCH + 150; i++) await w.openSession(eventIds[0]!, { indexAt: NOW });
    for (const e of eventIds.slice(1)) await w.openSession(e, { indexAt: NOW });
    w.clock.advance(SESSION_IDLE_MS);
    const gate = deferred<void>();
    let held = false;
    w.wait.due = async () => {
      if (held) return;
      held = true;
      await gate.promise;
    };
    const s = w.sweeper();
    const tick = s.tick();
    await flush(); // 첫 index.due가 붙잡힌 채
    const stopping = s.stop();
    gate.resolve();
    const t = await tick;
    await stopping;
    const r = t.events.find((e) => e.eventId === eventIds[0]);
    expect(r).toMatchObject({ outcome: 'STOPPED', checked: SESSION_SWEEP_BATCH, ended: SESSION_SWEEP_BATCH });
    expect(w.indexSize(eventIds[0]!)).toBe(150); // 둘째 묶음은 읽지 않았다
    expect(w.calls.due.filter(([e]) => e === eventIds[0])).toHaveLength(1);
  });

  test('NFR015_ADR0183_11_쉬는 시간 경계: 실패 뒤 5000ms에서는 BACKOFF가 아니라 다시 점검하고, 4999ms에서는 BACKOFF다', async () => {
    const w = world();
    const eventId = w.addEvent();
    await w.openSession(eventId, { indexAt: NOW });
    w.clock.advance(SESSION_IDLE_MS);
    let calls = 0;
    w.fail.sweep = () => (++calls === 1 ? new SeatStoreUnavailable(new Error('down')) : undefined);
    const s = w.sweeper();
    expect((await s.tick()).events).toMatchObject([report(eventId, 'UNAVAILABLE')]);
    w.clock.advance(SESSION_SWEEP_BACKOFF_MS - 1);
    expect((await s.tick()).events).toMatchObject([report(eventId, 'BACKOFF')]);
    w.clock.advance(1);
    expect((await s.tick()).events[0]!.outcome).toBe('DRAINED');
  });

  test('QT11_종료 사건을 더하지 못해도 세션 상태는 이미 지워졌고 색인에 그 jti가 남는다. 다음 틱의 점검이 GONE으로 색인에서 빼며, 사건이 두 번 더해지지 않는다(입장 자리는 최대 체류 시각에 정리된다)', async () => {
    const w = world();
    const eventId = w.addEvent();
    const jti = await w.openSession(eventId, { indexAt: NOW });
    w.clock.advance(SESSION_IDLE_MS);
    w.log.failEndedWith = new SeatStoreUnavailable(new Error('stream down'));
    const s = w.sweeper();
    const first = await s.tick();
    expect(first.events).toMatchObject([report(eventId, 'DRAINED', { checked: 1, ended: 1 })]);
    expect(await w.sessions.read(jti)).toBeUndefined();
    expect(w.score(eventId, jti)).toBeDefined(); // 사건 더하기가 실패해 ZREM도 하지 못했다
    expect(w.log.endedEntries).toEqual([]);
    expect(w.lines.filter((l) => l.level === 'warn')).toHaveLength(1);
    w.log.failEndedWith = undefined;
    const second = await s.tick();
    expect(second.events).toMatchObject([report(eventId, 'DRAINED', { checked: 1, gone: 1 })]);
    expect(w.score(eventId, jti)).toBeUndefined();
    expect(w.log.endedEntries).toEqual([]); // 사건은 영영 빠졌다(최대 체류 시각 정리가 덮는다)
  });
});

describe('SessionSweeper: Paying에서 Active로 돌아온 세션과 점검이 계속 실패하는 멤버(PRF-138 코드 리뷰)', () => {
  test('QT11_POL009_T8_T11_Paying을 본 뒤 결제 실패로 Active에 돌아온 세션은 돌아온 뒤 5분 안에 다시 점검되어 유휴 시한(돌아온 때 + 5분)에 IDLE로 끝난다. 최대 체류까지 밀리지 않는다', async () => {
    const w = world();
    const eventId = w.addEvent();
    const jti = await w.openSession(eventId);
    expect(await w.sessions.setPaying(jti, true)).toBe(true);
    const s = w.sweeper();
    w.clock.advance(SESSION_IDLE_MS);
    await s.tick(); // Paying을 본다(끝내지 않고 다시 놓는다)
    expect(await w.sessions.setPaying(jti, false)).toBe(true); // T8: 좌석맵으로 돌아옴, 유휴 시한 = 지금 + 5분
    const backAt = w.clock.now();
    // 사용자가 아무 요청도 하지 않는다: 돌아온 때부터 2 × 유휴(10분) 안에 IDLE로 끝나야 한다
    let endedAt: number | undefined;
    for (let k = 0; k < 2 * SESSION_IDLE_MS / 1000 && endedAt === undefined; k++) {
      w.clock.advance(1000);
      await s.tick();
      if (endedOf(w, jti).length > 0) endedAt = w.clock.now();
    }
    expect(endedAt).toBeDefined();
    expect(endedAt! - backAt).toBeLessThanOrEqual(2 * SESSION_IDLE_MS);
    expect(endedAt! - backAt).toBeGreaterThanOrEqual(SESSION_IDLE_MS);
    expect(endedOf(w, jti)[0]).toMatchObject({ reason: 'IDLE' });
  });

  test('QT11_점검이 계속 일시 장애가 아닌 오류로 실패하는 멤버(망가진 세션 상태) 하나가 같은 회차의 다른 세션 정리를 막지 않는다: 그 멤버는 60초 [가정] 뒤로 미루고 같은 틱에서 나머지를 끝낸다. 로그는 오류 갈래만 싣는다 [ASVS v5.0.0-16.2.5]', async () => {
    const w = world();
    const eventId = w.addEvent();
    const bad = await w.openSession(eventId, { indexAt: NOW }); // 점수가 가장 이르다(맨 앞)
    const good = await w.openSession(eventId, { indexAt: NOW + 1 });
    w.clock.advance(SESSION_IDLE_MS);
    w.fail.sweep = (jti) => (jti === bad ? new Error(`ERR PEAKET_CORRUPT_KEY s:session:{${jti}} boom-detail`) : undefined);
    const s = w.sweeper();
    const t = await s.tick();
    expect(t.events).toMatchObject([{ eventId, outcome: 'DRAINED', ended: 1 }]);
    expect(endedOf(w, good)).toHaveLength(1);
    expect(w.score(eventId, bad)).toBe(w.clock.now() + SESSION_SWEEP_POISON_RETRY_MS);
    expect(SESSION_SWEEP_POISON_RETRY_MS).toBe(60_000);
    expect(w.errorLines()).toHaveLength(1);
    const text = `${JSON.stringify(w.errorLines()[0]!.obj)}\n${w.errorLines()[0]!.msg}`;
    for (const secret of [bad, 's:{', 's:session', 'boom-detail']) expect(text).not.toContain(secret);
    // 60초 안에는 다시 점검하지 않고, 지나면 다시 본다
    w.calls.sweep.length = 0;
    await s.tick();
    expect(w.calls.sweep).toEqual([]);
    w.clock.advance(SESSION_SWEEP_POISON_RETRY_MS);
    await s.tick();
    expect(w.calls.sweep).toEqual([bad]);
  });
});
