// 좌석맵 Worker 진입점(docs/frontend.md §5.2·§4.7, BUILD_ORDER HOT-110). 받은 메시지를 Zod로 검사하고 엔진(engine.ts)에 넘긴다.
// 메인 스레드 대체(client.ts)도 같은 처리기를 쓴다. 캔버스 화소 크기(화면 크기 × dpr)는 두 길 모두 이 처리기가 맞춘다.
// 실시간(BAT-182, HOT-357): 첫 그림 뒤 stream을 받으면 좌석 델타 WebSocket(connection.ts)과 세대·갭 다시 맞추기(delta-sync.ts)를 연다.
// 화면에 보이는 구역만 1초 머문 뒤 구독하고(16개 상한), 델타는 엔진에 반영하며, 전체 보기·16개 초과 구역은 5초 스냅샷으로 갱신한다.
import { deltaE2eMs } from './clock';
import { createSeatConnection, type SeatSocket, type StateDetail } from './connection';
import { createDeltaSync } from './delta-sync';
import { SeatMapEngine, type BitmapFactory } from './engine';
import { FLAG, sectionOf, type SeatMapColumnsFile } from './layout';
import { sectionStatus } from './overview';
import { seatState, type Ctx2D } from './paint';
import { FromWorker, LIST_STATES, ToWorker } from './protocol';
import { decodeSnapshot, MAX_SUBSCRIBED_SECTIONS, type Snapshot } from './wire';

export interface Host {
  post(m: FromWorker, transfer?: Transferable[]): void;
  fetch(url: string, init: RequestInit): Promise<Response>;
  /** 다음 화면 갱신(그린 것이 화면에 나간 뒤). Worker 안 requestAnimationFrame이 없으면 setTimeout */
  nextFrame(): Promise<void>;
  now(): number;
  /** 좌석 델타 WebSocket을 연다(Worker는 전역 WebSocket, 시험은 가짜 소켓을 넣는다) */
  openSocket?(url: string, protocols: string[]): SeatSocket;
  /** 타이머(가짜 시계로 도는 시험이 바꾼다) */
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
  /** 서버 시계(보정 표본이 없을 때). 시험은 가짜 시각을 넣는다 */
  serverNow?(): number;
  random?(): number;
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

/** 구역이 화면에 이만큼 이어져 보이면 구독한다 [가정](docs/frontend.md §5.2, FE-T11) */
const SUBSCRIBE_DWELL_MS = 1_000;
/** 구독 집합을 바꾸는 최소 간격. 서버 상한(초당 2번)보다 보수적이다 [가정](§4.4.1) */
const SUBSCRIBE_MIN_INTERVAL_MS = 1_000;
/** 전체 보기·16개 초과 구역의 스냅샷 갱신 간격 [가정](§5.2) */
const SNAPSHOT_REFRESH_MS = 5_000;

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
  /** 입장 토큰(init이 준 값). stream의 소켓 인증과 스냅샷 요청에 쓴다 */
  let admission: { token: string; ephemeralKey?: string } | null = null;
  /** 스냅샷 주소(init). 구역 스냅샷은 여기에 ?section=을 붙인다 */
  let snapshotUrl: string | null = null;
  /** 좌석 델타 연결과 세대·갭 다시 맞추기 */
  let connection: ReturnType<typeof createSeatConnection> | null = null;
  let sync: ReturnType<typeof createDeltaSync> | null = null;
  /** 지금 좌석으로 보이는 구역(가운데 가까운 차례)과 실제로 보낸 구독 집합 */
  let visible: number[] = [];
  let subscribed: number[] = [];
  /** 구역이 처음 보인 시각(1,000ms 머묾을 센다) */
  const seenAt = new Map<number, number>();
  let sentSectionsKey = '';
  let lastSubscribeAt = Number.NEGATIVE_INFINITY;
  let subscribeTimer: unknown;
  /** 전체 보기 5초 스냅샷·16개 초과 구역 순환 스냅샷 */
  let refreshTimer: unknown;
  let refreshMode: 'overview' | 'seats' | null = null;
  let roundRobin = 0;
  /** 전체 스냅샷 요청이 진행 중인가(느린 응답이 겹치지 않게) */
  let refreshing = false;
  /** 탭이 숨겨졌는가(숨긴 동안 5초 갱신을 멈춘다) */
  let hidden = false;
  /** 마지막 닫힘 코드(4401을 '토큰 만료'로 가르는 데 쓴다) */
  let closeCode: number | null = null;
  /** 스트림 세대(dispose·init 뒤에 늦게 온 응답을 버린다) */
  let streamGen = 0;
  /** 접근성 목록이 연 구역의 델타(offset → state). 스냅샷 뒤 다시 얹은 것까지 모아 한 번에 보낸다 */
  const listedChanges = new Map<number, number>();
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

