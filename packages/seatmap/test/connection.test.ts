// 좌석 연결과 다시 맞추기(FE-T11, docs/frontend.md §3.5·§4.4.1, ADR-0117, ADR-0240, BUILD_ORDER HOT-100). 가짜 서버(소켓)와 가짜 시계로 본다.
import { describe, expect, it, vi } from 'vitest';
import { ClockSync, CLOCK_SAMPLES, deltaE2eMs } from '../src/clock';
import { closeDecision, createSeatConnection, HEARTBEAT_TIMEOUT_MS, SEATS_PROTOCOL, TIME_SYNC_MS, type SeatSocket } from '../src/connection';
import { createDeltaSync } from '../src/delta-sync';
import { SeatMapEngine } from '../src/engine';
import { decodeFrame, decodeSnapshot, encodeAuth } from '../src/wire';
import { encodeDelta, encodeSnapshot, fakeCtx, makeLayout } from './fixtures';

function fakeTime(start = 1_000) {
  let now = start;
  let id = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const advance = async (ms: number) => {
    const end = now + ms;
    for (let i = 0; i < 6; i++) await Promise.resolve();
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].fn();
      await Promise.resolve();
    }
    now = end;
    await Promise.resolve();
  };
  return { now: () => now, setTimer: (fn: () => void, ms: number) => (timers.set(++id, { at: now + ms, fn }), id), clearTimer: (h: unknown) => void timers.delete(h as number), advance, pending: () => timers.size };
}

class FakeSocket implements SeatSocket {
  protocol = '';
  binaryType = 'blob';
  readyState = 0;
  sent: Uint8Array[] = [];
  closed: number | undefined;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string, readonly protocols: string[]) {}
  send(d: Uint8Array) {
    this.sent.push(d);
  }
  close(code?: number) {
    this.closed = code ?? 1005;
    this.readyState = 3;
  }
  open(protocol = SEATS_PROTOCOL) {
    this.protocol = protocol;
    this.readyState = 1;
    this.onopen?.();
  }
  frame(u8: Uint8Array) {
    this.onmessage?.({ data: u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) });
  }
  drop(code: number) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

const heartbeat = (serverTimeMs: number, echo: number) => {
  const u8 = new Uint8Array(18);
  const v = new DataView(u8.buffer);
  v.setUint8(0, 1);
  v.setUint8(1, 2);
  v.setBigUint64(2, BigInt(serverTimeMs), true);
  v.setBigUint64(10, BigInt(echo), true);
  return u8;
};
const interval = (ms: number) => Uint8Array.of(1, 3, ms & 255, ms >> 8);

function setup(o: { serverNow?: () => number; expiresAtMs?: number; auth?: 'subprotocol' | 'first-message'; probeAuth?: () => Promise<'ok' | 'rejected' | 'unknown'>; onForbidden?: () => Promise<boolean>; url?: string; random?: () => number } = {}) {
  const t = fakeTime();
  const sockets: FakeSocket[] = [];
  const states: Array<[string, unknown]> = [];
  const frames: unknown[] = [];
  const resub: number[][] = [];
  const closes: Array<[number, boolean]> = [];
  const errors: unknown[] = [];
  const conn = createSeatConnection({
    url: o.url ?? 'wss://api.peaket.example/v1/events/e1/seats/stream',
    getToken: () => ({ token: 'aaa.bbb.ccc', expiresAtMs: o.expiresAtMs ?? 10_000_000 }),
    openSocket: (u, p) => {
      const s = new FakeSocket(u, p);
      sockets.push(s);
      return s;
    },
    now: t.now,
    serverNow: o.serverNow ?? t.now,
    setTimer: t.setTimer,
    clearTimer: t.clearTimer,
    random: o.random ?? (() => 1),
    auth: o.auth,
    probeAuth: o.probeAuth,
    onForbidden: o.onForbidden,
    onState: (s, d) => void states.push([s, d]),
    onFrame: (f) => void frames.push(f),
    onResubscribed: (x) => void resub.push([...x]),
    onClose: (c, opened) => void closes.push([c, opened]),
    onError: (e) => void errors.push(e),
  });
  const last = () => sockets.at(-1)!;
  const state = () => states.at(-1)![0];
  return { t, conn, sockets, states, frames, resub, closes, errors, last, state };
}
const types = (s: FakeSocket) => s.sent.map((u) => u[1]);

