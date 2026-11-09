// 좌석맵 마우스 올림 표시와 낮은 배율의 좌석 클릭(ADR-0236, CMP-021, SCR-010). 소유자가 브라우저에서 짚은 것을 재현한다(2026-11-09).
import { color } from '@peaket/ds/tokens';
import { describe, expect, it, vi } from 'vitest';
import { HOVER_GAP_PX, HOVER_RING_PX, HOVER_SCALE, SEAT_CM, SeatMapEngine, SELECT_ZOOM_PX } from '../src/engine';
import { decodeLayout } from '../src/layout';
import { overviewPalette } from '../src/overview';
import { seatStyle } from '../src/paint';
import { FromWorker } from '../src/protocol';
import { createHandler } from '../src/worker';
import { encodeSnapshot, fakeCtx, makeLayout } from './fixtures';

type Posted = { type: string } & Record<string, unknown>;
type View = { zoom: number; maxZoom: number; selectable: boolean; level: string; camera: { scale: number; tx: number; ty: number } };

const RING = { light: color.light['focus-ring'], dark: color.dark['focus-ring'] };
const SOLD = 1;
const L = decodeLayout(makeLayout());

async function setup(theme: 'light' | 'dark' = 'light') {
  const posted: Posted[] = [];
  const ctx = fakeCtx();
  const clock = { now: 1000 };
  const occupied = Array(800).fill(false) as boolean[];
  occupied[SOLD] = true;
  const host = {
    post: (m: unknown) => void posted.push(FromWorker.parse(m) as Posted),
    fetch: vi.fn(async (url: string) =>
      url.includes('snap')
        ? new Response(encodeSnapshot({ layoutVersion: makeLayout().layoutVersion, seatEpoch: 1, sections: [[0, 1], [1, 1], [2, 1], [3, 1]], occupied }).buffer as ArrayBuffer)
        : new Response(JSON.stringify(makeLayout())),
    ),
    nextFrame: async () => {},
    now: () => clock.now,
  };
  const handle = createHandler(host, () => ctx as never);
  await handle({ type: 'init', canvas: {}, layoutUrl: 'http://w/1.json', snapshotUrl: 'http://a/snap', admission: { token: 'adm' }, width: 600, height: 400, dpr: 1, theme });
  const view = () => posted.filter((m) => m.type === 'view').at(-1) as unknown as View;
  /** 좌석 k를 가운데에 두고 좌석 한 변이 px가 되는 배율로 맞춘다 */
  const zoomTo = async (px: number, k = 0) => {
    const v = view();
    await handle({ type: 'camera', zoom: (v.maxZoom * px) / 64, x: L.x[k]!, y: L.y[k]! });
  };
  /** 좌석 k의 화면 위치 */
  const at = (k: number) => {
    const c = view().camera;
    return { x: c.tx + L.x[k]! * c.scale, y: c.ty + L.y[k]! * c.scale };
  };
  const move = (k: number) => handle({ type: 'pointer', kind: 'move', ...at(k) });
  const rings = () => ctx.calls.filter(([n, c]) => n === 'strokeRect' && c === RING[theme]);
  const hovers = () => posted.filter((m) => m.type === 'hover');
  return { handle, posted, ctx, clock, view, zoomTo, at, move, rings, hovers };
}

