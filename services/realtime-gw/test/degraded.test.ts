// 전파 Degraded 자동 전환 허브 시험(BUILD_ORDER HOT-091, BAT-053). 바깥 경계는 createStreamHub(가짜 연결의 bufferedAmount·가짜 구독기·가짜 시계)다.
// 정본: docs/features/seat-hold.md §7 '전파 Degraded Mode'의 '자동 전환의 첫 구현'·'맺은 뒤', §12 S-T14 ①~③, ADR-0298 결정 1~7, docs/frontend.md §4.4.1(type 3 BatchInterval, 리틀 엔디언 u16).
// 단언 값은 hub-fixtures.ts의 SPEC.degraded(정본 값)이고 구현 상수를 가져오지 않는다. 경계는 양쪽(경계 − 1과 경계)을 본다.
// 창 맞춤: 정본은 '단조 시계의 10초 창'만 적었다. 허브를 만든 단조 시각(START)을 10초의 배수로 두어, 만든 때부터 재든 10초 배수로 재든 같은 창이 되게 한다.
// 박자는 창 시작에서 37ms 비낀 시각(START + 37 + 100k)에 두고, 경계 검사는 창 끝 − 1ms와 창 끝 정각의 박자로 본다.
// 넘친 대기 = maxWaitMs − 쌓기 시작할 때의 간격(ADR-0298 결정 1). 메시지를 박자 바로 앞에 changedAtMs = now − (간격 + 넘침)으로 보내 그 박자의 묶음 넘친 대기를 정한다.
import { describe, expect, test } from 'vitest';
import { channelOf, deltas, deltaText, type FakeConn, harness, type Harness, settle, SPEC, subscribeBytes, WALL0 } from './hub-fixtures.js';

const D = SPEC.degraded;
/** 허브를 만든 단조 시각(10초의 배수) */
const START = 1_230_000;
/** 박자가 창 시작에서 비낀 ms */
const OFF = 37;
/** 창 하나의 박자 수(10초 / 100ms) */
const TICKS_PER_WINDOW = D.windowMs / SPEC.intervalMs;

/** START에서 ms 지난 단조 시각으로 시계를 옮긴다(벽시계도 같이 간다) */
const moveTo = (h: Harness, ms: number): void => h.clock.advance(START + ms - h.clock.monotonicMs());
/** START에서 ms 지난 시각의 박자 하나 */
const tickAt = (h: Harness, ms: number): void => {
  moveTo(h, ms);
  h.hub.tick();
};
/** from번째 뒤로 받은 BatchInterval 값 */
const intervals = (c: FakeConn, from = 1): number[] => c.framesFrom(from).flatMap((f) => (f.type === 'batchInterval' ? [f.intervalMs] : []));
/** 게이지의 마지막 값(받은 적 없으면 undefined) */
const gauge = (h: Harness, name: string): number | undefined => h.metrics.filter((m) => m.name === name).at(-1)?.value;
/** 구역 section에 넘친 대기가 excessMs가 되도록(쌓기 시작할 때의 간격 intervalMs) 메시지 하나 */
let version = 0;
const publish = (h: Harness, section: number, o: { excessMs?: number; intervalMs?: number; epoch?: number; ago?: number } = {}): void => {
  const ago = o.ago ?? (o.excessMs === undefined ? 40 : (o.intervalMs ?? SPEC.intervalMs) + o.excessMs);
  h.sub.publish(channelOf('ev-1', section), deltaText({ epoch: o.epoch ?? 1, section, version: ++version, changedAtMs: h.clock.now() - ago, seats: [[version % 100, 1]] }));
};

/**
 * 평시 연결 driver(구역 section)로 창 w의 박자 100개를 돈다. 박자마다 메시지 하나를 보내 묶음 하나가 되게 하고,
 * overAt의 박자(창 안 차례 k)만 넘친 대기 excessMs, 나머지는 넘친 대기 0(maxWaitMs 40)이다. overAt이 null이면 빈 창(보내지 않고 박자만)
 */
