// 좌석 델타 허브(docs/features/seat-hold.md §7 'realtime-gw의 첫 구현', ADR-0296 결정 4·5·6, ADR-0110 결정 3·4, ADR-0240 결정 10, BUILD_ORDER HOT-090).
// 맺은 연결(핸드셰이크를 통과하고 회차가 토큰과 같은 것)마다 구독 집합·받는 프레임 검사·쌓인 묶음·하트비트·만료를 맡고,
// 파드 안에서 구역 채널마다 구독한 연결 수를 세어 좌석 Redis 샤드 Pub/Sub 구독을 0 ↔ 1에서만 바꾼다.
// 박자(tick)는 파드에 하나다(100ms [가정], 부르는 쪽의 타이머). 시계는 주입한다: 벽시계(now)는 serverTimeMs·maxWaitMs·토큰 exp에,
// 단조 시계(monotonicMs)는 간격(구독 바꾸기 1초 창, TimeSync 1,000ms, 하트비트 15초)에 쓴다.
// 회차·구역·연결은 Map·Set으로만 찾는다(ASVS v5.0.0-15.3.6). 닫힘 이유 글은 아래 고정 글만 싣는다(받은 값을 넣지 않는다, 1.3.7).
import type { Clock } from '@peaket/platform';
import { type BatchEntry, decodeInbound, encodeBatchInterval, encodeHeartbeat, encodeSeatDeltaBatch } from './frames.js';
import { KEY_PART, parseSeatDeltaMessage, sectionChannel, type SeatDeltaMessage } from './message.js';

/** 묶음 박자(ms, [가정] K4·S-T12). 첫 프레임 BatchInterval의 값이다(Degraded 전환이 생기기 전까지 늘 이 값) */
export const BATCH_INTERVAL_MS = 100;
/** 주기 하트비트 간격(ms, [가정]) */
export const HEARTBEAT_EVERY_MS = 15_000;
/** 구독 바꾸기를 세는 창(ms). (t − 창, t] 안의 SubscribeSections 수를 센다 */
export const SUBSCRIBE_WINDOW_MS = 1_000;
/** 창 안에서 받는 SubscribeSections 수 상한(초당 2번 [가정]). 이것을 넘는(3번째) 구독이 오면 4429 */
export const MAX_SUBSCRIBES_PER_WINDOW = 2;
/** 한 연결이 구독하는 구역 수 상한([가정] K4·S-T21) */
export const MAX_SUBSCRIBED_SECTIONS = 16;
/** 마지막으로 답한 TimeSync에서 이만큼 지나야 다시 답한다(초당 1번 [가정]) */
export const TIME_SYNC_MIN_GAP_MS = 1_000;
/** 보내기 버퍼 상한(1MiB [가정]). 넘은 연결은 보내지 않고 1013으로 닫는다 */
export const MAX_BUFFERED_BYTES = 1024 * 1024;
/** maxWaitMs는 u16이라 이 값에서 자른다 */
export const MAX_WAIT_MS_CAP = 65_535;
/** 묶음 하나의 구역 항목 수 상한(u16 sectionCount). 닿으면 그 자리에서 보낸다 */
const MAX_BATCH_ENTRIES = 65_535;

/** 닫힘 코드(docs/frontend.md §4.4.1 '닫힘 코드') */
export const CLOSE = {
  SERVER_RESTART: 1012,
  TRY_AGAIN_LATER: 1013,
  TOKEN_EXPIRED: 4401,
  FORBIDDEN: 4403,
  TOO_MANY: 4429,
} as const;

/** 닫힘 이유 글(코드에 고정한 짧은 글, ASVS v5.0.0-1.3.7) */
export const CLOSE_REASON = {
  serverRestart: 'server restart',
  slowConsumer: 'slow consumer',
  tokenExpired: 'token expired',
  badFrame: 'bad frame',
  badSection: 'bad section',
  badEvent: 'bad event',
  tooMany: 'too many',
} as const;

