// 좌석맵 Worker 진입점(docs/frontend.md §5.2·§4.7, BUILD_ORDER HOT-110). 받은 메시지를 Zod로 검사하고 엔진(engine.ts)에 넘긴다.
// 메인 스레드 대체(client.ts)도 같은 처리기를 쓴다. 캔버스 화소 크기(화면 크기 × dpr)는 두 길 모두 이 처리기가 맞춘다.
import { SeatMapEngine, type BitmapFactory } from './engine';
import { FLAG, sectionOf, type SeatMapColumnsFile } from './layout';
import { sectionStatus } from './overview';
import { seatState, type Ctx2D } from './paint';
import { FromWorker, LIST_STATES, ToWorker } from './protocol';
import { decodeSnapshot } from './wire';

export interface Host {
  post(m: FromWorker, transfer?: Transferable[]): void;
  fetch(url: string, init: RequestInit): Promise<Response>;
  /** 다음 화면 갱신(그린 것이 화면에 나간 뒤). Worker 안 requestAnimationFrame이 없으면 setTimeout */
  nextFrame(): Promise<void>;
  now(): number;
}

type Canvas = { width: number; height: number };

/** 파일·스냅샷 요청의 HTTP 오류(화면이 상태로 다음 동작을 고른다) */
class FetchFailed extends Error {
  readonly source: 'layout' | 'snapshot';
  readonly status: number;
  readonly problem: string | undefined;
  readonly retryAfter: number | undefined;
  constructor(source: 'layout' | 'snapshot', status: number, problem?: string, retryAfter?: number) {
    super(`${source === 'layout' ? '좌석맵 파일' : '좌석 스냅샷'} ${status}`);
    this.source = source;
    this.status = status;
    this.problem = problem;
    this.retryAfter = retryAfter;
  }
}

/** 응답 → FetchFailed(문제 유형은 type 주소의 끝, Retry-After는 초만 읽는다) */
async function failed(source: 'layout' | 'snapshot', res: Response): Promise<FetchFailed> {
  let problem: string | undefined;
  if ((res.headers.get('content-type') ?? '').includes('json')) {
    try {
      const t = ((await res.json()) as { type?: unknown }).type;
      if (typeof t === 'string') problem = t.split('/').filter(Boolean).pop();
    } catch {
      /* 본문을 읽지 못해도 상태로 가른다 */
    }
  }
  const ra = Number(res.headers.get('retry-after'));
  return new FetchFailed(source, res.status, problem, res.headers.has('retry-after') && Number.isFinite(ra) && ra >= 0 ? ra : undefined);
}

/** 누름에 확대로 답한 뒤 이 시간 안의 누름(더블클릭의 두 번째)은 고르지 않는다 [가정](ADR-0236) */
const AFTER_ZOOM_GUARD_MS = 300;

/** 읽기 요청 시간 제한(docs/frontend.md §4.1 '시간 초과' 읽기 10초) */
const READ_TIMEOUT_MS = 10_000;
const timeoutSignal = (): AbortSignal => AbortSignal.timeout(READ_TIMEOUT_MS);

