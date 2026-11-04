// 좌석맵을 화면에 붙이는 쪽(메인 스레드, docs/frontend.md §1.5 'OffscreenCanvas 2D, Worker 안 requestAnimationFrame' 행, FE-T15, BUILD_ORDER HOT-110).
// OffscreenCanvas(transferControlToOffscreen)가 있으면 Worker에 캔버스를 넘기고, 없으면 같은 그리기 모듈을 메인 스레드에서 돌린다.
import type { Ctx2D } from './paint';
import { FromWorker, type ToWorker } from './protocol';
import type { BitmapFactory } from './engine';
import { createHandler, offscreenBitmaps } from './worker';

export type Mode = 'worker' | 'main-thread';

/** 이 브라우저에서 Worker로 그릴 수 있는가(§1.5: Safari 16.4부터 OffscreenCanvas 2D) */
export function canUseWorker(g: { OffscreenCanvas?: unknown; Worker?: unknown } = globalThis as never, canvas?: { transferControlToOffscreen?: unknown }): boolean {
  return typeof g.Worker === 'function' && typeof g.OffscreenCanvas === 'function' && typeof canvas?.transferControlToOffscreen === 'function';
}

export interface SeatMapClient {
  mode: Mode;
  send(m: Exclude<ToWorker, { type: 'init' }>): void;
  dispose(): void;
}

export interface CreateOptions {
  canvas: HTMLCanvasElement;
  layoutUrl: string;
  snapshotUrl?: string;
  /** 입장 토큰(스냅샷을 받을 때 필요하다) */
  admission?: { token: string; ephemeralKey?: string };
  /** 등급 ID를 가격이 높은 차례로(회차 가격표) */
  tierRank?: string[];
  theme: 'light' | 'dark';
  onMessage(m: FromWorker): void;
  /** Worker를 만드는 함수(번들러가 정한 주소, 예: new Worker(new URL('@peaket/seatmap/worker', import.meta.url), { type: 'module' })) */
  createWorker(): Worker;
  /** 시험에서 바꾼다 */
  env?: { OffscreenCanvas?: unknown; Worker?: unknown };
}

/** OffscreenCanvas가 없는 브라우저의 구역 비트맵: canvas 요소에 그려 그대로 늘려 그린다 */
function elementBitmaps(): BitmapFactory | undefined {
  if (typeof document === 'undefined') return undefined;
  return {
    create(w, h) {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      return { ctx: c.getContext('2d') as unknown as Ctx2D, finish: () => ({ image: c }) };
    },
  };
}

/** 상대 주소를 문서 주소 기준 절대 주소로(Worker 안에서는 상대 주소가 Worker 스크립트 위치 기준으로 풀린다) */
export function absoluteUrl(u: string, base = globalThis.document?.baseURI ?? globalThis.location?.href): string {
  return base ? new URL(u, base).href : u;
}

export function createSeatMap(o: CreateOptions): SeatMapClient {
  o = { ...o, layoutUrl: absoluteUrl(o.layoutUrl), snapshotUrl: o.snapshotUrl === undefined ? undefined : absoluteUrl(o.snapshotUrl) };
  const width = o.canvas.clientWidth || o.canvas.width;
  const height = o.canvas.clientHeight || o.canvas.height;
  const dpr = globalThis.devicePixelRatio ?? 1;
  const recv = (data: unknown) => {
    const m = FromWorker.safeParse(data);
    o.onMessage(m.success ? m.data : { type: 'error', message: `Worker 메시지가 틀렸다: ${m.error.issues[0]?.message}` });
  };
  if (canUseWorker(o.env, o.canvas as never)) {
    const worker = o.createWorker();
    worker.onmessage = (e) => recv(e.data);
    worker.onerror = (e) => o.onMessage({ type: 'error', message: e.message || 'Worker 오류' });
    const offscreen = o.canvas.transferControlToOffscreen();
    worker.postMessage({ type: 'init', canvas: offscreen, layoutUrl: o.layoutUrl, snapshotUrl: o.snapshotUrl, admission: o.admission, tierRank: o.tierRank, width, height, dpr, theme: o.theme } satisfies ToWorker, [offscreen]);
    return { mode: 'worker', send: (m) => worker.postMessage(m), dispose: () => (worker.postMessage({ type: 'dispose' }), worker.terminate()) };
  }
  // 대체: 메인 스레드에서 같은 처리기를 돈다(캔버스 화소 크기도 처리기가 맞춘다)
  const handle = createHandler(
    {
      post: (m) => recv(m),
      fetch: (u, init) => fetch(u, init),
      nextFrame: () => new Promise((ok) => requestAnimationFrame(() => ok())),
      now: () => performance.timeOrigin + performance.now(),
    },
    (canvas) => (canvas as HTMLCanvasElement).getContext('2d') as unknown as Ctx2D,
    typeof OffscreenCanvas === 'function' ? offscreenBitmaps : elementBitmaps(),
  );
  void handle({ type: 'init', canvas: o.canvas, layoutUrl: o.layoutUrl, snapshotUrl: o.snapshotUrl, admission: o.admission, tierRank: o.tierRank, width, height, dpr, theme: o.theme });
  return { mode: 'main-thread', send: (m) => void handle(m), dispose: () => void handle({ type: 'dispose' }) };
}
