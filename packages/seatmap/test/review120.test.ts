// HOT-120 새 맥락 리뷰 재현 시험. 고치기 전에 실패하는 것을 확인했다.
import { describe, expect, it, vi } from 'vitest';
import { color } from '@peaket/ds/tokens';
import { FromWorker, MINIMAP, SeatMapEngine, decodeFrame, cameraFit } from '../src/index';
import { createHandler } from '../src/worker';
import { encodeDelta, encodeSnapshot, fakeCtx, makeLayout } from './fixtures';

const snapAll = () => encodeSnapshot({ layoutVersion: 3, seatEpoch: 1, sections: [[0, 1], [1, 1], [2, 1], [3, 1]], occupied: Array(800).fill(false) });

function engine(width = 400, height = 300, bitmaps?: { create: (w: number, h: number) => { ctx: ReturnType<typeof fakeCtx>; finish: () => { image: unknown } } }) {
  const ctx = fakeCtx();
  const e = new SeatMapEngine({ ctx, width, height, dpr: 1, theme: 'light', bitmaps });
  const layout = makeLayout();
  e.load(layout, snapAll());
  return { e, ctx, layout };
}

function host(layout: unknown) {
  const posted: Array<{ type: string } & Record<string, unknown>> = [];
  return {
    posted,
    host: {
      post: (m: unknown) => void posted.push(FromWorker.parse(m) as never),
      fetch: vi.fn(async (u: string) => (u.endsWith('.json') ? new Response(JSON.stringify(layout)) : new Response(snapAll().buffer as ArrayBuffer))),
      nextFrame: async () => {},
      now: () => 1,
    },
  };
}

