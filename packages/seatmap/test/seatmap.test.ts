// @peaket/seatmap 시험(docs/frontend.md §3.5·§5.2·§1.5, docs/design/tokens.json seat·pattern, BUILD_ORDER HOT-110)
import { describe, expect, it, vi } from 'vitest';
import { pattern, seatColor } from '@peaket/ds/tokens';
import {
  LayoutError,
  WireError,
  applyDelta,
  applySnapshot,
  buildGrids,
  canUseWorker,
  createSeatMap,
  decodeFrame,
  decodeLayout,
  decodeSnapshot,
  drawSeat,
  encodeSubscribe,
  encodeTimeSync,
  hitTest,
  seatIdOf,
  seatState,
  seatStyle,
  sectionOf,
  STATE,
  FromWorker,
} from '../src/index';
import { createHandler } from '../src/worker';
import { encodeDelta, encodeSnapshot, fakeCtx, makeLayout } from './fixtures';

describe('열 단위 좌석맵 파일', () => {
  it('구역 순서대로 이어 붙인 좌석 색인으로 형식 배열에 풀고, 좌석 ID는 홀드 요청 때만 찾는다', () => {
    const L = decodeLayout(makeLayout());
    expect(L.N).toBe(800);
    expect(L.S).toBe(4);
    expect([L.sectionStart[2], L.sectionEnd[2]]).toEqual([400, 599]);
    expect(sectionOf(L, 401)).toEqual({ section: 2, offset: 1 });
    expect(seatIdOf(L, 401)).toBe('S2-R0-1');
    expect(L.attr[0]! >> 4).toBe(1); // 휠체어
    expect(L.attr[0]! & 15).toBe(0); // VIP
  });

  it('색인 규칙(빈틈 없는 범위·열 길이·등급·좌석 수·구역당 65,536석)이 틀리면 풀지 않는다', () => {
    const bad = (f: (x: ReturnType<typeof makeLayout>) => void) => {
      const x = makeLayout();
      f(x);
      return () => decodeLayout(x);
    };
    expect(bad((x) => ((x as { format: string }).format = 'peaket.seatmap.columns.v0-poc'))).toThrow(LayoutError);
    expect(bad((x) => (x.sections[1]!.seatIndexRange.from += 1))).toThrow(/seatIndexRange/);
    expect(bad((x) => x.sections[0]!.seats.x.pop())).toThrow(/열 길이/);
    expect(bad((x) => (x.sections[0]!.seats.tier[3] = 9))).toThrow(/등급/);
    expect(bad((x) => (x.seatCount = 801))).toThrow(/seatCount/);
    const big = makeLayout({ sections: 1, rows: 257, perRow: 256, jitter: false });
    expect(() => decodeLayout(big)).toThrow(/65536 이하/);
  });
});

describe('누른 좌석 찾기', () => {
  it('격자 색인으로 찾은 좌석이 모든 좌석을 다 훑어 찾은 것과 같다(구역 경계 포함, 무작위 점 5,000개)', () => {
    const L = decodeLayout(makeLayout({ sections: 6, rows: 12, perRow: 30, gap: 20 }));
    const grids = buildGrids(L);
    const brute = (wx: number, wy: number) => {
      let best = -1;
      let bestD = 30 * 30;
      for (let k = 0; k < L.N; k++) {
        const d = (L.x[k]! - wx) ** 2 + (L.y[k]! - wy) ** 2;
        if (d < bestD) {
          bestD = d;
          best = k;
        }
      }
      return best;
    };
    let seed = 1;
    const rnd = () => ((seed = (seed * 48271) % 2147483647) / 2147483647);
    let hits = 0;
    for (let i = 0; i < 5000; i++) {
      const wx = rnd() * L.file.canvas.width;
      const wy = 250 + rnd() * 800;
      const got = hitTest(L, grids, wx, wy);
      expect(got).toBe(brute(wx, wy));
      if (got >= 0) hits++;
    }
    expect(hits).toBeGreaterThan(500);
  });
});

