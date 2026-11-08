// 좌석 화면을 잇는 데 더한 것(BUILD_ORDER HOT-350 ①, docs/frontend.md §4.4.2·§4.7, SCR-010).
// - 스냅샷의 layoutVersion이 받은 좌석맵과 다르면 그 판의 좌석맵 파일을 한 번 다시 받는다
// - 오류 메시지에 어느 요청이 어떤 상태로 실패했는지 싣는다(화면이 401은 예매 시간 끝, 그 밖은 다시 시도로 가른다)
// - 끌기는 pan 메시지로 카메라를 옮기고 배치 밖 빈 곳이 보이지 않게 묶는다
import { describe, expect, it, vi } from 'vitest';
import { FromWorker } from '../src/protocol';
import { SeatMapEngine } from '../src/engine';
import { createHandler } from '../src/worker';
import { encodeSnapshot, fakeCtx, makeLayout } from './fixtures';

type Posted = { type: string } & Record<string, unknown>;

function fakeHost(routes: (url: string) => Response) {
  const posted: Posted[] = [];
  const host = {
    post: (m: unknown) => void posted.push(FromWorker.parse(m) as Posted),
    fetch: vi.fn(async (url: string, _init?: RequestInit) => routes(url)),
    nextFrame: async () => {},
    now: () => 1000,
  };
  return { host, posted };
}

const LAYOUT_URL = 'http://w/v1/events/evt-1/seatmap-layouts/3.json';
const init = (o: Record<string, unknown> = {}) => ({ type: 'init', canvas: {}, layoutUrl: LAYOUT_URL, snapshotUrl: 'http://a/snap', admission: { token: 'adm', ephemeralKey: 'pub' }, width: 400, height: 300, dpr: 1, theme: 'light', ...o });
const snap = (layoutVersion: number) =>
  new Response(encodeSnapshot({ layoutVersion, seatEpoch: 1, sections: [[0, 1], [1, 1], [2, 1], [3, 1]], occupied: Array(800).fill(false) }).buffer as ArrayBuffer);
const layoutAt = (layoutVersion: number) => new Response(JSON.stringify({ ...makeLayout(), layoutVersion }));
const errors = (p: Posted[]) => p.filter((m) => m.type === 'error');

describe('SCR-010 좌석맵 판이 바뀌었을 때(§4.4.2)', () => {
  it('스냅샷의 판이 다르면 그 판의 좌석맵 파일을 자격 증명 없이 한 번 다시 받아 그린다', async () => {
    const { host, posted } = fakeHost((u) => (u.endsWith('/3.json') ? layoutAt(3) : u.endsWith('/4.json') ? layoutAt(4) : snap(4)));
    await createHandler(host, () => fakeCtx())(init());
    expect(errors(posted)).toEqual([]);
    expect(posted.find((m) => m.type === 'ready')).toMatchObject({ layoutVersion: 4 });
    const again = (host.fetch.mock.calls as unknown as Array<[string, RequestInit]>).find(([u]) => u.endsWith('/4.json'))!;
    expect(again[0]).toBe('http://w/v1/events/evt-1/seatmap-layouts/4.json');
    expect(again[1].credentials).toBe('omit');
  });

  it('다시 받아도 판이 다르면 더 받지 않고 오류를 알린다', async () => {
    const { host, posted } = fakeHost((u) => (u.endsWith('.json') ? layoutAt(3) : snap(4)));
    await createHandler(host, () => fakeCtx())(init());
    expect(errors(posted)).toHaveLength(1);
    expect(posted.some((m) => m.type === 'ready')).toBe(false);
    expect((host.fetch.mock.calls as unknown as Array<[string]>).filter(([u]) => u.endsWith('.json'))).toHaveLength(2);
  });

  it('좌석맵 주소가 판 번호 꼴이 아니면 다시 받지 않고 오류를 알린다', async () => {
    const { host, posted } = fakeHost((u) => (u.endsWith('.json') ? layoutAt(3) : snap(4)));
    await createHandler(host, () => fakeCtx())(init({ layoutUrl: '/layout.json' }));
    expect(errors(posted)).toHaveLength(1);
    expect((host.fetch.mock.calls as unknown as Array<[string]>).filter(([u]) => u.endsWith('.json'))).toHaveLength(1);
  });

  it('판이 같으면 한 번만 받는다', async () => {
    const { host, posted } = fakeHost((u) => (u.endsWith('.json') ? layoutAt(3) : snap(3)));
    await createHandler(host, () => fakeCtx())(init());
    expect(posted.find((m) => m.type === 'ready')).toMatchObject({ layoutVersion: 3 });
    expect((host.fetch.mock.calls as unknown as Array<[string]>).filter(([u]) => u.endsWith('.json'))).toHaveLength(1);
  });
});