  // ── 실시간(BAT-182, HOT-357): 스트림·구독·델타·5초 스냅샷 ──────────────
  const setTimer = (fn: () => void, ms: number): unknown => (host.setTimer ? host.setTimer(fn, ms) : setTimeout(fn, ms));
  const clearTimer = (handle: unknown): void => {
    if (handle === undefined) return;
    if (host.clearTimer) host.clearTimer(handle);
    else clearTimeout(handle as ReturnType<typeof setTimeout>);
  };
  const random = (): number => (host.random ? host.random() : Math.random());
  const admissionHeaders = (): Record<string, string> => {
    if (!admission) return {};
    return { 'X-Admission-Token': admission.token, ...(admission.ephemeralKey ? { 'X-Client-Ephemeral-Key': admission.ephemeralKey } : {}) };
  };

  /** 스냅샷 주소에 구역을 붙인다(openapi seatmap-snapshot `?section=`) */
  const sectionUrl = (section: number): string => {
    const base = snapshotUrl!;
    return `${base}${base.includes('?') ? '&' : '?'}section=${section}`;
  };

  /** 구역 하나의 스냅샷(GET seatmap-snapshot?section=). HTTP 오류는 status·Retry-After를 실어 delta-sync가 재시도하게 한다 */
  const fetchSectionSnapshot = async (section: number): Promise<ArrayBuffer> => {
    const res = await host.fetch(sectionUrl(section), { credentials: 'include', headers: admissionHeaders(), cache: 'no-store', signal: timeoutSignal() });
    if (!res.ok) {
      const e = await failed('snapshot', res);
      throw Object.assign(e, { retryAfterMs: (e.retryAfter ?? 0) * 1_000 });
    }
    return res.arrayBuffer();
  };

  /** 전체 스냅샷(전체 보기 5초 갱신). 낡은 판이면 엔진이 쓰지 않는다 */
  const fetchFullSnapshot = async (): Promise<Snapshot> => {
    const res = await host.fetch(snapshotUrl!, { credentials: 'include', headers: admissionHeaders(), cache: 'no-store', signal: timeoutSignal() });
    if (!res.ok) throw await failed('snapshot', res);
    return decodeSnapshot(await res.arrayBuffer());
  };

  const postSections = (): void => {
    const key = `${visible.join(',')}|${subscribed.join(',')}`;
    if (key === sentSectionsKey) return;
    sentSectionsKey = key;
    host.post({ type: 'sections', visible: [...visible], subscribed: [...subscribed] });
  };

  /** 구독 집합을 바꾼다: 전체 집합을 보내고, 새 구역은 스냅샷으로 맞춘 뒤 델타를 얹는다(§4.4.1) */
  const commitSections = (want: number[], now: number): void => {
    const added = want.filter((s) => !subscribed.includes(s));
    subscribed = want.slice(0, MAX_SUBSCRIBED_SECTIONS);
    lastSubscribeAt = now;
    connection?.setSections(subscribed);
    if (sync && added.length > 0) sync.resync(added);
    postSections();
    draw();
  };