/** 맺은 WebSocket 연결 하나(받는 층이 ws 소켓을 감싸 넘긴다) */
export interface StreamConnection {
  send(frame: Uint8Array): void;
  close(code: number, reason: string): void;
  readonly bufferedAmount: number;
}

/** 좌석 Redis 샤드 Pub/Sub 구독(어댑터가 node-redis sSubscribe·sUnsubscribe로 구현한다) */
export interface ChannelSubscriber {
  subscribe(channel: string, onMessage: (message: string) => void): Promise<void>;
  unsubscribe(channel: string): Promise<void>;
}

export interface StreamHubDeps {
  clock: Clock;
  subscriber: ChannelSubscriber;
  /** 회차 좌석맵 판의 구역 수(지금 기억한 판). 모르면 undefined(구역 0개로 본다) */
  sectionCount(eventId: string): number | undefined;
  /**
   * 지표 한 번. 이름은 seat-hold §7 '지표와 로그'다. 카운터는 더할 값, 히스토그램은 잰 값이다:
   * realtime_gw_batches_total·realtime_gw_batch_bytes_total·realtime_gw_batch_wait_ms·realtime_gw_pubsub_messages_total{result}
   */
  onMetric?(name: string, labels: Record<string, string>, value: number): void;
  /** 구독·해제가 실패했을 때(다음 박자에 다시 맞춘다). 채널 이름과 오류 이름만 넘긴다 */
  onSubscribeError?(e: { channel: string; op: 'subscribe' | 'unsubscribe'; error: string }): void;
}

export interface StreamHub {
  /** 맺은 연결을 들인다. 곧 BatchInterval{100}을 보낸다 */
  open(c: StreamConnection, s: { eventId: string; accountId: string; expiresAtMs: number }): void;
  /** 받은 프레임 하나 */
  receive(c: StreamConnection, data: Uint8Array, isBinary: boolean): void;
  /** 연결이 닫혔다(상대가 닫았거나 끊겼다). 여러 번 불러도 된다 */
  gone(c: StreamConnection): void;
  /** 박자 하나: 만료(4401) → 쌓인 묶음 → 주기 하트비트 */
  tick(): void;
  /** 모든 연결을 1012로 닫고, 진행 중인 구독·해제가 끝나기를 기다린다. 그 뒤 open은 곧 1012로 닫는다 */
  shutdown(): Promise<void>;
}

/** 쌓인 구역 항목(보낼 때 가장 이른 changedAtMs를 잰다) */
type PendingEntry = BatchEntry & { changedAtMs: number };

interface Pending {
  seatEpoch: number;
  entries: PendingEntry[];
}

interface Conn {
  readonly c: StreamConnection;
  readonly eventId: string;
  readonly expiresAtMs: number;
  sections: Set<number>;
  /** 받은 SubscribeSections의 단조 시각(창 안의 것만 둔다) */
  subscribeTimes: number[];
  /** 마지막으로 답한 TimeSync의 단조 시각 */
  lastTimeSyncAnswerMs: number | undefined;
  /** 마지막 주기 하트비트(처음에는 맺은 때)의 단조 시각 */
  lastHeartbeatMs: number;
  pending: Pending | undefined;
  closed: boolean;
}

interface ChannelState {
  /** Redis에 실제로 구독했다고 본 상태(마지막으로 끝난 구독·해제의 결과) */
  actual: boolean;
  /** 구독·해제가 진행 중(같은 채널은 한 번에 하나씩) */
  busy: boolean;
}