describe('FE-T11 좌석 연결: 인증과 첫 보내기', () => {
  it('하위 프로토콜로 입장 토큰을 싣고 이진 프레임으로 받으며, 서버가 고른 뒤에 live다', () => {
    const { conn, last, state } = setup();
    conn.start();
    expect(state()).toBe('connecting');
    expect(last().protocols).toEqual([SEATS_PROTOCOL, 'peaket.auth.aaa.bbb.ccc']);
    expect(last().binaryType).toBe('arraybuffer');
    last().open();
    expect(state()).toBe('live');
  });

  it('서버가 하위 프로토콜을 고르지 않으면 live가 아니고 닫는다', () => {
    const { conn, last, state, errors } = setup();
    conn.start();
    last().open('');
    expect(state()).toBe('connecting');
    expect(last().closed).toBeDefined();
    expect(errors).toHaveLength(1);
  });

  it('[ASVS v5.0.0-4.4.1] ws: 주소는 거부한다(로컬 개발 주소만 예외)', () => {
    expect(() => setup({ url: 'ws://api.peaket.example/x' })).toThrow(/wss/);
    expect(() => setup({ url: 'ws://127.0.0.1:4010/x' })).not.toThrow();
    expect(() => setup({ url: 'ws://localhost:4010/x' })).not.toThrow();
    expect(() => setup({ url: 'ws://localhost.evil.example/x' })).toThrow(/wss/);
  });

  it('구독할 구역이 있으면 구독을 먼저, 이어서 시계 맞추기를 보낸다', () => {
    const { conn, last } = setup();
    conn.setSections([2, 5]);
    conn.start();
    last().open();
    expect(types(last())).toEqual([16, 18]);
  });

  it('첫 메시지 인증(대체)에서는 토큰을 주소·하위 프로토콜에 싣지 않고 맨 먼저 Auth를 보낸다', () => {
    const { conn, last } = setup({ auth: 'first-message' });
    conn.setSections([1]);
    conn.start();
    expect(last().protocols).toEqual([SEATS_PROTOCOL]);
    last().open();
    expect(types(last())).toEqual([17, 16, 18]);
    expect([...last().sent[0]!]).toEqual([...encodeAuth('aaa.bbb.ccc')]);
    expect(last().url).not.toContain('aaa');
  });

  it('구독 상한(16)을 넘겨도 보내는 프레임은 16구역이고, 같은 집합은 다시 보내지 않는다', () => {
    const { conn, last } = setup();
    conn.start();
    last().open();
    last().sent.length = 0;
    const many = Array.from({ length: 20 }, (_, i) => i);
    conn.setSections(many);
    expect(new DataView(last().sent[0]!.buffer).getUint16(2, true)).toBe(16);
    conn.setSections(many.slice(0, 16));
    expect(last().sent).toHaveLength(1);
  });
});

