// 좌석 델타 WebSocket 연결(docs/frontend.md §3.5·§4.4.1, ADR-0240, FE-T11, BUILD_ORDER HOT-100). Worker 안에서 돈다.
// 소켓·타이머·시계·난수를 주입받아 가짜 서버로 시험한다. 화면 상태는 onState로 알리고, 메인 스레드의 XState 기계가 받아 그린다.
import { ClockSync } from './clock';
import { decodeFrame, encodeAuth, encodeSubscribe, encodeTimeSync, MAX_SUBSCRIBED_SECTIONS, type Frame } from './wire';

export const SEATS_PROTOCOL = 'peaket.seats.v1';
export const AUTH_PROTOCOL_PREFIX = 'peaket.auth.';
/** 이 시간 동안 어떤 프레임도 없으면 끊고 다시 붙는다 [가정] */
export const HEARTBEAT_TIMEOUT_MS = 35_000;
/** 여는 중에 답이 없으면 포기하는 시간 [가정] */
const OPEN_TIMEOUT_MS = 10_000;
/** 이만큼 붙어 있어야 실패 횟수를 지운다 [가정](답하고 바로 닫는 서버에 몰리지 않게) */
const STABLE_MS = 10_000;
/** 시계 맞추기 간격 [가정] */
export const TIME_SYNC_MS = 60_000;
const RECONNECT_BASE_MS = 500;
const RECONNECT_CAP_MS = 10_000;
/** 1012(서버 재시작) 뒤 무작위로 기다리는 범위 */
const RESTART_JITTER_MS = 5_000;
/** 4429(연결 과다) 뒤 최소 대기 */
const TOO_MANY_WAIT_MS = 10_000;
/** 한 번도 열리지 못한 닫힘이 이만큼 이어지면 토큰을 HTTP로 확인한다 [가정](ADR-0240) */
const PROBE_AFTER_FAILURES = 3;
/** 묶음 간격이 이보다 크면 Degraded다(평시 100, Degraded 1000) */
const NORMAL_BATCH_MS = 100;
/** 소켓 OPEN(WebSocket.OPEN) */
const OPEN = 1;

export type ConnectionState = 'connecting' | 'live' | 'reconnecting' | 'ended';
export type EndReason = 'token-invalid' | 'token-expired' | 'forbidden';
export type StateDetail = { reason: EndReason } | { degraded: boolean } | undefined;

export type CloseDecision = { kind: 'end'; reason: EndReason } | { kind: 'forbidden' } | { kind: 'retry'; delayMs: number };

/** 닫힘 코드 → 다음 동작(§4.4.1 '닫힘 코드'). attempt는 프레임을 받은 뒤 이어진 실패 횟수 */
export function closeDecision(code: number, attempt: number, random: () => number): CloseDecision {
  if (code === 4401) return { kind: 'end', reason: 'token-invalid' };
  if (code === 4403) return { kind: 'forbidden' };
  if (code === 1012) return { kind: 'retry', delayMs: Math.floor(random() * RESTART_JITTER_MS) };
  if (code === 4429) return { kind: 'retry', delayMs: TOO_MANY_WAIT_MS + Math.floor(random() * RESTART_JITTER_MS) };
  return { kind: 'retry', delayMs: Math.floor(random() * Math.min(RECONNECT_CAP_MS, RECONNECT_BASE_MS * 2 ** attempt)) };
}

/** 쓰는 만큼만 적은 WebSocket 모양(시험은 가짜로 바꾼다) */
export interface SeatSocket {
  protocol: string;
  binaryType: string;
  readyState: number;
  onopen: (() => void) | null;
  onmessage: ((e: { data: unknown }) => void) | null;
  onclose: ((e: { code: number }) => void) | null;
  onerror: (() => void) | null;
  send(data: Uint8Array): void;
  close(code?: number): void;
}