/** 좌석맵 파일 주소의 판 번호만 바꾼 주소(…/{layoutVersion}.json). 그 꼴이 아니면 undefined */
function layoutUrlAt(url: string, version: number): string | undefined {
  const m = /\/\d+\.json(?=$|[?#])/.exec(url);
  return m ? `${url.slice(0, m.index)}/${version}.json${url.slice(m.index + m[0].length)}` : undefined;
}

/** 좌석 하나의 목록 상태 코드(지도와 같은 판정, 휠체어·방금 놓은 좌석은 목록에서 가능으로 본다) */
function listStateOf(e: SeatMapEngine, k: number): number {
  const s = seatState(e.state[k]!, e.L.attr[k]!, e.isMine(k));
  return LIST_STATES.indexOf(s === 'wheelchair' || s === 'recently-released' ? 'available' : s);
}

/** 메시지 하나를 처리하는 함수를 만든다(Worker와 메인 스레드 대체가 함께 쓴다) */
export function createHandler(host: Host, getCtx: (canvas: OffscreenCanvas | HTMLCanvasElement) => Ctx2D, bitmaps?: BitmapFactory) {
  let engine: SeatMapEngine | null = null;
  let canvas: Canvas | null = null;
  let lastView = '';
  /** 접근성 목록이 연 구역 */
  let listed: number | null = null;
  /** 로딩 중에 바뀐 화면 크기(엔진을 만들 때 쓴다) */
  let pendingViewport: { w: number; h: number; dpr: number } | null = null;
  /** 엔진이 생기기 전에 온 등급 차례·이름 */
  let pendingTiers: { tierRank?: string[]; tierNames?: Record<string, string> } | null = null;
  /** 기다리는 그리기(끌기·확대 메시지가 몰려도 프레임마다 한 번만 그린다, docs/frontend.md §3.5 '그리기') */
  let frame: Promise<void> | null = null;
  /** 마우스가 있는 화면 점(떠나면 null). 카메라가 바뀌어도 같은 점으로 다시 판정한다(ADR-0236) */
  let hoverPoint: { x: number; y: number } | null = null;
  /** 화면에 알린 마지막 값 */
  let hoverPosted = false;
  /** 누름에 확대로 답한 시각 */
  let zoomedAt = Number.NEGATIVE_INFINITY;
  /** 마우스 올림 좌석을 맞춘다. 좌석이 바뀌었으면 true */
  const syncHover = (): boolean => {
    if (!engine) return false;
    const changed = hoverPoint ? engine.hoverAt(hoverPoint.x, hoverPoint.y) : engine.clearHover();
    const on = engine.hovered >= 0;
    if (on !== hoverPosted) {
      hoverPosted = on;
      host.post({ type: 'hover', selectable: on });
    }
    return changed;
  };
  const drawSoon = (): Promise<void> =>
    (frame ??= host.nextFrame().then(() => {
      frame = null;
      draw();
    }));
  /** 단계·배율이 바뀌었으면 view를 알린다 */
  const notifyView = () => {
    if (!engine) return;
    const v = { type: 'view' as const, level: engine.level(), zoom: Math.round(engine.zoom() * 1000) / 1000, maxZoom: Math.round(engine.maxZoom() * 1000) / 1000, selectable: engine.selectable(), camera: { ...engine.cam } };
    const key = JSON.stringify(v);
    if (key !== lastView) {
      lastView = key;
      host.post(v);
    }
  };
  /** 그리고 view를 알린다 */
  const draw = () => {
    if (!engine) return;
    syncHover();
    engine.draw();
    notifyView();
  };
  const fail = (e: unknown) =>
    host.post({
      type: 'error',
      message: String((e as Error)?.message ?? e),
      ...(e instanceof FetchFailed ? { source: e.source, status: e.status, ...(e.problem ? { problem: e.problem } : {}), ...(e.retryAfter !== undefined ? { retryAfter: e.retryAfter } : {}) } : {}),
    });
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
          host.fetch(m.layoutUrl, { credentials: 'omit', signal: timeoutSignal() }),
          m.snapshotUrl ? host.fetch(m.snapshotUrl, { credentials: 'include', headers, cache: 'no-store', signal: timeoutSignal() }) : Promise.resolve(null),
        ]);
        // 스냅샷을 먼저 본다: 401·403은 예매 시간이 끝난 것이라 좌석맵 파일 오류보다 앞선다
        if (snapRes && !snapRes.ok) throw await failed('snapshot', snapRes);
        if (!layoutRes.ok) throw await failed('layout', layoutRes);
        let file = (await layoutRes.json()) as SeatMapColumnsFile;
        const snapBytes = snapRes ? await snapRes.arrayBuffer() : undefined;
        // 스냅샷의 판이 받은 좌석맵과 다르면 그 판의 파일을 한 번 다시 받는다(§4.4.2). 그래도 다르면 엔진이 오류로 알린다
        if (snapBytes) {
          const want = decodeSnapshot(snapBytes).layoutVersion;
          const again = want === file.layoutVersion ? undefined : layoutUrlAt(m.layoutUrl, want);
          if (again) {
            const res = await host.fetch(again, { credentials: 'omit', signal: timeoutSignal() });
            if (!res.ok) throw await failed('layout', res);
            file = (await res.json()) as SeatMapColumnsFile;
          }
        }
        // 엔진은 파일을 다 받은 뒤에 만든다(그 전에 온 카메라·고르기는 무시한다)
        engine?.cache.clear();
        const e = new SeatMapEngine({
          ctx,
          width: pendingViewport?.w ?? m.width,
          height: pendingViewport?.h ?? m.height,
          dpr: pendingViewport?.dpr ?? m.dpr,
          theme: m.theme,
          bitmaps,
          tierRank: pendingTiers?.tierRank ?? m.tierRank,
          tierNames: pendingTiers?.tierNames ?? m.tierNames,
        });
        e.load(file, snapBytes);
        engine = e;
        lastView = '';
        engine.draw();
        const drawnAt = host.now();
        // 그린 것이 화면에 나간 시각: 다음 화면 갱신 뒤를 첫 그림 시각으로 본다(성능 추적의 화면 제시와 맞춰 보는 일은 HOT-120)
        await host.nextFrame();
        host.post({ type: 'ready', firstPaintAt: host.now(), drawnAt, layoutVersion: engine.L.layoutVersion, seatCount: engine.L.N, sectionCount: engine.L.S });
        notifyView();
        return;
      }
      if (m.type === 'dispose') {
        engine?.cache.clear();
        engine = null;
        listed = null;
        canvas = null;
        hoverPoint = null;
        hoverPosted = false;
        return;
      }
      if (m.type === 'viewport') {
        size(m.w, m.h, m.dpr);
        if (!engine) pendingViewport = { w: m.w, h: m.h, dpr: m.dpr };
      }
      if (m.type === 'tiers' && !engine) pendingTiers = { ...(m.tierRank ? { tierRank: m.tierRank } : {}), ...(m.tierNames ? { tierNames: m.tierNames } : {}) };
      if (!engine) return;
      switch (m.type) {
        case 'viewport':
          engine.resize(m.w, m.h, m.dpr);
          draw();
          break;
        case 'camera':
          engine.setCamera(m.zoom, m.x, m.y);
          draw();
          break;
        case 'zoomBy':
          engine.zoomBy(m.factor, m.x, m.y);
          await drawSoon();
          break;
        case 'pan':
          engine.panBy(m.dx, m.dy);
          await drawSoon();
          break;
        case 'tiers':
          engine.setTiers(m.tierRank, m.tierNames);
          draw();
          break;
        case 'fit':
          engine.fitAll();
          draw();
          break;
        case 'focusSection':
          if (m.section < engine.L.S) {
            engine.focusSection(m.section);
            draw();
          }
          break;
        case 'pointer':
          if (m.kind === 'move' || m.kind === 'leave') {
            hoverPoint = m.kind === 'move' ? { x: m.x, y: m.y } : null;
            if (syncHover()) await drawSoon();
            break;
          }
          if (m.kind !== 'up') break;
          if (host.now() - zoomedAt < AFTER_ZOOM_GUARD_MS) {
            host.post({ type: 'hit', seatIndex: -1, seatId: null, label: null, tier: null });
            break;
          }
          // 전체 배치도에서 구역을 누르면 그 구역으로 확대한다(seat-hold §10 '구역 누르기'). 같은 동작에서 좌석을 누른 것으로 보지 않는다
          if (engine.level() === 'overview') {
            const s = engine.sectionAt(m.x, m.y);
            if (s >= 0) {
              engine.focusSection(s);
              zoomedAt = host.now();
              draw();
            }
            host.post({ type: 'hit', seatIndex: -1, seatId: null, label: null, tier: null });
            break;
          }
          // 좌석이 작아 고를 수 없는 배율이면 고르지 않고 그 자리를 확대한다(ADR-0236)
          if (engine.zoomToSeat(m.x, m.y)) {
            zoomedAt = host.now();
            draw();
            host.post({ type: 'hit', seatIndex: -1, seatId: null, label: null, tier: null });
            break;
          }
          {
            const h = engine.hit(m.x, m.y);
            // 화면이 한도를 세려면 고를 수 있는 좌석인지 알아야 한다(판매·선택 불가·판매 제외는 select를 무시한다)
            host.post({ type: 'hit', ...h, ...(h.seatIndex >= 0 ? { selectable: engine.canSelect(h.seatIndex) } : {}) });
          }
          break;
        case 'released': {
          for (const s of m.seats) engine.markReleased(s.seatId, s.untilMs);
          draw();
          // 풀리는 때에 맞춰 다시 그린다
          const again = () => {
            const next = engine?.pruneReleased(Date.now());
            draw();
            if (next !== undefined) setTimeout(again, Math.max(50, next - Date.now()));
          };
          const next = engine.pruneReleased(Date.now());
          if (next !== undefined) setTimeout(again, Math.max(50, next - Date.now()));
          break;
        }
        case 'setMine':
          for (const id of m.seatIds) engine.setMine(id, m.on);
          draw();
          break;
        case 'select':
          // 고를 수 있는 좌석만(가능 상태, 판매 제외 아님). 이미 고른 좌석은 풀 수 있다
          if (engine.canSelect(m.seatIndex)) {
            engine.toggleMine(m.seatIndex);
            draw();
            const seats: number[] = [];
            for (let k = 0; k < engine.L.N; k++) if (engine.isMine(k)) seats.push(k);
            host.post({ type: 'selection', seatIndexes: seats });
            if (listed !== null) {
              const { section, offset } = sectionOf(engine.L, m.seatIndex);
              if (section === listed) {
                const offsets = Uint32Array.of(offset);
                const states = Uint8Array.of(listStateOf(engine, m.seatIndex));
                host.post({ type: 'stateChanged', section, version: engine.versions.version[section]!, offsets, states }, [offsets.buffer, states.buffer]);
              }
            }
          }
          break;
        case 'theme':
          engine.setTheme(m.theme);
          draw();
          break;
        case 'listSections': {
          const e = engine;
          host.post({ type: 'sectionList', sections: e.L.file.sections.map((sec, section) => ({ section, name: sec.name, status: sectionStatus(e.L, e.state, section).status })) });
          break;
        }
        case 'listSection': {
          listed = m.section !== null && m.section < engine.L.S ? m.section : null;
          if (listed === null) break;
          const start = engine.L.sectionStart[listed]!;
          const sec = engine.L.file.sections[listed]!;
          const states = new Uint8Array(engine.L.sectionEnd[listed]! - start + 1);
          for (let i = 0; i < states.length; i++) states[i] = listStateOf(engine, start + i);
          const wheelchair: number[] = [];
          sec.seats.flags.forEach((f, i) => {
            if (f & FLAG.WHEELCHAIR) wheelchair.push(i);
          });
          host.post(
            { type: 'sectionState', section: listed, version: engine.versions.version[listed]!, baseIndex: start, states, seats: { seatId: sec.seats.seatId, row: sec.seats.row, number: sec.seats.number, tier: sec.seats.tier, wheelchair }, tiers: engine.L.file.tiers },
            [states.buffer],
          );
          break;
        }
      }
    } catch (e) {
      fail(e);
    }
  };
}

/** OffscreenCanvas로 구역 비트맵을 만든다(Worker와, OffscreenCanvas가 있는 메인 스레드) */
export const offscreenBitmaps: BitmapFactory = {
  create(w, h) {
    const oc = new OffscreenCanvas(w, h);
    const ctx = oc.getContext('2d') as unknown as Ctx2D;
    return {
      ctx,
      finish: () => {
        const image = oc.transferToImageBitmap();
        return { image, close: () => image.close() };
      },
    };
  },
};

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
    offscreenBitmaps,
  );
  scope.onmessage = (e) => void handle(e.data);
}
