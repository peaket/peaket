// 두 단계 그리기·미니맵·[전체 보기]·구역 비트맵 캐시 시험(CMP-021, docs/design/d5 좌석맵 상태 표, docs/frontend.md §5.2, BUILD_ORDER HOT-120)
import { describe, expect, it, vi } from 'vitest';
import { color } from '@peaket/ds/tokens';
import { BitmapCache, FromWorker, MAX_SEAT_PX, MIN_SELECT_PX, SeatMapEngine, scaleBucket, sectionStatus, decodeLayout, STATE } from '../src/index';
import { createHandler } from '../src/worker';
import { encodeSnapshot, fakeCtx, makeLayout } from './fixtures';

const W = 400;
const H = 300;

function engineWith(o: { snapshot?: boolean; tiers?: number; bitmaps?: boolean } = {}) {
  const layout = makeLayout();
  if (o.tiers === 4) {
    layout.tiers = ['VIP', 'R', 'S', 'A'];
    layout.sections.forEach((sec, s) => (sec.seats.tier = sec.seats.tier.map(() => s % 4)));
  }
  const ctx = fakeCtx();
  const created: Array<{ w: number; h: number }> = [];
  const bitmaps = o.bitmaps
    ? {
        create: (w: number, h: number) => {
          created.push({ w, h });
          return { ctx: fakeCtx(), finish: () => ({ image: { w, h } }) };
        },
      }
    : undefined;
  const e = new SeatMapEngine({ ctx, width: W, height: H, dpr: 1, theme: 'light', bitmaps });
  const snap = encodeSnapshot({ layoutVersion: 3, seatEpoch: 1, sections: [[0, 1], [1, 1], [2, 1], [3, 1]], occupied: Array(800).fill(false) });
  e.load(layout, o.snapshot === false ? undefined : snap);
  return { e, ctx, created, layout };
}

describe('두 단계(전체 배치 → 좌석)', () => {
  it('처음은 전체 배치(overview)이고, 구역이 화면 폭의 1/3 이상이 되면 좌석 단계, 축소하면 다시 전체 배치로 합쳐진다', () => {
    const { e } = engineWith();
    expect(e.level()).toBe('overview');
    e.focusSection(2);
    expect(e.level()).toBe('seats');
    for (let i = 0; i < 10 && e.level() === 'seats'; i++) e.zoomBy(1 / 1.5);
    expect(e.level()).toBe('overview');
    e.focusSection(1);
    e.fitAll();
    expect(e.zoom()).toBeCloseTo(1);
    expect(e.level()).toBe('overview');
  });

  it('스냅샷을 받기 전(loading)에는 구역 외곽선만 그리고 면을 칠하지 않는다', () => {
    const { e, ctx } = engineWith({ snapshot: false });
    expect(e.level()).toBe('loading');
    ctx.calls.length = 0;
    e.draw();
    expect(ctx.calls.filter(([n]) => n === 'fill')).toEqual([]);
    expect(ctx.calls.filter(([n]) => n === 'stroke').length).toBeGreaterThanOrEqual(5);
  });

  it('전체 배치의 구역 면은 가격이 높은 등급부터 heat.3·heat.2·heat.1이고 넷째 등급부터는 칠하지 않으며, 면 둘레에 border를 긋는다', () => {
    const { e, ctx } = engineWith({ tiers: 4 });
    ctx.calls.length = 0;
    e.draw();
    const fills = ctx.calls.filter(([n]) => n === 'fill').map(([, c]) => c);
    // 무대 1 + 구역 셋(넷째 등급 구역은 칠하지 않는다)
    expect(fills).toEqual([color.light.text, color.light['heat-3'], color.light['heat-2'], color.light['heat-1']]);
    expect(ctx.calls.filter(([n]) => n === 'stroke').every(([, c]) => c === color.light.border)).toBe(true);
  });

  it('남은 좌석 상태는 0이면 매진, 10% 이하면 적음, 그 밖은 많음이고 판매 제외 좌석은 세지 않는다', () => {
    const L = decodeLayout(makeLayout());
    const state = new Uint8Array(L.N).fill(STATE.SOLD);
    expect(sectionStatus(L, state, 0)).toMatchObject({ free: 0, status: 'soldout' });
    // 구역마다 마지막 좌석은 판매 제외(fixtures)라 판매할 수 있는 좌석은 199석이다
    for (let k = 0; k < 19; k++) state[k] = STATE.AVAILABLE;
    expect(sectionStatus(L, state, 0)).toMatchObject({ free: 19, sellable: 199, status: 'few' });
    state[19] = STATE.AVAILABLE;
    expect(sectionStatus(L, state, 0).status).toBe('plenty');
    // 판매 제외 좌석은 가능 상태여도 남은 좌석에 세지 않는다
    state[199] = STATE.AVAILABLE;
    expect(sectionStatus(L, state, 0).free).toBe(20);
  });
});