export interface SeatConnectionDeps {
  url: string;
  /** 지금 입장 토큰과 만료(벽시계 ms). 다시 붙을 때마다 부른다(토큰이 갱신될 수 있다) */
  getToken(): { token: string; expiresAtMs: number };
  openSocket(url: string, protocols: string[]): SeatSocket;
  /** 단조 시계(performance.now). TimeSync·왕복에 쓴다 */
  now(): number;
  /** 서버 시각(보정 시계, §3.3). 기기 시계를 넘기면 빠른 기기가 첫 연결에 끝난다. 왕복을 잰 뒤에는 그 값을 먼저 쓴다 */
  serverNow(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  random(): number;
  /** 'first-message'는 게이트웨이가 하위 프로토콜을 못 읽을 때의 대체다(§4.4.1 '대체') */
  auth?: 'subprotocol' | 'first-message' | undefined;
  /** 핸드셰이크 거절은 브라우저에 1006으로만 보여 HTTP로 토큰을 확인한다(ADR-0240) */
  probeAuth?: (() => Promise<'ok' | 'rejected' | 'unknown'>) | undefined;
  /** 4403: 좌석맵 파일과 스냅샷을 다시 받는다. 성공하면 true */
  onForbidden?: (() => Promise<boolean>) | undefined;
  onState(state: ConnectionState, detail?: StateDetail): void;
  onFrame(frame: Frame, receivedAt: number): void;
  /** 다시 붙어 구독을 보냈다: 이 구역들의 스냅샷을 다시 받는다 */
  onResubscribed(sections: readonly number[]): void;
  /** 닫힘 코드와 열렸는지(텔레메트리, ADR-0240 결정 11) */
  onClose?: ((code: number, opened: boolean) => void) | undefined;
  onError(error: unknown): void;
}

function assertSecure(url: string): void {
  const u = new URL(url);
  if (u.protocol === 'wss:') return;
  if (u.protocol === 'ws:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]')) return;
  throw new Error('좌석 연결은 wss만 쓴다(로컬 개발 주소 말고는 ws를 거부한다)');
}

