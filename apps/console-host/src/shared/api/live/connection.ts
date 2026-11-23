// 탭 하나의 관제 실시간 연결(docs/frontend.md §4.4.4·§4.4.5, ADR-0100, ADR-0360). 탭마다 늘 여는 흐름 하나와 위젯 흐름 하나만 연다.
// - 늘 여는 흐름 GET /v1/ops/live?eventId=&screen=: 사건을 호스트 저장소(alerts·presence·commands)에 넣고 live.on 구독자에게 나눠 준다.
//   reset을 받으면 resync 번호를 올려 화면이 명령·승인 대기를 REST로 다시 읽게 하고, 경보는 경보 목록 REST(GET /v1/ops/alerts)로 갈아 끼운다.
//   처음 열 때도 경보 목록을 한 번 읽는다(콘솔을 열기 전부터 울리던 경보, F-03-3 OPS-380, ADR-0100 결정 2). 읽는 동안 온 alert 사건은 순번과 함께 모아
//   두었다가 목록 응답 seq 뒤의 것만 목록 위에 다시 얹는다
// - 위젯 흐름 GET /v1/ops/events/{eventId}/live?widgets=: WidgetStreams가 보이는 키를 모아 1초 묶어 다시 연다. 떠난 키는 10초 유예,
//   브라우저 탭을 30초 넘게 숨기면 위젯 흐름만 닫고 다시 보이면 다시 열며 키마다 위젯 조회(최근 15분)로 채운다(ADR-0361 결정 9). 늘 여는 흐름은 숨겨도 그대로다
// 닫힘 뒤 토큰 갱신(POST /v1/ops/auth/access-tokens)이 401이면 로그인 화면으로 간다.
import type { HostOperator, HostView, Unsubscribe } from '@peaket/console-contract';
import { ManagedStream, frameData, type RefreshResult, type SseFrame, type StreamFetch } from './live-stream';
import { WidgetStreams } from './widget-stream';
import { createSlotServices, type SlotServices } from './console-services';
import { ensureConsoleApi } from '../index';
import { hostActions, hostStore, type LiveAlert, type LiveControl, type LiveHostState } from '@/shared/model/live-host';

type LiveEvent = 'alert' | 'command' | 'presence' | 'approval' | 'reset' | 'control' | 'autoAction';

const timers = {
  setTimeout: (fn: () => void, ms: number): unknown => globalThis.setTimeout(fn, ms),
  clearTimeout: (h: unknown): void => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
};

const streamFetch: StreamFetch = async (url, init) => {
  const r = await fetch(url, init);
  return { ok: r.ok, status: r.status, body: r.body };
};

async function refreshToken(): Promise<RefreshResult> {
  if (!ensureConsoleApi()) return 'failed';
  try {
    const { createOpsAuthAccessToken } = await import('@peaket/api-client/endpoints/ops');
    await createOpsAuthAccessToken();
    return 'ok';
  } catch (e) {
    const status = (e as { status?: number } | null)?.status;
    return status === 401 ? 'unauthorized' : 'failed';
  }
}

/** reset 뒤 내 승인 대기를 명령 REST(GET /v1/ops/commands?state=PENDING_APPROVAL,REVERT_PENDING)로 다시 읽어 호스트 슬라이스를 바꾼다 */
async function resyncApprovals(): Promise<void> {
  if (!ensureConsoleApi()) return;
  try {
    const { listOpsCommands } = await import('@peaket/api-client/endpoints/ops');
    const r = await listOpsCommands({ state: ['PENDING_APPROVAL', 'REVERT_PENDING'], limit: 100 });
    const items = ((r.data as { items?: unknown[] }).items ?? []) as { commandId?: unknown; type?: unknown; state?: unknown; eventId?: unknown; approvalExpiresAt?: unknown; canApprove?: unknown }[];
    hostActions.replacePending(
      items
        .filter((c) => c.canApprove === true && typeof c.commandId === 'string')
        .map((c) => ({
          commandId: c.commandId as string,
          type: String(c.type ?? ''),
          state: String(c.state ?? ''),
          ...(typeof c.eventId === 'string' ? { eventId: c.eventId } : {}),
          ...(typeof c.approvalExpiresAt === 'string' ? { approvalExpiresAt: c.approvalExpiresAt } : {}),
        })),
    );
  } catch {
    // 다시 읽기 실패: 다음 approval·command 사건이 슬라이스를 고친다
  }
}

/** 경보 목록을 읽는 동안 늘 여는 흐름으로 온 alert 사건(순번은 SSE id) */
let alertResync: { buffered: { seq: number | undefined; alert: LiveAlert }[] } | undefined;
let alertsLoaded = false;

const isAlert = (a: unknown): a is LiveAlert =>
  typeof a === 'object' && a !== null && typeof (a as { alertId?: unknown }).alertId === 'string' && typeof (a as { status?: unknown }).status === 'string';

