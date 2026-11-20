// 좌석 스트림 배선(FE-T11, HOT-357·BAT-182, docs/frontend.md §4.4.1·§5.2·§3.5). 가짜 소켓·가짜 시계·가짜 스냅샷으로 Worker 처리기를 돈다.
// T1 첫 그림 뒤 stream 한 번 · T2 1,000ms 머묾과 전체 집합 · T3 16개 상한과 가운데 가까운 차례 · T4 판 경계 · T5 갭·세대·재연결 · T6 35초·60초·Degraded·4401.
import { describe, expect, it, vi } from 'vitest';
import { SEATS_PROTOCOL, type SeatSocket } from '../src/connection';
import { FromWorker } from '../src/protocol';
import { createHandler, type Host } from '../src/worker';
import { encodeBatchInterval, encodeHeartbeat } from '../src/wire';
import { encodeDelta, encodeSnapshot, fakeCtx, makeLayout } from './fixtures';

const LAYOUT_URL = 'http://w/v1/events/evt-1/seatmap-layouts/3.json';
const SNAPSHOT_URL = 'http://a/v1/events/evt-1/seatmap-snapshot';
const STREAM_URL = 'ws://127.0.0.1:4010/v1/events/evt-1/seats/stream';
const TOKEN = 'adm.token.sig';
/** 첫 그림 뒤 stream의 만료 시각(먼 미래) */
const EXPIRES_AT = 10_000_000;

type Posted = { type: string } & Record<string, unknown>;

/** 가짜 시계(connection.test.ts와 같은 방식). advance는 예약된 타이머를 시각 차례로 돌리고 마이크로태스크를 비운다 */
function fakeTime(start = 1_000) {
  let now = start;
  let id = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const flush = async (n = 8) => {
    for (let i = 0; i < n; i++) await Promise.resolve();
  };
  const advance = async (ms: number) => {
    const end = now + ms;
    await flush();
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].fn();
      await flush();
    }
    now = end;
    await flush();
  };
  return { now: () => now, setTimer: (fn: () => void, ms: number) => (timers.set(++id, { at: now + ms, fn }), id), clearTimer: (h: unknown) => void timers.delete(h as number), advance, flush, pending: () => timers.size };
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
  constructor(
    readonly url: string,
    readonly protocols: string[],
  ) {}
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

/** section 스냅샷 한 장(flags 1). 구역 좌석 수는 좌석맵 파일에서 센다 */
function sectionSnapshot(layout: ReturnType<typeof makeLayout>, section: number, version: number, seatEpoch = 1): Uint8Array {
  const sec = layout.sections[section]!;
  const n = sec.seatIndexRange.to - sec.seatIndexRange.from + 1;
  return encodeSnapshot({ flags: 1, layoutVersion: layout.layoutVersion, seatEpoch, sections: [[section, version]], occupied: Array(n).fill(false) });
}

const listOf = (u: Uint8Array): number[] => {
  const v = new DataView(u.buffer, u.byteOffset, u.byteLength);
  const n = v.getUint16(2, true);
  return Array.from({ length: n }, (_, i) => v.getUint16(4 + i * 2, true));
};
/** 소켓이 보낸 SubscribeSections(16)의 구독 목록들 */
const subscribeLists = (s: FakeSocket): number[][] => s.sent.filter((u) => u[1] === 16).map(listOf);
const frameTypes = (s: FakeSocket): number[] => s.sent.map((u) => u[1]!);