const runWindow = (h: Harness, w: number, o: { section?: number; overAt: readonly number[] | null; excessMs?: number }): void => {
  for (let k = 0; k < TICKS_PER_WINDOW; k++) {
    moveTo(h, w * D.windowMs + OFF + k * SPEC.intervalMs);
    if (o.overAt !== null) publish(h, o.section ?? 1, o.overAt.includes(k) ? { excessMs: o.excessMs ?? 61 } : {});
    h.hub.tick();
  }
};
/** 넘친 대기 61ms가 2/100인 창(넘음: a × 100 = 200 > n = 100) */
const OVER_2 = [10, 60] as const;
/** 넘친 대기 61ms가 1/100인 창(a × 100 = n이라 넘음이 아니다) */
const OVER_1 = [10] as const;

/** 창 0~17을 넘음 창으로 돌고 18번째 창이 끝난 정각(180,000ms)의 박자에 Degraded로 바꾼다. 바뀐 박자의 시각을 돌려준다 */
const enterDegraded = (h: Harness, driverSection = 1): number => {
  for (let w = 0; w < D.enterWindows; w++) runWindow(h, w, { section: driverSection, overAt: OVER_2 });
  const at = D.enterWindows * D.windowMs;
  tickAt(h, at);
  expect(gauge(h, 'realtime_gw_degraded')).toBe(1);
  return at;
};