describe('HOT-120 새 맥락 리뷰 재현', () => {
  it('좌석 단계에서는 구역 면을 칠하지 않고(좌석과 바탕 surface의 대비를 지킨다) 구역 글자를 좌석 밑에 쓰지 않는다', () => {
    const { e, ctx } = engine();
    e.focusSection(2);
    expect(e.level()).toBe('seats');
    ctx.calls.length = 0;
    e.draw();
    const heat: string[] = [color.light['heat-1'], color.light['heat-2'], color.light['heat-3']];
    expect(ctx.calls.filter(([n, c]) => n === 'fill' && heat.includes(c as string))).toEqual([]);
    expect(ctx.calls.filter(([n]) => n === 'fillText')).toEqual([]);
  });

  it('전체 배치에서 구역을 눌러 확대한 같은 동작에서는 좌석을 누른 것으로 보내지 않는다(확대 뒤 바로 고를 수 있는 큰 캔버스에서도)', async () => {
    const layout = makeLayout();
    const { host: h, posted } = host(layout);
    const handle = createHandler(h, () => fakeCtx());
    await handle({ type: 'init', canvas: {}, layoutUrl: '/l.json', snapshotUrl: '/s', admission: { token: 't' }, width: 1600, height: 1200, dpr: 1, theme: 'light' });
    const fit = cameraFit(1600, 1200, layout.canvas.minX, layout.canvas.minY, layout.canvas.width, layout.canvas.height);
    const p = layout.sections[2]!.shape.points;
    const wx = (p[0]![0] + p[1]![0]) / 2;
    const wy = (p[0]![1] + p[2]![1]) / 2;
    await handle({ type: 'pointer', kind: 'up', x: wx * fit.scale + fit.tx, y: wy * fit.scale + fit.ty });
    expect(posted.filter((m) => m.type === 'view').at(-1)).toMatchObject({ level: 'seats', selectable: true });
    expect(posted.at(-1)).toMatchObject({ type: 'hit', seatIndex: -1 });
  });

  it('끝까지 축소하면 전체가 맞는 카메라(가운데)로 돌아오고, 확대한 동안에도 배치가 화면 밖으로 밀려나지 않는다', () => {
    const { e, layout } = engine();
    e.focusSection(0);
    for (let i = 0; i < 20; i++) e.zoomBy(1 / 1.5);
    const fit = cameraFit(400, 300, layout.canvas.minX, layout.canvas.minY, layout.canvas.width, layout.canvas.height);
    expect(e.cam.scale).toBeCloseTo(fit.scale);
    expect(e.cam.tx).toBeCloseTo(fit.tx);
    expect(e.cam.ty).toBeCloseTo(fit.ty);
    e.focusSection(3);
    e.zoomBy(1.5, 0, 0);
    const v = e.viewRect();
    expect(v.x).toBeGreaterThanOrEqual(layout.canvas.minX - 1e-6);
    expect(v.x + v.w).toBeLessThanOrEqual(layout.canvas.minX + layout.canvas.width + 1e-6);
  });

  it('미니맵을 누르면 그 밑의 좌석을 고르지 않는다', () => {
    const { e } = engine();
    e.focusSection(3);
    while (!e.selectable()) e.zoomBy(1.5);
    const x = 400 - MINIMAP.margin - MINIMAP.width / 2;
    const y = 300 - MINIMAP.margin - 5;
    expect(e.hit(x, y).seatIndex).toBe(-1);
  });

  it('델타를 엔진에 반영하면 바뀐 구역의 비트맵만 버린다(다시 그릴 때 그 구역만 새로 만든다)', () => {
    const made: number[] = [];
    const { e } = engine(400, 300, { create: (w, h) => (made.push(w * h), { ctx: fakeCtx(), finish: () => ({ image: {} }) }) });
    e.focusSection(1);
    e.draw();
    const before = made.length;
    expect(before).toBeGreaterThan(0);
    const f = decodeFrame(encodeDelta({ seatEpoch: 1, sections: [{ index: 1, version: 2, changes: [[0, 2]] }] }));
    if (f.type !== 'delta') throw new Error('델타가 아니다');
    expect(e.applyDelta(f)).toEqual({ kind: 'apply', sections: [1], resync: [], dropped: [] });
    e.draw();
    expect(made.length).toBe(before + 1);
  });

  it('스냅샷 전(loading)에는 외곽선만 그리고 글자도 쓰지 않는다', () => {
    const ctx = fakeCtx();
    const e = new SeatMapEngine({ ctx, width: 400, height: 300, dpr: 1, theme: 'light' });
    e.load(makeLayout());
    ctx.calls.length = 0;
    e.draw();
    expect(ctx.calls.filter(([n]) => n === 'fillText')).toEqual([]);
  });

  it('등급 차례를 화면이 넘기면(회차 가격표) 그 차례로 면 색을 고른다', () => {
    const ctx = fakeCtx();
    const e = new SeatMapEngine({ ctx, width: 400, height: 300, dpr: 1, theme: 'light', tierRank: ['S', 'R', 'VIP'] });
    e.load(makeLayout(), snapAll());
    ctx.calls.length = 0;
    e.draw();
    // 0구역 VIP는 셋째(heat.1), 2구역 S는 첫째(heat.3)
    const fills = ctx.calls.filter(([n]) => n === 'fill').map(([, c]) => c);
    expect(fills.slice(1, 4)).toEqual([color.light['heat-1'], color.light['heat-2'], color.light['heat-3']]);
  });

  it('zoomBy의 화면 점은 화면 크기 안으로 받는다(무한대 카메라를 막는다)', async () => {
    const { host: h, posted } = host(makeLayout());
    const handle = createHandler(h, () => fakeCtx());
    await handle({ type: 'init', canvas: {}, layoutUrl: '/l.json', snapshotUrl: '/s', admission: { token: 't' }, width: 400, height: 300, dpr: 1, theme: 'light' });
    await handle({ type: 'zoomBy', factor: 2, x: 1e308, y: 0 });
    expect(posted.at(-1)).toMatchObject({ type: 'error' });
  });
});