describe('좌석 상태 두 층(스냅샷·델타)', () => {
  const L = decodeLayout(makeLayout());
  const range = (s: number): [number, number] => [L.sectionStart[s]!, L.sectionEnd[s]!];

  it('스냅샷의 점유(1)는 선택 불가로 쓰고, 한 구역 스냅샷은 그 구역에만 쓴다', () => {
    const state = new Uint8Array(L.N);
    const occupied = Array.from({ length: L.N }, (_, i) => i % 3 === 0);
    const snap = decodeSnapshot(encodeSnapshot({ layoutVersion: 3, seatEpoch: 5, sections: [[0, 1], [1, 2], [2, 3], [3, 4]], occupied }));
    expect(snap).toMatchObject({ layoutVersion: 3, seatEpoch: 5, flags: 0 });
    expect(snap.sections[3]).toEqual({ sectionIndex: 3, sectionVersion: 4 });
    applySnapshot(state, snap, range);
    expect([state[0], state[1], state[3]]).toEqual([STATE.UNAVAILABLE, STATE.AVAILABLE, STATE.UNAVAILABLE]);
    const one = decodeSnapshot(encodeSnapshot({ flags: 1, layoutVersion: 3, seatEpoch: 5, sections: [[2, 9]], occupied: Array(200).fill(true) }));
    const s2 = new Uint8Array(L.N);
    applySnapshot(s2, one, range);
    expect([s2[399], s2[400], s2[599], s2[600]]).toEqual([0, 3, 3, 0]);
    expect(() => decodeSnapshot(new Uint8Array([2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).toThrow(WireError);
  });

  it('델타는 같은 세대에서 구역 판이 +1이면 반영하고, 같거나 작으면 버리며, 건너뛰면 그 구역만 스냅샷으로 다시 맞춘다', () => {
    const state = new Uint8Array(L.N);
    const versions = { seatEpoch: 5, version: new Uint32Array([1, 2, 3, 4]) };
    const f = decodeFrame(encodeDelta({ seatEpoch: 5, sections: [{ index: 0, version: 2, changes: [[0, 1], [199, 2]] }, { index: 1, version: 2, changes: [[0, 2]] }, { index: 2, version: 5, changes: [[0, 1]] }] }));
    if (f.type !== 'delta') throw new Error('델타가 아니다');
    expect(f.maxWaitMs).toBe(100);
    const d = applyDelta(state, versions, f, L.sectionStart, L.sectionEnd);
    expect(d).toEqual({ kind: 'apply', sections: [0], resync: [2], dropped: [1] });
    expect([state[0], state[199], state[200], state[400]]).toEqual([1, 2, 0, 0]);
    expect(versions.version[0]).toBe(2);
  });

  it('세대가 커지면 모두 다시 맞추고, 옛 세대 묶음은 버리며, 상태 3 이상·구역 밖 거리는 받지 않는다', () => {
    const versions = { seatEpoch: 5, version: new Uint32Array(4) };
    const frame = (o: Parameters<typeof encodeDelta>[0]) => decodeFrame(encodeDelta(o)) as Extract<ReturnType<typeof decodeFrame>, { type: 'delta' }>;
    expect(applyDelta(new Uint8Array(L.N), versions, frame({ seatEpoch: 6, sections: [] }), L.sectionStart, L.sectionEnd)).toEqual({ kind: 'resync-all' });
    expect(applyDelta(new Uint8Array(L.N), versions, frame({ seatEpoch: 4, sections: [{ index: 0, version: 1, changes: [[0, 1]] }] }), L.sectionStart, L.sectionEnd)).toEqual({ kind: 'apply', sections: [], resync: [], dropped: [0] });
    expect(() => decodeFrame(encodeDelta({ seatEpoch: 5, sections: [{ index: 0, version: 1, changes: [[0, 3]] }] }))).toThrow(/0·1·2/);
    expect(() => applyDelta(new Uint8Array(L.N), versions, frame({ seatEpoch: 5, sections: [{ index: 0, version: 1, changes: [[200, 1]] }] }), L.sectionStart, L.sectionEnd)).toThrow(/구역 0 밖/);
  });

  it('하트비트·묶음 간격 프레임을 읽고, 구독(4 + 2n 바이트)·시계 맞추기(10바이트)를 만든다', () => {
    const hb = new Uint8Array(18);
    const v = new DataView(hb.buffer);
    v.setUint8(0, 1);
    v.setUint8(1, 2);
    v.setBigUint64(2, 1234n, true);
    v.setBigUint64(10, 99n, true);
    expect(decodeFrame(hb)).toEqual({ type: 'heartbeat', serverTimeMs: 1234, echoClientTimeMs: 99 });
    expect(decodeFrame(new Uint8Array([1, 3, 232, 3]))).toEqual({ type: 'batchInterval', intervalMs: 1000 });
    expect([...encodeSubscribe([2, 300])]).toEqual([1, 16, 2, 0, 2, 0, 44, 1]);
    const ts = encodeTimeSync(1_700_000_000_123);
    expect(ts.byteLength).toBe(10);
    expect(new DataView(ts.buffer).getBigUint64(2, true)).toBe(1_700_000_000_123n);
    expect(() => decodeFrame(new Uint8Array([1, 9]))).toThrow(/모르는 프레임/);
  });
});

describe('색 + 무늬(색만으로 가르지 않는다)', () => {
  it('Worker 상태·플래그·내 선택을 토큰 상태로 바꾸고, 색은 라이트·다크 토큰, 무늬는 pattern.seat를 쓴다', () => {
    expect(seatState(STATE.AVAILABLE, 0, false)).toBe('available');
    expect(seatState(STATE.AVAILABLE, 1 << 4, false)).toBe('wheelchair');
    expect(seatState(STATE.AVAILABLE, 2 << 4, false)).toBe('unavailable');
    expect(seatState(STATE.HELD, 0, false)).toBe('held-by-others');
    expect(seatState(STATE.SOLD, 0, false)).toBe('sold');
    expect(seatState(STATE.UNAVAILABLE, 0, false)).toBe('sold');
    expect(seatState(STATE.AVAILABLE, 0, true)).toBe('mine');
    expect(seatState(STATE.AVAILABLE, 0, false, true)).toBe('recently-released');
    for (const mode of ['light', 'dark'] as const) {
      for (const s of ['available', 'held-by-others', 'mine', 'sold', 'unavailable', 'wheelchair'] as const) {
        expect(seatStyle(s, mode)).toMatchObject({ state: s, color: seatColor[mode][s], pattern: pattern.seat[s] });
      }
      expect(seatStyle('recently-released', mode).color).toBe(seatColor[mode].available);
    }
  });

  it('무늬가 solid가 아닌 상태는 칠한 뒤 글리프 색으로 무늬를 더 그리고, 6px보다 작으면 칠하기만 한다', () => {
    for (const s of ['held-by-others', 'mine', 'sold', 'unavailable', 'wheelchair'] as const) {
      const ctx = fakeCtx();
      drawSeat(ctx, seatStyle(s, 'light'), 50, 50, 24);
      expect(ctx.calls[0]).toEqual(['fillRect', seatColor.light[s], 38, 38, 24, 24]);
      expect(ctx.calls.some(([n]) => n === 'stroke' || n === 'fill')).toBe(true);
      const tiny = fakeCtx();
      drawSeat(tiny, seatStyle(s, 'light'), 50, 50, 4);
      expect(tiny.calls).toHaveLength(1);
    }
    const plain = fakeCtx();
    drawSeat(plain, seatStyle('available', 'dark'), 10, 10, 24);
    expect(plain.calls).toEqual([['fillRect', seatColor.dark.available, -2, -2, 24, 24]]);
    const outline = fakeCtx();
    drawSeat(outline, seatStyle('recently-released', 'light'), 10, 10, 24);
    expect(outline.calls[0]?.[0]).toBe('strokeRect');
  });
});

/** 가짜 Worker 호스트 */
function fakeHost(files: { layout: unknown; snapshot?: Uint8Array }) {
  const posted: unknown[] = [];
  const host = {
    post: (m: unknown) => void posted.push(FromWorker.parse(m)),
    fetch: vi.fn(async (url: string) =>
      url.endsWith('.json') ? new Response(JSON.stringify(files.layout)) : files.snapshot ? new Response(files.snapshot.buffer as ArrayBuffer) : new Response(null, { status: 404 }),
    ),
    nextFrame: async () => {},
    now: () => 1000,
  };
  return { host, posted };
}

describe('Worker 처리기(메인 스레드 대체와 같은 코드)', () => {
  const layout = makeLayout();
  const occupied = Array.from({ length: 800 }, (_, i) => i < 400);
  const snapshot = encodeSnapshot({ layoutVersion: 3, seatEpoch: 1, sections: [[0, 1], [1, 1], [2, 1], [3, 1]], occupied });
  const init = { type: 'init', canvas: {}, layoutUrl: '/seatmap-layouts/3.json', snapshotUrl: '/snap', admission: { token: 'adm' }, width: 400, height: 300, dpr: 2, theme: 'light' };

  it('init에서 좌석맵 파일과 스냅샷을 받아 전체 배치도를 그리고 ready를 보낸다', async () => {
    const { host, posted } = fakeHost({ layout, snapshot });
    const ctx = fakeCtx();
    const handle = createHandler(host, () => ctx);
    await handle(init);
    expect(posted).toEqual([{ type: 'ready', firstPaintAt: 1000, drawnAt: 1000, layoutVersion: 3, seatCount: 800, sectionCount: 4 }, expect.objectContaining({ type: 'view', level: 'overview', zoom: 1, selectable: false })]);
    // 구역마다 '이름 등급'과 남은 상태 글자(색만으로 가르지 않는다)
    const texts = ctx.calls.filter(([n]) => n === 'fillText').map((c) => c[1]);
    // 스냅샷에서 앞 400석(0·1구역)이 점유라 매진
    expect(texts).toEqual(['1구역 VIP', '매진', '2구역 R', '매진', '3구역 S', '많음', '4구역 VIP', '많음']);
  });

  it('누르면 좌석 ID를, 고르면 내 선택 목록을 보내고, 틀린 메시지·판이 다른 스냅샷은 error로 알린다', async () => {
    const { host, posted } = fakeHost({ layout, snapshot });
    const handle = createHandler(host, () => fakeCtx());
    await handle(init);
    await handle({ type: 'camera', zoom: 20, x: layout.sections[2]!.seats.x[0]!, y: layout.sections[2]!.seats.y[0]! });
    await handle({ type: 'pointer', kind: 'up', x: 200, y: 150 });
    expect(posted.at(-1)).toEqual({ type: 'hit', seatIndex: 400, seatId: 'S2-R0-0', label: '3구역 1열 1번', tier: 'S', selectable: true });
    await handle({ type: 'select', seatIndex: 400 });
    expect(posted.at(-1)).toEqual({ type: 'selection', seatIndexes: [400] });
    await handle({ type: 'camera', zoom: -1, x: 0, y: 0 });
    expect(posted.at(-1)).toMatchObject({ type: 'error' });
    const other = fakeHost({ layout, snapshot: encodeSnapshot({ layoutVersion: 9, seatEpoch: 1, sections: [], occupied: Array(800).fill(false) }) });
    await createHandler(other.host, () => fakeCtx())(init);
    expect(other.posted).toEqual([{ type: 'error', message: expect.stringMatching(/layoutVersion 9/) }]);
  });
});

describe('OffscreenCanvas가 없는 브라우저', () => {
  it('FE-T15 OffscreenCanvas·transferControlToOffscreen이 없으면 같은 그리기 모듈을 메인 스레드에서 돌린다', async () => {
    expect(canUseWorker({ Worker: function () {}, OffscreenCanvas: function () {} }, { transferControlToOffscreen: () => {} })).toBe(true);
    expect(canUseWorker({ Worker: function () {} }, { transferControlToOffscreen: () => {} })).toBe(false);
    expect(canUseWorker({ Worker: function () {}, OffscreenCanvas: function () {} }, {})).toBe(false);
    const ctx = fakeCtx();
    const canvas = { clientWidth: 400, clientHeight: 300, width: 0, height: 0, getContext: () => ctx } as unknown as HTMLCanvasElement;
    const got: unknown[] = [];
    vi.stubGlobal('fetch', async (u: string) => (u.endsWith('.json') ? new Response(JSON.stringify(makeLayout())) : new Response(null, { status: 404 })));
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => setTimeout(cb, 0));
    try {
      const createWorker = vi.fn();
      const c = createSeatMap({ canvas, layoutUrl: '/seatmap-layouts/3.json', theme: 'dark', onMessage: (m) => got.push(m), createWorker, env: {} });
      expect(c.mode).toBe('main-thread');
      await vi.waitFor(() => expect(got.length).toBeGreaterThanOrEqual(1));
      expect(got[0]).toMatchObject({ type: 'ready', seatCount: 800 });
      expect(createWorker).not.toHaveBeenCalled();
      expect(ctx.calls.length).toBeGreaterThan(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