describe('S-T14 ① 보내기 버퍼로 그 연결만 1초 간격(ADR-0298 결정 3)', () => {
  test('S-T14 ① 262,143B 박자엔 그대로, 262,144B 박자에 그 연결만 BatchInterval 1000 하나(이어 쌓인 묶음)이고 게이지 1, 다음 묶음은 999ms 박자엔 없고 1,000ms 박자에 온다. 다른 연결은 프레임 변화가 없다', async () => {
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
    expect(intervals(a)).toEqual([D.intervalMs]);
    expect([...a.sent[from]!]).toEqual([1, 3, 0xe8, 0x03]); // 1000, 리틀 엔디언 u16
    expect(gauge(h, 'realtime_gw_buffer_slow_connections')).toBe(1);
    expect(gauge(h, 'realtime_gw_degraded')).toBeUndefined(); // 한 연결의 버퍼는 파드 전환에 넣지 않는다

    // 다음 묶음: 차례(T)에서 999ms 박자엔 없고 1,000ms 박자에 온다
    moveTo(h, T + 13);
    publish(h, 1);
    const before = deltas(a.framesFrom(1)).length;
    for (let t = T + 100; t <= T + 900; t += 100) tickAt(h, t);
    tickAt(h, T + 999);
    expect(deltas(a.framesFrom(1))).toHaveLength(before);
    tickAt(h, T + 1_000);
    expect(deltas(a.framesFrom(1))).toHaveLength(before + 1);
    expect(intervals(a)).toEqual([D.intervalMs]); // 간격이 그대로인 박자엔 다시 보내지 않는다

    // 다른 연결: BatchInterval 없이 박자마다 묶음(셋째 메시지는 T + 100 박자에)
    expect(intervals(b)).toEqual([]);
    expect(deltas(b.framesFrom(1))).toHaveLength(3);
    expect(b.closed).toBeUndefined();
  });

  test('S-T14 ① 1초가 된 연결은 65,536B 이하 박자만 30,000ms 이어지면 BatchInterval 100을 받고(29,999ms엔 아니다), 65,537B 박자가 끼면 처음부터 센다. 게이지는 1 → 0이고 그 뒤 묶음은 100ms 박자에 온다', async () => {
    const h = harness({ monotonic: START });
    const a = h.open();
    const b = h.open();
    for (const c of [a, b]) h.hub.receive(c, subscribeBytes([1]), true);
    await settle();
    a.bufferedAmount = D.slowEnterBytes + 5_000;
    tickAt(h, OFF);
    expect(intervals(a)).toEqual([D.intervalMs]);

    // 256KiB와 64KiB 사이에 머물면 그대로다
    a.bufferedAmount = D.slowExitBytes + 1;
    for (let t = OFF + 100; t <= OFF + 40_000; t += 100) tickAt(h, t);
    expect(intervals(a)).toEqual([D.intervalMs]);

    // 64KiB 정각 박자가 L0부터, 15초 뒤 65,537B 박자 하나, 다시 L1부터
    const L0 = OFF + 40_100;
    a.bufferedAmount = D.slowExitBytes;
    for (let t = L0; t < L0 + 15_000; t += 100) tickAt(h, t);
    a.bufferedAmount = D.slowExitBytes + 1;
    tickAt(h, L0 + 15_000);
    a.bufferedAmount = D.slowExitBytes;
    const L1 = L0 + 15_100;
    for (let t = L1; t <= L1 + 29_900; t += 100) tickAt(h, t);
    // L0에서 30초(L0 + 30,000 = L1 + 14,900)는 이미 지났지만 처음부터 셌으므로 아니다
    tickAt(h, L1 + 29_999);
    expect(intervals(a)).toEqual([D.intervalMs]);
    expect(gauge(h, 'realtime_gw_buffer_slow_connections')).toBe(1);
    tickAt(h, L1 + 30_000);
    expect(intervals(a)).toEqual([D.intervalMs, SPEC.intervalMs]);
    expect([...a.sent.at(-1)!]).toEqual([1, 3, 100, 0]);
    expect(gauge(h, 'realtime_gw_buffer_slow_connections')).toBe(0);

    // 되돌린 뒤 묶음은 다음 100ms 박자에 온다
    moveTo(h, L1 + 30_013);
    publish(h, 1);
    const before = deltas(a.framesFrom(1)).length;
    tickAt(h, L1 + 30_100);
    expect(deltas(a.framesFrom(1))).toHaveLength(before + 1);
    expect(intervals(b)).toEqual([]);
    expect(gauge(h, 'realtime_gw_degraded')).toBeUndefined();
  });

  test('S-T14 ① 1초 간격인 연결도 1,048,577B 박자에 1013 slow consumer로 닫히고 게이지에서 빠지며, 1,048,576B인 연결은 열린 채 1초 간격이다', async () => {
    const h = harness({ monotonic: START });
    const over = h.open();
    const atLimit = h.open();
    over.bufferedAmount = D.slowEnterBytes;
    atLimit.bufferedAmount = SPEC.maxBuffered;
    tickAt(h, OFF);
    expect(intervals(over)).toEqual([D.intervalMs]);
    expect(intervals(atLimit)).toEqual([D.intervalMs]);
    expect(gauge(h, 'realtime_gw_buffer_slow_connections')).toBe(2);
    // 1초 차례가 아닌 박자(OFF + 100)에도 1MiB 검사는 박자마다 본다
    over.bufferedAmount = SPEC.maxBuffered + 1;
    const sent = over.sent.length;
    tickAt(h, OFF + 100);
    expect(over.closes).toEqual([{ code: SPEC.close.slow, reason: SPEC.reason.slow }]);
    expect(over.sent).toHaveLength(sent);
    expect(gauge(h, 'realtime_gw_buffer_slow_connections')).toBe(1);
    tickAt(h, OFF + 1_100);
    expect(atLimit.closed).toBeUndefined();
  });
});