/** 처리기 하나와 그 호스트. section 스냅샷은 defer면 시험이 응답 시각을 정한다 */
function setup(o: { layout?: ReturnType<typeof makeLayout>; deferSection?: boolean } = {}) {
  const layout = o.layout ?? makeLayout({ sections: 4, rows: 10, perRow: 20, gap: 2000, jitter: false });
  const t = fakeTime();
  const posted: Posted[] = [];
  const sockets: FakeSocket[] = [];
  const sectionCalls: Array<{ url: string; section: number; respond: (res: Response) => void; fail: (err: unknown) => void }> = [];
  const fullSnapshot = encodeSnapshot({ layoutVersion: layout.layoutVersion, seatEpoch: 1, sections: Array.from({ length: layout.sections.length }, (_, s) => [s, 1] as [number, number]), occupied: Array(layout.seatCount).fill(false) });
  const fetch = vi.fn(async (url: string) => {
    if (url.endsWith('.json')) return new Response(JSON.stringify(layout));
    const section = new URL(url).searchParams.get('section');
    if (section === null) return new Response(fullSnapshot.slice().buffer as ArrayBuffer);
    const index = Number(section);
    if (!o.deferSection) return new Response(sectionSnapshot(layout, index, 1).slice().buffer as ArrayBuffer);
    return new Promise<Response>((resolve, reject) => {
      sectionCalls.push({ url, section: index, respond: resolve, fail: reject });
    });
  });
  const host: Host = {
    post: (m) => void posted.push(FromWorker.parse(m) as Posted),
    fetch,
    nextFrame: async () => {},
    now: t.now,
    openSocket: (url, protocols) => {
      const s = new FakeSocket(url, protocols);
      sockets.push(s);
      return s;
    },
    setTimer: t.setTimer,
    clearTimer: t.clearTimer,
    serverNow: t.now,
    random: () => 0.5,
  };
  const handle = createHandler(host, () => fakeCtx());
  const init = (extra: Record<string, unknown> = {}) => ({ type: 'init', canvas: {}, layoutUrl: LAYOUT_URL, snapshotUrl: SNAPSHOT_URL, admission: { token: TOKEN, ephemeralKey: 'pub' }, width: 400, height: 300, dpr: 1, theme: 'light', ...extra });
  /** init → ready → stream → 소켓 open까지. 돌려주는 socket은 열린 소켓이다 */
  const ready = async (extra: Record<string, unknown> = {}) => {
    const started = handle(init(extra));
    await started;
    await handle({ type: 'stream', url: STREAM_URL, expiresAtMs: EXPIRES_AT });
    const socket = sockets.at(-1)!;
    socket.open();
    await t.flush();
    return socket;
  };
  return { layout, t, posted, sockets, sectionCalls, host, fetch, handle, init, ready, lastConnection: () => posted.filter((m) => m.type === 'connection').at(-1) as Posted | undefined, sections: () => posted.filter((m) => m.type === 'sections') as Posted[] };
}

/** 구역 스냅샷 응답 하나. version은 기다리던 델타의 앞 번호(놓친 판)를 준다 */
const respondSection = (call: { section: number; respond: (res: Response) => void }, layout: ReturnType<typeof makeLayout>, version: number, seatEpoch = 1) => call.respond(new Response(sectionSnapshot(layout, call.section, version, seatEpoch).slice().buffer as ArrayBuffer));

describe('FE-T11 좌석 스트림: 첫 그림과 연결', () => {
  it('[FE-T11] 첫 그림 전에는 스트림을 열지 않고 ready 뒤 한 번만 연다', async () => {
    const s = setup();
    // init 전의 stream은 무시한다(엔진이 없다)
    await s.handle({ type: 'stream', url: STREAM_URL, expiresAtMs: EXPIRES_AT });
    expect(s.sockets).toHaveLength(0);
    await s.handle(s.init());
    expect(s.posted.some((m) => m.type === 'ready')).toBe(true);
    expect(s.sockets).toHaveLength(0);
    await s.handle({ type: 'stream', url: STREAM_URL, expiresAtMs: EXPIRES_AT });
    expect(s.sockets).toHaveLength(1);
    // 두 번 보내도 하나다(docs/frontend.md §4.4.1 '첫 그림 뒤 한 번')
    await s.handle({ type: 'stream', url: STREAM_URL, expiresAtMs: EXPIRES_AT });
    expect(s.sockets).toHaveLength(1);
    const socket = s.sockets[0]!;
    expect(socket.url).toBe(STREAM_URL);
    expect(socket.protocols).toEqual([SEATS_PROTOCOL, `peaket.auth.${TOKEN}`]);
    // 하위 프로토콜을 고르기 전에는 live가 아니다
    expect(s.lastConnection()).toMatchObject({ state: 'connecting' });
    socket.open();
    await s.t.flush();
    expect(s.lastConnection()).toMatchObject({ state: 'live' });
  });
});