describe('SCR-010 오류의 출처와 상태', () => {
  it.each([401, 403, 410, 503])('스냅샷 %i은 source snapshot과 상태를 싣는다', async (status) => {
    const { host, posted } = fakeHost((u) => (u.endsWith('.json') ? layoutAt(3) : new Response(null, { status })));
    await createHandler(host, () => fakeCtx())(init());
    expect(errors(posted)[0]).toMatchObject({ source: 'snapshot', status });
  });

  it('좌석맵 파일 404는 source layout이다', async () => {
    const { host, posted } = fakeHost((u) => (u.endsWith('.json') ? new Response(null, { status: 404 }) : snap(3)));
    await createHandler(host, () => fakeCtx())(init());
    expect(errors(posted)[0]).toMatchObject({ source: 'layout', status: 404 });
  });

  it('응답 없이 끊기면 상태를 싣지 않는다', async () => {
    const { host, posted } = fakeHost(() => {
      throw new TypeError('Failed to fetch');
    });
    await createHandler(host, () => fakeCtx())(init());
    expect(errors(posted)[0]).toMatchObject({ message: 'Failed to fetch' });
    expect(errors(posted)[0]!.status).toBeUndefined();
  });
});

describe('SCR-010 등급 글자', () => {
  const engine = (tierNames?: Record<string, string>) => {
    const e = new SeatMapEngine({ ctx: fakeCtx(), width: 400, height: 300, dpr: 1, theme: 'light', ...(tierNames ? { tierNames } : {}) });
    e.load(makeLayout());
    return e;
  };

  it('회차 가격표의 이름으로 쓰고, 없는 등급은 파일의 ID를 그대로 쓴다', () => {
    expect(engine({ VIP: 'VIP석' }).tierLabel(0)).toBe('VIP석');
    expect(engine({ R: 'R석' }).tierLabel(0)).toBe('VIP');
    expect(engine().tierLabel(0)).toBe('VIP');
  });

  it('init의 tierNames가 엔진까지 간다', async () => {
    const { host, posted } = fakeHost((u) => (u.endsWith('.json') ? layoutAt(3) : snap(3)));
    const texts: string[] = [];
    const ctx = fakeCtx();
    const fill = ctx.fillText?.bind(ctx);
    (ctx as unknown as { fillText: (t: string, x: number, y: number) => void }).fillText = (t, x, y) => {
      texts.push(t);
      fill?.(t, x, y);
    };
    await createHandler(host, () => ctx)(init({ tierNames: { VIP: 'VIP석' } }));
    expect(errors(posted)).toEqual([]);
    expect(texts.some((t) => t.includes('VIP석'))).toBe(true);
  });
});

