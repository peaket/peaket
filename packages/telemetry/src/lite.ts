// @peaket/telemetry lite 판(대기실 경량 페이지도 싣는다, docs/frontend.md §5.16·§5.1). 브라우저 지표 묶음(asyncapi RumSample 판 2)을
// 모아 같은 출처 /_t/rum으로 보낸다. 묶음은 64KiB 이하이고, 화면이 보이는 동안 60초 [가정]마다와 화면이 숨겨질 때 보낸다.
// route는 앱의 경로 템플릿 목록에 있는 값만 싣는다(실제 주소는 그 틀로 바꾸고, 맞는 틀이 없으면 (unknown). 쿼리·조각·식별값은 싣지 않는다, FE-T22).
// 원인 정보(attribution)는 계약대로 선택자 수준만 싣는다: 아래 허용 칸의 선택자 문자열과 숫자만 남기고, 주소·성능 항목 객체는 버린다.

export const MAX_BATCH_BYTES = 64 * 1024;
export const FLUSH_INTERVAL_MS = 60_000;
const UNKNOWN_ROUTE = '(unknown)';

export type App = 'web' | 'queue-room' | 'partner' | 'console' | 'scanner';

/** 화면이 넘기는 값(묶음 공통 칸은 batcher가 채운다) */
export interface RumInput {
  /** 경로 템플릿(예: /events/[id]). 템플릿 모양이 아니면 (unknown)으로 싣는다 */
  route: string;
  metrics?: { lcp?: number; inp?: number; cls?: number; fcp?: number; ttfb?: number };
  longTasks?: { count: number; totalMs: number };
  errors?: { count: number };
  apiFail?: { network?: number; http4xx?: number; http5xx?: number; timeout?: number };
  marks?: Partial<Record<'queue_reflect_ms' | 'seat_delta_e2e_ms' | 'seatmap_ready_ms' | 'payment_confirm_ms' | 'ws_reconnects' | 'scan_judge_ms', number>>;
  /** web-vitals 속성 정보 빌드의 원인 칸. 허용 칸만 남는다(ATTRIBUTION_STRINGS·ATTRIBUTION_NUMBERS) */
  attribution?: Record<string, unknown>;
}

/** 원인 정보에서 싣는 선택자 칸(INP 대상, LCP 요소, CLS 가장 큰 이동 대상)과 상태 칸 */
export const ATTRIBUTION_STRINGS = ['interactionTarget', 'interactionType', 'element', 'largestShiftTarget', 'loadState'] as const;
/** 원인 정보에서 싣는 숫자 칸(밀리초·점수) */
export const ATTRIBUTION_NUMBERS = [
  'inputDelay',
  'processingDuration',
  'presentationDelay',
  'timeToFirstByte',
  'resourceLoadDelay',
  'resourceLoadDuration',
  'elementRenderDelay',
  'largestShiftValue',
  'largestShiftTime',
] as const;
/** 주소처럼 보이는 값(선택자에는 없다) */
const URL_LIKE = /:\/\/|^\/\/|[?&][^=\s]*=/;