/** 경보 목록 REST로 경보 슬라이스를 갈아 끼운다(처음 열 때·reset 뒤). 고른 회차와 상관없이 모든 경보를 받는다(플랫폼 묶음도 그린다) */
async function resyncAlerts(): Promise<void> {
  if (!ensureConsoleApi()) return;
  const pending: NonNullable<typeof alertResync> = { buffered: [] };
  alertResync = pending;
  try {
    const { listOpsAlerts } = await import('@peaket/api-client/endpoints/ops');
    const r = await listOpsAlerts();
    if (alertResync !== pending) return; // 더 새로 읽기 시작했다
    const data = (r.data ?? {}) as { items?: unknown[]; seq?: unknown };
    const items = (Array.isArray(data.items) ? data.items : []).filter(isAlert);
    const seq = typeof data.seq === 'number' ? data.seq : 0;
    const after = pending.buffered.filter((b) => b.seq === undefined || b.seq > seq).map((b) => b.alert);
    hostActions.replaceAlerts(items, after);
  } catch {
    // 다시 읽기 실패: 슬라이스는 그대로 두고 다음 사건이 고친다
  } finally {
    if (alertResync === pending) alertResync = undefined;
  }
}

/** 다시 보일 때 위젯 조회로 채우는 창 15분 [가정](frontend §5.7 '다시 보일 때') */
const REFILL_RANGE_MS = 15 * 60_000;

/** 위젯 조회 REST(GET /v1/ops/widgets/{widgetKey}?eventId=&from=&to=) */
async function queryWidget(key: string, vars: { eventId?: string | null; from?: string; to?: string }): Promise<unknown> {
  if (!ensureConsoleApi()) throw new Error('관제 API 주소가 없다');
  const { getOpsWidget } = await import('@peaket/api-client/endpoints/ops');
  const eventId = vars.eventId ?? hostStore.getState().scope.eventId;
  const r = await getOpsWidget(key, { ...(eventId ? { eventId } : {}), ...(vars.from ? { from: vars.from } : {}), ...(vars.to ? { to: vars.to } : {}) });
  return r.data;
}

/** 숨긴 탭에서 돌아올 때 키마다 최근 15분 창을 한 번 받는다 */
function refillWidget(key: string, eventId: string): Promise<unknown> {
  const to = new Date();
  return queryWidget(key, { eventId, from: new Date(to.getTime() - REFILL_RANGE_MS).toISOString(), to: to.toISOString() });
}

const listeners = new Map<LiveEvent, Set<(p: unknown) => void>>();
let liveStream: ManagedStream | undefined;
let widgets: WidgetStreams | undefined;
let origin = '';
let screen = 'console';
let goLogin: () => void = () => {
  if (typeof location !== 'undefined') location.assign('/login');
};

function emit(event: LiveEvent, payload: unknown): void {
  for (const h of [...(listeners.get(event) ?? [])]) {
    try {
      h(payload);
    } catch {
      // 한 구독자의 오류가 다른 구독자를 막지 않는다
    }
  }
}

function onLiveFrame(f: SseFrame): void {
  const data = frameData(f);
  if (data === undefined) return;
  const d = data as Record<string, unknown>;
  switch (f.event) {
    case 'command':
      if (typeof d.commandId === 'string' && typeof d.state === 'string') hostActions.command(d.commandId, d.state);
      emit('command', data);
      break;
    case 'approval':
      if (typeof d.commandId === 'string') {
        hostActions.approval({
          commandId: d.commandId,
          type: String(d.type ?? ''),
          state: String(d.state ?? ''),
          ...(typeof d.eventId === 'string' ? { eventId: d.eventId } : {}),
          ...(typeof d.approvalExpiresAt === 'string' ? { approvalExpiresAt: d.approvalExpiresAt } : {}),
        });
      }
      emit('approval', data);
      break;
    case 'alert':
      if (isAlert(data)) {
        hostActions.alert(data);
        if (alertResync) {
          const seq = f.lastEventId !== undefined && /^\d+$/.test(f.lastEventId) ? Number(f.lastEventId) : undefined;
          alertResync.buffered.push({ seq, alert: data });
        }
      }
      emit('alert', data);
      break;
    case 'presence':
      if (typeof d.eventId === 'string' && Array.isArray(d.operators)) hostActions.presence(d.eventId, d.operators as HostOperator[]);
      emit('presence', data);
      break;
    case 'control':
      // 본문 그대로(asyncapi OpsControl: 회차·종류·입력 없음 시작·없는 입력·지금 목표·감축, F-03-3)
      if (typeof d.kind === 'string') hostActions.control(data as LiveControl);
      emit('control', data);
      break;
    case 'autoAction':
      emit('autoAction', data);
      break;
    case 'reset':
      // 알림 표 밖의 번호로 다시 붙었다(ADR-0100 결정 2): 호스트는 승인 대기를 명령 REST로, 경보를 경보 목록 REST로 다시 읽고,
      // 화면은 resync 번호·reset 구독으로 자기 목록을 다시 읽는다
      hostActions.resync();
      void resyncApprovals();
      void resyncAlerts();
      emit('reset', data);
      break;
    default:
      break;
  }
}

