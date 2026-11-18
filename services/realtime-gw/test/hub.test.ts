// 좌석 델타 허브 단위 시험(BUILD_ORDER HOT-090, BAT-052). 바깥 경계는 createStreamHub(가짜 연결·가짜 구독기·가짜 시계)다.
// 정본: docs/features/seat-hold.md §7 'realtime-gw의 첫 구현'(맺은 뒤·받는 프레임 검사·좌석 Redis 구독·묶음·느린 연결과 내릴 때·지표와 로그),
// §12 S-T31 ①~⑤·S-T42 ④~⑪·⑮~⑰·⑲·S-T12 ②, docs/frontend.md §4.4.1(바이트 형식·닫힘 코드·닫힘 이유 글·구독 상한 표), ADR-0296 결정 4·5·6, ADR-0297, ADR-0110, ADR-0240 결정 10.
// 리뷰 반영(BAT-052 RF-T1·T2·T5·T12·T13): 허브는 0 ↔ 1 전환마다 구독기를 한 번 부르기만 하고 결과로 상태를 정하지 않는다(ADR-0297 결정 1).
// 단언 값은 hub-fixtures.ts의 SPEC(정본 값)이고 구현 상수를 가져오지 않는다. 시간 경계는 경계 − 1ms와 경계를 둘 다 본다.
import { describe, expect, test } from 'vitest';
import { encodeSubscribe, encodeTimeSync } from '../../../packages/seatmap/src/wire.js'; // 화면 인코더(맞물림 시험, WIR-06)
import { channelOf, deltas, deltaText, entriesOf, FakeConn, harness, MONO0, rawFrame, settle, SPEC, subscribeBytes, timeSyncBytes, WALL0 } from './hub-fixtures.js';

const range = (n: number, from = 0): number[] => Array.from({ length: n }, (_, i) => from + i);

describe('맺은 뒤 첫 프레임', () => {
  test('S-T42 ① 연 곧 첫 프레임은 BatchInterval 100 하나다(ADR-0240 결정 10)', () => {
    const h = harness();
    const c = h.open();
    expect(c.frames()).toEqual([{ type: 'batchInterval', intervalMs: SPEC.intervalMs }]);
    expect([...c.sent[0]!]).toEqual([1, 3, 100, 0]);
  });
});

