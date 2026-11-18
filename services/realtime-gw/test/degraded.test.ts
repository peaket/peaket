// 전파 Degraded 자동 전환 허브 시험(BUILD_ORDER HOT-091, BAT-053). 바깥 경계는 createStreamHub(가짜 연결의 bufferedAmount·send 갈고리·가짜 구독기·가짜 시계)다.
// 정본: docs/features/seat-hold.md §7 '전파 Degraded Mode'의 '자동 전환의 첫 구현'(2026-11-19 리뷰 반영으로 고침)·'맺은 뒤', §12 S-T14 ①~③, ADR-0298 결정 1~7,
// docs/frontend.md §4.4.1(type 3 BatchInterval, 리틀 엔디언 u16). 리뷰 반영 재현 시험 RF-T1~T10은 계획 '리뷰 반영 계획' 1의 표다(RF-T11은 '시험 이의', RF-T12는 통합).
// 단언 값은 hub-fixtures.ts의 SPEC.degraded(정본 값)이고 구현 상수를 가져오지 않는다. 경계는 양쪽(경계 − 1과 경계)을 본다.
// 표본(박자 늦음) = 박자 안에서 보낸 묶음의 '보낸 단조 시각 − 예정 시각(지난 박자 시작 + 100ms)'. 박자 처리 시간은 가짜 연결의 send 갈고리에서 가짜 시계를 밀어 만든다.
// 창 맞춤: 정본은 '단조 시계의 10초 창'만 적었다. 허브를 만든 단조 시각(START)을 10초의 배수로 두어, 만든 때부터 재든 10초 배수로 재든 같은 창이 되게 한다.
// 박자는 대개 창 시작에서 37ms 비낀 시각(START + 37 + 100k)이다. 연결 번호는 허브에 연결을 들인 차례(0부터)다.
import { describe, expect, test } from 'vitest';
import { decodeFrame } from '../../../packages/seatmap/src/wire.js';
import { channelOf, deltas, deltaText, FakeConn, harness, type Harness, settle, SPEC, subscribeBytes, WALL0 } from './hub-fixtures.js';

const D = SPEC.degraded;
const W = D.windowMs;
/** 허브를 만든 단조 시각(10초의 배수) */
const START = 1_230_000;
/** 박자가 창 시작에서 비낀 ms */
const OFF = 37;
/** 창 하나의 박자 수(10초 / 100ms) */
const TICKS_PER_WINDOW = W / SPEC.intervalMs;
const BI1000 = [1, 3, 0xe8, 0x03];
const BI100 = [1, 3, 100, 0];

/** START에서 ms 지난 단조 시각으로 시계를 옮긴다(벽시계도 같이 간다) */
const moveTo = (h: Harness, ms: number): void => h.clock.advance(START + ms - h.clock.monotonicMs());
/** START에서 ms 지난 시각의 박자 하나 */
const tickAt = (h: Harness, ms: number): void => {
  moveTo(h, ms);
  h.hub.tick();
};
/** from번째 뒤로 받은 BatchInterval 값 */
const intervals = (c: FakeConn, from = 1): number[] => c.framesFrom(from).flatMap((f) => (f.type === 'batchInterval' ? [f.intervalMs] : []));
const deltaCount = (c: FakeConn): number => deltas(c.framesFrom(1)).length;
/** 게이지의 마지막 값(받은 적 없으면 undefined) */
const gauge = (h: Harness, name: string): number | undefined => h.metrics.filter((m) => m.name === name).at(-1)?.value;
const valuesOf = (h: Harness, name: string): number[] => h.metrics.filter((m) => m.name === name).map((m) => m.value);

let version = 0;
/** 구역 section에 메시지 하나(changedAtMs = 지금 − ago, 좌석 seats개) */
const publish = (h: Harness, section: number, o: { epoch?: number; ago?: number; seats?: number } = {}): void => {
  const seats = Array.from({ length: o.seats ?? 1 }, (_, i) => [i, 1] as [number, number]);
  h.sub.publish(channelOf('ev-1', section), deltaText({ epoch: o.epoch ?? 1, section, version: ++version, changedAtMs: h.clock.now() - (o.ago ?? 0), seats }));
};
/** 그 연결이 다음에 묶음을 보낼 때 가짜 시계를 ms 민다(박자 처리 시간 → 표본 = 박자 늦음 + ms) */
const delayNextDelta = (h: Harness, c: FakeConn, ms: number): void => {
  const prev = c.onSend;
  c.onSend = (f) => {
    if (decodeFrame(f).type !== 'delta') return;
    c.onSend = prev;
    h.clock.advance(ms);
  };
};
/** 프레임 크기(머리 18 + 구역 항목마다 8 + 3 × 좌석)가 정확히 65,536이 되는 메시지 묶음: 950좌석 22개 + 878좌석 */
const BURST_65536 = [...Array<number>(22).fill(950), 878];
/** 정확히 65,535가 되는 묶음: 900좌석 23개 + 1,075좌석 */
const BURST_65535 = [...Array<number>(23).fill(900), 1_075];

/**
 * 창 w의 박자 100개(시각 w × 10,000 + 37 + 100k)를 돈다. 박자 바로 앞에 driver의 구역에 메시지 하나를 보내 박자마다 묶음 하나가 되게 하고,
 * overAt의 박자(창 안 차례 k)만 driver의 send가 lagMs(기본 51)만큼 시계를 민다. overAt이 null이면 메시지 없이 박자만 돈다(박자는 돌고 표본이 없는 창).
 * mid.run은 박자 mid.k의 75ms 뒤(박자 사이, 늦음 51ms보다 뒤)에 부른다
 */
const runWindow = (h: Harness, w: number, o: { driver: FakeConn; section: number; overAt: readonly number[] | null; lagMs?: number; mid?: { k: number; run: () => void } }): void => {
  for (let k = 0; k < TICKS_PER_WINDOW; k++) {
    const t = w * W + OFF + k * SPEC.intervalMs;
    moveTo(h, t);
    if (o.overAt !== null) {
      publish(h, o.section);
      if (o.overAt.includes(k)) delayNextDelta(h, o.driver, o.lagMs ?? 51);
    }
    h.hub.tick();
    if (o.mid?.k === k) {
      moveTo(h, t + 75);
      o.mid.run();
    }
  }
};
/** 박자 늦음 51ms가 2/100인 창(넘음: a × 100 = 200 > n = 100) */
const OVER_2 = [10, 60] as const;
/** 51ms가 1/100인 창(a × 100 = n이라 넘음이 아니다) */
const OVER_1 = [10] as const;