describe('좌석맵 마우스 올림(ADR-0236)', () => {
  it('고를 수 있는 좌석에 올리면 그 좌석을 키워 그리고 초점 고리 색 테두리를 두르며, 화면에 고를 수 있다고 알린다', async () => {
    const { ctx, view, zoomTo, at, move, rings, hovers } = await setup();
    await zoomTo(32);
    ctx.calls.length = 0;
    await move(0);
    expect(hovers().at(-1)).toMatchObject({ selectable: true });
    // view의 배율은 소수 셋째 자리로 반올림돼 좌석 크기는 카메라에서 얻는다
    const size = view().camera.scale * SEAT_CM * 0.8 * HOVER_SCALE;
    const { x, y } = at(0);
    const seat = seatStyle('wheelchair', 'light'); // fixtures의 구역 첫 좌석은 휠체어석이다
    const big = ctx.calls.filter(([n, c]) => n === 'fillRect' && c === seat.color).at(-1)!;
    expect(big.slice(2)).toEqual([expect.closeTo(x - size / 2, 5), expect.closeTo(y - size / 2, 5), expect.closeTo(size, 5), expect.closeTo(size, 5)]);
    expect(rings()).toHaveLength(1);
    const outer = size + 2 * HOVER_GAP_PX + HOVER_RING_PX;
    expect(rings()[0]!.slice(2)).toEqual([expect.closeTo(x - outer / 2, 5), expect.closeTo(y - outer / 2, 5), expect.closeTo(outer, 5), expect.closeTo(outer, 5)]);
  });

  it('다크에서 고른 좌석은 테두리와 색이 같아도, 좌석과 테두리 사이의 바탕색 틈으로 구분된다', async () => {
    const { handle, ctx, zoomTo, move, rings } = await setup('dark');
    await zoomTo(32);
    await handle({ type: 'select', seatIndex: 2 });
    ctx.calls.length = 0;
    await move(2);
    expect(seatStyle('mine', 'dark').color.toLowerCase()).toBe(RING.dark.toLowerCase());
    expect(rings()).toHaveLength(1);
    const ring = rings()[0]!;
    const i = ctx.calls.indexOf(ring);
    const gap = ctx.calls[i - 1]!;
    expect(gap[0]).toBe('strokeRect');
    expect(gap[1]).toBe(overviewPalette('dark').bg);
    expect(gap[4] as number).toBeLessThan(ring[4] as number);
  });

  it('판매된 좌석에는 아무 표시도 하지 않는다', async () => {
    const { ctx, zoomTo, move, rings, hovers } = await setup();
    await zoomTo(32);
    ctx.calls.length = 0;
    await move(SOLD);
    expect(rings()).toHaveLength(0);
    expect(hovers().some((m) => m.selectable === true)).toBe(false);
  });

  it('마우스가 떠나면 표시를 지우고, 같은 좌석 위에서 움직일 때는 다시 그리지 않는다', async () => {
    const { handle, ctx, zoomTo, at, move, rings, hovers } = await setup();
    await zoomTo(32);
    await move(0);
    ctx.calls.length = 0;
    const { x, y } = at(0);
    await handle({ type: 'pointer', kind: 'move', x: x + 1, y: y + 1 });
    expect(ctx.calls).toHaveLength(0);
    await handle({ type: 'pointer', kind: 'leave', x: 0, y: 0 });
    expect(rings()).toHaveLength(0);
    expect(ctx.calls.length).toBeGreaterThan(0);
    expect(hovers().at(-1)).toMatchObject({ selectable: false });
  });

  it('고른 좌석에 올려도 표시한다(다시 눌러 풀 수 있다)', async () => {
    const { handle, ctx, zoomTo, move, rings } = await setup();
    await zoomTo(32);
    await handle({ type: 'select', seatIndex: 2 });
    ctx.calls.length = 0;
    await move(2);
    expect(rings()).toHaveLength(1);
    expect(ctx.calls.some(([n, c]) => n === 'fillRect' && c === seatStyle('mine', 'light').color)).toBe(true);
  });

  it('지도를 옮기면 마우스 아래의 좌석으로 표시가 바뀐다', async () => {
    const { handle, ctx, view, zoomTo, at, move, rings } = await setup();
    await zoomTo(32, 5);
    await move(5);
    const before = at(5);
    ctx.calls.length = 0;
    // 한 칸 왼쪽으로 옮기면 같은 화면 점에 다음 좌석이 온다
    const scale = view().camera.scale;
    await handle({ type: 'pan', dx: -(L.x[6]! - L.x[5]!) * scale, dy: 0 });
    expect(rings()).toHaveLength(1);
    expect(rings()[0]![2] as number).toBeCloseTo(before.x - (scale * SEAT_CM * 0.8 * HOVER_SCALE + 2 * HOVER_GAP_PX + HOVER_RING_PX) / 2, 3);
  });

  it('고를 수 없는 배율에서는 표시하지 않는다', async () => {
    const { ctx, zoomTo, move, rings, hovers } = await setup();
    await zoomTo(10);
    ctx.calls.length = 0;
    await move(0);
    expect(rings()).toHaveLength(0);
    expect(hovers().some((m) => m.selectable === true)).toBe(false);
  });
});