describe('S-T31 받는 프레임 검사와 구독 상한', () => {
  test('S-T31 ① 구역 16개 구독은 열려 있고, 17개는 4429로 닫히며 그 연결의 채널을 모두 푼다 [ASVS v5.0.0-2.4.1] [ASVS v5.0.0-2.1.3]', async () => {
    const h = harness();
    const c = h.open();
    h.hub.receive(c, subscribeBytes(range(16)), true);
    await settle();
    expect(c.closed).toBeUndefined();
    expect(h.sub.calls).toEqual(range(16).map((s) => ['subscribe', channelOf('ev-1', s)]));
    // 1초 창을 비운 뒤 17개(빈도 상한이 아니라 구역 수 상한으로 닫히게)
    h.clock.advance(SPEC.windowMs);
    h.hub.receive(c, subscribeBytes(range(17)), true);
    await settle();
    expect(c.closes).toEqual([{ code: SPEC.close.tooMany, reason: expect.any(String) }]);
    // 닫으면 그 연결이 든 16개 채널을 모두 푼다(새로 17번째는 구독하지 않았다)
    expect(h.sub.calls.slice(16)).toEqual(range(16).map((s) => ['unsubscribe', channelOf('ev-1', s)]));
    // 첫 구독이 17개여도 4429다
    const d = h.open();
    h.hub.receive(d, subscribeBytes(range(17)), true);
    expect(d.closes.map((x) => x.code)).toEqual([SPEC.close.tooMany]);
  });

  test('S-T31 ① 구역 수 검사(4429)는 구역 색인 검사(4403)보다 먼저다: 판의 구역이 10개인데 17개를 보내면 4429 [ASVS v5.0.0-2.4.1]', () => {
    const h = harness({ sections: { 'ev-1': 10 } });
    const c = h.open();
    h.hub.receive(c, subscribeBytes(range(17)), true);
    expect(c.closes.map((x) => x.code)).toEqual([SPEC.close.tooMany]);
    expect(h.sub.calls).toEqual([]);
  });

  test('S-T31 ② 0·500·999ms의 세 번째 SubscribeSections는 4429다(맺은 뒤 첫 구독도 센다) [ASVS v5.0.0-2.4.1]', async () => {
    const h = harness();
    const c = h.open();
    h.hub.receive(c, subscribeBytes([1]), true);
    h.clock.advance(500);
    h.hub.receive(c, subscribeBytes([2]), true);
    h.clock.advance(499);
    expect(c.closed).toBeUndefined();
    h.hub.receive(c, subscribeBytes([3]), true);
    await settle();
    expect(c.closes.map((x) => x.code)).toEqual([SPEC.close.tooMany]);
    // 세 번째 목록은 받지 않았다(구역 3을 구독하지 않는다)
    expect(h.sub.calls.filter(([op, ch]) => op === 'subscribe' && ch === channelOf('ev-1', 3))).toEqual([]);
  });

  test('S-T31 ② 창은 (t − 1,000ms, t]다: 0·500·1,000ms는 열려 있고, 이어 1,499ms의 넷째는 500·1,000·1,499가 창 안이라 4429, 1,500ms의 넷째는 둘뿐이라 열려 있다 [ASVS v5.0.0-2.4.1]', () => {
    const run = (fourthAt: number) => {
      const h = harness();
      const c = h.open();
      h.hub.receive(c, subscribeBytes([1]), true);
      h.clock.advance(500);
      h.hub.receive(c, subscribeBytes([2]), true);
      h.clock.advance(500);
      h.hub.receive(c, subscribeBytes([3]), true);
      expect(c.closed).toBeUndefined();
      h.clock.advance(fourthAt - 1_000);
      h.hub.receive(c, subscribeBytes([4]), true);
      return c.closes.map((x) => x.code);
    };
    expect(run(1_499)).toEqual([SPEC.close.tooMany]);
    expect(run(1_500)).toEqual([]);
  });

  test('S-T31 ③ 판의 구역이 N개이면 색인 N − 1은 받고 N은 4403, 같은 색인 둘도 4403이다. 검사는 그때의 판으로 한다', async () => {
    const h = harness({ sections: { 'ev-1': 5 } });
    const ok = h.open();
    h.hub.receive(ok, subscribeBytes([4]), true);
    await settle();
    expect(ok.closed).toBeUndefined();
    expect(h.sub.calls).toEqual([['subscribe', channelOf('ev-1', 4)]]);

    for (const bad of [[5], [0, 5], [65_535], [1, 1], [2, 3, 2]]) {
      const c = h.open();
      h.hub.receive(c, subscribeBytes(bad), true);
      expect(c.closes.map((x) => x.code), JSON.stringify(bad)).toEqual([SPEC.close.forbidden]);
    }
    await settle();
    // 거절한 목록의 어떤 구역도 구독하지 않았다
    expect(h.sub.calls).toEqual([['subscribe', channelOf('ev-1', 4)]]);

    // 판이 6구역으로 바뀌면 색인 5를 받는다
    h.sections.set('ev-1', 6);
    const later = h.open();
    h.hub.receive(later, subscribeBytes([5]), true);
    expect(later.closed).toBeUndefined();
    // 판을 모르는 회차는 구역 0개로 본다(색인 0도 4403)
    const unknown = h.open({ eventId: 'ev-9' });
    h.hub.receive(unknown, subscribeBytes([0]), true);
    expect(unknown.closes.map((x) => x.code)).toEqual([SPEC.close.forbidden]);
  });

  test('S-T31 ④ 정한 길이와 다른 SubscribeSections·TimeSync, version 2, 정하지 않은 type(17 포함), 글 프레임, 1,024바이트를 넘는 프레임은 모두 4403이다', async () => {
    const h = harness();
    const pad = (n: number) => Array.from({ length: n }, () => 0);
    const cases: Array<[string, Uint8Array, boolean]> = [
      ['SubscribeSections 길이 −1', subscribeBytes([1, 2]).subarray(0, 7), true],
      ['SubscribeSections 길이 +1', Uint8Array.from([...subscribeBytes([1, 2]), 0]), true],
      ['SubscribeSections count만 있고 목록 없음', subscribeBytes([], { count: 1 }), true],
      ['SubscribeSections 머리만', rawFrame(1, 16), true],
      ['TimeSync 9바이트', timeSyncBytes(5n).subarray(0, 9), true],
      ['TimeSync 11바이트', Uint8Array.from([...timeSyncBytes(5n), 0]), true],
      ['version 2', subscribeBytes([1], { version: 2 }), true],
      ['version 0', subscribeBytes([1], { version: 0 }), true],
      ['type 17(Auth)', rawFrame(1, 17, [3, 0, 97, 98, 99]), true],
      ['type 19', rawFrame(1, 19, pad(8)), true],
      ['type 1', rawFrame(1, 1, pad(16)), true],
      ['type 2', rawFrame(1, 2, pad(16)), true],
      ['type 3', rawFrame(1, 3, [100, 0]), true],
      ['빈 프레임', new Uint8Array(0), true],
      ['1바이트', Uint8Array.from([1]), true],
      ['글 프레임(바이트는 바른 SubscribeSections)', subscribeBytes([1]), false],
      ['1,025바이트', Uint8Array.from([...subscribeBytes(range(510)), 0]), true],
      ['1,026바이트(길이는 맞는 SubscribeSections 511개)', subscribeBytes(range(511)), true],
    ];
    expect(cases.find(([n]) => n === '1,025바이트')![1].byteLength).toBe(1_025);
    expect(cases.find(([n]) => n.startsWith('1,026'))![1].byteLength).toBe(1_026);
    for (const [name, bytes, isBinary] of cases) {
      const c = h.open();
      h.hub.receive(c, bytes, isBinary);
      expect(c.closes.map((x) => x.code), name).toEqual([SPEC.close.forbidden]);
      // 닫은 뒤에는 답도 구독도 없다
      expect(c.sent.length, name).toBe(1);
    }
    await settle();
    expect(h.sub.calls).toEqual([]);

    // 1,024바이트(SubscribeSections 510개)는 모양 검사를 지나 구역 수 상한(4429)에 걸린다: 크기 상한은 1,024바이트까지 받는다
    const at1024 = h.open();
    expect(subscribeBytes(range(510)).byteLength).toBe(SPEC.maxFrameBytes);
    h.hub.receive(at1024, subscribeBytes(range(510)), true);
    expect(at1024.closes.map((x) => x.code)).toEqual([SPEC.close.tooMany]);
  });

  test('S-T31 ④ 4 + 2 × 16바이트의 바른 SubscribeSections와 10바이트 TimeSync는 받는다', () => {
    const h = harness();
    const c = h.open();
    const frame = subscribeBytes(range(16, 2));
    expect(frame.byteLength).toBe(4 + 2 * 16);
    h.hub.receive(c, frame, true);
    h.hub.receive(c, timeSyncBytes(77n), true);
    expect(c.closed).toBeUndefined();
    expect(c.frames().at(-1)).toEqual({ type: 'heartbeat', serverTimeMs: WALL0, echoClientTimeMs: 77 });
    // 0개 구독도 된다
    h.clock.advance(SPEC.windowMs);
    h.hub.receive(c, subscribeBytes([]), true);
    expect(c.closed).toBeUndefined();
  });

  test('S-T31 ⑤ TimeSync는 0ms에 답하고, 999ms에는 답하지 않으며 닫지도 않고, 1,000ms에 답한다(답하지 않은 것은 간격을 옮기지 않는다)', () => {
    const h = harness();
    const c = h.open();
    const X = 2n ** 40n + 7n;
    const answers = () => c.frames().filter((f) => f.type === 'heartbeat');

    h.hub.receive(c, timeSyncBytes(X), true);
    expect(answers()).toEqual([{ type: 'heartbeat', serverTimeMs: WALL0, echoClientTimeMs: Number(X) }]);

    h.clock.advance(999);
    h.hub.receive(c, timeSyncBytes(X + 1n), true);
    expect(answers()).toHaveLength(1);
    expect(c.closed).toBeUndefined();

    h.clock.advance(1);
    h.hub.receive(c, timeSyncBytes(X + 2n), true);
    expect(answers()).toEqual([
      { type: 'heartbeat', serverTimeMs: WALL0, echoClientTimeMs: Number(X) },
      { type: 'heartbeat', serverTimeMs: WALL0 + 1_000, echoClientTimeMs: Number(X + 2n) },
    ]);

    // 마지막으로 '답한' 것(1,000ms)에서 잰다: 1,999ms는 답 없음, 2,000ms는 답함
    h.clock.advance(999);
    h.hub.receive(c, timeSyncBytes(X + 3n), true);
    expect(answers()).toHaveLength(2);
    h.clock.advance(1);
    h.hub.receive(c, timeSyncBytes(X + 4n), true);
    expect(answers().at(-1)).toEqual({ type: 'heartbeat', serverTimeMs: WALL0 + 2_000, echoClientTimeMs: Number(X + 4n) });
    expect(c.closed).toBeUndefined();
  });
});