/** 창 0~17을 넘음 창으로 돌고 18번째 창이 끝난 정각(180,000ms)의 박자에 Degraded로 바꾼다. 바뀐 박자의 시각을 돌려준다 */
const enterDegraded = (h: Harness, driver: FakeConn, section: number): number => {
  for (let w = 0; w < D.enterWindows; w++) runWindow(h, w, { driver, section, overAt: OVER_2 });
  const at = D.enterWindows * W;
  tickAt(h, at);
  expect(gauge(h, 'realtime_gw_degraded')).toBe(1);
  return at;
};

describe('S-T14 ① 보내기 버퍼로 그 연결만 1초 간격(ADR-0298 결정 3·5)', () => {
  test('S-T14 ① 262,143B 박자엔 그대로, 262,144B 박자에 그 연결만 BatchInterval 1000 하나(이어 쌓인 묶음)이고 게이지 1, 1초 차례는 연결 번호 0이면 T + 100, T + 1,100이며 그 − 1ms 박자엔 없다. 다른 연결은 프레임 변화가 없다', async () => {
    const h = harness({ monotonic: START });
    const a = h.open();
    const b = h.open();
    for (const c of [a, b]) h.hub.receive(c, subscribeBytes([1]), true);
    await settle();

    a.bufferedAmount = D.slowEnterBytes - 1;
    publish(h, 1);
    tickAt(h, OFF);
    expect(a.framesFrom(1).map((f) => f.type)).toEqual(['delta']);
    expect(gauge(h, 'realtime_gw_buffer_slow_connections')).toBeUndefined();

    a.bufferedAmount = D.slowEnterBytes;
    publish(h, 1);
    const from = a.sent.length;
    const T = OFF + 100;
    tickAt(h, T);
    // 간격 판정과 BatchInterval → 쌓인 묶음(같은 박자)
    expect(a.framesFrom(from).map((f) => f.type)).toEqual(['batchInterval', 'delta']);
    expect([...a.sent[from]!]).toEqual(BI1000);
    expect(gauge(h, 'realtime_gw_buffer_slow_connections')).toBe(1);
    expect(gauge(h, 'realtime_gw_degraded')).toBeUndefined(); // 한 연결의 버퍼는 파드 전환에 넣지 않는다

    // 첫 차례 T + 100 × ((0 mod 10) + 1) = T + 100
    moveTo(h, T + 13);
    publish(h, 1);
    tickAt(h, T + 99);
    expect(deltaCount(a)).toBe(2);
    tickAt(h, T + 100);
    expect(deltaCount(a)).toBe(3);
    // 다음 차례 T + 1,100(고정 격자)
    moveTo(h, T + 150);
    publish(h, 1);
    for (let t = T + 200; t <= T + 1_000; t += 100) tickAt(h, t);
    tickAt(h, T + 1_099);
    expect(deltaCount(a)).toBe(3);
    tickAt(h, T + 1_100);
    expect(deltaCount(a)).toBe(4);
    expect(intervals(a)).toEqual([D.intervalMs]); // 간격이 그대로인 박자엔 다시 보내지 않는다

    // 다른 연결: BatchInterval 없이 박자마다 묶음
    expect(intervals(b)).toEqual([]);
    expect(deltaCount(b)).toBe(4);
    expect(b.closed).toBeUndefined();
  });

  test('S-T14 ① 1초가 된 연결은 차례 직전 버퍼가 65,536B 이하인 차례가 30번 이어진 차례에 BatchInterval 100을 받고(29번에는 아니다), 65,537B 차례가 끼면 처음부터 세며, 차례가 아닌 박자의 버퍼는 보지 않는다. 게이지 1 → 0이고 그 뒤 묶음은 100ms 박자에 온다', async () => {
    const h = harness({ monotonic: START });
    const a = h.open();
    const b = h.open();
    h.hub.receive(a, subscribeBytes([1]), true);
    await settle();
    a.bufferedAmount = D.slowEnterBytes + 5_000;
    tickAt(h, OFF);
    expect(intervals(a)).toEqual([D.intervalMs]);
    // 차례 j(0부터): OFF + 100 + 1,000j(박자 k = 1 + 10j)
    for (let k = 1; k <= 501; k++) {
      const turn = (k - 1) % 10 === 0;
      const j = Math.floor((k - 1) / 10);
      // j < 6: 64KiB와 256KiB 사이(그대로). 그 뒤 차례가 아닌 박자는 100,000B, 차례는 65,536B(j = 20만 65,537B로 끊는다)
      a.bufferedAmount = j < 6 ? D.slowExitBytes + 1 : !turn ? 100_000 : j === 20 ? D.slowExitBytes + 1 : D.slowExitBytes;
      tickAt(h, OFF + 100 * k);
      if (turn && j === 49) {
        // 낮은 차례 j = 21~49는 29번이다
        expect(intervals(a)).toEqual([D.intervalMs]);
        expect(gauge(h, 'realtime_gw_buffer_slow_connections')).toBe(1);
      }
    }
    // k = 501은 차례 j = 50, 30번째 낮은 차례
    expect(intervals(a)).toEqual([D.intervalMs, SPEC.intervalMs]);
    expect([...a.sent.at(-1)!]).toEqual(BI100);
    expect(gauge(h, 'realtime_gw_buffer_slow_connections')).toBe(0);

    // 되돌린 뒤 묶음은 다음 100ms 박자에 온다
    a.bufferedAmount = 0;
    const last = OFF + 100 * 501;
    moveTo(h, last + 13);
    publish(h, 1);
    const before = deltaCount(a);
    tickAt(h, last + 100);
    expect(deltaCount(a)).toBe(before + 1);
    expect(intervals(b)).toEqual([]);
    expect(gauge(h, 'realtime_gw_degraded')).toBeUndefined();
  });

  test('S-T14 ① RF-T6 들어오는 양(박자마다 약 10KB)보다 빨리 빼 가는(300KiB/s) 연결은 1초 동안 버퍼가 늘 남아도, 한 번 256KiB를 넘긴 뒤 차례 직전 버퍼가 64KiB 이하인 차례 30번 뒤 BatchInterval 100을 받는다(29번에는 아니다)', async () => {
    const h = harness({ monotonic: START });
    const RATE = 300 * 1024; // B/s
    let buf = 0;
    let last = h.clock.monotonicMs();
    const level = (): number => {
      const now = h.clock.monotonicMs();
      buf = Math.max(0, buf - (RATE * (now - last)) / 1000);
      last = now;
      return buf;
    };
    const c = new FakeConn();
    Object.defineProperty(c, 'bufferedAmount', { get: level, configurable: true });
    c.onSend = (f) => {
      level();
      buf += f.byteLength;
    };
    h.hub.open(c, { eventId: 'ev-1', accountId: 'acct-1', expiresAtMs: WALL0 + 3_600_000, tokenId: 'jti-drain' });
    h.hub.receive(c, subscribeBytes([1]), true);
    await settle();
    const SEATS = 3_400; // 항목 10,208B
    const step = (t: number): void => {
      moveTo(h, t);
      publish(h, 1, { seats: SEATS });
      h.hub.tick();
    };
    let t = OFF;
    for (; t < OFF + 2_000; t += 100) step(t);
    expect(intervals(c)).toEqual([]);
    // 한 번 300KiB를 더해 256KiB를 넘긴다 → 그 박자(T)에 1초. 연결 번호 0: 차례 T + 100 + 1,000j
    const T = t;
    moveTo(h, T);
    level();
    buf += 300 * 1024;
    step(T);
    expect(intervals(c)).toEqual([D.intervalMs]);
    // 첫 차례(T + 100)는 버퍼가 아직 64KiB를 넘고, T + 1,100부터 차례마다 64KiB 이하 → 30번째는 T + 30,100
    for (t = T + 100; t <= T + 30_000; t += 100) step(t);
    expect(intervals(c)).toEqual([D.intervalMs]);
    step(T + 30_100);
    expect(intervals(c)).toEqual([D.intervalMs, SPEC.intervalMs]);
    expect(c.closed).toBeUndefined();
  });

  test('S-T14 ① RF-T10 1초 간격인 연결도 1,048,577B 박자에 1013 slow consumer로 닫히고 게이지에서 빠지며, 1,048,576B인 연결은 열린 채 1초 간격이고, 상대가 닫으면(gone) 게이지가 1 → 0이다', () => {
    const h = harness({ monotonic: START });
    const over = h.open();
    const atLimit = h.open();
    over.bufferedAmount = D.slowEnterBytes;
    atLimit.bufferedAmount = SPEC.maxBuffered;
    tickAt(h, OFF);
    expect(intervals(over)).toEqual([D.intervalMs]);
    expect(intervals(atLimit)).toEqual([D.intervalMs]);
    expect(gauge(h, 'realtime_gw_buffer_slow_connections')).toBe(2);
    // 1초 차례가 아닌 박자에도 1MiB 검사는 박자마다 본다
    over.bufferedAmount = SPEC.maxBuffered + 1;
    const sent = over.sent.length;
    tickAt(h, OFF + 50);
    expect(over.closes).toEqual([{ code: SPEC.close.slow, reason: SPEC.reason.slow }]);
    expect(over.sent).toHaveLength(sent);
    expect(gauge(h, 'realtime_gw_buffer_slow_connections')).toBe(1);
    tickAt(h, OFF + 1_100);
    expect(atLimit.closed).toBeUndefined();
    // 상대가 닫은 길
    h.hub.gone(atLimit);
    expect(gauge(h, 'realtime_gw_buffer_slow_connections')).toBe(0);
  });
});