describe('낮은 배율의 좌석 클릭(ADR-0236)', () => {
  it('좌석이 보이지만 고를 수 없는 배율에서 좌석을 누르면 그 자리를 고를 수 있는 배율로 확대하고, 고르지는 않는다', async () => {
    const { handle, posted, view, zoomTo, at } = await setup();
    await zoomTo(10);
    expect(view()).toMatchObject({ level: 'seats', selectable: false });
    const p = at(3);
    await handle({ type: 'pointer', kind: 'up', ...p });
    expect(view().selectable).toBe(true);
    expect(view().camera.scale * SEAT_CM * 0.8).toBeCloseTo(SELECT_ZOOM_PX, 3);
    expect(at(3).x).toBeCloseTo(p.x, 3);
    expect(at(3).y).toBeCloseTo(p.y, 3);
    expect(posted.filter((m) => m.type === 'hit').at(-1)).toMatchObject({ seatIndex: -1 });
    expect(posted.some((m) => m.type === 'selection')).toBe(false);
  });

  it('확대 직후의 클릭(더블클릭의 두 번째)은 고르지 않고, 시간이 지나면 고른다', async () => {
    const { handle, posted, clock, zoomTo, at } = await setup();
    await zoomTo(10);
    const p = at(3);
    await handle({ type: 'pointer', kind: 'up', ...p });
    clock.now += 150;
    await handle({ type: 'pointer', kind: 'up', ...at(3) });
    expect(posted.filter((m) => m.type === 'hit').at(-1)).toMatchObject({ seatIndex: -1 });
    clock.now += 400;
    await handle({ type: 'pointer', kind: 'up', ...at(3) });
    expect(posted.filter((m) => m.type === 'hit').at(-1)).toMatchObject({ seatIndex: 3, selectable: true });
  });

  it('좌석이 그려지지 않을 만큼 작으면(2px 미만) 눌러도 확대하지 않는다', () => {
    const file = makeLayout({ rows: 4, perRow: 200 });
    const big = decodeLayout(file);
    const e = new SeatMapEngine({ ctx: fakeCtx() as never, width: 600, height: 400, dpr: 1, theme: 'light' });
    e.load(file, encodeSnapshot({ layoutVersion: file.layoutVersion, seatEpoch: 1, sections: [[0, 1], [1, 1], [2, 1], [3, 1]], occupied: Array(big.N).fill(false) as boolean[] }));
    const place = (seatPx: number) => {
      const scale = seatPx / (SEAT_CM * 0.8);
      e.cam = { scale, tx: 300 - big.x[0]! * scale, ty: 150 - big.y[0]! * scale };
    };
    place(1.5);
    expect(e.level()).toBe('seats');
    expect(e.zoomToSeat(300, 150)).toBe(false);
    place(3);
    expect(e.zoomToSeat(300, 150)).toBe(true);
  });

  it('좌석에서 먼 빈 곳을 누르면 확대하지 않는다', async () => {
    const { handle, view, zoomTo, at } = await setup();
    await zoomTo(10);
    const scale = view().camera.scale;
    const p = at(0);
    await handle({ type: 'pointer', kind: 'up', x: p.x - 300, y: p.y - 300 });
    expect(view().camera.scale).toBe(scale);
  });
});

describe('방금 놓은 좌석(docs/frontend.md §4.2.2 6행, BUILD_ORDER HOT-356)', () => {
  const engineOf = () => {
    const e = new SeatMapEngine({ ctx: fakeCtx() as never, width: 600, height: 400, dpr: 1, theme: 'light' });
    const file = makeLayout();
    e.load(file, encodeSnapshot({ layoutVersion: file.layoutVersion, seatEpoch: 1, sections: [[0, 1], [1, 1], [2, 1], [3, 1]], occupied: Array(decodeLayout(file).N).fill(false) as boolean[] }));
    return e;
  };
  it('좌석 ID로 표시하면 시간이 지나기 전에는 고를 수 없고, 지나면 다시 고를 수 있다', () => {
    const e = engineOf();
    const k = 5;
    const id = e.L.seatIds[0]![k]!;
    expect(e.canSelect(k)).toBe(true);
    e.markReleased(id, Date.now() + 30_000);
    expect(e.isRecentlyReleased(k, Date.now())).toBe(true);
    expect(e.canSelect(k)).toBe(false);
    expect(e.pruneReleased(Date.now() + 31_000)).toBeUndefined();
    expect(e.canSelect(k)).toBe(true);
  });
  it('setMine은 좌석 ID로 내 좌석 표시를 켜고 끄며, 내 좌석은 놓은 좌석이어도 고른 상태로 둔다', () => {
    const e = engineOf();
    const id = e.L.seatIds[0]![3]!;
    e.setMine(id, true);
    expect(e.isMine(3)).toBe(true);
    e.setMine(id, true);
    expect(e.isMine(3)).toBe(true);
    e.setMine(id, false);
    expect(e.isMine(3)).toBe(false);
  });
});