  /** 5초 갱신을 멈춘다(숨긴 탭·연결 끝) */
  const stopRefresh = (): void => {
    if (refreshTimer !== undefined) clearTimer(refreshTimer);
    refreshTimer = undefined;
    refreshMode = null;
  };

  /** 전체 보기면 전체 스냅샷 한 번, 좌석 단계에서 16개를 넘으면 구역 하나를 돌아가며 받는다(§5.2) */
  function refreshOnce(): void {
    if (!engine || !connection || !snapshotUrl || hidden) return stopRefresh();
    const e = engine;
    const gen = streamGen;
    const mode = e.level() === 'seats' ? 'seats' : 'overview';
    refreshMode = mode;
    if (mode === 'overview') {
      if (!refreshing) {
        refreshing = true;
        void fetchFullSnapshot()
          .then(
            (snap) => {
              if (gen === streamGen && !hidden && engine && engine.applyFullSnapshot(snap)) draw();
            },
            (err: unknown) => {
              // 401·403은 화면이 대기실로 보내야 한다(다시 물어도 같다). 그 밖은 다음 5초에 다시 시도한다
              if (err instanceof FetchFailed && (err.status === 401 || err.status === 403)) {
                stopRefresh();
                fail(err);
              }
            },
          )
          .finally(() => {
            refreshing = false;
          });
      }
    } else {
      const extra = visible.filter((s) => !subscribed.includes(s));
      if (extra.length > 0) {
        const s = extra[roundRobin % extra.length]!;
        roundRobin = (roundRobin + 1) % extra.length;
        sync?.resync([s]);
      }
    }
    // 요청이 끝나기를 기다리지 않고 다음 차례를 잡는다(요청은 delta-sync가 한 번에 하나로 줄 세운다)
    if (!hidden && refreshTimer === undefined && connection) refreshTimer = setTimer(refreshOnce, SNAPSHOT_REFRESH_MS);
  }

  /** 갱신 주기를 지금 단계에 맞춘다(단계가 바뀔 때만 5초를 다시 센다) */
  function scheduleRefresh(): void {
    const mode = engine && engine.level() === 'seats' ? 'seats' : 'overview';
    if (hidden || !connection || !engine) return stopRefresh();
    if (refreshMode === mode && refreshTimer !== undefined) return;
    if (refreshTimer !== undefined) clearTimer(refreshTimer);
    refreshMode = mode;
    refreshTimer = setTimer(refreshOnce, SNAPSHOT_REFRESH_MS);
  }

  /**
   * 보이는 구역과 구독 집합을 다시 센다. 새로 보인 구역은 1,000ms 이어져야 넣고, 화면 밖으로 나간 구역은 바로 뺀다.
   * 집합이 바뀌면 1,000ms에 한 번만 보내고, 아직 머묾이 차지 않은 구역이 있으면 그때를 예약한다.
   */
  function evaluate(): void {
    const e = engine;
    if (!e || !connection) return;
    const now = host.now();
    visible = e.visibleSections();
    const seen = new Set(visible);
    for (const s of [...seenAt.keys()]) if (!seen.has(s)) seenAt.delete(s);
    for (const s of visible) if (!seenAt.has(s)) seenAt.set(s, now);
    let want: number[] = [];
    if (e.level() === 'seats') {
      for (const s of visible) if (now - (seenAt.get(s) ?? now) >= SUBSCRIBE_DWELL_MS) want.push(s);
      want = want.slice(0, MAX_SUBSCRIBED_SECTIONS);
    }
    const changed = want.join(',') !== subscribed.join(',');
    if (subscribeTimer !== undefined) {
      clearTimer(subscribeTimer);
      subscribeTimer = undefined;
    }
    if (changed) {
      const wait = lastSubscribeAt + SUBSCRIBE_MIN_INTERVAL_MS - now;
      if (wait <= 0) commitSections(want, now);
      else subscribeTimer = setTimer(evaluate, wait);
    } else {
      let earliest = Number.POSITIVE_INFINITY;
      for (const s of visible) {
        if (want.includes(s)) continue;
        earliest = Math.min(earliest, (seenAt.get(s) ?? now) + SUBSCRIBE_DWELL_MS);
      }
      if (earliest > now && earliest !== Number.POSITIVE_INFINITY) subscribeTimer = setTimer(evaluate, Math.max(1, earliest - now));
    }
    postSections();
    scheduleRefresh();
  }