export function createStreamHub(d: StreamHubDeps): StreamHub {
  const conns = new Map<StreamConnection, Conn>();
  /** 채널 → 그 구역을 구독한 연결 */
  const byChannel = new Map<string, Set<Conn>>();
  const channels = new Map<string, ChannelState>();
  /** 구독·해제가 실패해 다음 박자에 다시 맞출 채널 */
  const dirty = new Set<string>();
  const inFlight = new Set<Promise<void>>();
  /** 채널마다 메시지 받는 함수(같은 채널은 같은 함수) */
  const listeners = new Map<string, (message: string) => void>();
  let stopped = false;

  const metric = (name: string, labels: Record<string, string>, value: number): void => d.onMetric?.(name, labels, value);

  const want = (channel: string): boolean => (byChannel.get(channel)?.size ?? 0) > 0;

  const listenerOf = (channel: string): ((message: string) => void) => {
    let l = listeners.get(channel);
    if (!l) {
      l = (message: string) => onMessage(channel, message);
      listeners.set(channel, l);
    }
    return l;
  };

  /** 채널의 원하는 상태(연결 수 > 0)와 실제를 맞춘다. 같은 채널은 한 번에 하나씩, 끝난 뒤 다르면 한 번 더 한다(docs/data.md §5) */
  const reconcile = (channel: string): void => {
    let st = channels.get(channel);
    if (!st) {
      st = { actual: false, busy: false };
      channels.set(channel, st);
    }
    if (st.busy) return;
    const target = want(channel);
    if (target === st.actual) {
      if (!target) {
        channels.delete(channel);
        listeners.delete(channel);
      }
      return;
    }
    const state = st;
    state.busy = true;
    dirty.delete(channel);
    let op: Promise<void>;
    try {
      op = target ? d.subscriber.subscribe(channel, listenerOf(channel)) : d.subscriber.unsubscribe(channel);
    } catch (err) {
      op = Promise.reject(err);
    }
    const done: Promise<void> = Promise.resolve(op).then(
      () => {
        state.actual = target;
        state.busy = false;
        reconcile(channel);
      },
      (err: unknown) => {
        state.busy = false;
        dirty.add(channel);
        d.onSubscribeError?.({ channel, op: target ? 'subscribe' : 'unsubscribe', error: err instanceof Error ? err.name : 'unknown' });
      },
    );
    inFlight.add(done);
    void done.finally(() => inFlight.delete(done));
  };

  const join = (conn: Conn, sectionIndex: number): void => {
    const channel = sectionChannel(conn.eventId, sectionIndex);
    let set = byChannel.get(channel);
    if (!set) {
      set = new Set();
      byChannel.set(channel, set);
    }
    set.add(conn);
    if (set.size === 1) reconcile(channel);
  };

  const leave = (conn: Conn, sectionIndex: number): void => {
    const channel = sectionChannel(conn.eventId, sectionIndex);
    const set = byChannel.get(channel);
    if (!set || !set.delete(conn)) return;
    if (set.size === 0) {
      byChannel.delete(channel);
      reconcile(channel);
    }
  };

  const detach = (conn: Conn): void => {
    conns.delete(conn.c);
    for (const s of conn.sections) leave(conn, s);
    conn.sections = new Set();
    conn.pending = undefined;
  };

  const closeConn = (conn: Conn, code: number, reason: string): void => {
    if (conn.closed) return;
    conn.closed = true;
    detach(conn);
    conn.c.close(code, reason);
  };

  /** 보내기 버퍼가 상한을 넘었으면 보내지 않고 1013으로 닫는다(ADR-0296 결정 6). 보냈으면 참 */
  const sendTo = (conn: Conn, frame: Uint8Array): boolean => {
    if (conn.closed) return false;
    if (conn.c.bufferedAmount > MAX_BUFFERED_BYTES) {
      closeConn(conn, CLOSE.TRY_AGAIN_LATER, CLOSE_REASON.slowConsumer);
      return false;
    }
    conn.c.send(frame);
    return true;
  };

  /** 쌓인 묶음을 보낸다(없으면 아무것도 하지 않는다) */
  const flush = (conn: Conn): void => {
    const p = conn.pending;
    conn.pending = undefined;
    if (!p || p.entries.length === 0) return;
    const serverTimeMs = d.clock.now();
    let earliest = p.entries[0]!.changedAtMs;
    for (const e of p.entries) if (e.changedAtMs < earliest) earliest = e.changedAtMs;
    // maxWaitMs = serverTimeMs − 묶음 안 가장 이른 changedAtMs(0 아래는 0, 65,535 위는 65,535, ADR-0296 결정 5)
    const maxWaitMs = Math.min(MAX_WAIT_MS_CAP, Math.max(0, serverTimeMs - earliest));
    const frame = encodeSeatDeltaBatch({ serverTimeMs, maxWaitMs, seatEpoch: p.seatEpoch, entries: p.entries });
    if (!sendTo(conn, frame)) return;
    metric('realtime_gw_batches_total', {}, 1);
    metric('realtime_gw_batch_bytes_total', {}, frame.byteLength);
    metric('realtime_gw_batch_wait_ms', {}, maxWaitMs);
  };

  const enqueue = (conn: Conn, m: SeatDeltaMessage): void => {
    // 쌓인 것과 세대가 다르면 쌓인 것을 바로 보내고 새로 쌓는다(한 묶음에는 한 세대만)
    if (conn.pending && conn.pending.seatEpoch !== m.seatEpoch) flush(conn);
    if (conn.closed) return;
    let p = conn.pending;
    if (!p) {
      p = { seatEpoch: m.seatEpoch, entries: [] };
      conn.pending = p;
    }
    // 같은 구역의 메시지는 합치지 않고 받은 차례대로 항목 하나씩(ADR-0296 결정 4)
    p.entries.push({ sectionIndex: m.sectionIndex, sectionVersion: m.sectionVersion, seats: m.seats, changedAtMs: m.changedAtMs });
    if (p.entries.length >= MAX_BATCH_ENTRIES) flush(conn);
  };

  function onMessage(channel: string, text: string): void {
    const m = parseSeatDeltaMessage(channel, text);
    if (!m) {
      metric('realtime_gw_pubsub_messages_total', { result: 'bad' }, 1);
      return;
    }
    const set = byChannel.get(channel);
    if (!set || set.size === 0) {
      metric('realtime_gw_pubsub_messages_total', { result: 'unrouted' }, 1);
      return;
    }
    metric('realtime_gw_pubsub_messages_total', { result: 'ok' }, 1);
    for (const conn of [...set]) {
      if (conn.eventId === m.eventId && conn.sections.has(m.sectionIndex)) enqueue(conn, m);
    }
  }

  /** 구독 집합을 바꾼다. 뺀 구역의 쌓인 것은 버린다 */
  const setSections = (conn: Conn, next: Set<number>): void => {
    const old = conn.sections;
    conn.sections = next;
    const removed = [...old].filter((s) => !next.has(s));
    for (const s of removed) leave(conn, s);
    for (const s of next) if (!old.has(s)) join(conn, s);
    if (removed.length > 0 && conn.pending) {
      const gone = new Set(removed);
      conn.pending.entries = conn.pending.entries.filter((e) => !gone.has(e.sectionIndex));
      if (conn.pending.entries.length === 0) conn.pending = undefined;
    }
  };

  return {
    open(c, s) {
      if (conns.has(c)) return;
      if (stopped) {
        c.close(CLOSE.SERVER_RESTART, CLOSE_REASON.serverRestart);
        return;
      }
      // 회차 ID는 받는 층이 모양을 봤지만 허브도 본다(겹친 가드, ASVS v5.0.0-15.3.6)
      if (typeof s.eventId !== 'string' || !KEY_PART.test(s.eventId)) {
        c.close(CLOSE.FORBIDDEN, CLOSE_REASON.badEvent);
        return;
      }
      const conn: Conn = {
        c,
        eventId: s.eventId,
        expiresAtMs: s.expiresAtMs,
        sections: new Set(),
        subscribeTimes: [],
        lastTimeSyncAnswerMs: undefined,
        lastHeartbeatMs: d.clock.monotonicMs(),
        pending: undefined,
        closed: false,
      };
      conns.set(c, conn);
      // 첫 프레임은 BatchInterval{100}(ADR-0240 결정 10)
      sendTo(conn, encodeBatchInterval(BATCH_INTERVAL_MS));
    },

    receive(c, data, isBinary) {
      const conn = conns.get(c);
      if (!conn || conn.closed) return;
      const frame = decodeInbound(data, isBinary);
      // ① 모양
      if (!frame) return closeConn(conn, CLOSE.FORBIDDEN, CLOSE_REASON.badFrame);
      const mono = d.clock.monotonicMs();
      if (frame.type === 'timeSync') {
        // 마지막으로 답한 TimeSync에서 1,000ms가 지나지 않았으면 답하지 않고 닫지도 않는다
        if (conn.lastTimeSyncAnswerMs !== undefined && mono - conn.lastTimeSyncAnswerMs < TIME_SYNC_MIN_GAP_MS) return;
        conn.lastTimeSyncAnswerMs = mono;
        sendTo(conn, encodeHeartbeat(d.clock.now(), frame.clientTimeMs));
        return;
      }
      // ② 구독 바꾸기 빈도: (t − 1,000ms, t] 안에 이것까지 3개 이상이면 4429(맺은 뒤 첫 구독도 센다)
      const recent = conn.subscribeTimes.filter((t) => t > mono - SUBSCRIBE_WINDOW_MS);
      recent.push(mono);
      conn.subscribeTimes = recent;
      if (recent.length > MAX_SUBSCRIBES_PER_WINDOW) return closeConn(conn, CLOSE.TOO_MANY, CLOSE_REASON.tooMany);
      // ③ 구역 수
      if (frame.sections.length > MAX_SUBSCRIBED_SECTIONS) return closeConn(conn, CLOSE.TOO_MANY, CLOSE_REASON.tooMany);
      // ④ 판의 구역 수 안이고 겹치지 않는다(그때의 판으로 본다)
      const count = d.sectionCount(conn.eventId) ?? 0;
      const next = new Set<number>();
      for (const s of frame.sections) {
        if (s >= count || next.has(s)) return closeConn(conn, CLOSE.FORBIDDEN, CLOSE_REASON.badSection);
        next.add(s);
      }
      // ⑤ 구독 집합을 그 목록으로 바꾼다(0개도 된다)
      setSections(conn, next);
    },

    gone(c) {
      const conn = conns.get(c);
      if (!conn) return;
      conn.closed = true;
      detach(conn);
    },

    tick() {
      for (const channel of [...dirty]) reconcile(channel);
      const now = d.clock.now();
      const mono = d.clock.monotonicMs();
      for (const conn of [...conns.values()]) {
        if (conn.closed) continue;
        // 토큰 exp 이상이 된 첫 박자에 4401(늦어도 박자 하나)
        if (now >= conn.expiresAtMs) {
          closeConn(conn, CLOSE.TOKEN_EXPIRED, CLOSE_REASON.tokenExpired);
          continue;
        }
        flush(conn);
        if (conn.closed) continue;
        // 마지막 주기 하트비트(처음에는 맺은 때)에서 15초가 지난 첫 박자(TimeSync 답은 이 주기를 옮기지 않는다)
        if (mono - conn.lastHeartbeatMs >= HEARTBEAT_EVERY_MS) {
          conn.lastHeartbeatMs = mono;
          sendTo(conn, encodeHeartbeat(now, 0n));
        }
      }
    },

    async shutdown() {
      stopped = true;
      for (const conn of [...conns.values()]) closeConn(conn, CLOSE.SERVER_RESTART, CLOSE_REASON.serverRestart);
      while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
    },
  };
}