describe('FE-T11 좌석 연결: 닫힘 코드와 다시 붙기', () => {
  it('닫힘 코드별 판단: 4401 끝, 4403 금지, 1012 0~5초, 4429 10초 이상, 그 밖은 전체 지터(상한 10초)', () => {
    expect(closeDecision(4401, 0, () => 0.5)).toEqual({ kind: 'end', reason: 'token-invalid' });
    expect(closeDecision(4403, 0, () => 0.5)).toEqual({ kind: 'forbidden' });
    expect(closeDecision(1012, 3, () => 0.5)).toEqual({ kind: 'retry', delayMs: 2500 });
    expect(closeDecision(4429, 0, () => 0)).toEqual({ kind: 'retry', delayMs: 10_000 });
    expect(closeDecision(1006, 0, () => 1)).toEqual({ kind: 'retry', delayMs: 500 });
    expect(closeDecision(1006, 2, () => 1)).toEqual({ kind: 'retry', delayMs: 2000 });
    expect(closeDecision(1006, 20, () => 1)).toEqual({ kind: 'retry', delayMs: 10_000 });
    expect(closeDecision(1006, 2, () => 0)).toEqual({ kind: 'retry', delayMs: 0 });
  });

  it('4401이면 다시 붙지 않고 끝난다', async () => {
    const { t, conn, last, sockets, states } = setup();
    conn.start();
    last().open();
    last().drop(4401);
    await t.advance(60_000);
    expect(sockets).toHaveLength(1);
    expect(states.at(-1)).toEqual(['ended', { reason: 'token-invalid' }]);
  });

  it('1012 뒤에는 reconnecting을 거쳐 다시 붙고, 구독을 먼저 보내고 구독 구역을 다시 맞추라고 알린다', async () => {
    const { t, conn, last, sockets, resub, state } = setup();
    conn.setSections([3]);
    conn.start();
    last().open();
    expect(resub).toEqual([]);
    last().drop(1012);
    expect(state()).toBe('reconnecting');
    await t.advance(5_000);
    expect(sockets).toHaveLength(2);
    last().open();
    expect(state()).toBe('live');
    expect(types(last())[0]).toBe(16);
    expect(resub).toEqual([[3]]);
  });

  it('프레임을 받기 전까지는 실패가 쌓여 기다림이 늘고, 프레임을 받으면 처음으로 돌아간다', async () => {
    const { t, conn, last, sockets } = setup();
    conn.start();
    last().open();
    last().drop(1006);
    await t.advance(500);
    expect(sockets).toHaveLength(2);
    last().open();
    last().drop(1006);
    await t.advance(500);
    expect(sockets).toHaveLength(2);
    await t.advance(500);
    expect(sockets).toHaveLength(3);
    last().open();
    await t.advance(10_000);
    last().drop(1006);
    await t.advance(500);
    expect(sockets).toHaveLength(4);
  });

  it('리뷰 재현: 프레임을 하나 답하고 바로 닫는 서버에는 기다림이 줄지 않는다', async () => {
    const { t, conn, last, sockets } = setup();
    conn.start();
    last().open();
    last().frame(heartbeat(5, 1_000));
    last().drop(1006);
    await t.advance(500);
    expect(sockets).toHaveLength(2);
    last().open();
    last().frame(heartbeat(5, 1_500));
    last().drop(1006);
    await t.advance(500);
    expect(sockets).toHaveLength(2);
  });

  it('리뷰 재현: 여는 중에 답이 없으면 10초 뒤 포기하고 다시 붙는다', async () => {
    const { t, conn, last, sockets, state } = setup();
    conn.start();
    await t.advance(9_999);
    expect(sockets).toHaveLength(1);
    await t.advance(1);
    expect(sockets[0]!.closed).toBeDefined();
    expect(state()).toBe('reconnecting');
    await t.advance(500);
    expect(sockets).toHaveLength(2);
  });

  it('리뷰 재현: 서버가 프로토콜을 고르지 않아 닫은 뒤에도 다시 붙는다', async () => {
    const { t, conn, last, sockets, state } = setup();
    conn.start();
    last().open('');
    last().drop(1006);
    expect(state()).toBe('reconnecting');
    await t.advance(500);
    expect(sockets).toHaveLength(2);
  });

  it('리뷰 재현: 여는 중에 dispose하면 소켓을 닫고 타이머가 남지 않는다', () => {
    const { t, conn, last } = setup();
    conn.start();
    conn.dispose();
    expect(last().closed).toBe(1000);
    expect(t.pending()).toBe(0);
  });

  it('리뷰 재현: 만료 판정은 맞춘 시계를 먼저 쓴다(기기 시계가 달라도)', async () => {
    const { t, conn, last, states } = setup({ expiresAtMs: 50_000, serverNow: () => 0 });
    conn.start();
    last().open();
    await t.advance(10);
    last().frame(heartbeat(49_900, 1_000));
    last().drop(1006);
    await t.advance(0);
    expect(states.at(-1)).toEqual(['ended', { reason: 'token-expired' }]);
  });

  it('리뷰 재현: 소켓을 못 만든 오류의 글을 그대로 넘기지 않는다', () => {
    const t = fakeTime();
    const errors: Error[] = [];
    const conn = createSeatConnection({
      url: 'wss://a.example/x',
      getToken: () => ({ token: 'SECRET', expiresAtMs: 9e9 }),
      openSocket: () => {
        throw new Error('bad protocol peaket.auth.SECRET');
      },
      now: t.now,
      serverNow: t.now,
      setTimer: t.setTimer,
      clearTimer: t.clearTimer,
      random: () => 1,
      onState: () => undefined,
      onFrame: () => undefined,
      onResubscribed: () => undefined,
      onError: (e) => void errors.push(e as Error),
    });
    conn.start();
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).not.toContain('SECRET');
  });

  it('입장 토큰이 만료되면 더 붙지 않고 끝난다', async () => {
    const { t, conn, last, sockets, states } = setup({ expiresAtMs: 1_300 });
    conn.start();
    last().open();
    last().drop(1006);
    await t.advance(60_000);
    expect(sockets).toHaveLength(1);
    expect(states.at(-1)).toEqual(['ended', { reason: 'token-expired' }]);
  });

  it('핸드셰이크 거절은 브라우저에 1006으로만 보여 3번 연달아 못 열면 HTTP로 토큰을 확인하고, 거절이면 끝난다', async () => {
    const probeAuth = vi.fn(async () => 'rejected' as const);
    const { t, conn, last, sockets, states, closes } = setup({ probeAuth });
    conn.start();
    last().drop(1006);
    await t.advance(500);
    last().drop(1006);
    expect(probeAuth).not.toHaveBeenCalled();
    await t.advance(1_000);
    last().drop(1006);
    await t.advance(0);
    expect(probeAuth).toHaveBeenCalledTimes(1);
    await t.advance(60_000);
    expect(sockets).toHaveLength(3);
    expect(states.at(-1)).toEqual(['ended', { reason: 'token-invalid' }]);
    expect(closes.every(([, opened]) => opened === false)).toBe(true);
  });

  it('토큰 확인이 괜찮으면 계속 다시 붙는다', async () => {
    const probeAuth = vi.fn(async () => 'ok' as const);
    const { t, conn, last, sockets } = setup({ probeAuth });
    conn.start();
    for (let i = 0; i < 3; i++) {
      last().drop(1006);
      await t.advance(10_000);
    }
    expect(sockets.length).toBeGreaterThan(3);
  });

  it('4403은 좌석맵을 다시 받고 한 번만 새로 붙고, 다시 4403이면 끝난다', async () => {
    const onForbidden = vi.fn(async () => true);
    const { t, conn, last, sockets, states } = setup({ onForbidden });
    conn.start();
    last().open();
    last().drop(4403);
    await t.advance(0);
    expect(onForbidden).toHaveBeenCalledTimes(1);
    expect(sockets).toHaveLength(2);
    last().open();
    last().drop(4403);
    await t.advance(60_000);
    expect(onForbidden).toHaveBeenCalledTimes(1);
    expect(sockets).toHaveLength(2);
    expect(states.at(-1)).toEqual(['ended', { reason: 'forbidden' }]);
  });

  it('dispose 뒤에는 1000으로 닫고 타이머가 남지 않으며 더 알리지 않는다', async () => {
    const { t, conn, last, sockets, states } = setup();
    conn.start();
    last().open();
    const n = states.length;
    conn.dispose();
    expect(last().closed).toBe(1000);
    expect(t.pending()).toBe(0);
    last().drop(1000);
    await t.advance(60_000);
    expect(sockets).toHaveLength(1);
    expect(states).toHaveLength(n);
  });
});