describe('FE-T11 좌석 스트림: 보이는 구역만 1초 뒤 구독', () => {
  it('[FE-T11] 보이는 구역만 1,000ms 머문 뒤 구독하고 999ms에는 보내지 않는다', async () => {
    const s = setup();
    const socket = await s.ready();
    // 전체 보기: 구독 0, SubscribeSections도 없다
    expect(s.sections().at(-1)).toMatchObject({ visible: [], subscribed: [] });
    expect(subscribeLists(socket)).toEqual([]);

    await s.handle({ type: 'focusSection', section: 0 });
    await s.t.advance(999);
    expect(subscribeLists(socket)).toEqual([]);
    expect(s.sections().at(-1)).toMatchObject({ visible: [0], subscribed: [] });

    await s.t.advance(1);
    expect(subscribeLists(socket)).toEqual([[0]]);
    expect(s.sections().at(-1)).toMatchObject({ visible: [0], subscribed: [0] });

    // 옆 구역으로 옮기면 전체 집합을 보내고 이전 구역은 빠진다. 바꾸기는 1,000ms에 한 번이다
    await s.handle({ type: 'focusSection', section: 1 });
    await s.t.advance(999);
    expect(subscribeLists(socket)).toEqual([[0]]);
    await s.t.advance(1);
    expect(subscribeLists(socket)).toEqual([[0], [1]]);
    expect(s.sections().at(-1)).toMatchObject({ visible: [1], subscribed: [1] });

    // 전체 보기로 축소하면 빈 집합
    await s.handle({ type: 'fit' });
    await s.t.advance(999);
    expect(subscribeLists(socket)).toEqual([[0], [1]]);
    await s.t.advance(1);
    expect(subscribeLists(socket)).toEqual([[0], [1], []]);
    expect(s.sections().at(-1)).toMatchObject({ visible: [], subscribed: [] });
  });

  it('[FE-T11] 1초 넘게 안정된 뒤 한 번에 옮겨도 새 구역을 1초 뒤 구독한다', async () => {
    const s = setup();
    const socket = await s.ready();
    await s.handle({ type: 'focusSection', section: 0 });
    await s.t.advance(1000);
    expect(subscribeLists(socket)).toEqual([[0]]);
    // 바꾸기 간격(1,000ms)이 이미 지난 뒤 새 구역으로 옮긴다. 머묾 타이머를 새로 잡아야 한다
    await s.t.advance(1500);
    await s.handle({ type: 'focusSection', section: 1 });
    await s.t.advance(999);
    expect(s.sections().at(-1)).toMatchObject({ visible: [1], subscribed: [0] });
    await s.t.advance(1);
    expect(subscribeLists(socket)).toEqual([[0], [1]]);
    expect(s.sections().at(-1)).toMatchObject({ visible: [1], subscribed: [1] });
  });
});