describe('S-T14 ② 파드 전환: 박자 늦음의 10초 창(ADR-0298 결정 1·2·6·7)', () => {
  test('S-T14 ② 박자 늦음 51ms가 2/100인 창이 18개 이어지면 18번째 창이 끝난 정각의 박자에 파드의 모든 연결이 BatchInterval 1000을 한 번 받고 realtime_gw_degraded 1, 바뀜 한 번(n 100·a 2·b 2·박자 101)이다. 17개 뒤와 창 끝 − 1ms에는 아니고, 박자 밖(65,536B)에 곧 보낸 묶음은 n에 들지 않는다', async () => {
    const h = harness({ monotonic: START });
    const driver = h.open();
    const idle = h.open(); // 구독 없는 연결도 파드의 연결이다
    const big = h.open();
    h.hub.receive(driver, subscribeBytes([1]), true);
    h.hub.receive(big, subscribeBytes([4]), true);
    await settle();
    for (let w = 0; w < D.enterWindows - 1; w++) runWindow(h, w, { driver, section: 1, overAt: OVER_2 });
    runWindow(h, D.enterWindows - 1, {
      driver,
      section: 1,
      overAt: OVER_2,
      mid: {
        k: 50,
        run: () => {
          for (const n of BURST_65536) publish(h, 4, { seats: n });
        },
      },
    });
    expect(big.sent.at(-1)!.byteLength).toBe(D.maxPendingFrameBytes);
    expect(intervals(driver)).toEqual([]);
    expect(intervals(idle)).toEqual([]);
    expect(h.degradedChanges).toEqual([]);
    expect(gauge(h, 'realtime_gw_degraded')).toBeUndefined();
    tickAt(h, D.enterWindows * W - 1);
    expect(intervals(idle)).toEqual([]);
    tickAt(h, D.enterWindows * W);
    for (const c of [driver, idle, big]) expect(intervals(c)).toEqual([D.intervalMs]);
    expect([...idle.sent.at(-1)!]).toEqual(BI1000);
    expect(gauge(h, 'realtime_gw_degraded')).toBe(1);
    expect(h.degradedChanges).toEqual([{ degraded: true, batches: 100, overEnter: 2, overExit: 2, ticks: 101 }]);
    expect(gauge(h, 'realtime_gw_buffer_slow_connections')).toBeUndefined();
    for (let t = D.enterWindows * W + OFF; t < D.enterWindows * W + 20_000; t += 100) tickAt(h, t);
    expect(intervals(driver)).toEqual([D.intervalMs]);
    expect(intervals(idle)).toEqual([D.intervalMs]);
    expect(h.degradedChanges).toHaveLength(1);
  });

  test('S-T14 ② 넘음 창 17개 뒤 a × 100 = n인 창(51ms 1/100)이 끼면 처음부터 센다: 그 뒤 17개로는 아니고 18개째 끝에 1000이다', async () => {
    const h = harness({ monotonic: START });
    const driver = h.open();
    h.hub.receive(driver, subscribeBytes([1]), true);
    await settle();
    const run = (w: number, overAt: readonly number[]) => runWindow(h, w, { driver, section: 1, overAt });
    for (let w = 0; w < 17; w++) run(w, OVER_2);
    run(17, OVER_1);
    for (let w = 18; w < 18 + 17; w++) run(w, OVER_2);
    tickAt(h, 35 * W - 1);
    expect(intervals(driver)).toEqual([]);
    run(35, OVER_2);
    tickAt(h, 36 * W - 1);
    expect(intervals(driver)).toEqual([]);
    expect(h.degradedChanges).toEqual([]);
    tickAt(h, 36 * W);
    expect(intervals(driver)).toEqual([D.intervalMs]);
  });

  test('S-T14 ② 넘음 창 17개 뒤 박자는 돌고 표본이 없는 창이 끼면 이어짐이 끊긴다(괜찮음): 그 뒤 1개·17개로는 아니고 18개째 끝에 1000이다', async () => {
    const h = harness({ monotonic: START });
    const driver = h.open();
    h.hub.receive(driver, subscribeBytes([1]), true);
    await settle();
    for (let w = 0; w < 17; w++) runWindow(h, w, { driver, section: 1, overAt: OVER_2 });
    runWindow(h, 17, { driver, section: 1, overAt: null });
    runWindow(h, 18, { driver, section: 1, overAt: OVER_2 });
    tickAt(h, 19 * W);
    expect(intervals(driver)).toEqual([]);
    for (let w = 19; w < 35; w++) runWindow(h, w, { driver, section: 1, overAt: OVER_2 });
    tickAt(h, 35 * W);
    expect(intervals(driver)).toEqual([]);
    expect(h.degradedChanges).toEqual([]);
    runWindow(h, 35, { driver, section: 1, overAt: OVER_2 });
    tickAt(h, 36 * W);
    expect(intervals(driver)).toEqual([D.intervalMs]);
  });

  test('S-T14 ② 박자 늦음 50ms 정각(넘음 아님)이 2/100인 창은 20개 이어져도 그대로다', async () => {
    const h = harness({ monotonic: START });
    const driver = h.open();
    h.hub.receive(driver, subscribeBytes([1]), true);
    await settle();
    for (let w = 0; w < 20; w++) runWindow(h, w, { driver, section: 1, overAt: OVER_2, lagMs: D.enterLagMs });
    tickAt(h, 20 * W + 500);
    expect(intervals(driver)).toEqual([]);
    expect(h.degradedChanges).toEqual([]);
    expect(gauge(h, 'realtime_gw_degraded')).toBeUndefined();
  });

  test('S-T14 ② RF-T7 넘음 창 17개 뒤 박자가 25,000ms 멈추면 박자가 돌지 않은 창이 넘음으로 세어져 다시 돈 박자에 Degraded다(마지막 창 n 0·박자 0)', async () => {
    const h = harness({ monotonic: START });
    const driver = h.open();
    h.hub.receive(driver, subscribeBytes([1]), true);
    await settle();
    for (let w = 0; w < 17; w++) runWindow(h, w, { driver, section: 1, overAt: OVER_2 });
    const stoppedAt = 16 * W + OFF + 99 * 100; // 169,937
    tickAt(h, stoppedAt + 25_000);
    expect(intervals(driver)).toEqual([D.intervalMs]);
    expect(gauge(h, 'realtime_gw_degraded')).toBe(1);
    expect(h.degradedChanges).toEqual([{ degraded: true, batches: 0, overEnter: 0, overExit: 0, ticks: 0 }]);
  });

  test('S-T14 ② RF-T7 Degraded에서 박자가 300,001ms 멈추면(박자가 돌지 않은 창은 괜찮음이 아니다) Degraded 그대로다', async () => {
    const h = harness({ monotonic: START });
    const driver = h.open();
    h.hub.receive(driver, subscribeBytes([1]), true);
    await settle();
    const T0 = enterDegraded(h, driver, 1);
    tickAt(h, T0 + 300_001);
    expect(intervals(driver)).toEqual([D.intervalMs]);
    expect(gauge(h, 'realtime_gw_degraded')).toBe(1);
    expect(h.degradedChanges).toHaveLength(1);
  });

  test('S-T14 ② RF-T9 Degraded에서 p99 25ms 이하 창이 30개 이어지면 모든 연결이 BatchInterval 100을 받고 0이다. 29개로는 아니고, 26ms 2/100 창이 끼면 처음부터 세며, 25ms 정각 2/100 창은 괜찮음이다. 되돌린 박자의 1초 묶음(maxWaitMs 약 900)은 박자 늦음 0으로 세어 그 창 + 넘음 창 17개로는 들어가지 않는다', async () => {
    const h = harness({ monotonic: START });
    // 연결 번호 0~9가 구역 0~9: Degraded에서 박자마다 한 연결이 차례(흩기) → 창 하나에 n = 100
    const conns = Array.from({ length: 10 }, () => h.open());
    conns.forEach((c, i) => h.hub.receive(c, subscribeBytes([i]), true));
    const idle = h.open();
    await settle();
    const T0 = enterDegraded(h, conns[0]!, 0);
    for (const c of [...conns, idle]) expect(intervals(c)).toEqual([D.intervalMs]);
    // lagged: 창 w의 박자 k 앞에 그 연결의 다음 묶음(다음 차례)에 lagMs를 단다. 연결 c의 차례 박자는 k ≡ c + 1 (mod 10)
    const degradedWindow = (w: number, lagged: Array<{ k: number; conn: number; lagMs: number }> = []): void => {
      for (let k = 0; k < TICKS_PER_WINDOW; k++) {
        const t = w * W + OFF + k * SPEC.intervalMs;
        if (t <= T0) continue;
        moveTo(h, t);
        for (let s = 0; s < 10; s++) publish(h, s);
        for (const x of lagged) if (x.k === k) delayNextDelta(h, conns[x.conn]!, x.lagMs);
        h.hub.tick();
      }
    };
    for (let w = 18; w <= 46; w++) degradedWindow(w);
    tickAt(h, 47 * W);
    expect(intervals(conns[0]!)).toEqual([D.intervalMs]);
    expect(h.degradedChanges).toHaveLength(1);
    // 창 47: 26ms 2/100 → 괜찮음 아님, 처음부터
    degradedWindow(47, [
      { k: 30, conn: 1, lagMs: 26 },
      { k: 70, conn: 2, lagMs: 26 },
    ]);
    // 창 48~76(29개). 창 50에는 25ms 정각 2/100(괜찮음)
    for (let w = 48; w <= 76; w++)
      degradedWindow(
        w,
        w === 50
          ? [
              { k: 20, conn: 3, lagMs: 25 },
              { k: 60, conn: 4, lagMs: 25 },
            ]
          : [],
      );
    tickAt(h, 77 * W);
    expect(intervals(conns[0]!)).toEqual([D.intervalMs]);
    expect(h.degradedChanges).toHaveLength(1);
    degradedWindow(77);
    tickAt(h, 78 * W - 1);
    expect(intervals(idle)).toEqual([D.intervalMs]);
    tickAt(h, 78 * W);
    for (const c of [...conns, idle]) expect(intervals(c)).toEqual([D.intervalMs, SPEC.intervalMs]);
    expect(valuesOf(h, 'realtime_gw_degraded')).toEqual([1, 0]);
    // 창 77의 박자: 770,000 + 100개 + 779,999
    expect(h.degradedChanges).toEqual([
      { degraded: true, batches: 100, overEnter: 2, overExit: 2, ticks: 100 },
      { degraded: false, batches: 100, overEnter: 0, overExit: 0, ticks: 102 },
    ]);
    // RF-T9: 되돌린 박자(창 78)에 열 연결이 1초 동안 쌓인 묶음을 보냈다. 그 창은 51ms 1/100(n 110·a 1)로 넘음이 아니다
    runWindow(h, 78, { driver: conns[0]!, section: 0, overAt: OVER_1 });
    for (let w = 79; w < 79 + 17; w++) runWindow(h, w, { driver: conns[0]!, section: 0, overAt: OVER_2 });
    tickAt(h, 96 * W);
    expect(intervals(conns[0]!)).toEqual([D.intervalMs, SPEC.intervalMs]);
    runWindow(h, 96, { driver: conns[0]!, section: 0, overAt: OVER_2 });
    tickAt(h, 97 * W);
    expect(intervals(conns[0]!)).toEqual([D.intervalMs, SPEC.intervalMs, D.intervalMs]);
  });

  test.each([103, 107])('S-T14 ② RF-T1 Degraded에서 박자가 %ims마다 오고 realtime-gw 안 지연이 없으면 30창 뒤 모든 연결이 BatchInterval 100을 받고 게이지 0이다(29창에는 아니다). realtime_gw_tick_lag_ms에 박자 늦음이 남는다', async (P) => {
    const h = harness({ monotonic: START });
    const conns = Array.from({ length: 10 }, () => h.open());
    conns.forEach((c, i) => h.hub.receive(c, subscribeBytes([i]), true));
    await settle();
    const T0 = enterDegraded(h, conns[0]!, 0);
    const step = (t: number): void => {
      moveTo(h, t);
      for (let s = 0; s < 10; s++) publish(h, s);
      h.hub.tick();
    };
    let t = T0 + P;
    for (; t < 48 * W; t += P) step(t);
    for (const c of conns) expect(intervals(c)).toEqual([D.intervalMs]);
    step(t);
    for (const c of conns) expect(intervals(c)).toEqual([D.intervalMs, SPEC.intervalMs]);
    expect(gauge(h, 'realtime_gw_degraded')).toBe(0);
    expect(valuesOf(h, 'realtime_gw_tick_lag_ms')).toContain(P - 100);
  });

  test('S-T14 ② RF-T2 평시에 changedAtMs가 파드 시계보다 80ms 뒤진 메시지(시계 차이·Redis 퍼짐)를 박자 바로 뒤에 받아도 25창 동안 Degraded가 아니고 realtime_gw_pubsub_lag_ms에 80이 남는다. 같은 꼴(−40)으로 Degraded에서는 30창 뒤 돌아온다', async () => {
    const h = harness({ monotonic: START });
    const driver = h.open();
    h.hub.receive(driver, subscribeBytes([1]), true);
    await settle();
    const lagged = (from: number, to: number, ago: number): void => {
      for (let w = from; w < to; w++)
        for (let k = 0; k < TICKS_PER_WINDOW; k++) {
          const t = w * W + OFF + k * SPEC.intervalMs;
          tickAt(h, t);
          moveTo(h, t + 1);
          publish(h, 1, { ago });
        }
    };
    lagged(0, 25, 80);
    tickAt(h, 25 * W);
    expect(intervals(driver)).toEqual([]);
    expect(h.degradedChanges).toEqual([]);
    expect(valuesOf(h, 'realtime_gw_pubsub_lag_ms')).toContain(80);
    // 넘음 창 18개(25~42)로 들인다
    for (let w = 25; w < 43; w++) runWindow(h, w, { driver, section: 1, overAt: OVER_2 });
    tickAt(h, 43 * W);
    expect(intervals(driver)).toEqual([D.intervalMs]);
    // Degraded: 창 43~72(30개)
    lagged(43, 73, 40);
    tickAt(h, 73 * W - 1);
    expect(intervals(driver)).toEqual([D.intervalMs]);
    tickAt(h, 73 * W);
    expect(intervals(driver)).toEqual([D.intervalMs, SPEC.intervalMs]);
    expect(valuesOf(h, 'realtime_gw_pubsub_lag_ms')).toContain(40);
  });

  test('S-T14 ② RF-T3 보내기 버퍼로 1초가 된 연결(마지막 번호)의 send가 70ms씩 걸려도 그 묶음은 n·a·b에 들지 않아 20창이 지나도 다른 연결은 BatchInterval 1000을 받지 않는다 [ASVS v5.0.0-2.4.1]', async () => {
    const h = harness({ monotonic: START });
    const b = h.open();
    const a = h.open();
    for (const c of [b, a]) h.hub.receive(c, subscribeBytes([1]), true);
    await settle();
    a.bufferedAmount = 300 * 1024;
    a.onSend = (f) => {
      if (decodeFrame(f).type === 'delta') h.clock.advance(70);
    };
    for (let w = 0; w < 20; w++) runWindow(h, w, { driver: b, section: 1, overAt: [] });
    tickAt(h, 20 * W);
    expect(intervals(a)).toEqual([D.intervalMs]);
    expect(deltaCount(a)).toBeGreaterThan(150);
    expect(intervals(b)).toEqual([]);
    expect(h.degradedChanges).toEqual([]);
    expect(gauge(h, 'realtime_gw_degraded')).toBeUndefined();
  });

  test('S-T14 ② RF-T4 Degraded, 연결 100개, 박자 100ms이고 9.7초마다 박자 하나가 35ms 늦으면(그 박자의 표본은 창의 1% = 10/1,000) 30창 뒤 돌아온다', async () => {
    const h = harness({ monotonic: START });
    const many = Array.from({ length: 100 }, () => h.open());
    const driver = h.open();
    for (const c of many) h.hub.receive(c, subscribeBytes([2]), true);
    h.hub.receive(driver, subscribeBytes([1]), true);
    await settle();
    const T0 = enterDegraded(h, driver, 1);
    // 늦은 박자 199,900 + 9,700k(창 19~47마다 꼭 하나)
    const late = new Set(Array.from({ length: 29 }, (_, k) => 199_900 + 9_700 * k));
    for (let g = T0 + 100; g < 48 * W; g += 100) {
      moveTo(h, late.has(g) ? g + 35 : g);
      publish(h, 2);
      h.hub.tick();
    }
    expect(intervals(many[0]!)).toEqual([D.intervalMs]);
    moveTo(h, 48 * W);
    publish(h, 2);
    h.hub.tick();
    for (const c of many) expect(intervals(c)).toEqual([D.intervalMs, SPEC.intervalMs]);
  });
});