describe('S-T42 맺은 뒤의 박자', () => {
  test('S-T42 ④ 토큰 exp − 1ms의 박자에는 열려 있고 exp의 박자에 4401로 닫히며 구독을 푼다(exp는 박자 배수가 아닌 값)', async () => {
    const h = harness();
    const exp = WALL0 + 4_321;
    const c = h.open({ expiresAtMs: exp });
    h.hub.receive(c, subscribeBytes([3]), true);
    await settle();
    h.clock.advance(4_320);
    h.hub.tick();
    expect(c.closed).toBeUndefined();
    h.clock.advance(1);
    h.hub.tick();
    await settle();
    expect(c.closes).toEqual([{ code: SPEC.close.expired, reason: expect.any(String) }]);
    expect(h.sub.calls).toEqual([
      ['subscribe', channelOf('ev-1', 3)],
      ['unsubscribe', channelOf('ev-1', 3)],
    ]);
    // 닫은 연결에는 다시 보내지 않는다
    h.clock.advance(SPEC.heartbeatMs);
    h.hub.tick();
    expect(c.sent).toHaveLength(1);
  });

  test('S-T42 ⑦ TimeSync에는 곧 Heartbeat로 답하고 echoClientTimeMs가 보낸 값이다. 주기 하트비트(echo 0)는 맺은 뒤 15초가 지난 첫 박자마다이고 14,999ms 박자에는 없다', () => {
    const h = harness();
    const c = h.open();
    const hb = () => c.frames().filter((f) => f.type === 'heartbeat');
    h.hub.receive(c, timeSyncBytes(123_456_789n), true);
    expect(hb()).toEqual([{ type: 'heartbeat', serverTimeMs: WALL0, echoClientTimeMs: 123_456_789 }]);

    // TimeSync 답(14,000ms)은 주기를 옮기지 않는다
    h.clock.advance(14_000);
    h.hub.receive(c, timeSyncBytes(9n), true);
    expect(hb()).toHaveLength(2);
    h.clock.advance(999);
    h.hub.tick(); // 14,999ms
    expect(hb()).toHaveLength(2);
    h.clock.advance(1);
    h.hub.tick(); // 15,000ms
    expect(hb().at(-1)).toEqual({ type: 'heartbeat', serverTimeMs: WALL0 + 15_000, echoClientTimeMs: 0 });
    expect(hb()).toHaveLength(3);
    h.hub.tick(); // 같은 시각의 박자를 한 번 더: 또 보내지 않는다
    expect(hb()).toHaveLength(3);

    h.clock.advance(14_999);
    h.hub.tick(); // 29,999ms
    expect(hb()).toHaveLength(3);
    h.clock.advance(1);
    h.hub.tick(); // 30,000ms
    expect(hb()).toHaveLength(4);
    expect(hb().at(-1)).toEqual({ type: 'heartbeat', serverTimeMs: WALL0 + 30_000, echoClientTimeMs: 0 });
    // 하트비트와 묶음 말고는 아무것도 보내지 않았다
    expect(c.frames().filter((f) => f.type === 'delta')).toEqual([]);
  });
});