describe('FE-T11 좌석 연결: 살아 있음과 시계', () => {
  it('35초 동안 프레임이 없으면 끊고 다시 붙고, 프레임이 오면 그 시간을 다시 센다', async () => {
    const { t, conn, last, sockets, state } = setup();
    conn.start();
    last().open();
    await t.advance(HEARTBEAT_TIMEOUT_MS - 1);
    last().frame(heartbeat(5, 0));
    await t.advance(HEARTBEAT_TIMEOUT_MS - 1);
    expect(sockets).toHaveLength(1);
    await t.advance(1);
    expect(last().closed).toBeDefined();
    expect(state()).toBe('reconnecting');
    await t.advance(500);
    expect(sockets).toHaveLength(2);
  });

  it('시계 맞추기를 연결 직후와 60초마다 보내고, 응답으로 왕복을 잰다', async () => {
    const { t, conn, last } = setup();
    conn.start();
    last().open();
    expect(decodeSent(last().sent[0]!)).toBe(1_000);
    await t.advance(40);
    last().frame(heartbeat(50_000, 1_000));
    expect(conn.clock.offset()).toBe(50_000 + 20 - 1_040);
    await t.advance(30_000);
    last().frame(heartbeat(5, 0));
    last().sent.length = 0;
    await t.advance(TIME_SYNC_MS - 40 - 30_000);
    expect(types(last())).toEqual([18]);
  });

  it('왕복이 가장 짧은 표본을 쓰고 8개까지만 기억하며, echo가 0인 하트비트는 버린다', () => {
    const c = new ClockSync();
    c.sample(1000, 0, 500);
    expect(c.offset()).toBeUndefined();
    c.sample(1000, 100, 200); // 왕복 100 → 보정 1000+50-200
    c.sample(2000, 300, 310); // 왕복 10 → 보정 2000+5-310
    expect(c.offset()).toBe(1695);
    c.sample(9000, 500, 400); // 왕복이 음수면 버린다
    expect(c.offset()).toBe(1695);
    for (let i = 0; i < CLOCK_SAMPLES; i++) c.sample(5000, 1000 + i, 1100 + i);
    expect(c.offset()).toBe(5000 + 50 - 1100 - (CLOCK_SAMPLES - 1) + (CLOCK_SAMPLES - 1));
  });

  it('seat_delta_e2e_ms는 그린 시각(보정 시계) − (serverTimeMs − maxWaitMs)이고, 시계가 없으면 없다', () => {
    const c = new ClockSync();
    expect(deltaE2eMs({ serverTimeMs: 5000, maxWaitMs: 80 }, 100, c)).toBeUndefined();
    c.sample(5000, 90, 100); // 왕복 10, 보정 4905
    expect(deltaE2eMs({ serverTimeMs: 5000, maxWaitMs: 80 }, 200, c)).toBe(4905 + 200 - 4920);
  });

  it('묶음 간격이 1초로 바뀌면 live인 채 Degraded로 알리고, 깨진 프레임은 버리고 연결을 유지한다', () => {
    const { conn, last, states, errors, frames, state } = setup();
    conn.start();
    last().open();
    last().frame(interval(1000));
    expect(states.at(-1)).toEqual(['live', { degraded: true }]);
    last().frame(interval(100));
    expect(states.at(-1)).toEqual(['live', { degraded: false }]);
    const before = frames.length;
    last().frame(Uint8Array.of(9, 9));
    expect(errors).toHaveLength(1);
    expect(frames).toHaveLength(before);
    expect(state()).toBe('live');
  });
});

