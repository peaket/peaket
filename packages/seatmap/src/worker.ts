// 좌석맵 Worker 진입점(docs/frontend.md §5.2·§4.7, BUILD_ORDER HOT-110). 받은 메시지를 Zod로 검사하고 엔진(engine.ts)에 넘긴다.
// 메인 스레드 대체(client.ts)도 같은 처리기를 쓴다. 캔버스 화소 크기(화면 크기 × dpr)는 두 길 모두 이 처리기가 맞춘다.
import { SeatMapEngine } from './engine';
import type { SeatMapColumnsFile } from './layout';
import type { Ctx2D } from './paint';
import { FromWorker, ToWorker } from './protocol';

export interface Host {
  post(m: FromWorker, transfer?: Transferable[]): void;
  fetch(url: string, init: RequestInit): Promise<Response>;
  /** 다음 화면 갱신(그린 것이 화면에 나간 뒤). Worker 안 requestAnimationFrame이 없으면 setTimeout */
  nextFrame(): Promise<void>;
  now(): number;
}

type Canvas = { width: number; height: number };

/** 메시지 하나를 처리하는 함수를 만든다(Worker와 메인 스레드 대체가 함께 쓴다) */
export function createHandler(host: Host, getCtx: (canvas: OffscreenCanvas | HTMLCanvasElement) => Ctx2D) {
  let engine: SeatMapEngine | null = null;
  let canvas: Canvas | null = null;
  const fail = (e: unknown) => host.post({ type: 'error', message: String((e as Error)?.message ?? e) });
  const size = (w: number, h: number, dpr: number) => {
    if (!canvas) return;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  };
  return async function handle(raw: unknown): Promise<void> {
    const parsed = ToWorker.safeParse(raw);
    if (!parsed.success) return fail(`메시지가 틀렸다: ${parsed.error.issues[0]?.message}`);
    const m = parsed.data;
    try {
      if (m.type === 'init') {
        canvas = m.canvas as unknown as Canvas;
        size(m.width, m.height, m.dpr);
        const ctx = getCtx(m.canvas);
        // 좌석맵 파일은 공개 정적 파일(자격 증명 없음, immutable). 스냅샷은 팬 쿠키와 입장 토큰으로 받는다(openapi seatmap-snapshot)
        const headers: Record<string, string> = {};
        if (m.admission) {
          headers['X-Admission-Token'] = m.admission.token;
          if (m.admission.ephemeralKey) headers['X-Client-Ephemeral-Key'] = m.admission.ephemeralKey;
        }
        const [layoutRes, snapRes] = await Promise.all([
          host.fetch(m.layoutUrl, { credentials: 'omit' }),
          m.snapshotUrl ? host.fetch(m.snapshotUrl, { credentials: 'include', headers, cache: 'no-store' }) : Promise.resolve(null),
        ]);
        if (!layoutRes.ok) throw new Error(`좌석맵 파일 ${layoutRes.status}`);
        if (snapRes && !snapRes.ok) throw new Error(`좌석 스냅샷 ${snapRes.status}`);
        const file = (await layoutRes.json()) as SeatMapColumnsFile;
        // 엔진은 파일을 다 받은 뒤에 만든다(그 전에 온 카메라·고르기는 무시한다)
        const e = new SeatMapEngine({ ctx, width: m.width, height: m.height, dpr: m.dpr, theme: m.theme });
        e.load(file, snapRes ? await snapRes.arrayBuffer() : undefined);
        engine = e;
        engine.draw();
        // 그린 것이 화면에 나간 시각: 다음 화면 갱신 뒤를 첫 그림 시각으로 본다(성능 추적의 화면 제시와 맞춰 보는 일은 HOT-120)
        await host.nextFrame();
        host.post({ type: 'ready', firstPaintAt: host.now(), layoutVersion: engine.L.layoutVersion, seatCount: engine.L.N, sectionCount: engine.L.S });
        return;
      }
      if (m.type === 'dispose') {
        engine = null;
        canvas = null;
        return;
      }
      if (m.type === 'viewport') size(m.w, m.h, m.dpr);
      if (!engine) return;
      switch (m.type) {
        case 'viewport':
          engine.resize(m.w, m.h, m.dpr);
          engine.draw();
          break;
        case 'camera':
          engine.setCamera(m.zoom, m.x, m.y);
          engine.draw();
          break;
        case 'pointer':
          if (m.kind === 'up') host.post({ type: 'hit', ...engine.hit(m.x, m.y) });
          break;
        case 'select':
          // 고를 수 있는 좌석만(가능 상태, 판매 제외 아님). 이미 고른 좌석은 풀 수 있다
          if (engine.canSelect(m.seatIndex)) {
            engine.toggleMine(m.seatIndex);
            engine.draw();
            const seats: number[] = [];
            for (let k = 0; k < engine.L.N; k++) if (engine.isMine(k)) seats.push(k);
            host.post({ type: 'selection', seatIndexes: seats });
          }
          break;
        case 'theme':
          engine.setTheme(m.theme);
          engine.draw();
          break;
      }
    } catch (e) {
      fail(e);
    }
  };
}

// Worker로 실릴 때만 메시지 처리기를 단다(시험·메인 스레드 대체가 가져올 때는 달지 않는다)
declare const WorkerGlobalScope: unknown;
if (typeof WorkerGlobalScope !== 'undefined' && typeof self !== 'undefined') {
  const scope = self as unknown as { onmessage: ((e: MessageEvent) => void) | null; postMessage(m: unknown, t?: Transferable[]): void; requestAnimationFrame?: (cb: () => void) => void };
  const handle = createHandler(
    {
      post: (m, t) => scope.postMessage(m, t ?? []),
      fetch: (u, init) => fetch(u, init),
      nextFrame: () => new Promise((ok) => (scope.requestAnimationFrame ? scope.requestAnimationFrame(() => ok()) : setTimeout(ok, 0))),
      now: () => performance.timeOrigin + performance.now(),
    },
    (canvas) => (canvas as OffscreenCanvas).getContext('2d') as unknown as Ctx2D,
  );
  scope.onmessage = (e) => void handle(e.data);
}