describe('S-T42 묶음', () => {
  test('S-T42 ⑤ 구독한 구역의 메시지만 다음 박자에 한 묶음으로 오고, 같은 구역 둘은 받은 차례대로 두 항목이며 maxWaitMs = serverTimeMs − 가장 이른 changedAtMs다 [ASVS v5.0.0-8.1.2]', async () => {
    const h = harness();
    const a = h.open();
    const b = h.open();
    const other = h.open({ eventId: 'ev-2' });
    h.hub.receive(a, subscribeBytes([2, 5]), true);
    h.hub.receive(b, subscribeBytes([3]), true);
    h.hub.receive(other, subscribeBytes([2]), true);
    await settle();

    const W = h.clock.now();
    expect(h.sub.publish(channelOf('ev-1', 2), deltaText({ epoch: 7, section: 2, version: 11, changedAtMs: W - 30, seats: [[0, 1], [7, 2]] }))).toBe(true);
    // 구독하지 않은 구역(다른 연결이 구독한 3)과 다른 회차(ev-2의 구역 2)
    expect(h.sub.publish(channelOf('ev-1', 3), deltaText({ epoch: 7, section: 3, version: 4, changedAtMs: W - 500, seats: [[1, 1]] }))).toBe(true);
    expect(h.sub.publish(channelOf('ev-2', 2), deltaText({ epoch: 7, section: 2, version: 9, changedAtMs: W - 600, seats: [[2, 2]] }))).toBe(true);
    // 같은 구역 둘째(번호 +1). changedAtMs가 첫째보다 이르다: maxWaitMs는 받은 차례가 아니라 가장 이른 것으로 잰다
    expect(h.sub.publish(channelOf('ev-1', 2), deltaText({ epoch: 7, section: 2, version: 12, changedAtMs: W - 80, seats: [[7, 0]] }))).toBe(true);
    // 박자 전에는 보내지 않는다
    expect(a.sent).toHaveLength(1);

    h.clock.advance(37);
    h.hub.tick();
    const got = deltas(a.framesFrom(1));
    expect(got).toHaveLength(1);
    expect(got[0]!.serverTimeMs).toBe(W + 37);
    expect(got[0]!.maxWaitMs).toBe(37 + 80);
    expect(got[0]!.seatEpoch).toBe(7);
    expect(entriesOf(got[0]!)).toEqual([
      { sectionIndex: 2, sectionVersion: 11, offsets: [0, 7], states: [1, 2] },
      { sectionIndex: 2, sectionVersion: 12, offsets: [7], states: [0] },
    ]);
    // 묶음에는 좌석 거리와 상태만 싣는다: 머리 18 + 구역마다 8 + 좌석마다 3바이트
    expect(a.sent[1]!.byteLength).toBe(18 + (8 + 2 * 3) + (8 + 1 * 3));
    expect(a.sent).toHaveLength(2);
    // 다른 연결은 제 것만 받는다
    expect(deltas(b.framesFrom(1)).map(entriesOf)).toEqual([[{ sectionIndex: 3, sectionVersion: 4, offsets: [1], states: [1] }]]);
    expect(deltas(other.framesFrom(1)).map(entriesOf)).toEqual([[{ sectionIndex: 2, sectionVersion: 9, offsets: [2], states: [2] }]]);

    // 메시지가 없는 박자에는 프레임이 없다
    h.clock.advance(SPEC.intervalMs);
    h.hub.tick();
    h.clock.advance(SPEC.intervalMs);
    h.hub.tick();
    expect(a.sent).toHaveLength(2);
    expect(b.sent).toHaveLength(2);
  });

  test('S-T42 ⑤ maxWaitMs는 0 아래를 0, 65,535 위를 65,535로 자른다(미래 changedAtMs, 65,534·65,535·65,536·70초 전)', async () => {
    const h = harness();
    const a = h.open();
    h.hub.receive(a, subscribeBytes([1]), true);
    await settle();
    const waitFor = (ago: number): number => {
      const now = h.clock.now();
      h.sub.publish(channelOf('ev-1', 1), deltaText({ epoch: 1, section: 1, version: 1, changedAtMs: now - ago, seats: [[0, 1]] }));
      const before = a.sent.length;
      h.hub.tick();
      const got = deltas(a.framesFrom(before));
      expect(got).toHaveLength(1);
      h.clock.advance(SPEC.intervalMs);
      return got[0]!.maxWaitMs;
    };
    expect(waitFor(-500)).toBe(0);
    expect(waitFor(0)).toBe(0);
    expect(waitFor(65_534)).toBe(65_534);
    expect(waitFor(65_535)).toBe(SPEC.maxWaitCap);
    expect(waitFor(65_536)).toBe(SPEC.maxWaitCap);
    expect(waitFor(70_000)).toBe(SPEC.maxWaitCap);
  });

  test('S-T42 ⑤ 구독에서 뺀 구역의 쌓인 것은 버린다(남은 구역의 것만 다음 박자에 온다)', async () => {
    const h = harness();
    const a = h.open();
    h.hub.receive(a, subscribeBytes([2, 5]), true);
    await settle();
    const W = h.clock.now();
    h.sub.publish(channelOf('ev-1', 5), deltaText({ epoch: 3, section: 5, version: 1, changedAtMs: W - 10, seats: [[4, 1]] }));
    h.sub.publish(channelOf('ev-1', 2), deltaText({ epoch: 3, section: 2, version: 8, changedAtMs: W - 5, seats: [[1, 2]] }));
    h.clock.advance(41);
    h.hub.receive(a, subscribeBytes([2]), true);
    h.hub.tick();
    const got = deltas(a.framesFrom(1));
    expect(got.map(entriesOf)).toEqual([[{ sectionIndex: 2, sectionVersion: 8, offsets: [1], states: [2] }]]);
    expect(got[0]!.maxWaitMs).toBe(41 + 5);
  });

  test('S-T42 ⑥ 세대 7 메시지 둘이 쌓인 뒤 세대 8이 오면 그 자리에서 세대 7 묶음 하나가 나가고, 다음 박자에 세대 8 묶음이 온다(한 묶음에 한 세대)', async () => {
    const h = harness();
    const a = h.open();
    h.hub.receive(a, subscribeBytes([1]), true);
    await settle();
    const W = h.clock.now();
    h.sub.publish(channelOf('ev-1', 1), deltaText({ epoch: 7, section: 1, version: 20, changedAtMs: W - 12, seats: [[3, 1]] }));
    h.clock.advance(5);
    h.sub.publish(channelOf('ev-1', 1), deltaText({ epoch: 7, section: 1, version: 21, changedAtMs: W - 2, seats: [[3, 2]] }));
    expect(a.sent).toHaveLength(1);
    h.clock.advance(6);
    h.sub.publish(channelOf('ev-1', 1), deltaText({ epoch: 8, section: 1, version: 1, changedAtMs: W + 9, seats: [[3, 0]] }));
    // 박자를 기다리지 않고 세대 7 묶음
    const first = deltas(a.framesFrom(1));
    expect(first).toHaveLength(1);
    expect(first[0]!.seatEpoch).toBe(7);
    expect(first[0]!.serverTimeMs).toBe(W + 11);
    expect(first[0]!.maxWaitMs).toBe(11 + 12);
    expect(entriesOf(first[0]!).map((e) => e.sectionVersion)).toEqual([20, 21]);

    h.clock.advance(50);
    h.hub.tick();
    const all = deltas(a.framesFrom(1));
    expect(all).toHaveLength(2);
    expect(all[1]!.seatEpoch).toBe(8);
    expect(entriesOf(all[1]!)).toEqual([{ sectionIndex: 1, sectionVersion: 1, offsets: [3], states: [0] }]);
    expect(all[1]!.maxWaitMs).toBe(61 - 9);
  });

  test('S-T42 ⑨ 틀린 메시지 사이의 맞는 메시지는 묶음에 오고, 틀린 것만 빠지며 result="bad"가 그 수만큼 늘고 연결은 열려 있다', async () => {
    const h = harness();
    const a = h.open();
    h.hub.receive(a, subscribeBytes([2]), true);
    await settle();
    const W = h.clock.now();
    const ch = channelOf('ev-1', 2);
    const bad = [
      `2 7 2 1 ${W} 1:1`, // 판 2
      `1 7 2 1 ${W}`, // 좌석 없음(칸 모자람)
      `1 7 9 1 ${W} 1:1`, // 채널(2)과 다른 구역
      `1 7 2 1 ${W} 1:3`, // state 3
      `1 4294967296 2 1 ${W} 1:1`, // seatEpoch 2^32
    ];
    h.sub.publish(ch, deltaText({ epoch: 7, section: 2, version: 1, changedAtMs: W, seats: [[1, 1]] }));
    for (const t of bad.slice(0, 3)) h.sub.publish(ch, t);
    h.sub.publish(ch, deltaText({ epoch: 7, section: 2, version: 2, changedAtMs: W, seats: [[2, 2]] }));
    for (const t of bad.slice(3)) h.sub.publish(ch, t);
    h.hub.tick();
    const got = deltas(a.framesFrom(1));
    expect(got.map(entriesOf)).toEqual([
      [
        { sectionIndex: 2, sectionVersion: 1, offsets: [1], states: [1] },
        { sectionIndex: 2, sectionVersion: 2, offsets: [2], states: [2] },
      ],
    ]);
    const counted = (result: string) => h.metrics.filter((m) => m.name === 'realtime_gw_pubsub_messages_total' && m.labels.result === result).reduce((s, m) => s + m.value, 0);
    expect(counted('bad')).toBe(bad.length);
    expect(counted('ok')).toBe(2);
    expect(a.closed).toBeUndefined();
  });

  test('S-T42 ⑪ 보내기 버퍼가 1MiB + 1인 연결은 묶음 때 보내지 않고 1013으로 닫히고, 1MiB 정각인 연결과 다른 연결은 묶음을 이어 받는다', async () => {
    const h = harness();
    const slow = h.open();
    const atLimit = h.open();
    const fast = h.open();
    for (const c of [slow, atLimit, fast]) h.hub.receive(c, subscribeBytes([1]), true);
    await settle();
    slow.bufferedAmount = SPEC.maxBuffered + 1;
    atLimit.bufferedAmount = SPEC.maxBuffered;
    const W = h.clock.now();
    h.sub.publish(channelOf('ev-1', 1), deltaText({ epoch: 1, section: 1, version: 1, changedAtMs: W, seats: [[0, 1]] }));
    h.hub.tick();
    expect(slow.closes.map((x) => x.code)).toEqual([SPEC.close.slow]);
    expect(slow.sent).toHaveLength(1);
    expect(deltas(atLimit.framesFrom(1))).toHaveLength(1);
    expect(deltas(fast.framesFrom(1))).toHaveLength(1);
    h.clock.advance(SPEC.intervalMs);
    h.sub.publish(channelOf('ev-1', 1), deltaText({ epoch: 1, section: 1, version: 2, changedAtMs: W, seats: [[0, 2]] }));
    h.hub.tick();
    expect(deltas(atLimit.framesFrom(1))).toHaveLength(2);
    expect(deltas(fast.framesFrom(1))).toHaveLength(2);
    expect(slow.sent).toHaveLength(1);
    expect(atLimit.closed).toBeUndefined();
  });

  test('S-T12 ② 묶음 셋을 보내면 realtime_gw_batches_total 3, batch_bytes_total은 세 프레임 바이트의 합, batch_wait_ms는 세 maxWaitMs이고, 묶음이 없는 박자에는 늘지 않는다', async () => {
    const h = harness();
    const a = h.open();
    h.hub.receive(a, subscribeBytes([1, 2]), true);
    await settle();
    for (const [ago, seats] of [
      [15, [[0, 1]]],
      [42, [[1, 1], [2, 2], [3, 0]]],
      [230, [[9, 2]]],
    ] as Array<[number, Array<[number, number]>]>) {
      const now = h.clock.now();
      h.sub.publish(channelOf('ev-1', 1), deltaText({ epoch: 2, section: 1, version: ago, changedAtMs: now - ago, seats }));
      h.hub.tick();
      h.clock.advance(SPEC.intervalMs);
    }
    const sent = a.sent.slice(1);
    const frames = deltas(a.framesFrom(1));
    expect(frames.map((f) => f.maxWaitMs)).toEqual([15, 42, 230]);
    const of = (name: string) => h.metrics.filter((m) => m.name === name);
    expect(of('realtime_gw_batches_total').reduce((s, m) => s + m.value, 0)).toBe(3);
    expect(of('realtime_gw_batch_bytes_total').reduce((s, m) => s + m.value, 0)).toBe(sent.reduce((s, f) => s + f.byteLength, 0));
    expect(of('realtime_gw_batch_wait_ms').map((m) => m.value)).toEqual([15, 42, 230]);
    const before = h.metrics.length;
    h.hub.tick();
    h.clock.advance(SPEC.intervalMs);
    h.hub.tick();
    expect(h.metrics.slice(before).filter((m) => m.name.startsWith('realtime_gw_batch'))).toEqual([]);
  });
});