function safeAttribution(a: Record<string, unknown> | undefined): Record<string, string | number> | undefined {
  if (!a) return undefined;
  const out: Record<string, string | number> = {};
  for (const k of ATTRIBUTION_STRINGS) {
    const v = a[k];
    if (typeof v === 'string' && !URL_LIKE.test(v)) out[k] = v;
  }
  for (const k of ATTRIBUTION_NUMBERS) {
    const v = a[k];
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** 실제 주소 → 앱의 경로 템플릿(맞는 것이 없으면 (unknown)) */
export function routeTemplate(urlOrPath: string, templates: readonly string[]): string {
  let path: string;
  try {
    path = new URL(urlOrPath, 'https://peaket.invalid').pathname;
  } catch {
    return UNKNOWN_ROUTE;
  }
  const segs = path.split('/').filter(Boolean);
  // 맞는 틀 가운데 고정 조각이 가장 많은 틀(같으면 목록에서 앞의 틀). '/events/new'가 '/events/[id]'보다 먼저다
  let best: string = UNKNOWN_ROUTE;
  let bestStatic = -1;
  for (const t of templates) {
    const ts = t.split('/').filter(Boolean);
    if (ts.length !== segs.length) continue;
    if (!ts.every((p, i) => (p.startsWith('[') ? segs[i] !== '' : p === segs[i]))) continue;
    const fixed = ts.filter((p) => !p.startsWith('[')).length;
    if (fixed > bestStatic) [best, bestStatic] = [t, fixed];
  }
  return best;
}

export interface BatcherOptions {
  app: App;
  /** 앱의 경로 템플릿 목록(예: /events/[id]). route는 이 목록에 있는 값만 싣는다 */
  routes: readonly string[];
  send: (body: string) => Promise<void>;
  dpl?: string;
  sampleRate?: number;
  deviceClass?: () => 'mobile' | 'tablet' | 'desktop';
  navType?: () => 'navigate' | 'reload' | 'back_forward' | 'prerender' | 'soft';
  uuid?: () => string;
}

export function createRumBatcher(o: BatcherOptions) {
  const queue: string[] = [];
  const uuid = o.uuid ?? (() => crypto.randomUUID());
  const bytes = (s: string) => new TextEncoder().encode(s).length;
  const state = { dropped: 0 };

  function add(input: RumInput) {
    // 화면이 넘긴 값은 아는 칸만 골라 싣고, 공통 칸(판·사건 키·앱·기기·배포·표본)은 batcher가 정한다
    const attribution = safeAttribution(input.attribution);
    const event = {
      schemaVersion: 2,
      eventKey: uuid(),
      app: o.app,
      route: o.routes.includes(input.route) ? input.route : routeTemplate(input.route, o.routes),
      ...(input.metrics ? { metrics: input.metrics } : {}),
      ...(input.longTasks ? { longTasks: input.longTasks } : {}),
      ...(input.errors ? { errors: input.errors } : {}),
      ...(input.apiFail ? { apiFail: input.apiFail } : {}),
      ...(input.marks ? { marks: input.marks } : {}),
      ...(attribution ? { attribution } : {}),
      ...(o.deviceClass ? { deviceClass: o.deviceClass() } : {}),
      ...(o.navType ? { navType: o.navType() } : {}),
      ...(o.dpl ? { dpl: o.dpl } : {}),
      ...(o.sampleRate !== undefined ? { sampleRate: o.sampleRate } : {}),
    };
    const json = JSON.stringify(event);
    // 묶음 괄호 두 바이트를 더해도 64KiB를 넘는 사건은 보내지 않는다
    if (bytes(json) + 2 > MAX_BATCH_BYTES) {
      state.dropped++;
      return;
    }
    queue.push(json);
  }

  /** 큐 앞에서 64KiB 이하 묶음 하나를 뗀다(본문과 바이트 수) */
  function takeBatch(): { body: string; size: number } {
    const batch: string[] = [];
    let size = 2;
    while (queue.length > 0) {
      const next = bytes(queue[0]!) + (batch.length > 0 ? 1 : 0);
      if (size + next > MAX_BATCH_BYTES) break;
      batch.push(queue.shift()!);
      size += next;
    }
    return { body: `[${batch.join(',')}]`, size };
  }

  /**
   * 쌓인 사건을 64KiB 이하 묶음으로 나눠 보낸다. 주기 보내기(interval)는 묶음을 하나씩 기다려 모두 보낸다.
   * 화면을 숨길 때(hidden)는 keepalive 한도(문서 하나에서 아직 나가는 중인 keepalive 본문의 합 64KiB, Fetch 표준) 안의 묶음만 바로 내보내고
   * 나머지는 큐에 남긴다(다시 보이면 다음 주기에 보낸다). 한도를 넘겨 내보내면 브라우저가 그 요청을 바로 거절해 잃기 때문이다
   */
  async function flush(reason: 'interval' | 'hidden') {
    if (reason === 'interval') {
      while (queue.length > 0) await o.send(takeBatch().body);
      return;
    }
    const sends: Array<Promise<void>> = [];
    let inFlight = 0;
    while (queue.length > 0) {
      const first = bytes(queue[0]!) + 2;
      if (inFlight + first > MAX_BATCH_BYTES) break;
      const b = takeBatch();
      if (inFlight + b.size > MAX_BATCH_BYTES) {
        // 이 묶음을 다 실으면 한도를 넘는다: 되돌리고 멈춘다
        queue.unshift(...(JSON.parse(b.body) as unknown[]).map((e) => JSON.stringify(e)));
        break;
      }
      inFlight += b.size;
      sends.push(o.send(b.body));
    }
    await Promise.allSettled(sends);
  }

  return {
    add,
    flush,
    /** 아직 보내지 않은 사건 수 */
    get pending() {
      return queue.length;
    },
    get dropped() {
      return state.dropped;
    },
  };
}

export interface SendDeps {
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  sendBeacon?: (url: string, body: string) => boolean;
  /** 시험에서 바꾼다(기본은 이 브라우저가 keepalive를 아는지) */
  keepaliveSupported?: boolean;
}

/** 이 브라우저의 fetch가 keepalive를 아는가(Request.keepalive, §1.5 'fetch keepalive' 행: Firefox 133·Safari 13부터) */
export function keepaliveSupported(): boolean {
  return typeof Request === 'function' && 'keepalive' in Request.prototype;
}

/**
 * fetch(keepalive, 쿠키 없음)로 보내고, keepalive가 안 되는 브라우저만 sendBeacon(쿠키가 실려 가므로 게이트웨이가 지운다, observability §11).
 * keepalive로 보냈는데 실패한 묶음은 버린다(sendBeacon으로 다시 보내면 쿠키가 실린 같은 묶음이 두 번 갈 수 있다)
 */
export async function sendBatch(url: string, body: string, deps: SendDeps = {}): Promise<void> {
  const keepalive = deps.keepaliveSupported ?? keepaliveSupported();
  if (!keepalive) {
    const beacon = deps.sendBeacon ?? ((u: string, b: string) => navigator.sendBeacon(u, b));
    beacon(url, body);
    return;
  }
  const f = deps.fetch ?? ((u: string, i: RequestInit) => fetch(u, i));
  try {
    await f(url, { method: 'POST', body, keepalive: true, credentials: 'omit', headers: { 'content-type': 'application/json' } });
  } catch {
    // 지표는 잃어도 된다(다시 보내지 않는다)
  }
}

/** 보내기 일정을 거는 문서(시험은 가짜로 바꾼다) */
export interface ScheduleDoc {
  visibilityState: DocumentVisibilityState;
  addEventListener(type: 'visibilitychange', f: () => void): void;
  removeEventListener(type: 'visibilitychange', f: () => void): void;
}

/** 화면이 보이는 동안 60초 [가정]마다, 화면을 숨길 때 바로 보낸다(§5.16 '묶음'). 멈추는 함수를 돌려준다 */
export function startRumSchedule(b: Pick<ReturnType<typeof createRumBatcher>, 'flush'>, doc: ScheduleDoc = document, intervalMs = FLUSH_INTERVAL_MS): () => void {
  const timer = setInterval(() => {
    if (doc.visibilityState === 'visible') void b.flush('interval');
  }, intervalMs);
  const onVisibility = () => {
    if (doc.visibilityState === 'hidden') void b.flush('hidden');
  };
  doc.addEventListener('visibilitychange', onVisibility);
  return () => {
    clearInterval(timer);
    doc.removeEventListener('visibilitychange', onVisibility);
  };
}