const decodeSent = (u: Uint8Array) => Number(new DataView(u.buffer, u.byteOffset).getBigUint64(2, true));

// ── 다시 맞추기 ────────────────────────────────────────────

const SEATS = 200;
function engineFixture() {
  const file = makeLayout();
  const e = new SeatMapEngine({ ctx: fakeCtx() as never, width: 600, height: 400, dpr: 1, theme: 'light' });
  e.load(file, encodeSnapshot({ layoutVersion: file.layoutVersion, seatEpoch: 1, sections: [[0, 1], [1, 1], [2, 1], [3, 1]], occupied: Array(800).fill(false) as boolean[] }));
  return { e, layoutVersion: file.layoutVersion };
}
const delta = (epoch: number, ...s: Array<[number, number, Array<[number, number]>]>) =>
  decodeFrame(encodeDelta({ seatEpoch: epoch, sections: s.map(([index, version, changes]) => ({ index, version, changes })) })) as Extract<ReturnType<typeof decodeFrame>, { type: 'delta' }>;

function syncSetup(o: { subscribed?: number[]; random?: () => number } = {}) {
  const { e, layoutVersion } = engineFixture();
  const t = fakeTime();
  const calls: number[] = [];
  const replies: Array<{ section: number; resolve: (b: Uint8Array) => void; reject: (x: unknown) => void }> = [];
  const applied: number[][] = [];
  const errors: unknown[] = [];
  const fatals: string[] = [];
  const sync = createDeltaSync({
    engine: e,
    now: t.now,
    onFatal: (k) => void fatals.push(k),
    fetchSection: (section) =>
      new Promise((resolve, reject) => {
        calls.push(section);
        replies.push({ section, resolve, reject });
      }),
    subscribed: () => o.subscribed ?? [0, 1],
    random: o.random ?? (() => 0.5),
    setTimer: t.setTimer,
    clearTimer: t.clearTimer,
    onApplied: (s) => void applied.push([...s]),
    onError: (x) => void errors.push(x),
  });
  const snap = (section: number, version: number, epoch = 1, occupied: boolean[] = Array(SEATS).fill(false) as boolean[]) => encodeSnapshot({ flags: 1, layoutVersion, seatEpoch: epoch, sections: [[section, version]], occupied });
  const flush = async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  };
  return { e, t, sync, calls, replies, applied, errors, fatals, snap, flush, layoutVersion };
}