describe('S-T42 ⑧ 채널 구독 수 세기', () => {
  test('S-T42 ⑧ 두 연결이 같은 구역을 구독하면 SSUBSCRIBE 한 번, 첫 연결 해제에는 없고(남은 연결은 계속 받는다) 마지막 해제에 SUNSUBSCRIBE 한 번이다', async () => {
    const h = harness();
    const a = h.open();
    const b = h.open();
    const ch = channelOf('ev-1', 4);
    h.hub.receive(a, subscribeBytes([4]), true);
    await settle();
    expect(h.sub.calls).toEqual([['subscribe', ch]]);
    h.hub.receive(b, subscribeBytes([4]), true);
    await settle();
    expect(h.sub.calls).toEqual([['subscribe', ch]]);
    h.clock.advance(300);
    h.hub.receive(a, subscribeBytes([]), true);
    await settle();
    expect(h.sub.calls).toEqual([['subscribe', ch]]);
    // 남은 연결은 계속 받고 뺀 연결은 받지 않는다
    expect(h.sub.publish(ch, deltaText({ epoch: 1, section: 4, version: 1, changedAtMs: h.clock.now(), seats: [[0, 1]] }))).toBe(true);
    h.hub.tick();
    expect(deltas(b.framesFrom(1))).toHaveLength(1);
    expect(deltas(a.framesFrom(1))).toHaveLength(0);
    h.hub.receive(b, subscribeBytes([]), true);
    await settle();
    expect(h.sub.calls).toEqual([
      ['subscribe', ch],
      ['unsubscribe', ch],
    ]);
  });

  test('S-T42 ⑧ ⑰ 허브는 구독기의 약속을 기다리지 않는다: 구독이 끝나지 않은 채 마지막 해제가 오면 그 자리에서 unsubscribe를 부르고, 다시 구독하면 그 자리에서 subscribe를 부른다(같은 채널의 차례는 구독기 몫, ADR-0297 결정 1). 닫힌 연결(gone)도 해제를 부른다', async () => {
    const h = harness();
    const a = h.open();
    const ch = channelOf('ev-1', 4);
    h.sub.hold = true;
    h.hub.receive(a, subscribeBytes([4]), true);
    await settle();
    expect(h.sub.calls).toEqual([['subscribe', ch]]);
    h.clock.advance(600); // 구독 바꾸기 빈도 상한(1초 창에 2번)에 걸리지 않게
    h.hub.receive(a, subscribeBytes([]), true);
    await settle();
    // 구독의 약속이 끝나지 않았어도 1 → 0에서 곧 해제를 부른다
    expect(h.sub.calls).toEqual([
      ['subscribe', ch],
      ['unsubscribe', ch],
    ]);
    h.clock.advance(600); // 구독 바꾸기 빈도 상한(1초 창에 2번)에 걸리지 않게
    h.hub.receive(a, subscribeBytes([4]), true);
    await settle();
    expect(h.sub.calls).toEqual([
      ['subscribe', ch],
      ['unsubscribe', ch],
      ['subscribe', ch],
    ]);
    // 약속이 나중에 끝나도 허브는 더 부르지 않는다(결과로 상태를 정하지 않는다)
    for (const p of h.sub.pending.splice(0)) p.resolve();
    await settle();
    expect(h.sub.calls).toHaveLength(3);

    // 닫힌 연결(gone)도 0이 되면 해제를 부른다
    h.hub.gone(a);
    await settle();
    expect(h.sub.calls.at(-1)).toEqual(['unsubscribe', ch]);
    expect(h.sub.calls).toHaveLength(4);
  });
});