describe('S-T14 ③ 1초 간격 연결의 첫 프레임·알림·차례(ADR-0298 결정 4·5)', () => {
  test('S-T14 ③ 파드가 Degraded인 동안 새로 붙은 연결의 첫 프레임은 BatchInterval 1000 하나이고, 간격이 그대로인 박자엔 다시 보내지 않는다', async () => {
    const h = harness({ monotonic: START });
    const driver = h.open();
    h.hub.receive(driver, subscribeBytes([1]), true);
    await settle();
    const T0 = enterDegraded(h, driver, 1);
    moveTo(h, T0 + 3);
    const late = h.open();
    expect(late.frames()).toEqual([{ type: 'batchInterval', intervalMs: D.intervalMs }]);
    expect([...late.sent[0]!]).toEqual(BI1000);
    for (let t = T0 + 100; t <= T0 + 5_000; t += 100) tickAt(h, t);
    expect(late.frames().filter((f) => f.type === 'batchInterval')).toEqual([{ type: 'batchInterval', intervalMs: D.intervalMs }]);
    expect(late.closed).toBeUndefined();
  });

  test('S-T14 ③ 1초 차례는 고정 격자다(연결 번호 1이면 바뀐 때 + 200, 그 뒤 1,000ms마다): 차례 − 1ms 박자엔 없고, 쌓인 것이 없는 차례도 넘어가며, 박자가 늦어도 차례가 밀리지 않고, 세대가 바뀐 메시지가 오면 쌓인 것을 바로 보낸다', async () => {
    const h = harness({ monotonic: START });
    const driver = h.open();
    const b = h.open();
    h.hub.receive(driver, subscribeBytes([1]), true);
    h.hub.receive(b, subscribeBytes([2]), true);
    await settle();
    const T0 = enterDegraded(h, driver, 1);
    expect(intervals(b)).toEqual([D.intervalMs]);

    moveTo(h, T0 + 50);
    publish(h, 2);
    tickAt(h, T0 + 100);
    tickAt(h, T0 + 199);
    expect(deltaCount(b)).toBe(0);
    tickAt(h, T0 + 200);
    expect(deltaCount(b)).toBe(1);

    // 차례 T0 + 1,200은 쌓인 것 없이 지나간다 → 다음 차례 T0 + 2,200
    for (let t = T0 + 300; t <= T0 + 1_200; t += 100) tickAt(h, t);
    moveTo(h, T0 + 1_250);
    publish(h, 2);
    for (let t = T0 + 1_300; t <= T0 + 2_100; t += 100) tickAt(h, t);
    tickAt(h, T0 + 2_199);
    expect(deltaCount(b)).toBe(1);
    tickAt(h, T0 + 2_200);
    expect(deltaCount(b)).toBe(2);

    // 차례 T0 + 3,200의 박자가 60ms 늦게(T0 + 3,260) 와도 다음 차례는 T0 + 4,200이다
    moveTo(h, T0 + 2_250);
    publish(h, 2);
    for (let t = T0 + 2_300; t <= T0 + 3_100; t += 100) tickAt(h, t);
    tickAt(h, T0 + 3_260);
    expect(deltaCount(b)).toBe(3);
    moveTo(h, T0 + 3_280);
    publish(h, 2);
    for (let t = T0 + 3_360; t <= T0 + 4_160; t += 100) tickAt(h, t);
    tickAt(h, T0 + 4_199);
    expect(deltaCount(b)).toBe(3);
    tickAt(h, T0 + 4_200);
    expect(deltaCount(b)).toBe(4);

    // 세대 5가 쌓인 뒤 세대 6이 오면(박자 사이) 세대 5 묶음이 바로 나가고, 세대 6은 다음 차례(T0 + 5,200)에
    moveTo(h, T0 + 4_250);
    publish(h, 2, { epoch: 5 });
    tickAt(h, T0 + 4_300);
    moveTo(h, T0 + 4_350);
    publish(h, 2, { epoch: 6 });
    expect(deltas(b.framesFrom(1)).map((f) => f.seatEpoch)).toEqual([1, 1, 1, 1, 5]);
    expect(deltas(b.framesFrom(1)).at(-1)!.serverTimeMs).toBe(WALL0 + T0 + 4_350);
    for (let t = T0 + 4_400; t <= T0 + 5_100; t += 100) tickAt(h, t);
    tickAt(h, T0 + 5_199);
    expect(deltaCount(b)).toBe(5);
    tickAt(h, T0 + 5_200);
    expect(deltas(b.framesFrom(1)).map((f) => f.seatEpoch)).toEqual([1, 1, 1, 1, 5, 6]);
    expect(intervals(b)).toEqual([D.intervalMs]);
  });

  test('S-T14 ③ RF-T5 연결 20개(번호 0~19)로 파드 전환하면 연결 i의 첫 차례는 t + 100 × ((i mod 10) + 1)이고 그 뒤 1,000ms마다라 한 박자에 보내는 1초 연결은 2개뿐이며, 차례 − 1ms 박자에는 없다', async () => {
    const h = harness({ monotonic: START });
    const conns = Array.from({ length: 20 }, () => h.open());
    const driver = h.open();
    h.hub.receive(driver, subscribeBytes([1]), true);
    await settle();
    const T0 = enterDegraded(h, driver, 1);
    moveTo(h, T0 + 5);
    for (const c of conns) h.hub.receive(c, subscribeBytes([2]), true);
    await settle();
    const sentAt = (t: number): number[] => {
      moveTo(h, t);
      publish(h, 2);
      const before = conns.map(deltaCount);
      h.hub.tick();
      return conns.flatMap((c, i) => (deltaCount(c) > before[i]! ? [i] : []));
    };
    for (let j = 1; j <= 20; j++) {
      if (j === 3) expect(sentAt(T0 + 299)).toEqual([]);
      const m = (j - 1) % 10;
      expect(sentAt(T0 + 100 * j)).toEqual([m, m + 10]);
    }
  });

  test('S-T14 ③ 1초 간격 연결에도 15초 주기 하트비트와 토큰 exp의 4401은 박자 단위 그대로다(1초 차례가 아닌 박자에 온다)', () => {
    const h = harness({ monotonic: START });
    // 맺은 때 START, exp는 벽시계 WALL0 + 16,321(박자 배수가 아님)
    const c = h.open({ expiresAtMs: WALL0 + 16_321 });
    const hb = () => c.frames().filter((f) => f.type === 'heartbeat');
    tickAt(h, OFF);
    // OFF + 100 박자에 버퍼로 1초: 연결 번호 0의 차례는 OFF + 200 + 1,000j라 15,000ms·16,321ms 박자는 차례가 아니다
    c.bufferedAmount = D.slowEnterBytes;
    tickAt(h, OFF + 100);
    expect(intervals(c)).toEqual([D.intervalMs]);
    for (let t = OFF + 200; t <= 14_937; t += 100) tickAt(h, t);
    tickAt(h, 14_999);
    expect(hb()).toEqual([]);
    tickAt(h, 15_000);
    expect(hb()).toEqual([{ type: 'heartbeat', serverTimeMs: WALL0 + 15_000, echoClientTimeMs: 0 }]);
    for (let t = 15_100; t <= 16_300; t += 100) tickAt(h, t);
    tickAt(h, 16_320);
    expect(c.closed).toBeUndefined();
    tickAt(h, 16_321);
    expect(c.closes).toEqual([{ code: SPEC.close.expired, reason: SPEC.reason.expired }]);
    expect(gauge(h, 'realtime_gw_buffer_slow_connections')).toBe(0);
  });

  test('S-T14 ③ RF-T8 쌓인 묶음 프레임이 65,536B에 닿으면 1초 연결도 평시 연결도 차례·박자 전에 그 자리에서 보내고(65,535B면 기다린다), 프레임은 65,536B + 마지막 메시지 이하다 [ASVS v5.0.0-2.4.1]', async () => {
    const h = harness({ monotonic: START });
    const a = h.open();
    const b = h.open();
    for (const c of [a, b]) h.hub.receive(c, subscribeBytes([3]), true);
    await settle();
    a.bufferedAmount = 300 * 1024;
    tickAt(h, OFF);
    expect(intervals(a)).toEqual([D.intervalMs]);
    expect(intervals(b)).toEqual([]);
    moveTo(h, OFF + 50);
    const sizes = () => [a, b].map((c) => c.sent.length);
    const before = sizes();
    for (const n of BURST_65536.slice(0, -1)) publish(h, 3, { seats: n });
    expect(sizes()).toEqual(before);
    publish(h, 3, { seats: BURST_65536.at(-1)! });
    expect(sizes()).toEqual(before.map((n) => n + 1));
    for (const c of [a, b]) {
      expect(c.sent.at(-1)!.byteLength).toBe(D.maxPendingFrameBytes);
      expect(deltas([decodeFrame(c.sent.at(-1)!)])[0]!.sections).toHaveLength(BURST_65536.length);
    }
    const mid = sizes();
    for (const n of BURST_65535) publish(h, 3, { seats: n });
    expect(sizes()).toEqual(mid); // 65,535B: 기다린다
    publish(h, 3, { seats: 10 }); // 항목 38B
    expect(sizes()).toEqual(mid.map((n) => n + 1));
    for (const c of [a, b]) {
      expect(c.sent.at(-1)!.byteLength).toBe(D.maxPendingFrameBytes - 1 + 38);
      expect(c.sent.at(-1)!.byteLength).toBeLessThanOrEqual(D.maxPendingFrameBytes + 38);
    }
  });

  test('S-T14 ③ 파드와 버퍼에 함께 걸린 연결은 둘 다 풀린 박자에만 BatchInterval 100을 받는다: 파드가 먼저 돌아오면 버퍼 차례 30번 뒤에, 버퍼가 먼저 풀리면 파드가 돌아온 박자에', async () => {
    const h = harness({ monotonic: START });
    const driver = h.open();
    const x = h.open(); // 연결 번호 1: 파드가 먼저 돌아온다
    const y = h.open(); // 연결 번호 2: 버퍼가 먼저 풀린다
    h.hub.receive(driver, subscribeBytes([1]), true);
    await settle();
    // 창 0의 첫 박자(OFF)에 x·y가 버퍼로 1초(차례 x: OFF + 200 + 1,000j, y: OFF + 300 + 1,000j), 그 뒤 64KiB와 256KiB 사이에 머문다
    x.bufferedAmount = D.slowEnterBytes;
    y.bufferedAmount = D.slowEnterBytes;
    runWindow(h, 0, {
      driver,
      section: 1,
      overAt: OVER_2,
      mid: {
        k: 0,
        run: () => {
          x.bufferedAmount = y.bufferedAmount = 100_000;
        },
      },
    });
    expect(intervals(x)).toEqual([D.intervalMs]);
    expect(intervals(y)).toEqual([D.intervalMs]);
    for (let w = 1; w < D.enterWindows; w++) runWindow(h, w, { driver, section: 1, overAt: OVER_2 });
    tickAt(h, D.enterWindows * W);
    expect(intervals(driver)).toEqual([D.intervalMs]);
    expect(intervals(x)).toEqual([D.intervalMs]);
    expect(intervals(y)).toEqual([D.intervalMs]);

    // y는 Degraded 동안 버퍼가 비어 차례 30번 뒤 버퍼에서 풀린다(간격은 파드 때문에 그대로라 알림 없음)
    y.bufferedAmount = 0;
    for (let t = D.enterWindows * W + OFF; t < 48 * W; t += 100) tickAt(h, t);
    expect(intervals(y)).toEqual([D.intervalMs]);
    // 박자는 돌고 표본이 없는 창 18~47(30개)이 끝난 정각에 파드가 돌아온다
    tickAt(h, 48 * W - 1);
    expect(intervals(driver)).toEqual([D.intervalMs]);
    tickAt(h, 48 * W);
    expect(gauge(h, 'realtime_gw_degraded')).toBe(0);
    expect(intervals(driver)).toEqual([D.intervalMs, SPEC.intervalMs]);
    expect(intervals(y)).toEqual([D.intervalMs, SPEC.intervalMs]);
    expect(intervals(x)).toEqual([D.intervalMs]);

    // x: 480,037부터 64KiB. 차례 480,237(1번) … 509,237(30번)
    x.bufferedAmount = D.slowExitBytes;
    for (let t = 48 * W + OFF; t <= 509_137; t += 100) tickAt(h, t);
    expect(intervals(x)).toEqual([D.intervalMs]);
    tickAt(h, 509_237);
    expect(intervals(x)).toEqual([D.intervalMs, SPEC.intervalMs]);
    expect(intervals(driver)).toEqual([D.intervalMs, SPEC.intervalMs]);
    expect(intervals(y)).toEqual([D.intervalMs, SPEC.intervalMs]);
  });
});