describe('FE-T11 다시 맞추기: 갭과 세대(ADR-0117)', () => {
  it('다음 판의 델타는 바로 반영한다', () => {
    const { e, sync, calls, applied } = syncSetup();
    sync.onDelta(delta(1, [0, 2, [[5, 2]]]));
    expect(e.state[5]).toBe(2);
    expect(calls).toEqual([]);
    expect(applied).toEqual([[0]]);
  });

  it('판을 건너뛰면 그 구역 스냅샷을 받고, 기다리는 동안 온 델타는 번호로 걸러 다시 얹는다', async () => {
    const { e, sync, calls, replies, snap, flush, applied } = syncSetup();
    sync.onDelta(delta(1, [0, 4, [[1, 2]]]));
    expect(calls).toEqual([0]);
    sync.onDelta(delta(1, [0, 5, [[2, 2]]]));
    sync.onDelta(delta(1, [0, 6, [[3, 1]]]));
    expect(e.state[3]).toBe(0);
    replies[0]!.resolve(snap(0, 5));
    await flush();
    // 스냅샷이 5까지 담았으므로 4·5는 버리고 6만 얹는다
    expect(e.versions.version[0]).toBe(6);
    expect(e.state[1]).toBe(0);
    expect(e.state[2]).toBe(0);
    expect(e.state[3]).toBe(1);
    expect(applied.at(-1)).toEqual([0]);
  });

  it('[ADR-0117] 같은 구역의 재요청은 한 번에 하나다: 갭이 잇따라도 앞 요청을 기다리고, 결과의 판이 아직 낮으면 한 번 더 묻는다', async () => {
    const { e, sync, calls, replies, snap, flush } = syncSetup();
    sync.onDelta(delta(1, [0, 4, [[1, 2]]]));
    sync.onDelta(delta(1, [0, 9, [[2, 2]]]));
    sync.onDelta(delta(1, [0, 12, [[3, 2]]]));
    expect(calls).toEqual([0]);
    replies[0]!.resolve(snap(0, 8));
    await flush();
    // 8 다음이 9라 9는 얹고, 10·11이 비어 12에서 갭: 한 번 더 묻는다
    expect(calls).toEqual([0, 0]);
    expect(e.versions.version[0]).toBe(9);
    replies[1]!.resolve(snap(0, 12));
    await flush();
    expect(e.versions.version[0]).toBe(12);
    expect(calls).toHaveLength(2);
  });

  it('다른 구역의 델타는 기다리지 않고 반영한다', () => {
    const { e, sync } = syncSetup();
    sync.onDelta(delta(1, [0, 4, [[1, 2]]]));
    sync.onDelta(delta(1, [1, 2, [[0, 2]]]));
    expect(e.state[SEATS]).toBe(2);
  });

  it('세대가 오르면 0~1초 뒤 구독 구역을 모두 다시 받고 새 세대로 바꾼다. 더 작은 번호부터 다시 세도 버리지 않는다', async () => {
    const { e, t, sync, calls, replies, snap, flush } = syncSetup();
    sync.onDelta(delta(1, [0, 2, [[0, 2]]]));
    sync.onDelta(delta(2, [0, 1, [[1, 2]]]));
    expect(calls).toEqual([]);
    await t.advance(499);
    expect(calls).toEqual([]);
    await t.advance(1);
    expect(calls.sort()).toEqual([0, 1]);
    replies[0]!.resolve(snap(replies[0]!.section, 1, 2));
    replies[1]!.resolve(snap(replies[1]!.section, 3, 2));
    await flush();
    expect(e.versions.seatEpoch).toBe(2);
    expect(e.versions.version[1]).toBe(3);
    sync.onDelta(delta(2, [0, 2, [[9, 1]]]));
    expect(e.state[9]).toBe(1);
  });

  it('옛 세대의 델타는 버린다', async () => {
    const { e, sync } = syncSetup();
    sync.onDelta(delta(0, [0, 9, [[1, 2]]]));
    expect(e.state[1]).toBe(0);
    expect(e.versions.version[0]).toBe(1);
  });

  it('스냅샷이 503으로 실패하면 지연 뒤 다시 묻고, 그 사이 또 요청하지 않는다', async () => {
    const { e, t, sync, calls, replies, snap, flush } = syncSetup();
    sync.onDelta(delta(1, [0, 4, [[1, 2]]]));
    replies[0]!.reject(Object.assign(new Error('503'), { status: 503 }));
    await flush();
    sync.onDelta(delta(1, [0, 5, [[2, 2]]]));
    expect(calls).toHaveLength(1);
    await t.advance(1_000);
    expect(calls).toHaveLength(2);
    replies[1]!.resolve(snap(0, 5));
    await flush();
    expect(e.versions.version[0]).toBe(5);
  });

  it('스냅샷이 401이면 다시 묻지 않고 끝났다고 알린다', async () => {
    const { t, sync, calls, replies, flush, fatals } = syncSetup();
    sync.onDelta(delta(1, [0, 4, [[1, 2]]]));
    replies[0]!.reject(Object.assign(new Error('401'), { status: 401 }));
    await flush();
    await t.advance(30_000);
    expect(calls).toHaveLength(1);
    expect(fatals).toEqual(['unauthorized']);
  });

  it('리뷰 재현: 스냅샷의 좌석맵 판이 다르면 조용히 멈추지 않고 알린다', async () => {
    const { sync, replies, flush, fatals, layoutVersion } = syncSetup();
    sync.onDelta(delta(1, [0, 4, [[1, 2]]]));
    replies[0]!.resolve(encodeSnapshot({ flags: 1, layoutVersion: layoutVersion + 1, seatEpoch: 1, sections: [[0, 9]], occupied: Array(SEATS).fill(false) as boolean[] }));
    await flush();
    expect(fatals).toEqual(['layout']);
  });

  it('리뷰 재현(높음): 갭 스냅샷의 세대가 오르면 다른 구역도 다시 맞춘다(옛 세대의 큰 판에 새 델타가 버려지지 않게)', async () => {
    const { e, t, sync, calls, replies, snap, flush } = syncSetup();
    for (let v = 2; v <= 50; v++) sync.onDelta(delta(1, [1, v, []]));
    expect(e.versions.version[1]).toBe(50);
    sync.onDelta(delta(1, [0, 4, [[1, 2]]]));
    replies[0]!.resolve(snap(0, 3, 2));
    await flush();
    await t.advance(1_000);
    expect(calls).toContain(1);
    const r = replies.find((x) => x.section === 1)!;
    r.resolve(snap(1, 1, 2));
    await flush();
    sync.onDelta(delta(2, [1, 2, [[0, 2]]]));
    expect(e.state[SEATS]).toBe(2);
  });

  it('리뷰 재현: 요청 중에 세대가 오르거나 다시 붙으면 끝난 뒤 한 번 더 묻는다', async () => {
    const { t, sync, calls, replies, snap, flush } = syncSetup({ subscribed: [0] });
    sync.onDelta(delta(1, [0, 4, [[1, 2]]]));
    expect(calls).toEqual([0]);
    sync.resync([0]);
    expect(calls).toEqual([0]);
    replies[0]!.resolve(snap(0, 3));
    await flush();
    await t.advance(0);
    expect(calls).toEqual([0, 0]);
  });

  it('리뷰 재현: 쌓아 두는 델타는 상한이 있고, 잃어버린 뒤에는 한 번 더 묻는다', async () => {
    const { e, sync, calls, replies, snap, flush } = syncSetup();
    sync.onDelta(delta(1, [0, 4, [[1, 2]]]));
    for (let v = 5; v <= 80; v++) sync.onDelta(delta(1, [0, v, [[2, 2]]]));
    replies[0]!.resolve(snap(0, 4));
    await flush();
    expect(calls).toEqual([0, 0]);
    replies[1]!.resolve(snap(0, 80));
    await flush();
    expect(e.versions.version[0]).toBe(80);
  });

  it('[ADR-0117] 실패한 재요청은 Retry-After를 지키고, 한 페이지에서 분당 60회를 넘지 않는다', async () => {
    const subscribed = Array.from({ length: 16 }, (_, i) => i);
    const { t, sync, calls, replies, flush } = syncSetup({ subscribed });
    sync.resync(subscribed);
    expect(calls).toHaveLength(16);
    const fail = (retryAfterMs?: number) => {
      for (const r of replies.splice(0)) r.reject(Object.assign(new Error('503'), { status: 503, retryAfterMs }));
    };
    fail(3_000);
    await flush();
    await t.advance(2_000);
    expect(calls).toHaveLength(16);
    await t.advance(1_500);
    expect(calls).toHaveLength(32);
    const at = calls.length;
    for (let i = 0; i < 60; i++) {
      fail();
      await flush();
      await t.advance(1_000);
    }
    expect(calls.length - at).toBeLessThanOrEqual(60);
  });

  it('dispose 뒤에 온 응답은 반영하지 않는다', async () => {
    const { e, sync, replies, snap, flush } = syncSetup();
    sync.onDelta(delta(1, [0, 4, [[1, 2]]]));
    sync.dispose();
    replies[0]!.resolve(snap(0, 9));
    await flush();
    expect(e.versions.version[0]).toBe(1);
  });

  it('재연결 뒤 resync는 구역 수만큼 한 번씩 묻는다', () => {
    const { sync, calls } = syncSetup();
    sync.resync([0, 1, 0]);
    expect(calls.sort()).toEqual([0, 1]);
  });

  it('구역 스냅샷은 좌석 상태와 판을 그 구역만 바꾼다', () => {
    const { e, layoutVersion } = engineFixture();
    const occ = Array(SEATS).fill(false) as boolean[];
    occ[3] = true;
    e.applySectionSnapshot(decodeSnapshot(encodeSnapshot({ flags: 1, layoutVersion, seatEpoch: 1, sections: [[1, 7]], occupied: occ })));
    expect(e.state[SEATS + 3]).toBe(3);
    expect(e.state[3]).toBe(0);
    expect(e.versions.version[1]).toBe(7);
    // 리뷰 재현: 점유로 온 좌석이 이미 다른 분 선택·판매면 그 값을 지키고, 내 좌석이면 다른 분 선택으로 둬 내 표시가 남는다
    e.state[SEATS + 5] = 1;
    e.state[SEATS + 6] = 2;
    e.toggleMine(SEATS + 7);
    const occ2 = Array(SEATS).fill(false) as boolean[];
    occ2[5] = occ2[6] = occ2[7] = occ2[8] = true;
    e.applySectionSnapshot(decodeSnapshot(encodeSnapshot({ flags: 1, layoutVersion, seatEpoch: 1, sections: [[1, 8]], occupied: occ2 })));
    expect([...e.state.subarray(SEATS + 5, SEATS + 9)]).toEqual([1, 2, 1, 3]);
    expect(() => e.applySectionSnapshot(decodeSnapshot(encodeSnapshot({ flags: 1, layoutVersion: layoutVersion + 1, seatEpoch: 1, sections: [[1, 8]], occupied: occ })))).toThrow();
  });
});