describe('S-T14 ② 파드 전환: 넘친 대기의 10초 창(ADR-0298 결정 1·2·6·7)', () => {
  test('S-T14 ② 넘친 대기 61ms가 2/100인 창이 18개 이어지면 18번째 창이 끝난 박자에 파드의 모든 연결이 BatchInterval 1000을 한 번 받고 realtime_gw_degraded 1, 바뀜 한 번(n 100·a 2·b 2)이다. 17개 뒤와 창 끝 − 1ms 박자에는 아니다', async () => {
    const h = harness({ monotonic: START });
    const driver = h.open();
    const idle = h.open(); // 구독 없는 연결도 파드의 연결이다
    h.hub.receive(driver, subscribeBytes([1]), true);
    await settle();
    for (let w = 0; w < D.enterWindows - 1; w++) runWindow(h, w, { overAt: OVER_2 });
    // 17개가 끝난 뒤(17번째 창 끝을 지난 박자들)
    runWindow(h, D.enterWindows - 1, { overAt: OVER_2 });
    expect(intervals(driver)).toEqual([]);
    expect(intervals(idle)).toEqual([]);
    expect(h.degradedChanges).toEqual([]);
    expect(gauge(h, 'realtime_gw_degraded')).toBeUndefined();
    // 18번째 창 끝 − 1ms의 박자: 아직 창이 끝나지 않았다
    tickAt(h, D.enterWindows * D.windowMs - 1);
    expect(intervals(idle)).toEqual([]);
    // 창 끝 정각의 박자
    tickAt(h, D.enterWindows * D.windowMs);
    expect(intervals(driver)).toEqual([D.intervalMs]);
    expect(intervals(idle)).toEqual([D.intervalMs]);
    expect([...idle.sent.at(-1)!]).toEqual([1, 3, 0xe8, 0x03]);
    expect(gauge(h, 'realtime_gw_degraded')).toBe(1);
    expect(h.degradedChanges).toEqual([{ degraded: true, batches: 100, over60: 2, over30: 2 }]);
    // 파드 전환은 버퍼 게이지를 움직이지 않는다
    expect(gauge(h, 'realtime_gw_buffer_slow_connections')).toBeUndefined();
    // 간격이 그대로인 박자엔 다시 보내지 않는다
    for (let t = D.enterWindows * D.windowMs + OFF; t < D.enterWindows * D.windowMs + 20_000; t += 100) tickAt(h, t);
    expect(intervals(driver)).toEqual([D.intervalMs]);
    expect(intervals(idle)).toEqual([D.intervalMs]);
    expect(h.degradedChanges).toHaveLength(1);
  });

  test('S-T14 ② 넘음 창 17개 뒤 a × 100 = n인 창(61ms 1/100)이 끼면 처음부터 센다: 그 뒤 17개로는 아니고 18개째 끝에 1000이다', async () => {
    const h = harness({ monotonic: START });
    const driver = h.open();
    h.hub.receive(driver, subscribeBytes([1]), true);
    await settle();
    for (let w = 0; w < 17; w++) runWindow(h, w, { overAt: OVER_2 });
    runWindow(h, 17, { overAt: OVER_1 });
    for (let w = 18; w < 18 + 17; w++) runWindow(h, w, { overAt: OVER_2 });
    tickAt(h, 35 * D.windowMs - 1);
    expect(intervals(driver)).toEqual([]);
    expect(h.degradedChanges).toEqual([]);
    runWindow(h, 35, { overAt: OVER_2 });
    tickAt(h, 36 * D.windowMs - 1);
    expect(intervals(driver)).toEqual([]);
    tickAt(h, 36 * D.windowMs);
    expect(intervals(driver)).toEqual([D.intervalMs]);
    expect(h.degradedChanges).toEqual([{ degraded: true, batches: 100, over60: 2, over30: 2 }]);
  });

  test('S-T14 ② 넘음 창 17개 뒤 묶음이 없는 창이 끼면 이어짐이 끊긴다: 그 뒤 1개·17개로는 아니고 18개째 끝에 1000이다(빈 창은 넘음이 아니다)', async () => {
    const h = harness({ monotonic: START });
    const driver = h.open();
    h.hub.receive(driver, subscribeBytes([1]), true);
    await settle();
    for (let w = 0; w < 17; w++) runWindow(h, w, { overAt: OVER_2 });
    runWindow(h, 17, { overAt: null });
    runWindow(h, 18, { overAt: OVER_2 });
    tickAt(h, 19 * D.windowMs);
    expect(intervals(driver)).toEqual([]);
    for (let w = 19; w < 18 + 17; w++) runWindow(h, w, { overAt: OVER_2 });
    tickAt(h, 35 * D.windowMs);
    expect(intervals(driver)).toEqual([]);
    expect(h.degradedChanges).toEqual([]);
    runWindow(h, 35, { overAt: OVER_2 });
    tickAt(h, 36 * D.windowMs);
    expect(intervals(driver)).toEqual([D.intervalMs]);
  });

  test('S-T14 ② 넘친 대기 60ms 정각(넘침 아님)이 2/100인 창은 20개 이어져도 그대로다', async () => {
    const h = harness({ monotonic: START });
    const driver = h.open();
    h.hub.receive(driver, subscribeBytes([1]), true);
    await settle();
    for (let w = 0; w < 20; w++) runWindow(h, w, { overAt: OVER_2, excessMs: D.enterExcessMs });
    tickAt(h, 20 * D.windowMs + 500);
    expect(intervals(driver)).toEqual([]);
    expect(h.degradedChanges).toEqual([]);
    expect(gauge(h, 'realtime_gw_degraded')).toBeUndefined();
  });

  test('S-T14 ② Degraded에서 1초 묶음(maxWaitMs 약 1,000, 넘침 아님)만 오는 괜찮음 창이 30개 이어지면 모든 연결이 BatchInterval 100을 받고 0이다. 29개로는 아니고, 31ms 2/100 창이 끼면 처음부터 세며, 30ms 정각 2/100 창은 괜찮음이다', async () => {
    const h = harness({ monotonic: START });
    // 구역 0~9에 연결 하나씩: Degraded에서 1초마다 열 묶음 → 창 하나에 n = 100
    const conns = Array.from({ length: 10 }, () => h.open());
    conns.forEach((c, i) => h.hub.receive(c, subscribeBytes([i]), true));
    const idle = h.open();
    await settle();
    const T0 = enterDegraded(h, 0);
    for (const c of [...conns, idle]) expect(intervals(c)).toEqual([D.intervalMs]);

    // Degraded: 박자마다 열 구역에 메시지(changedAtMs = now − 40). 1초 차례(T0 + 1,000j)의 묶음은 maxWaitMs 약 940 → 넘친 대기 0
    // special: 창 w의 차례 k 박자에 그 구역 묶음의 넘친 대기를 정한다(박자 바로 앞에 changedAtMs = now − (1,000 + 넘침))
    const degradedWindow = (w: number, special: Array<{ k: number; section: number; excessMs: number }> = []): void => {
      for (let k = 0; k < TICKS_PER_WINDOW; k++) {
        const t = w * D.windowMs + OFF + k * SPEC.intervalMs;
        if (t <= T0) continue;
        moveTo(h, t);
        for (let s = 0; s < 10; s++) publish(h, s);
        for (const x of special) if (x.k === k) publish(h, x.section, { excessMs: x.excessMs, intervalMs: D.intervalMs });
        h.hub.tick();
      }
    };
    // 창 18(T0가 든 창)부터 29개(18~46)
    for (let w = 18; w <= 46; w++) degradedWindow(w);
    tickAt(h, 47 * D.windowMs);
    expect(intervals(conns[0]!)).toEqual([D.intervalMs]);
    expect(h.degradedChanges).toHaveLength(1);
    // 창 47: 31ms 넘친 대기 2/100(차례 박자 k = 30·70은 T0 + 1,000j 박자다) → 괜찮음 아님, 처음부터
    degradedWindow(47, [
      { k: 30, section: 0, excessMs: 31 },
      { k: 70, section: 1, excessMs: 31 },
    ]);
    // 창 48~76(29개). 창 50에는 30ms 정각 2/100(괜찮음)
    for (let w = 48; w <= 76; w++) degradedWindow(w, w === 50 ? [{ k: 20, section: 2, excessMs: 30 }, { k: 80, section: 3, excessMs: 30 }] : []);
    tickAt(h, 77 * D.windowMs);
    // 창 18~47을 잇는 30개는 47이 끊었고, 48~76은 29개라 아직이다
    expect(intervals(conns[0]!)).toEqual([D.intervalMs]);
    expect(h.degradedChanges).toHaveLength(1);
    degradedWindow(77);
    tickAt(h, 78 * D.windowMs - 1);
    expect(intervals(idle)).toEqual([D.intervalMs]);
    tickAt(h, 78 * D.windowMs);
    for (const c of [...conns, idle]) expect(intervals(c)).toEqual([D.intervalMs, SPEC.intervalMs]);
    expect(gauge(h, 'realtime_gw_degraded')).toBe(0);
    expect(h.metrics.filter((m) => m.name === 'realtime_gw_degraded').map((m) => m.value)).toEqual([1, 0]);
    expect(h.degradedChanges).toEqual([
      { degraded: true, batches: 100, over60: 2, over30: 2 },
      { degraded: false, batches: 100, over60: 0, over30: 0 },
    ]);
    // 되돌린 뒤는 다음 100ms 박자에 묶음이 온다
    moveTo(h, 78 * D.windowMs + 10);
    publish(h, 5);
    const before = deltas(conns[5]!.framesFrom(1)).length;
    tickAt(h, 78 * D.windowMs + 100);
    expect(deltas(conns[5]!.framesFrom(1))).toHaveLength(before + 1);
  });
});