function liveUrl(): string {
  const q = new URLSearchParams();
  const eventId = hostStore.getState().scope.eventId;
  if (eventId) q.set('eventId', eventId);
  q.set('screen', screen);
  return `${origin}/v1/ops/live?${q.toString()}`;
}

function newStream(url: () => string, onFrame: (f: SseFrame) => void, resume: boolean, onOpen?: () => void): ManagedStream {
  return new ManagedStream({
    url,
    fetch: streamFetch,
    timers,
    random: Math.random,
    refresh: refreshToken,
    onUnauthorized: () => goLogin(),
    onFrame,
    resume,
    onStatus: resume ? (s) => hostActions.connected(s === 'open') : undefined,
    ...(onOpen ? { onOpen } : {}),
  });
}

/** 탭의 연결을 연다(이미 열었으면 그대로). 관제 API 주소가 없으면 열지 않는다 */
export function startLive(o: { origin: string; screen?: string; onUnauthorized?: () => void }): void {
  if (!o.origin) return;
  origin = o.origin.replace(/\/+$/, '');
  if (o.screen) screen = o.screen;
  if (o.onUnauthorized) goLogin = o.onUnauthorized;
  liveStream ??= newStream(liveUrl, onLiveFrame, true);
  liveStream.start();
  if (!alertsLoaded) {
    alertsLoaded = true;
    void resyncAlerts();
  }
  widgets ??= new WidgetStreams({ origin, timers, createStream: (url, onFrame) => newStream(url, onFrame, false), refill: refillWidget });
  widgets.setEvent(hostStore.getState().scope.eventId);
  watchVisibility();
}

let visibilityHooked = false;

/** 브라우저 탭 숨김을 위젯 흐름에 알린다(늘 여는 흐름은 숨겨도 그대로다, frontend §4.4.4 '숨긴 탭') */
function watchVisibility(): void {
  if (visibilityHooked || typeof document === 'undefined' || typeof document.addEventListener !== 'function') return;
  visibilityHooked = true;
  const report = () => setLiveHidden(document.visibilityState === 'hidden');
  document.addEventListener('visibilitychange', report);
  report();
}

/** 브라우저 탭을 숨겼는가(참이면 30초 뒤 위젯 흐름만 닫는다). 시험은 이 함수로 숨김을 만든다 */
export function setLiveHidden(hidden: boolean): void {
  widgets?.setHidden(hidden);
}

/** 탭의 연결을 닫는다(로그아웃·시험) */
export function stopLive(): void {
  liveStream?.stop();
  widgets?.close();
}

/** 고른 회차를 바꾼다: 늘 여는 흐름은 접속자 회차가 바뀌어 다시 열고(Last-Event-ID는 이어 감), 위젯 흐름은 바로 새 회차로 연다 */
export function setLiveEvent(eventId: string | null, nextScreen?: string): void {
  const changed = hostStore.getState().scope.eventId !== eventId || (nextScreen !== undefined && nextScreen !== screen);
  if (nextScreen) screen = nextScreen;
  hostActions.scope(eventId);
  if (!changed) return;
  if (liveStream?.running) liveStream.restart();
  widgets?.setEvent(eventId);
}

/** 늘 여는 흐름 사건을 듣는다 */
export function onLive(event: LiveEvent, h: (p: unknown) => void): Unsubscribe {
  let set = listeners.get(event);
  if (!set) {
    set = new Set();
    listeners.set(event, set);
  }
  set.add(h);
  return () => set.delete(h);
}

/** 원격에 넘기는 읽기 전용 호스트 상태 */
function hostView(s: LiveHostState): HostView {
  return { scope: s.scope, control: s.control, autoActions: s.autoActions, alerts: s.alerts, presence: s.presence };
}

/** 위젯 자리 하나의 통로와 호스트 손잡이(화면 안·밖) */
export function slotFor(slot: string): SlotServices {
  return createSlotServices({
    slot,
    query: (key, vars) => queryWidget(key, vars),
    subscribe(key, next) {
      if (!widgets) return () => undefined;
      return widgets.subscribe(key, (m) => next(m.value, m.at));
    },
    on: (event, h) => onLive(event, h),
    host: {
      get: () => hostView(hostStore.getState()),
      subscribe: (l) => hostStore.subscribe((s) => l(hostView(s))),
      // 원격은 자기 React 트리에서 이 값을 읽는다(지금 값. 바뀜은 subscribe로 받는다)
      use: (f) => f(hostView(hostStore.getState())),
    },
    permissions: ['ops:read'],
    timers,
  });
}

/** 위젯 자리 하나의 ConsoleServices */
export function servicesFor(slot: string) {
  return slotFor(slot).services;
}

/** 시험·진단: 지금 연 위젯 키 */
export function openWidgetKeys(): readonly string[] {
  return widgets?.openKeys ?? [];
}

/** 시험·진단: 지금 목록에 든 위젯 키(구독 중 + 유예 중) */
export function wantedWidgetKeys(): readonly string[] {
  return widgets?.wantedKeys ?? [];
}