describe('S-T14 ②③ 버퍼 1초 연결의 차례 보내기는 박자 끝, 20ms 몫(SEC-06, ADR-0298 결정 5)', () => {
  test('S-T14 ② RF-T13 먼저 연 버퍼 1초 연결 a의 차례 send가 70ms씩 걸려도 a의 묶음은 같은 박자의 b 묶음 뒤에 나가 b의 표본을 늦추지 않으므로 20창이 지나도 b는 BatchInterval 1000을 받지 않는다 [ASVS v5.0.0-2.4.1]', async () => {
    const h = harness({ monotonic: START });
    const a = h.open(); // 연결 번호 0(b보다 먼저)
    const b = h.open();
    for (const c of [a, b]) h.hub.receive(c, subscribeBytes([1]), true);
    await settle();
    const order: Array<['a' | 'b', number]> = [];
    a.bufferedAmount = 300 * 1024;
    a.onSend = (f) => {
      if (decodeFrame(f).type !== 'delta') return;
      order.push(['a', h.clock.monotonicMs()]);
      h.clock.advance(70);
    };
    b.onSend = (f) => {
      if (decodeFrame(f).type === 'delta') order.push(['b', h.clock.monotonicMs()]);
    };
    for (let w = 0; w < 20; w++) runWindow(h, w, { driver: b, section: 1, overAt: [] });
    tickAt(h, 20 * W);
    expect(intervals(a)).toEqual([D.intervalMs]);
    expect(intervals(b)).toEqual([]);
    expect(h.degradedChanges).toEqual([]);
    expect(gauge(h, 'realtime_gw_degraded')).toBeUndefined();
    // a의 차례 박자(OFF + 100 + 1,000j)마다 a의 send는 같은 박자의 b의 send 뒤다
    const aTurns = order.filter(([who]) => who === 'a');
    expect(aTurns.length).toBeGreaterThan(150);
    for (let i = 0; i < order.length; i++) {
      if (order[i]![0] !== 'a') continue;
      const prev = order[i - 1];
      expect(prev?.[0]).toBe('b');
      expect(order[i]![1] - prev![1]).toBeLessThan(SPEC.intervalMs);
    }
  });

  test('S-T14 ③ RF-T14 한 박자에 차례가 된 버퍼 1초 연결 셋의 send가 15ms씩 걸리면 뒤 고리 몫(20ms) 안인 0ms·15ms에 둘을 보내고 30ms에 멈추며, 남은 하나는 다음 박자 뒤 고리에서 보낸다. 다음 차례 격자는 그대로 1,000ms 뒤다', async () => {
    const h = harness({ monotonic: START });
    // 연결 번호 0·10·20은 같은 차례 칸(mod 10 = 0)이다
    const conns = Array.from({ length: 21 }, () => h.open());
    const slow = [conns[0]!, conns[10]!, conns[20]!];
    for (const c of slow) {
      h.hub.receive(c, subscribeBytes([1]), true);
      c.bufferedAmount = 300 * 1024;
      c.onSend = (f) => {
        if (decodeFrame(f).type === 'delta') h.clock.advance(15);
      };
    }
    await settle();
    tickAt(h, OFF); // 셋 다 버퍼로 1초(T = OFF), 첫 차례 T + 100
    for (const c of slow) expect(intervals(c)).toEqual([D.intervalMs]);
    const count = () => slow.map(deltaCount);
    const T = OFF;
    moveTo(h, T + 50);
    publish(h, 1);
    tickAt(h, T + 99);
    expect(count()).toEqual([0, 0, 0]);
    tickAt(h, T + 100);
    const first = count();
    expect(first.reduce((x, y) => x + y, 0)).toBe(2);
    const left = first.indexOf(0);
    expect(left).toBeGreaterThanOrEqual(0);
    tickAt(h, T + 200);
    expect(count()).toEqual([1, 1, 1]);
    // 다음 차례는 셋 다 T + 1,100(넘어간 연결도 격자가 밀리지 않는다). 몫이 넘지 않게 send 지연을 뺀다
    for (const c of slow) c.onSend = undefined;
    moveTo(h, T + 250);
    publish(h, 1);
    for (let t = T + 300; t <= T + 1_000; t += 100) tickAt(h, t);
    tickAt(h, T + 1_099);
    expect(count()).toEqual([1, 1, 1]);
    tickAt(h, T + 1_100);
    expect(count()).toEqual([2, 2, 2]);
  });
});