describe('S-T14 ③ 1초 간격 연결의 첫 프레임·알림·차례(ADR-0298 결정 4·5)', () => {
  test('S-T14 ③ 파드가 Degraded인 동안 새로 붙은 연결의 첫 프레임은 BatchInterval 1000 하나이고, 간격이 그대로인 박자엔 다시 보내지 않는다', async () => {
    const h = harness({ monotonic: START });
    const driver = h.open();
    h.hub.receive(driver, subscribeBytes([1]), true);
    await settle();
    const T0 = enterDegraded(h);
    moveTo(h, T0 + 3);
    const late = h.open();
    expect(late.frames()).toEqual([{ type: 'batchInterval', intervalMs: D.intervalMs }]);
    expect([...late.sent[0]!]).toEqual([1, 3, 0xe8, 0x03]);
    for (let t = T0 + 100; t <= T0 + 5_000; t += 100) tickAt(h, t);
    expect(late.frames().filter((f) => f.type === 'batchInterval')).toEqual([{ type: 'batchInterval', intervalMs: D.intervalMs }]);
    expect(late.closed).toBeUndefined();
  });

  test('S-T14 ③ 1초 간격에서 차례의 999ms 박자에는 보내지 않고 1,000ms 박자에 보내며, 쌓인 것이 없는 차례도 넘어가고, 세대가 바뀐 메시지가 오면 쌓인 것을 박자를 기다리지 않고 바로 보낸다', async () => {
    const h = harness({ monotonic: START });
    const driver = h.open();
    const b = h.open();
    h.hub.receive(driver, subscribeBytes([1]), true);
    h.hub.receive(b, subscribeBytes([2]), true);
    await settle();
    const T0 = enterDegraded(h);
    expect(intervals(b)).toEqual([D.intervalMs]);
    const got = (): number => deltas(b.framesFrom(1)).length;

    // 차례 T0: T0 + 999 박자엔 없고 T0 + 1,000 박자에
    moveTo(h, T0 + 50);
    publish(h, 2);
    for (let t = T0 + 100; t <= T0 + 900; t += 100) tickAt(h, t);
    tickAt(h, T0 + 999);
    expect(got()).toBe(0);
    tickAt(h, T0 + 1_000);
    expect(got()).toBe(1);

    // 차례 T0 + 1,000 → 쌓인 것 없이 T0 + 2,000이 지나간다 → 다음 차례 T0 + 3,000
    for (let t = T0 + 1_100; t <= T0 + 2_000; t += 100) tickAt(h, t);
    moveTo(h, T0 + 2_050);
    publish(h, 2);
    for (let t = T0 + 2_100; t <= T0 + 2_900; t += 100) tickAt(h, t);
    tickAt(h, T0 + 2_999);
    expect(got()).toBe(1);
    tickAt(h, T0 + 3_000);
    expect(got()).toBe(2);

    // 세대 5가 쌓인 뒤 세대 6이 오면(박자 사이) 세대 5 묶음이 바로 나간다
    moveTo(h, T0 + 3_050);
    publish(h, 2, { epoch: 5 });
    tickAt(h, T0 + 3_100);
    tickAt(h, T0 + 3_200);
    expect(got()).toBe(2);
    moveTo(h, T0 + 3_250);
    publish(h, 2, { epoch: 6 });
    expect(deltas(b.framesFrom(1)).map((f) => f.seatEpoch)).toEqual([1, 1, 5]);
    expect(deltas(b.framesFrom(1)).at(-1)!.serverTimeMs).toBe(WALL0 + T0 + 3_250);
    // 세대 6은 다음 차례(T0 + 4,000)에
    for (let t = T0 + 3_300; t <= T0 + 3_900; t += 100) tickAt(h, t);
    tickAt(h, T0 + 3_999);
    expect(got()).toBe(3);
    tickAt(h, T0 + 4_000);
    expect(deltas(b.framesFrom(1)).map((f) => f.seatEpoch)).toEqual([1, 1, 5, 6]);
    expect(intervals(b)).toEqual([D.intervalMs]);
  });

  test('S-T14 ③ 1초 간격 연결에도 15초 주기 하트비트와 토큰 exp의 4401은 박자 단위 그대로다(1초 차례가 아닌 박자에 온다)', () => {
    const h = harness({ monotonic: START });
    // 맺은 때 START, exp는 벽시계 WALL0 + 16,321(박자 배수가 아님)
    const c = h.open({ expiresAtMs: WALL0 + 16_321 });
    const hb = () => c.frames().filter((f) => f.type === 'heartbeat');
    tickAt(h, OFF);
    // OFF + 100 박자에 버퍼로 1초: 차례는 OFF + 100에서 시작해 1,000ms마다라 15,000ms·16,321ms 박자는 차례가 아니다
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

  test('S-T14 ③ 파드와 버퍼에 함께 걸린 연결은 둘 다 풀린 박자에만 BatchInterval 100을 받는다: 파드가 먼저 돌아오면 버퍼가 30초 풀린 박자에, 버퍼가 먼저 풀리면 파드가 돌아온 박자에', async () => {
    const h = harness({ monotonic: START });
    const driver = h.open();
    const x = h.open(); // 파드가 먼저 돌아온다
    const y = h.open(); // 버퍼가 먼저 풀린다
    h.hub.receive(driver, subscribeBytes([1]), true);
    await settle();
    const T0 = enterDegraded(h);
    for (const c of [driver, x, y]) expect(intervals(c)).toEqual([D.intervalMs]);

    // y: Degraded 동안 버퍼로도 걸렸다가(BatchInterval 없음) 30초 뒤 버퍼가 풀린다(아직 BatchInterval 없음)
    y.bufferedAmount = D.slowEnterBytes;
    tickAt(h, T0 + 1_037);
    y.bufferedAmount = 0;
    for (let t = T0 + 1_137; t <= T0 + 40_037; t += 100) tickAt(h, t);
    expect(intervals(y)).toEqual([D.intervalMs]);

    // 묶음 없는 창은 괜찮음: 창 18~47(30개)이 끝난 정각(480,000ms)에 파드가 돌아온다. x는 그 전부터 버퍼가 256KiB 이상이다
    for (let t = T0 + 40_137; t < 470_000; t += 100) tickAt(h, t);
    x.bufferedAmount = D.slowEnterBytes + 1;
    for (let t = 470_037; t < 480_000; t += 100) tickAt(h, t);
    tickAt(h, 480_000 - 1);
    expect(intervals(driver)).toEqual([D.intervalMs]);
    tickAt(h, 480_000);
    expect(gauge(h, 'realtime_gw_degraded')).toBe(0);
    expect(intervals(driver)).toEqual([D.intervalMs, SPEC.intervalMs]);
    expect(intervals(y)).toEqual([D.intervalMs, SPEC.intervalMs]);
    expect(intervals(x)).toEqual([D.intervalMs]);

    // x: 버퍼가 64KiB 이하인 박자가 L부터 30초 이어진 박자에 100
    const L = 480_037;
    x.bufferedAmount = D.slowExitBytes;
    for (let t = L; t <= L + 29_900; t += 100) tickAt(h, t);
    tickAt(h, L + 29_999);
    expect(intervals(x)).toEqual([D.intervalMs]);
    tickAt(h, L + 30_000);
    expect(intervals(x)).toEqual([D.intervalMs, SPEC.intervalMs]);
    expect(intervals(driver)).toEqual([D.intervalMs, SPEC.intervalMs]);
    expect(intervals(y)).toEqual([D.intervalMs, SPEC.intervalMs]);
  });
});