describe('좌석 단계의 그리기', () => {
  it('좌석이 24px 미만인 배율은 구역 비트맵(캐시)을 늘려 그리고, 다시 그릴 때는 만든 것을 쓰며, 고르면 그 구역만 다시 만든다', () => {
    const { e, ctx, created } = engineWith({ bitmaps: true });
    e.focusSection(2);
    expect(e.level()).toBe('seats');
    expect(e.seatPx()).toBeLessThan(MIN_SELECT_PX);
    ctx.calls.length = 0;
    e.draw();
    const images = ctx.calls.filter(([n]) => n === 'drawImage').length;
    expect(images).toBeGreaterThan(0);
    const made = created.length;
    expect(made).toBe(images);
    e.draw();
    expect(created.length).toBe(made);
    e.toggleMine(400);
    e.draw();
    expect(created.length).toBe(made + 1);
    expect(e.cache.bytes).toBeLessThanOrEqual(e.cache.maxBytes);
  });

  it('좌석을 고를 수 있는 배율(24px 이상)에서는 비트맵 없이 보이는 좌석만 바로 그리고, 미니맵에 지금 보는 범위를 그린다', () => {
    const { e, ctx } = engineWith({ bitmaps: true });
    e.focusSection(2);
    while (e.seatPx() < MIN_SELECT_PX) e.zoomBy(1.5);
    ctx.calls.length = 0;
    const drawn = e.draw();
    expect(drawn).toBeGreaterThan(0);
    expect(ctx.calls.filter(([n]) => n === 'drawImage')).toEqual([]);
    const rects = ctx.calls.filter(([n]) => n === 'strokeRect');
    // 미니맵 틀과 지금 보는 범위
    expect(rects.length).toBe(2);
    // 지금 보는 범위를 배치 캔버스 안으로 잘라 그린다
    const v = e.viewRect();
    const c = makeLayout().canvas;
    const x0 = Math.max(v.x, c.minX);
    const y0 = Math.max(v.y, c.minY);
    const x1 = Math.min(v.x + v.w, c.minX + c.width);
    const y1 = Math.min(v.y + v.h, c.minY + c.height);
    expect(rects[1]!.slice(2)).toEqual([x0, y0, x1 - x0, y1 - y0]);
  });

  it('전체 배치에서는 미니맵을 그리지 않고, 배율은 전체가 맞는 배율과 좌석 64px 사이로 묶인다', () => {
    const { e, ctx } = engineWith();
    ctx.calls.length = 0;
    e.draw();
    expect(ctx.calls.filter(([n]) => n === 'strokeRect')).toEqual([]);
    e.zoomBy(1e6);
    expect(e.seatPx()).toBeCloseTo(MAX_SEAT_PX);
    e.zoomBy(1e-6);
    expect(e.zoom()).toBeCloseTo(1);
  });
});

describe('구역 비트맵 캐시', () => {
  it('하나가 8MB를 넘으면 넣지 않고, 합이 64MB를 넘으면 오래 안 쓴 것부터 버리며, 구역 하나를 지우면 그 구역 것만 버린다', () => {
    const closed: string[] = [];
    const c = new BitmapCache(30, 10);
    const bmp = (n: string, bytes: number) => ({ image: n, scale: 1, bytes, close: () => closed.push(n) });
    expect(c.set(0, 0, bmp('big', 11))).toBe(false);
    c.set(0, 0, bmp('a', 10));
    c.set(1, 0, bmp('b', 10));
    c.set(2, 0, bmp('c', 10));
    c.get(0, 0); // a를 최근으로
    c.set(3, 0, bmp('d', 10));
    expect(closed).toEqual(['b']);
    expect(c.bytes).toBe(30);
    c.set(0, 1, bmp('a2', 5));
    c.invalidate(0);
    expect(closed).toEqual(['b', 'c', 'a', 'a2']);
    expect(c.size).toBe(1);
  });

  it('배율 단계는 √2 단계로 올림해 늘려 그릴 때 흐려지지 않는다', () => {
    for (const s of [0.013, 0.1, 0.37, 1, 1.6]) {
      const b = scaleBucket(s);
      expect(b.scale).toBeGreaterThanOrEqual(s - 1e-12);
      expect(b.scale / s).toBeLessThan(Math.SQRT2 + 1e-9);
    }
  });
});