describe('FE-T11 좌석 스트림: 16개 상한', () => {
  it('[FE-T11] 구독 16개 상한은 가운데 가까운 순서로 자르고 17번째를 보내지 않는다', async () => {
    // 구역 20개를 같은 자리(겹친 배치)에 두고 가운데에서의 거리만 조금씩 다르게 한다. 모두 화면 폭 1/3 이상으로 보인다
    const layout = makeLayout({ sections: 20, rows: 5, perRow: 20, gap: -1100, jitter: false });
    layout.sections.forEach((sec, s) => {
      const dy = Math.abs(s - 10) * 10;
      sec.seats.y = sec.seats.y.map((y) => y + dy);
    });
    const s = setup({ layout });
    const socket = await s.ready();
    await s.handle({ type: 'focusSection', section: 0 });
    await s.t.advance(1_000);
    // focusSection(0) 뒤 화면 가운데(캔버스 가운데)에 가까운 차례. 0구역은 아래로 100cm 밀어 두어 10구역이 가장 가깝다
    const expected = [10, 9, 11, 8, 12, 7, 13, 6, 14, 5, 15, 4, 16, 3, 17, 2];
    const lists = subscribeLists(socket);
    expect(lists).toHaveLength(1);
    expect(lists[0]).toEqual(expected);
    expect(lists[0]).toHaveLength(16);
    // SubscribeSections 프레임은 4 + 2×16 = 36바이트이고 17번째(18)를 싣지 않는다
    const frame = socket.sent.find((u) => u[1] === 16)!;
    expect(frame.byteLength).toBe(36);
    expect(listOf(frame)).not.toContain(18);
    expect(s.sections().at(-1)).toMatchObject({ visible: [...expected, 18, 1, 19, 0], subscribed: expected });
  });
});

describe('FE-T11 좌석 스트림: 판 경계와 목록 알림', () => {
  it('[FE-T11] 델타는 다음 번호만 반영하고 같거나 작으면 버리며 바뀐 구역만 목록에 알린다', async () => {
    const s = setup({ deferSection: true });
    const socket = await s.ready();
    await s.handle({ type: 'listSection', section: 0 });
    const before = s.posted.filter((m) => m.type === 'sectionState').length;
    expect(before).toBe(1);

    // v+1: 반영하고 목록에 바뀐 좌석만 보낸다
    socket.frame(encodeDelta({ seatEpoch: 1, sections: [{ index: 0, version: 2, changes: [[0, 1], [1, 2]] }] }));
    await s.t.flush();
    let changed = s.posted.filter((m) => m.type === 'stateChanged');
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({ section: 0, version: 2 });
    expect([...((changed[0]!.offsets as Uint32Array) ?? [])]).toEqual([0, 1]);
    expect([...((changed[0]!.states as Uint8Array) ?? [])]).toEqual([1, 2]);

    // 같은 번호와 작은 번호는 버린다
    socket.frame(encodeDelta({ seatEpoch: 1, sections: [{ index: 0, version: 2, changes: [[0, 3]] }] }));
    socket.frame(encodeDelta({ seatEpoch: 1, sections: [{ index: 0, version: 1, changes: [[0, 3]] }] }));
    await s.t.flush();
    expect(s.posted.filter((m) => m.type === 'stateChanged')).toHaveLength(1);

    // 다른 구역의 델타는 목록이 연 구역(0)에 알리지 않는다
    socket.frame(encodeDelta({ seatEpoch: 1, sections: [{ index: 1, version: 2, changes: [[0, 1]] }] }));
    await s.t.flush();
    expect(s.posted.filter((m) => m.type === 'stateChanged')).toHaveLength(1);

    // v+2 갭: 그 구역 스냅샷을 한 번 받아 놓친 판을 채우고, 기다린 델타를 다시 얹는다
    socket.frame(encodeDelta({ seatEpoch: 1, sections: [{ index: 0, version: 4, changes: [[2, 2]] }] }));
    await s.t.flush();
    const calls = s.sectionCalls;
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]!.url).searchParams.get('section')).toBe('0');
    respondSection(calls[0]!, s.layout, 3);
    await s.t.flush();
    changed = s.posted.filter((m) => m.type === 'stateChanged');
    expect(changed.at(-1)).toMatchObject({ section: 0, version: 4 });
    await s.handle({ type: 'listSection', section: 0 });
    const state = s.posted.filter((m) => m.type === 'sectionState').at(-1)!;
    expect(state).toMatchObject({ section: 0, version: 4 });
    // 판매(엔진 상태 2)는 목록 상태 코드 3(sold)이다
    expect((state.states as Uint8Array)[2]).toBe(3);
  });
});