export function createSeatConnection(d: SeatConnectionDeps) {
  assertSecure(d.url);
  const auth = d.auth ?? 'subprotocol';
  const clock = new ClockSync();
  let socket: SeatSocket | null = null;
  let current: ConnectionState = 'connecting';
  let degraded = false;
  let sections: number[] = [];
  let sentSections = '';
  let attempt = 0;
  let failedOpens = 0;
  let forbiddenSeen = false;
  let everLive = false;
  let opened = false;
  let disposed = false;
  let reconnects = 0;
  let retryTimer: unknown;
  let watchdog: unknown;
  let syncTimer: unknown;
  let stableTimer: unknown;

  const nowServer = () => clock.toServer(d.now()) ?? d.serverNow();

  const stopTimers = () => {
    for (const t of [retryTimer, watchdog, syncTimer, stableTimer]) if (t !== undefined) d.clearTimer(t);
    retryTimer = watchdog = syncTimer = stableTimer = undefined;
  };

  const setState = (s: ConnectionState, detail?: StateDetail) => {
    if (s === current && detail === undefined) return;
    current = s;
    d.onState(s, detail);
  };

  const end = (reason: EndReason) => {
    stopTimers();
    detach();
    setState('ended', { reason });
  };

  /** 지금 소켓에서 손을 뗀다(늦게 온 사건을 받지 않는다) */
  function detach(): SeatSocket | null {
    const s = socket;
    socket = null;
    if (s) s.onopen = s.onmessage = s.onclose = s.onerror = null;
    return s;
  }

  const armWatchdog = (ms = HEARTBEAT_TIMEOUT_MS) => {
    if (watchdog !== undefined) d.clearTimer(watchdog);
    watchdog = d.setTimer(() => {
      watchdog = undefined;
      // 닫힘 사건이 늦을 수 있어 기다리지 않는다
      const s = detach();
      s?.close();
      lost(1006);
    }, ms);
  };

  const sendTimeSync = () => {
    if (socket?.readyState === OPEN) socket.send(encodeTimeSync(d.now()));
    syncTimer = d.setTimer(sendTimeSync, TIME_SYNC_MS);
  };

  const sendSections = () => {
    if (socket?.readyState !== OPEN) return;
    socket.send(encodeSubscribe(sections));
    sentSections = sections.join(',');
  };

  function open(): void {
    if (disposed) return;
    const { token, expiresAtMs } = d.getToken();
    if (nowServer() >= expiresAtMs) return end('token-expired');
    opened = false;
    sentSections = '';
    let s: SeatSocket;
    try {
      s = d.openSocket(d.url, auth === 'subprotocol' ? [SEATS_PROTOCOL, AUTH_PROTOCOL_PREFIX + token] : [SEATS_PROTOCOL]);
    } catch {
      // 브라우저 오류 글에 하위 프로토콜(토큰)이 들어갈 수 있어 넘기지 않는다
      d.onError(new Error('좌석 소켓을 열지 못했다'));
      return lost(1006);
    }
    s.binaryType = 'arraybuffer';
    socket = s;
    armWatchdog(OPEN_TIMEOUT_MS);
    s.onopen = () => {
      if (s !== socket) return;
      if (s.protocol !== SEATS_PROTOCOL) {
        d.onError(new Error('서버가 좌석 하위 프로토콜을 고르지 않았다'));
        s.close();
        return;
      }
      opened = true;
      failedOpens = 0;
      stableTimer = d.setTimer(() => {
        stableTimer = undefined;
        attempt = 0;
      }, STABLE_MS);
      if (everLive) reconnects++;
      if (auth === 'first-message') s.send(encodeAuth(d.getToken().token));
      // 다시 붙으면 구독을 먼저 보낸다(§4.4.1 '살아 있음')
      if (sections.length > 0) sendSections();
      const again = everLive;
      everLive = true;
      setState('live');
      if (again && sections.length > 0) d.onResubscribed(sections);
      if (syncTimer !== undefined) d.clearTimer(syncTimer);
      sendTimeSync();
      armWatchdog();
    };
    s.onmessage = (e) => {
      if (s !== socket) return;
      armWatchdog();
      if (!(e.data instanceof ArrayBuffer)) return;
      const receivedAt = d.now();
      let frame: Frame;
      try {
        frame = decodeFrame(e.data);
      } catch (err) {
        d.onError(err);
        return;
      }
      if (frame.type === 'heartbeat') clock.sample(frame.serverTimeMs, frame.echoClientTimeMs, receivedAt);
      else if (frame.type === 'batchInterval') {
        degraded = frame.intervalMs > NORMAL_BATCH_MS;
        d.onState('live', { degraded });
      }
      d.onFrame(frame, receivedAt);
    };
    s.onclose = (e) => {
      if (s !== socket) return;
      socket = null;
      lost(e.code);
    };
  }

  function scheduleRetry(delayMs: number): void {
    const { expiresAtMs } = d.getToken();
    if (nowServer() + delayMs >= expiresAtMs) return end('token-expired');
    setState('reconnecting');
    attempt++;
    retryTimer = d.setTimer(() => {
      retryTimer = undefined;
      open();
    }, delayMs);
  }

  function lost(code: number): void {
    if (disposed) return;
    const wasOpen = opened;
    opened = false;
    if (watchdog !== undefined) d.clearTimer(watchdog);
    if (syncTimer !== undefined) d.clearTimer(syncTimer);
    if (stableTimer !== undefined) d.clearTimer(stableTimer);
    watchdog = syncTimer = stableTimer = undefined;
    d.onClose?.(code, wasOpen);
    const next = closeDecision(code, attempt, d.random);
    if (next.kind === 'end') return end(next.reason);
    if (next.kind === 'forbidden') return forbidden();
    if (wasOpen) failedOpens = 0;
    else failedOpens++;
    if (failedOpens >= PROBE_AFTER_FAILURES && d.probeAuth) {
      failedOpens = 0;
      setState('reconnecting');
      void d.probeAuth().then(
        (r) => {
          if (disposed || current === 'ended') return;
          if (r === 'rejected') end('token-invalid');
          else scheduleRetry(next.delayMs);
        },
        () => {
          if (!disposed && current !== 'ended') scheduleRetry(next.delayMs);
        },
      );
      return;
    }
    scheduleRetry(next.delayMs);
  }

  function forbidden(): void {
    if (forbiddenSeen || !d.onForbidden) return end('forbidden');
    forbiddenSeen = true;
    setState('reconnecting');
    void d.onForbidden().then(
      (ok) => {
        if (disposed || current === 'ended') return;
        if (ok) open();
        else end('forbidden');
      },
      () => {
        if (!disposed && current !== 'ended') end('forbidden');
      },
    );
  }

  return {
    clock,
    start(): void {
      d.onState('connecting');
      open();
    },
    /** 지금 구독할 전체 집합. 상한을 넘으면 앞에서부터(화면 가운데에 가까운 차례로 넘긴다) */
    setSections(next: readonly number[]): void {
      sections = next.slice(0, MAX_SUBSCRIBED_SECTIONS);
      if (opened && sections.join(',') !== sentSections) sendSections();
    },
    state: (): ConnectionState => current,
    /** 다시 붙은 횟수(ws_reconnects) */
    reconnects: (): number => reconnects,
    dispose(): void {
      disposed = true;
      stopTimers();
      const s = detach();
      s?.close(1000);
    },
  };
}

export type SeatConnection = ReturnType<typeof createSeatConnection>;