describe('Worker 메시지(HOT-120)', () => {
  it('전체 배치에서 구역을 누르면 그 구역으로 확대하고, [+]·[−]·[전체 보기]·구역으로 확대하면 단계가 바뀔 때만 view를 알린다', async () => {
    const layout = makeLayout();
    const posted: Array<{ type: string } & Record<string, unknown>> = [];
    const host = {
      post: (m: unknown) => void posted.push(FromWorker.parse(m) as never),
      fetch: vi.fn(async (url: string) =>
        url.endsWith('.json') ? new Response(JSON.stringify(layout)) : new Response(encodeSnapshot({ layoutVersion: 3, seatEpoch: 1, sections: [[0, 1], [1, 1], [2, 1], [3, 1]], occupied: Array(800).fill(false) }).buffer as ArrayBuffer),
      ),
      nextFrame: async () => {},
      now: () => 1,
    };
    const handle = createHandler(host, () => fakeCtx());
    await handle({ type: 'init', canvas: {}, layoutUrl: '/l.json', snapshotUrl: '/s', admission: { token: 't' }, width: W, height: H, dpr: 1, theme: 'light' });
    expect(posted.map((m) => m.type)).toEqual(['ready', 'view']);
    expect(posted[1]).toMatchObject({ type: 'view', level: 'overview', zoom: 1, selectable: false });
    expect((posted[1] as unknown as { camera: { scale: number } }).camera.scale).toBeCloseTo(W / layout.canvas.width);
    // 3구역 라벨 근처(구역 도형 안)를 누른다
    const fitScale = W / layout.canvas.width;
    const sec = layout.sections[2]!.shape.points;
    const cx = ((sec[0]![0] + sec[1]![0]) / 2 - layout.canvas.minX) * fitScale;
    const cy = (sec[0]![1] + 20 - layout.canvas.minY) * fitScale + (H - layout.canvas.height * fitScale) / 2;
    await handle({ type: 'pointer', kind: 'up', x: cx, y: cy });
    const views = () => posted.filter((m) => m.type === 'view');
    expect(views().at(-1)).toMatchObject({ level: 'seats' });
    expect(posted.at(-1)).toMatchObject({ type: 'hit', seatIndex: -1 });
    const n = views().length;
    await handle({ type: 'fit' });
    expect(views().length).toBe(n + 1);
    expect(views().at(-1)).toMatchObject({ level: 'overview', zoom: 1 });
    await handle({ type: 'fit' });
    expect(views().length).toBe(n + 1);
    await handle({ type: 'focusSection', section: 1 });
    expect(views().at(-1)).toMatchObject({ level: 'seats' });
    await handle({ type: 'zoomBy', factor: 100 });
    expect(views().at(-1)).toMatchObject({ level: 'seats', selectable: true });
    await handle({ type: 'focusSection', section: 99 });
    expect(views().at(-1)).toMatchObject({ selectable: true });
  });
});

describe('주소', () => {
  it('createSeatMap은 좌석맵·스냅샷 상대 주소를 문서 주소 기준 절대 주소로 바꿔 Worker에 넘긴다(Worker 안 상대 주소는 스크립트 위치 기준이라 404가 난다)', async () => {
    const { absoluteUrl } = await import('../src/index');
    expect(absoluteUrl('./layout.json', 'https://www.peaket.example/booking/e1/seats')).toBe('https://www.peaket.example/booking/e1/layout.json');
    expect(absoluteUrl('/v1/events/e1/seatmap-snapshot', 'https://www.peaket.example/x')).toBe('https://www.peaket.example/v1/events/e1/seatmap-snapshot');
    expect(absoluteUrl('https://api.peaket.example/s', 'https://www.peaket.example/')).toBe('https://api.peaket.example/s');
  });
});