describe('FE-T11 좌석 스트림: 갭·세대·재연결 회복', () => {
  it('[FE-T11] 갭·세대·재연결에서 그 구역 스냅샷을 한 번에 하나만 받고 기다린 델타를 다시 얹는다', async () => {
    const s = setup({ deferSection: true });
    const socket = await s.ready();
    await s.handle({ type: 'focusSection', section: 0 });
    await s.t.advance(1_000);
    expect(subscribeLists(socket)).toEqual([[0]]);

    // 갭 두 개를 잇달아 받아도 스냅샷 요청은 하나다(한 번에 하나). 기다리는 동안 온 델타는 버리지 않는다
    socket.frame(encodeDelta({ seatEpoch: 1, sections: [{ index: 0, version: 3, changes: [[3, 1]] }] }));
    await s.t.flush();
    expect(s.sectionCalls).toHaveLength(1);
    socket.frame(encodeDelta({ seatEpoch: 1, sections: [{ index: 0, version: 4, changes: [[4, 2]] }] }));
    await s.t.flush();
    expect(s.sectionCalls).toHaveLength(1);
    respondSection(s.sectionCalls[0]!, s.layout, 2);
    await s.t.flush();
    expect(s.sectionCalls).toHaveLength(1);
    socket.frame(encodeDelta({ seatEpoch: 1, sections: [{ index: 0, version: 5, changes: [[5, 1]] }] }));
    await s.t.flush();
    await s.handle({ type: 'listSection', section: 0 });
    expect(s.posted.filter((m) => m.type === 'sectionState').at(-1)).toMatchObject({ section: 0, version: 5 });
    await s.handle({ type: 'listSection', section: null });

    // 세대가 오르면 구독 구역 전체를 0~1,000ms 무작위로 늦춰 스냅샷으로 다시 맞춘다(random 0.5 → 500ms)
    const beforeEpoch = s.sectionCalls.length;
    socket.frame(encodeDelta({ seatEpoch: 2, sections: [{ index: 0, version: 5, changes: [] }] }));
    await s.t.flush();
    expect(s.sectionCalls).toHaveLength(beforeEpoch);
    await s.t.advance(499);
    expect(s.sectionCalls).toHaveLength(beforeEpoch);
    await s.t.advance(1);
    expect(s.sectionCalls).toHaveLength(beforeEpoch + 1);
    respondSection(s.sectionCalls.at(-1)!, s.layout, 5, 2);
    await s.t.flush();

    // 503은 Retry-After 뒤 다시 묻는다(2초 → 지터 1.1배 = 2,200ms)
    socket.frame(encodeDelta({ seatEpoch: 2, sections: [{ index: 0, version: 7, changes: [[6, 1]] }] }));
    await s.t.flush();
    const first = s.sectionCalls.at(-1)!;
    first.fail(Object.assign(new Error('좌석 스냅샷 503'), { status: 503, retryAfterMs: 2_000 }));
    await s.t.flush();
    const callsAt503 = s.sectionCalls.length;
    await s.t.advance(2_199);
    expect(s.sectionCalls).toHaveLength(callsAt503);
    await s.t.advance(1);
    expect(s.sectionCalls).toHaveLength(callsAt503 + 1);
    respondSection(s.sectionCalls.at(-1)!, s.layout, 6, 2);
    await s.t.flush();

    // 다시 붙으면 SubscribeSections를 먼저 보내고 구독 구역 스냅샷을 받는다
    const beforeReconnect = s.sectionCalls.length;
    socket.drop(1013);
    await s.t.flush();
    expect(s.lastConnection()).toMatchObject({ state: 'reconnecting' });
    await s.t.advance(250);
    expect(s.sockets).toHaveLength(2);
    const again = s.sockets[1]!;
    again.open();
    await s.t.flush();
    expect(subscribeLists(again)[0]).toEqual([0]);
    expect(frameTypes(again).indexOf(16)).toBeLessThan(frameTypes(again).indexOf(18));
    expect(s.sectionCalls).toHaveLength(beforeReconnect + 1);
    respondSection(s.sectionCalls.at(-1)!, s.layout, 7, 2);
    await s.t.flush();
    expect(s.lastConnection()).toMatchObject({ state: 'live' });

    // 다시 붙는 사이에도 같은 구역 스냅샷은 하나만 보낸다(진행 중이면 기다렸다가 한 번 더, M6)
    const callsBeforeGap = s.sectionCalls.length;
    again.frame(encodeDelta({ seatEpoch: 2, sections: [{ index: 0, version: 9, changes: [[7, 1]] }] }));
    await s.t.flush();
    expect(s.sectionCalls).toHaveLength(callsBeforeGap + 1);
    again.drop(1013);
    await s.t.flush();
    // 두 번째 재연결은 실패 횟수가 하나 늘어 500ms 뒤다(random 0.5 × 500 × 2)
    await s.t.advance(500);
    expect(s.sockets).toHaveLength(3);
    const third = s.sockets.at(-1)!;
    third.open();
    await s.t.flush();
    // 앞 요청이 끝나기 전에 또 보내지 않는다
    expect(s.sectionCalls).toHaveLength(callsBeforeGap + 1);
    respondSection(s.sectionCalls.at(-1)!, s.layout, 8, 2);
    await s.t.flush();
    // 끝난 뒤에는 다시 붙은 몫으로 한 번 더 묻는다
    expect(s.sectionCalls).toHaveLength(callsBeforeGap + 2);
    respondSection(s.sectionCalls.at(-1)!, s.layout, 9, 2);
    await s.t.flush();
    await s.handle({ type: 'listSection', section: 0 });
    expect(s.posted.filter((m) => m.type === 'sectionState').at(-1)).toMatchObject({ section: 0, version: 9 });
  });
});