describe('S-T42 ⑰ 구독 상태의 주인은 구독기 하나(ADR-0297 결정 1)', () => {
  test('S-T42 ⑰ (가) 마지막 해제의 unsubscribe가 거절된 뒤 박자 전에 다른 연결이 같은 구역을 구독하면 허브가 그 자리에서 subscribe를 다시 부르고, 그 연결이 묶음을 받는다', async () => {
    const h = harness();
    const a = h.open();
    const b = h.open();
    const ch = channelOf('ev-1', 4);
    h.hub.receive(a, subscribeBytes([4]), true);
    await settle();
    expect(h.sub.calls).toEqual([['subscribe', ch]]);
    h.sub.hold = true;
    h.clock.advance(300);
    h.hub.receive(a, subscribeBytes([]), true);
    await settle();
    h.sub.pending.shift()!.reject(new Error('boom'));
    await settle();
    h.sub.hold = false;
    expect(h.sub.calls).toEqual([
      ['subscribe', ch],
      ['unsubscribe', ch],
    ]);
    // 박자 전에 b가 같은 구역을 구독한다: 0 → 1이므로 subscribe(실패한 해제의 결과로 '아직 구독 중'이라 보지 않는다)
    h.hub.receive(b, subscribeBytes([4]), true);
    await settle();
    expect(h.sub.calls.at(-1)).toEqual(['subscribe', ch]);
    expect(h.sub.calls).toHaveLength(3);
    expect(h.sub.publish(ch, deltaText({ epoch: 1, section: 4, version: 1, changedAtMs: h.clock.now(), seats: [[0, 1]] }))).toBe(true);
    h.hub.tick();
    expect(deltas(b.framesFrom(1)).map(entriesOf)).toEqual([[{ sectionIndex: 4, sectionVersion: 1, offsets: [0], states: [1] }]]);
    expect(a.closed).toBeUndefined();
  });

  test('S-T42 ⑰ (나) subscribe가 거절된 뒤 그 구역의 연결이 모두 빠지면 허브가 unsubscribe를 부른다(남는 구독이 없다). 해제로 빠져도, 닫혀(gone) 빠져도 같다', async () => {
    for (const how of ['해제', 'gone'] as const) {
      const h = harness();
      const a = h.open();
      const ch = channelOf('ev-1', 2);
      h.sub.hold = true;
      h.hub.receive(a, subscribeBytes([2]), true);
      await settle();
      h.sub.pending.shift()!.reject(new Error('boom'));
      await settle();
      h.sub.hold = false;
      h.clock.advance(300);
      if (how === '해제') h.hub.receive(a, subscribeBytes([]), true);
      else h.hub.gone(a);
      await settle();
      expect(h.sub.calls, how).toEqual([
        ['subscribe', ch],
        ['unsubscribe', ch],
      ]);
    }
  });

  test('S-T42 ⑰ (다) 허브는 0 ↔ 1 전환마다 구독기를 한 번만 부르고, 구독이 거절돼도 박자(tick)에서 다시 부르지 않는다(다시 보내기와 물러서기는 구독기 몫)', async () => {
    const h = harness();
    const a = h.open();
    const b = h.open();
    const ch = channelOf('ev-1', 2);
    h.sub.hold = true;
    h.hub.receive(a, subscribeBytes([2]), true);
    await settle();
    h.sub.pending.shift()!.reject(new Error('boom'));
    await settle();
    h.sub.hold = false;
    // 둘째 연결이 같은 구역을 구독해도(1 → 2) 부르지 않는다
    h.hub.receive(b, subscribeBytes([2]), true);
    await settle();
    for (let i = 0; i < 60; i++) {
      h.clock.advance(SPEC.intervalMs);
      h.hub.tick();
    }
    await settle();
    expect(h.sub.calls).toEqual([['subscribe', ch]]);
    // 첫 연결이 빠져도(2 → 1) 부르지 않고, 마지막이 빠지면(1 → 0) 한 번 부른다
    h.hub.receive(a, subscribeBytes([]), true);
    await settle();
    expect(h.sub.calls).toEqual([['subscribe', ch]]);
    h.hub.receive(b, subscribeBytes([]), true);
    await settle();
    h.hub.tick();
    await settle();
    expect(h.sub.calls).toEqual([
      ['subscribe', ch],
      ['unsubscribe', ch],
    ]);
  });
});