describe('SCR-010 새 맥락 리뷰 재현', () => {
  it('오류에 문제 유형과 Retry-After(초)를 싣는다', async () => {
    const res = () => new Response(JSON.stringify({ type: 'https://peaket.example/problems/admission-token-invalid', status: 401 }), { status: 401, headers: { 'content-type': 'application/problem+json' } });
    const a = fakeHost((u) => (u.endsWith('.json') ? layoutAt(3) : res()));
    await createHandler(a.host, () => fakeCtx())(init());
    expect(errors(a.posted)[0]).toMatchObject({ source: 'snapshot', status: 401, problem: 'admission-token-invalid' });
    const b = fakeHost((u) => (u.endsWith('.json') ? layoutAt(3) : new Response(null, { status: 503, headers: { 'retry-after': '3' } })));
    await createHandler(b.host, () => fakeCtx())(init());
    expect(errors(b.posted)[0]).toMatchObject({ status: 503, retryAfter: 3 });
  });

  it('파일·스냅샷 요청에 시간 제한 신호를 단다', async () => {
    const { host } = fakeHost((u) => (u.endsWith('.json') ? layoutAt(3) : snap(3)));
    await createHandler(host, () => fakeCtx())(init());
    for (const [, opts] of host.fetch.mock.calls as unknown as Array<[string, RequestInit]>) expect(opts.signal).toBeInstanceOf(AbortSignal);
  });

  it('로딩 중에 바뀐 화면 크기로 엔진을 만든다', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { host, posted } = fakeHost((u) => (u.endsWith('.json') ? layoutAt(3) : snap(3)));
    const realFetch = host.fetch.getMockImplementation()!;
    host.fetch.mockImplementation(async (u: string, o?: RequestInit) => {
      await gate;
      return realFetch(u, o);
    });
    const handle = createHandler(host, () => fakeCtx());
    const started = handle(init({ width: 400, height: 300 }));
    await handle({ type: 'viewport', w: 800, h: 600, dpr: 1 });
    release();
    await started;
    const b = fakeHost((u) => (u.endsWith('.json') ? layoutAt(3) : snap(3)));
    await createHandler(b.host, () => fakeCtx())(init({ width: 800, height: 600 }));
    const cam = (p: Posted[]) => (p.filter((m) => m.type === 'view').at(-1) as unknown as { camera: unknown }).camera;
    expect(cam(posted)).toEqual(cam(b.posted));
  });

  it('등급 차례·이름은 tiers 메시지로 나중에 줄 수 있고, 엔진이 생기기 전에 오면 만들 때 쓴다', async () => {
    const texts: string[] = [];
    const ctx = fakeCtx();
    (ctx as unknown as { fillText: (t: string) => void }).fillText = (t) => void texts.push(t);
    const a = fakeHost((u) => (u.endsWith('.json') ? layoutAt(3) : snap(3)));
    const handle = createHandler(a.host, () => ctx);
    await handle(init());
    expect(texts.some((t) => t.includes('VIP석'))).toBe(false);
    await handle({ type: 'tiers', tierRank: ['S', 'R', 'VIP'], tierNames: { VIP: 'VIP석' } });
    expect(texts.some((t) => t.includes('VIP석'))).toBe(true);

    const early: string[] = [];
    const ctx2 = fakeCtx();
    (ctx2 as unknown as { fillText: (t: string) => void }).fillText = (t) => void early.push(t);
    const b = fakeHost((u) => (u.endsWith('.json') ? layoutAt(3) : snap(3)));
    const handle2 = createHandler(b.host, () => ctx2);
    const started = handle2(init());
    await handle2({ type: 'tiers', tierNames: { VIP: 'VIP석' } });
    await started;
    expect(early.some((t) => t.includes('VIP석'))).toBe(true);
  });

  it('끌기·확대는 프레임마다 한 번만 그린다', async () => {
    const { host, posted } = fakeHost((u) => (u.endsWith('.json') ? layoutAt(3) : snap(3)));
    const handle = createHandler(host, () => fakeCtx());
    await handle(init());
    await handle({ type: 'zoomBy', factor: 4, x: 200, y: 150 });
    let frame!: () => void;
    host.nextFrame = () => new Promise<void>((r) => (frame = r));
    const n = posted.filter((m) => m.type === 'view').length;
    const a = handle({ type: 'pan', dx: 5, dy: 0 });
    const b = handle({ type: 'pan', dx: 7, dy: 0 });
    const c = handle({ type: 'zoomBy', factor: 1.1, x: 100, y: 100 });
    expect(posted.filter((m) => m.type === 'view').length).toBe(n);
    frame();
    await Promise.all([a, b, c]);
    expect(posted.filter((m) => m.type === 'view').length).toBe(n + 1);
  });
});

describe('SCR-010 끌기', () => {
  const ready = async () => {
    const { host, posted } = fakeHost((u) => (u.endsWith('.json') ? layoutAt(3) : snap(3)));
    const handle = createHandler(host, () => fakeCtx());
    await handle(init());
    return { handle, posted, view: () => posted.filter((m) => m.type === 'view').at(-1) as unknown as { camera: { tx: number; ty: number; scale: number } } };
  };

  it('확대한 뒤 pan은 카메라를 그만큼 옮긴다', async () => {
    const { handle, view } = await ready();
    await handle({ type: 'zoomBy', factor: 4, x: 200, y: 150 });
    const a = view().camera;
    await handle({ type: 'pan', dx: 30, dy: -20 });
    expect(view().camera).toMatchObject({ tx: a.tx + 30, ty: a.ty - 20, scale: a.scale });
  });

  it('배치 밖 빈 곳이 보이지 않게 묶는다(전체 보기에서는 움직이지 않는다)', async () => {
    const { handle, view, posted } = await ready();
    const a = view().camera;
    const n = posted.length;
    await handle({ type: 'pan', dx: 500, dy: 500 });
    expect(posted.length === n || view().camera.tx === a.tx).toBe(true);
    expect(view().camera).toEqual(a);
  });
});
