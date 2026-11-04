// 새 맥락 리뷰 재현 시험(BUILD_ORDER HOT-110). 고치기 전에 실패하는 것을 확인했다.
import { describe, expect, it, vi } from 'vitest';
import { seatColor } from '@peaket/ds/tokens';
import {
  applyDelta,
  applySnapshot,
  buildGrids,
  decodeFrame,
  decodeLayout,
  decodeSnapshot,
  drawSeat,
  encodeSubscribe,
  FromWorker,
  hitTest,
  seatState,
  seatStyle,
  sectionOf,
  STATE,
} from '../src/index';
import { createHandler } from '../src/worker';
import { encodeDelta, encodeSnapshot, fakeCtx, makeLayout } from './fixtures';

/** WCAG 상대 대비(색 아닌 요소 3:1, d2 §5) */
function contrast(a: string, b: string) {
  const lum = (h: string) => {
    const v = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((x) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
    return 0.2126 * v[0]! + 0.7152 * v[1]! + 0.0722 * v[2]!;
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
}

function fakeHost(files: { layout: unknown; snapshot?: Uint8Array }) {
  const posted: Array<{ type: string } & Record<string, unknown>> = [];
  const host = {
    post: (m: unknown) => void posted.push(FromWorker.parse(m) as never),
    fetch: vi.fn(async (url: string, _init?: RequestInit) =>
      url.endsWith('.json') ? new Response(JSON.stringify(files.layout)) : files.snapshot ? new Response(files.snapshot.buffer as ArrayBuffer) : new Response(null, { status: 404 }),
    ),
    nextFrame: async () => {},
    now: () => 1000,
  };
  return { host, posted };
}

const allFree = () => encodeSnapshot({ layoutVersion: 3, seatEpoch: 1, sections: [[0, 1], [1, 1], [2, 1], [3, 1]], occupied: Array(800).fill(false) });
const init = (o: Record<string, unknown> = {}) => ({ type: 'init', canvas: {}, layoutUrl: '/l.json', snapshotUrl: '/snap', admission: { token: 'adm' }, width: 400, height: 300, dpr: 1, theme: 'light', ...o });

describe('새 맥락 리뷰 재현(HOT-110)', () => {
  it('캔버스 화소 크기를 화면 크기 × dpr로 맞추고(Worker 길·메인 스레드 길 같은 처리기), viewport에서 다시 맞춘다', async () => {
    const canvas = { width: 300, height: 150 };
    const { host } = fakeHost({ layout: makeLayout(), snapshot: allFree() });
    const handle = createHandler(host, () => fakeCtx());
    await handle(init({ canvas, dpr: 2 }));
    expect([canvas.width, canvas.height]).toEqual([800, 600]);
    await handle({ type: 'viewport', w: 500, h: 250, dpr: 3 });
    expect([canvas.width, canvas.height]).toEqual([1500, 750]);
  });

  it('스냅샷은 쿠키와 입장 토큰(X-Admission-Token, 처음이면 X-Client-Ephemeral-Key)으로 받고, 좌석맵 파일은 자격 증명 없이 받는다', async () => {
    const { host, posted } = fakeHost({ layout: makeLayout(), snapshot: allFree() });
    await createHandler(host, () => fakeCtx())(init({ admission: { token: 'adm', ephemeralKey: 'pub' } }));
    expect(posted[0]).toMatchObject({ type: 'ready' });
    const calls = host.fetch.mock.calls as unknown as Array<[string, RequestInit]>;
    const layoutCall = calls.find(([u]) => u === '/l.json')!;
    const snapCall = calls.find(([u]) => u === '/snap')!;
    expect(layoutCall[1].credentials).toBe('omit');
    expect(snapCall[1].credentials).toBe('include');
    expect(new Headers(snapCall[1].headers).get('x-admission-token')).toBe('adm');
    expect(new Headers(snapCall[1].headers).get('x-client-ephemeral-key')).toBe('pub');
    const bad = fakeHost({ layout: makeLayout(), snapshot: allFree() });
    await createHandler(bad.host, () => fakeCtx())(init({ admission: undefined }));
    expect(bad.posted[0]).toMatchObject({ type: 'error' });
  });

  it('빗금·X·점 무늬는 칠한 색과 3:1 넘게 대비되는 잉크로 그려 색만으로 가르지 않는다(라이트·다크 모두)', () => {
    for (const mode of ['light', 'dark'] as const) {
      for (const s of ['held-by-others', 'mine', 'sold', 'unavailable', 'wheelchair'] as const) {
        const st = seatStyle(s, mode);
        expect(contrast(st.ink, st.color), `${mode} ${s}`).toBeGreaterThanOrEqual(3);
        const ctx = fakeCtx();
        drawSeat(ctx, st, 50, 50, 24);
        const inked = ctx.calls.filter(([n]) => n === 'stroke' || n === 'fill');
        expect(inked.length, `${mode} ${s} 무늬`).toBeGreaterThan(0);
        expect(inked.every(([, color]) => color === st.ink), `${mode} ${s} 잉크`).toBe(true);
      }
    }
    expect(seatStyle('mine', 'light').ink).toBe(seatColor.light.glyph);
    expect(seatStyle('wheelchair', 'dark').ink).toBe(seatColor.dark.glyph);
  });

  it('이웃 구역 좌석이 반경 안에 함께 드는 경계에서도 가장 가까운 좌석을 고른다(처음 맞은 구역에서 돌려주면 틀린다)', () => {
    const L = decodeLayout(makeLayout({ sections: 4, rows: 6, perRow: 10, gap: -20, jitter: false }));
    const grids = buildGrids(L);
    // 0구역 마지막 열(x = 495)과 1구역 첫 열(x = 530) 사이, 1구역 쪽에 더 가깝다
    const wx = 520;
    const wy = 300;
    const got = hitTest(L, grids, wx, wy);
    expect(L.x[got]).toBe(530);
    expect(sectionOf(L, got).section).toBe(1);
    const firstHit = () => {
      for (let s = 0; s < L.S; s++) {
        let best = -1;
        let bestD = 900;
        for (let k = L.sectionStart[s]!; k <= L.sectionEnd[s]!; k++) {
          const d = (L.x[k]! - wx) ** 2 + (L.y[k]! - wy) ** 2;
          if (d < bestD) [best, bestD] = [k, d];
        }
        if (best >= 0) return best;
      }
      return -1;
    };
    expect(sectionOf(L, firstHit()).section).toBe(0);
  });

  it('좌석이 24 CSS px보다 작은 배율(전체 배치도)에서는 누른 좌석이 없고, 판매·선택 불가·판매 제외 좌석은 고르지 못한다', async () => {
    const layout = makeLayout();
    const occupied = Array.from({ length: 800 }, (_, i) => i === 401);
    const { host, posted } = fakeHost({ layout, snapshot: encodeSnapshot({ layoutVersion: 3, seatEpoch: 1, sections: [[0, 1], [1, 1], [2, 1], [3, 1]], occupied }) });
    const handle = createHandler(host, () => fakeCtx());
    await handle(init());
    const s2 = layout.sections[2]!.seats;
    await handle({ type: 'camera', zoom: 1, x: s2.x[0]!, y: s2.y[0]! });
    await handle({ type: 'pointer', kind: 'up', x: 200, y: 150 });
    expect(posted.at(-1)).toMatchObject({ type: 'hit', seatIndex: -1, seatId: null });
    await handle({ type: 'select', seatIndex: 401 });
    await handle({ type: 'select', seatIndex: 799 });
    expect(posted.filter((m) => m.type === 'selection')).toEqual([]);
    await handle({ type: 'select', seatIndex: 400 });
    expect(posted.at(-1)).toEqual({ type: 'selection', seatIndexes: [400] });
  });

  it('휠체어석은 다른 상태여도 휠체어 표시를 함께 그리고, 내가 고른 좌석이 판매되면 판매로 그린다', () => {
    expect(seatState(STATE.SOLD, 1 << 4, true)).toBe('sold');
    expect(seatState(STATE.HELD, 0, true)).toBe('mine');
    const plain = fakeCtx();
    drawSeat(plain, seatStyle('sold', 'light'), 50, 50, 24);
    const marked = fakeCtx();
    drawSeat(marked, seatStyle('sold', 'light'), 50, 50, 24, true);
    expect(marked.calls.filter(([n]) => n === 'arc').length).toBeGreaterThan(plain.calls.filter(([n]) => n === 'arc').length);
  });

  it('캔버스·좌표·플래그·좌석 ID가 틀리거나 격자 칸 수가 상한을 넘는 파일은 풀지 않는다(메모리 고갈 막기)', () => {
    const f1 = makeLayout();
    f1.canvas.width = 0;
    expect(() => decodeLayout(f1)).toThrow(/canvas/);
    const f2 = makeLayout();
    f2.sections[0]!.seats.x[0] = 10_000_000;
    expect(() => decodeLayout(f2)).toThrow(/캔버스 밖/);
    const f3 = makeLayout();
    f3.sections[0]!.seats.flags[0] = 16;
    expect(() => decodeLayout(f3)).toThrow(/플래그/);
    const f4 = makeLayout();
    (f4.sections[0]!.seats.seatId as unknown[])[0] = 7;
    expect(() => decodeLayout(f4)).toThrow(/좌석 ID/);
    // 좌석 두 석이 1km 캔버스의 양 끝에 있는 구역 스무 개: 구역마다 칸 25만 개라 상한(400만)을 넘는다
    const wide = makeLayout({ sections: 20, rows: 1, perRow: 2, jitter: false });
    wide.canvas = { minX: 0, minY: 0, width: 100_000, height: 100_000 };
    wide.stage = [{ kind: 'RECT', points: [[0, 0], [10, 0], [10, 10]] }];
    for (const sec of wide.sections) {
      sec.shape = { kind: 'RECT', points: [[0, 0], [100_000, 0], [100_000, 100_000]] };
      sec.seats.x = [0, 100_000];
      sec.seats.y = [0, 100_000];
    }
    expect(() => buildGrids(decodeLayout(wide))).toThrow(/격자 칸/);
  });

  it('델타 묶음에 구역 밖 거리가 있으면 그 구역 상태를 하나도 바꾸지 않고, 구독은 16구역·겹침 없음·u16 안만 만든다', () => {
    const L = decodeLayout(makeLayout());
    const state = new Uint8Array(L.N);
    const versions = { seatEpoch: 1, version: new Uint32Array(4) };
    const f = decodeFrame(encodeDelta({ seatEpoch: 1, sections: [{ index: 0, version: 1, changes: [[0, 2], [500, 1]] }] })) as Extract<ReturnType<typeof decodeFrame>, { type: 'delta' }>;
    expect(() => applyDelta(state, versions, f, L.sectionStart, L.sectionEnd)).toThrow(/밖/);
    expect(state[0]).toBe(0);
    expect(versions.version[0]).toBe(0);
    expect(() => encodeSubscribe(Array.from({ length: 17 }, (_, i) => i))).toThrow(/16/);
    expect(() => encodeSubscribe([1, 1])).toThrow(/겹/);
    expect(() => encodeSubscribe([70_000])).toThrow(/구역/);
    const one = decodeSnapshot(encodeSnapshot({ flags: 1, layoutVersion: 3, seatEpoch: 1, sections: [[9, 1]], occupied: [true] }));
    expect(() => applySnapshot(new Uint8Array(L.N), one, (s) => (s < L.S ? [L.sectionStart[s]!, L.sectionEnd[s]!] : undefined) as [number, number])).toThrow(/구역/);
  });
});