describe('S-T42 ⑮ 받지 않는 연결의 보내기 버퍼(ADR-0297 결정 2)', () => {
  test('S-T42 ⑮ 구독 없는 연결도 보내기 버퍼가 1MiB + 1이면 보낼 것이 없는 다음 박자에 1013 slow consumer로 닫히고, 1MiB 정각이면 열려 있다 [ASVS v5.0.0-2.4.1]', async () => {
    const h = harness();
    const over = h.open();
    const atLimit = h.open();
    const subscribedOver = h.open();
    h.hub.receive(subscribedOver, subscribeBytes([3]), true);
    await settle();
    over.bufferedAmount = SPEC.maxBuffered + 1;
    atLimit.bufferedAmount = SPEC.maxBuffered;
    subscribedOver.bufferedAmount = SPEC.maxBuffered + 1;
    // 박자 전에는 닫지 않는다
    expect(over.closed).toBeUndefined();
    h.clock.advance(SPEC.intervalMs);
    h.hub.tick();
    await settle();
    expect(over.closes).toEqual([{ code: SPEC.close.slow, reason: SPEC.reason.slow }]);
    expect(subscribedOver.closes).toEqual([{ code: SPEC.close.slow, reason: SPEC.reason.slow }]);
    expect(atLimit.closed).toBeUndefined();
    // 닫은 연결에는 보내지 않았고(첫 BatchInterval뿐), 그 연결의 구역은 풀린다
    expect(over.sent).toHaveLength(1);
    expect(subscribedOver.sent).toHaveLength(1);
    expect(h.sub.calls).toEqual([
      ['subscribe', channelOf('ev-1', 3)],
      ['unsubscribe', channelOf('ev-1', 3)],
    ]);
    // 다음 박자에도 정각인 연결은 열려 있다
    h.clock.advance(SPEC.intervalMs);
    h.hub.tick();
    expect(atLimit.closed).toBeUndefined();
  });
});

describe('S-T42 ⑯ 같은 입장 토큰의 연결 수(ADR-0297 결정 3)', () => {
  test('S-T42 ⑯ 같은 토큰 jti로 셋째 연결은 맺은 뒤 4429 too many로 닫히고 앞의 둘은 열려 있다. 하나가 빠지면 다시 붙을 수 있고, 다른 토큰은 세지 않는다', async () => {
    const h = harness();
    const first = h.open({ tokenId: 'jti-same' });
    const second = h.open({ tokenId: 'jti-same' });
    const other = h.open({ tokenId: 'jti-other' });
    expect([first.closed, second.closed, other.closed]).toEqual([undefined, undefined, undefined]);
    const third = h.open({ tokenId: 'jti-same' });
    expect(third.closes).toEqual([{ code: SPEC.close.tooMany, reason: SPEC.reason.tooMany }]);
    expect([first.closed, second.closed]).toEqual([undefined, undefined]);
    // 닫힌 셋째는 받는 프레임을 보지 않는다(구독하지 않는다)
    h.hub.receive(third, subscribeBytes([1]), true);
    await settle();
    expect(h.sub.calls).toEqual([]);
    // 하나가 빠지면 같은 토큰으로 다시 붙는다(다시 붙는 동안의 겹침)
    h.hub.gone(first);
    const again = h.open({ tokenId: 'jti-same' });
    expect(again.closed).toBeUndefined();
    expect(again.frames()).toEqual([{ type: 'batchInterval', intervalMs: SPEC.intervalMs }]);
    // 허브가 닫은 연결도 자리를 비운다(4403으로 닫은 뒤 다시 붙음)
    h.hub.receive(second, rawFrame(1, 17), true);
    expect(second.closes.map((x) => x.code)).toEqual([SPEC.close.forbidden]);
    expect(h.open({ tokenId: 'jti-same' }).closed).toBeUndefined();
    expect(h.open({ tokenId: 'jti-same' }).closes.map((x) => x.code)).toEqual([SPEC.close.tooMany]);
    expect(SPEC.sameTokenMax).toBe(2);
  });
});

describe('S-T42 ⑲ 내릴 때의 마감(ADR-0297 결정 5)', () => {
  test('S-T42 ⑲ 구독기가 해제 응답을 붙잡아도 shutdown()은 1초 + 여유 안에 끝나고 모든 연결은 1012 server restart로 닫힌다', async () => {
    const h = harness();
    const a = h.open();
    const b = h.open({ eventId: 'ev-2' });
    h.sub.hold = true;
    h.hub.receive(a, subscribeBytes([1, 2]), true);
    h.hub.receive(b, subscribeBytes([1]), true);
    await settle();
    const started = Date.now();
    const result = await Promise.race([
      h.hub.shutdown().then(() => 'done' as const),
      new Promise<'late'>((r) => setTimeout(() => r('late'), SPEC.shutdownUnsubscribeWaitMs + 500)),
    ]);
    expect(result).toBe('done');
    expect(Date.now() - started).toBeLessThan(SPEC.shutdownUnsubscribeWaitMs + 500);
    expect(a.closes).toEqual([{ code: SPEC.close.restart, reason: SPEC.reason.restart }]);
    expect(b.closes).toEqual([{ code: SPEC.close.restart, reason: SPEC.reason.restart }]);
    // 내린 뒤의 open은 곧 1012
    expect(h.open().closes).toEqual([{ code: SPEC.close.restart, reason: SPEC.reason.restart }]);
  });
});