  /** 델타를 반영한 뒤 목록이 연 구역이면 바뀐 좌석만 알린다(§4.4.1) */
  const onApplied = (sections: readonly number[]): void => {
    draw();
    if (listed === null || !sections.includes(listed) || listedChanges.size === 0) return;
    const offsets = Uint32Array.from(listedChanges.keys());
    const states = Uint8Array.from(listedChanges.values());
    listedChanges.clear();
    host.post({ type: 'stateChanged', section: listed, version: engine?.versions.version[listed]!, offsets, states }, [offsets.buffer, states.buffer]);
  };

  /** 스트림 상태를 모두 정리한다(dispose·init 다시) */
  const stopStream = (): void => {
    streamGen++;
    stopRefresh();
    if (subscribeTimer !== undefined) clearTimer(subscribeTimer);
    subscribeTimer = undefined;
    sync?.dispose();
    connection?.dispose();
    sync = null;
    connection = null;
    visible = [];
    subscribed = [];
    seenAt.clear();
    listedChanges.clear();
    sentSectionsKey = '';
    lastSubscribeAt = Number.NEGATIVE_INFINITY;
    roundRobin = 0;
    closeCode = null;
  };

  return async function handle(raw: unknown): Promise<void> {
    const parsed = ToWorker.safeParse(raw);
    if (!parsed.success) return fail(`메시지가 틀렸다: ${parsed.error.issues[0]?.message}`);
    const m = parsed.data;
    try {
      if (m.type === 'init') {
        stopStream();
        admission = m.admission ?? null;
        snapshotUrl = m.snapshotUrl ?? null;
        hidden = false;
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
        stopStream();
        engine?.cache.clear();
        engine = null;
        listed = null;
        canvas = null;
        hoverPoint = null;
        hoverPosted = false;
        admission = null;
        snapshotUrl = null;
        return;
      }
      if (m.type === 'viewport') {
        size(m.w, m.h, m.dpr);
        if (!engine) pendingViewport = { w: m.w, h: m.h, dpr: m.dpr };
      }
      if (m.type === 'tiers' && !engine) pendingTiers = { ...(m.tierRank ? { tierRank: m.tierRank } : {}), ...(m.tierNames ? { tierNames: m.tierNames } : {}) };
      if (!engine) return;
      switch (m.type) {
        case 'stream': {
          // 첫 그림 뒤 한 번만 연다(두 번 보내도 소켓은 하나, T1). 입장 토큰은 init의 admission을 쓴다
          if (connection) break;
          if (!admission || !snapshotUrl) {
            fail('입장 토큰이나 스냅샷 주소가 없어 실시간 연결을 열 수 없다');
            break;
          }
          const e = engine;
          closeCode = null;
          sync = createDeltaSync({
            engine: e,
            fetchSection: fetchSectionSnapshot,
            subscribed: () => subscribed,
            random,
            now: () => host.now(),
            setTimer,
            clearTimer,
            onApplied,
            onError: (err) => fail(err),
            onFatal: (kind, err) => fail(kind === 'unauthorized' ? err : new Error(`좌석 실시간 연결의 좌석맵 판이 다르다: ${String((err as Error)?.message ?? err)}`)),
          });
          const conn = createSeatConnection({
            url: m.url,
            getToken: () => ({ token: admission!.token, expiresAtMs: m.expiresAtMs }),
            openSocket: (url, protocols) => (host.openSocket ? host.openSocket(url, protocols) : (new WebSocket(url, protocols) as unknown as SeatSocket)),
            now: () => host.now(),
            serverNow: () => (host.serverNow ? host.serverNow() : Date.now()),
            setTimer,
            clearTimer,
            random,
            auth: 'subprotocol',
            // 한 번도 열리지 못한 닫힘이 이어지면 HTTP로 토큰을 확인한다(ADR-0240). 스냅샷 경로를 쓴다
            probeAuth: async () => {
              try {
                const res = await host.fetch(snapshotUrl!, { credentials: 'include', headers: admissionHeaders(), cache: 'no-store', signal: timeoutSignal() });
                return res.status === 401 || res.status === 403 ? 'rejected' : res.ok ? 'ok' : 'unknown';
              } catch {
                return 'unknown';
              }
            },
            onState: (state, detail) => {
              // 연결을 맺은 뒤의 4401은 서버가 본 토큰 만료다(§4.4.1). 화면은 '예매 시간이 끝났습니다'(ended)로 간다
              let d: StateDetail = detail;
              if (state === 'ended' && detail && 'reason' in detail && detail.reason === 'token-invalid' && closeCode === 4401) d = { reason: 'token-expired' };
              host.post({ type: 'connection', state, ...(d ?? {}) });
              if (state === 'live') scheduleRefresh();
              else if (state === 'ended') stopRefresh();
            },
            onFrame: (frame) => {
              if (frame.type !== 'delta') return;
              // 목록이 연 구역의 바뀐 좌석을 모아 둔다(스냅샷 뒤 다시 얹은 것까지 onApplied에서 한 번에 보낸다)
              if (listed !== null) {
                for (const s of frame.sections) {
                  if (s.sectionIndex !== listed) continue;
                  s.offsets.forEach((offset, i) => listedChanges.set(offset, s.states[i]!));
                }
              }
              sync?.onDelta(frame);
              // 그린 시각(보정 시계) − (serverTimeMs − maxWaitMs). 시계 표본이 나빠 음수가 나올 수 있어 0 아래는 0으로 본다
              const ms = deltaE2eMs(frame, host.now(), conn.clock);
              if (ms !== undefined) host.post({ type: 'metrics', deltaE2eMs: Math.max(0, ms) });
            },
            onResubscribed: (sections) => sync?.resync(sections),
            onClose: (code) => {
              closeCode = code;
            },
            onError: (err) => fail(err),
          });
          connection = conn;
          conn.start();
          evaluate();
          break;
        }
        case 'visibility':
          hidden = !m.visible;
          if (hidden) stopRefresh();
          else if (connection) {
            // 다시 보이면 바로 한 번 받고 5초 주기를 새로 센다(§5.2)
            stopRefresh();
            refreshOnce();
          }
          break;
        case 'viewport':
          engine.resize(m.w, m.h, m.dpr);
          draw();
          evaluate();
          break;
        case 'camera':
          engine.setCamera(m.zoom, m.x, m.y);
          draw();
          evaluate();
          break;
        case 'zoomBy':
          engine.zoomBy(m.factor, m.x, m.y);
          await drawSoon();
          evaluate();
          break;
        case 'pan':
          engine.panBy(m.dx, m.dy);
          await drawSoon();
          evaluate();
          break;
        case 'tiers':
          engine.setTiers(m.tierRank, m.tierNames);
          draw();
          break;
        case 'fit':
          engine.fitAll();
          draw();
          evaluate();
          break;
        case 'focusSection':
          if (m.section < engine.L.S) {
            engine.focusSection(m.section);
            draw();
            evaluate();
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
              evaluate();
            }
            host.post({ type: 'hit', seatIndex: -1, seatId: null, label: null, tier: null });
            break;
          }
          // 좌석이 작아 고를 수 없는 배율이면 고르지 않고 그 자리를 확대한다(ADR-0236)
          if (engine.zoomToSeat(m.x, m.y)) {
            zoomedAt = host.now();
            draw();
            evaluate();
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
          listedChanges.clear();
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