describe('FE-T11 좌석 스트림: 끊김·시계·Degraded·4401', () => {
  it('[FE-T11] 35초 무프레임·60초 TimeSync·BatchInterval 1000·4401을 연결 상태 기계에 잇는다', async () => {
    const s = setup();
    const socket = await s.ready();
    // 35초 동안 프레임이 없으면 끊고 다시 붙는다
    await s.t.advance(34_999);
    expect(s.sockets).toHaveLength(1);
    await s.t.advance(1);
    expect(s.sockets).toHaveLength(1);
    expect(s.lastConnection()).toMatchObject({ state: 'reconnecting' });
    await s.t.advance(250);
    expect(s.sockets).toHaveLength(2);
    const again = s.sockets[1]!;
    again.open();
    await s.t.flush();
    expect(s.lastConnection()).toMatchObject({ state: 'live' });

    // 60초마다 TimeSync를 보낸다(연결 직후 하나 + 60초). 하트비트가 오면 35초 시계를 다시 잡는다
    await s.t.advance(20_000);
    again.frame(encodeHeartbeat(s.t.now(), 0));
    await s.t.advance(20_000);
    again.frame(encodeHeartbeat(s.t.now(), 0));
    const at60 = frameTypes(again).filter((t) => t === 18).length;
    await s.t.advance(19_999);
    expect(frameTypes(again).filter((t) => t === 18)).toHaveLength(at60);
    await s.t.advance(1);
    expect(frameTypes(again).filter((t) => t === 18)).toHaveLength(at60 + 1);

    // BatchInterval 1,000이면 Degraded, 100이면 지운다(연결은 유지)
    again.frame(encodeBatchInterval(1_000));
    await s.t.flush();
    expect(s.lastConnection()).toMatchObject({ state: 'live', degraded: true });
    again.frame(encodeBatchInterval(100));
    await s.t.flush();
    expect(s.lastConnection()).toMatchObject({ state: 'live', degraded: false });

    // 4401은 다시 붙지 않는다. 연결을 맺은 뒤의 4401은 '예매 시간이 끝났습니다'(token-expired)다
    again.drop(4401);
    await s.t.flush();
    expect(s.lastConnection()).toMatchObject({ state: 'ended', reason: 'token-expired' });
    await s.t.advance(60_000);
    expect(s.sockets).toHaveLength(2);
  });
});