describe('S-T31 ④ S-T42 ⑦ 화면 인코더와의 맞물림(WIR-06)', () => {
  test('S-T31 ④ S-T42 ⑦ 화면 인코더 @peaket/seatmap encodeSubscribe·encodeTimeSync가 만든 바이트를 허브가 받는다: 구독이 되고 곧 Heartbeat로 답한다', async () => {
    const h = harness();
    const c = h.open();
    h.hub.receive(c, encodeSubscribe(range(16, 3)), true);
    await settle();
    expect(c.closed).toBeUndefined();
    expect(h.sub.calls).toEqual(range(16, 3).map((s) => ['subscribe', channelOf('ev-1', s)]));
    h.hub.receive(c, encodeTimeSync(1_763_441_234_567), true);
    expect(c.frames().at(-1)).toEqual({ type: 'heartbeat', serverTimeMs: WALL0, echoClientTimeMs: 1_763_441_234_567 });
    // 빈 목록(구독 모두 뺌)도 받는다
    h.clock.advance(SPEC.windowMs);
    h.hub.receive(c, encodeSubscribe([]), true);
    await settle();
    expect(c.closed).toBeUndefined();
    expect(h.sub.calls.filter(([op]) => op === 'unsubscribe')).toHaveLength(16);
  });
});

describe('원형 오염 막기', () => {
  test('S-T42 ⑤ 회차 ID __proto__·constructor의 연결과 메시지는 다른 회차 연결에 가지 않고 Object.prototype에 새 속성이 없다 [ASVS v5.0.0-15.3.6]', async () => {
    const protoKeys = Object.getOwnPropertyNames(Object.prototype).sort();
    const h = harness({ sections: { 'ev-1': 3 } });
    // 객체 글자로는 __proto__ 칸을 만들 수 없어 Map에 바로 넣는다
    h.sections.set('__proto__', 3);
    h.sections.set('constructor', 3);
    const p = h.open({ eventId: '__proto__' });
    const k = h.open({ eventId: 'constructor' });
    const e = h.open({ eventId: 'ev-1' });
    for (const c of [p, k, e]) h.hub.receive(c, subscribeBytes([0]), true);
    await settle();
    for (const c of [p, k, e]) expect(c.closed).toBeUndefined();
    const now = h.clock.now();
    expect(h.sub.publish(channelOf('__proto__', 0), deltaText({ epoch: 1, section: 0, version: 5, changedAtMs: now, seats: [[1, 2]] }))).toBe(true);
    h.hub.tick();
    expect(deltas(p.framesFrom(1)).map(entriesOf)).toEqual([[{ sectionIndex: 0, sectionVersion: 5, offsets: [1], states: [2] }]]);
    expect(deltas(k.framesFrom(1))).toEqual([]);
    expect(deltas(e.framesFrom(1))).toEqual([]);
    expect(Object.getOwnPropertyNames(Object.prototype).sort()).toEqual(protoKeys);
    expect(({} as Record<string, unknown>).sections).toBeUndefined();
    expect(({} as Record<string, unknown>)['0']).toBeUndefined();
  });
});

describe('닫힘 이유 글', () => {
  test('S-T31 ③ 닫힘 이유 글은 받은 값(회차 ID·구역 색인)을 싣지 않고 입력이 달라도 같은 고정 글이다 [ASVS v5.0.0-1.3.7]', () => {
    const h = harness({ sections: { 'ev-a1b2c3': 2, 'ev-zz9': 2 } });
    const a = h.open({ eventId: 'ev-a1b2c3' });
    const b = h.open({ eventId: 'ev-zz9' });
    h.hub.receive(a, subscribeBytes([4242]), true);
    h.hub.receive(b, subscribeBytes([7]), true);
    expect(a.closed!.code).toBe(SPEC.close.forbidden);
    expect(a.closed!.reason).toBe(b.closed!.reason);
    for (const s of ['ev-a1b2c3', '4242']) expect(a.closed!.reason).not.toContain(s);
    expect(Buffer.byteLength(a.closed!.reason)).toBeLessThanOrEqual(123);
    // 상대가 끊은 연결(gone)에는 닫기를 다시 부르지 않는다
    const c = new FakeConn();
    h.hub.open(c, { eventId: 'ev-zz9', accountId: 'acct-1', expiresAtMs: WALL0 + 60_000, tokenId: 'jti-gone' });
    h.hub.gone(c);
    h.hub.receive(c, subscribeBytes([0]), true);
    expect(c.closes).toEqual([]);
    expect(MONO0 % SPEC.intervalMs).not.toBe(0);
  });
});

describe('S-T42 ③ ⑮ ⑯ 닫힘 이유 글은 계약이다(ADR-0297 결정 8)', () => {
  test("S-T42 ③ ⑮ ⑯ 허브가 닫는 이유 글은 docs/frontend.md §4.4.1 '닫힘 이유 글'과 글자 그대로 같다: bad event·bad frame·bad section·too many·token expired·slow consumer·server restart [ASVS v5.0.0-1.3.7]", async () => {
    const h = harness({ sections: { 'ev-1': 5 } });
    const badEvent = new FakeConn();
    h.hub.open(badEvent, { eventId: 'ev:1', accountId: 'acct-1', expiresAtMs: WALL0 + 60_000, tokenId: 'jti-be' });
    const badFrame = h.open();
    h.hub.receive(badFrame, rawFrame(1, 17, [3, 0, 97, 98, 99]), true);
    const badSection = h.open();
    h.hub.receive(badSection, subscribeBytes([5]), true);
    const tooMany = h.open();
    h.hub.receive(tooMany, subscribeBytes(range(17)), true);
    const expired = h.open({ expiresAtMs: WALL0 + 150 });
    const slow = h.open();
    slow.bufferedAmount = SPEC.maxBuffered + 1;
    const rest = h.open();
    h.clock.advance(SPEC.intervalMs * 2);
    h.hub.tick();
    await h.hub.shutdown();
    expect([badEvent, badFrame, badSection, tooMany, expired, slow, rest].map((c) => c.closes)).toEqual([
      [{ code: SPEC.close.forbidden, reason: SPEC.reason.badEvent }],
      [{ code: SPEC.close.forbidden, reason: SPEC.reason.badFrame }],
      [{ code: SPEC.close.forbidden, reason: SPEC.reason.badSection }],
      [{ code: SPEC.close.tooMany, reason: SPEC.reason.tooMany }],
      [{ code: SPEC.close.expired, reason: SPEC.reason.expired }],
      [{ code: SPEC.close.slow, reason: SPEC.reason.slow }],
      [{ code: SPEC.close.restart, reason: SPEC.reason.restart }],
    ]);
  });
});
