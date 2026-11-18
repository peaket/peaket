// 좌석 델타 허브(docs/features/seat-hold.md §7 'realtime-gw의 첫 구현'·'전파 Degraded Mode', ADR-0296 결정 4·5·6, ADR-0110 결정 3·4, ADR-0240 결정 10, ADR-0298, BUILD_ORDER HOT-090·091).
// 맺은 연결(핸드셰이크를 통과하고 회차가 토큰과 같은 것)마다 구독 집합·받는 프레임 검사·쌓인 묶음·하트비트·만료를 맡고,
// 파드 안에서 구역 채널마다 구독한 연결 수를 세어 0 → 1이면 구독기의 subscribe, 1 → 0이면 unsubscribe를 한 번 부른다.
// 원하는 구독 상태의 주인은 구독기 하나다(ADR-0297 결정 1): 허브는 약속의 결과로 상태를 정하지 않고, 다시 보내기·물러서기도 구독기 몫이다.
// 박자(tick)는 파드에 하나다(100ms [가정], 부르는 쪽의 타이머). 시계는 주입한다: 벽시계(now)는 serverTimeMs·maxWaitMs·토큰 exp에,
// 단조 시계(monotonicMs)는 간격(구독 바꾸기 1초 창, TimeSync 1,000ms, 하트비트 15초, 박자 예정 시각과 박자 늦음, 1초 차례 격자, 파드 10초 창)에 쓴다.
// 회차·구역·연결은 Map·Set으로만 찾는다(ASVS v5.0.0-15.3.6). 닫힘 이유 글은 아래 고정 글만 싣는다(받은 값을 넣지 않는다, 1.3.7).
// 전파 Degraded(ADR-0298): 연결마다 묶음 간격은 100ms 또는 1,000ms다. 파드 판정(degrade.ts, 박자 늦음의 10초 창)이 Degraded이거나
// 그 연결의 보내기 버퍼가 256KiB 이상이 되어 바뀌었으면 1,000ms다. 간격이 바뀐 박자에 BatchInterval을 한 번 보낸다.
// 1초 차례는 고정 격자이고 연결 번호(들인 차례) mod 10으로 흩는다. 새 타이머는 두지 않는다.
import type { Clock } from '@peaket/platform';
import { createDegradeJudge, type DegradedChange } from './degrade.js';
import { type BatchEntry, decodeInbound, encodeBatchInterval, encodeHeartbeat, encodeSeatDeltaBatch } from './frames.js';
import { KEY_PART, parseSeatDeltaMessage, sectionChannel, type SeatDeltaMessage } from './message.js';

/** 묶음 박자이자 평시 연결의 묶음 간격(ms, [가정] K4·S-T12). 박자는 Degraded에서도 이 값 그대로다 */
export const BATCH_INTERVAL_MS = 100;
/** Degraded 연결의 묶음 간격이자 1초 차례 격자(ms, seat-hold §7 '전파 Degraded Mode') */
export const DEGRADED_BATCH_INTERVAL_MS = 1_000;
/** 1초 차례를 흩는 갈래 수. 첫 차례는 바뀐 박자 + 100 × ((연결 번호 mod 이 값) + 1)ms다(ADR-0298 결정 5) */
export const TURN_SPREAD_SLOTS = 10;
/** 100ms 간격인 연결의 보내기 버퍼가 이 값 이상인 박자에 그 연결만 1초 간격으로 바꾼다(256KiB [가정], ADR-0298 결정 3) */
export const SLOW_BUFFER_ENTER_BYTES = 256 * 1024;
/** 1초가 된 연결은 차례 박자의 보내기 바로 전 버퍼가 이 값 이하인 차례가 이어지면 되돌린다(64KiB [가정]) */
export const SLOW_BUFFER_EXIT_BYTES = 64 * 1024;
/** 되돌리는 데 필요한 이어진 낮은 차례 수(약 30초 [가정]) */
export const SLOW_BUFFER_EXIT_TURNS = 30;
/** 쌓인 묶음의 프레임 크기가 이 값에 닿으면 간격과 관계없이 그 자리에서 보낸다(64KiB [가정], ADR-0298 결정 5) */
export const MAX_PENDING_FRAME_BYTES = 64 * 1024;
/** 버퍼 1초 연결의 차례 보내기에 박자마다 주는 몫(ms, 20 [가정], 괜찮음 기준 25ms 아래, ADR-0298 결정 5, SEC-06) */
export const BUFFER_SLOW_SEND_BUDGET_MS = 20;
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
/** 같은 입장 토큰(jti)의 파드 연결 상한([가정], ADR-0297 결정 3). 셋째는 맺은 뒤 4429 */
export const MAX_CONNECTIONS_PER_TOKEN = 2;
/** 내릴 때 구독 해제 응답을 기다리는 상한(ms, [가정], ADR-0297 결정 5) */
export const SHUTDOWN_UNSUBSCRIBE_WAIT_MS = 1_000;
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

/** 닫힘 이유 글(코드에 고정한 짧은 글, ASVS v5.0.0-1.3.7). docs/frontend.md §4.4.1 '닫힘 이유 글'의 계약이다(ADR-0297 결정 8) */
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

/**
 * 좌석 Redis 샤드 Pub/Sub 구독(어댑터가 node-redis sSubscribe·sUnsubscribe로 구현한다).
 * 두 함수는 원하는 상태를 적고 곧 돌려주며 거절하지 않는다(ADR-0297 결정 1). 허브는 거절이 와도 삼키고 다시 부르지 않는다
 */
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
   * realtime_gw_batches_total·realtime_gw_batch_bytes_total·realtime_gw_batch_wait_ms·realtime_gw_pubsub_messages_total{result},
   * realtime_gw_tick_lag_ms(박자마다 시작 − 예정 시각)·realtime_gw_pubsub_lag_ms(메시지를 받은 벽시각 − changedAtMs, 판정에는 쓰지 않는다).
   * 게이지 둘은 값을 그대로 둔다(바뀔 때만 온다. 시작 값 0은 부르는 쪽이 둔다):
   * realtime_gw_degraded(파드가 Degraded면 1)·realtime_gw_buffer_slow_connections(버퍼로 1초 간격인 연결 수)
   */
  onMetric?(name: string, labels: Record<string, string>, value: number): void;
  /**
   * 파드가 Degraded로 바뀌거나 되돌아왔다(마지막 창의 n = batches, a = overEnter(50ms 초과), b = overExit(25ms 초과), 박자 수 = ticks).
   * 부르는 쪽이 정규 로그 줄 realtime_gw_degraded 하나를 낸다(ADR-0298 결정 7)
   */
  onDegradedChange?(e: { degraded: boolean; batches: number; overEnter: number; overExit: number; ticks: number }): void;
}

export interface StreamHub {
  /** 맺은 연결을 들인다. 곧 그때의 간격(평시 100, 파드가 Degraded면 1000)의 BatchInterval을 보낸다. 같은 토큰(tokenId = jti)의 연결이 이미 2개면 4429 too many로 닫는다 */
  open(c: StreamConnection, s: { eventId: string; accountId: string; expiresAtMs: number; tokenId: string }): void;
  /** 받은 프레임 하나 */
  receive(c: StreamConnection, data: Uint8Array, isBinary: boolean): void;
  /** 연결이 닫혔다(상대가 닫았거나 끊겼다). 여러 번 불러도 된다 */
  gone(c: StreamConnection): void;
  /** 박자 하나: 파드 창 판정 → (연결마다) 만료(4401) → 보내기 버퍼(1013) → 간격 판정과 BatchInterval → 쌓인 묶음 → 주기 하트비트 → (뒤 고리) 버퍼 1초 연결의 차례 보내기(20ms 몫) */
  tick(): void;
  /** 모든 연결을 1012로 닫고, 구독 해제 응답은 1초까지만 기다린다(ADR-0297 결정 5). 그 뒤 open은 곧 1012로 닫는다 */
  shutdown(): Promise<void>;
}

/** 쌓인 구역 항목(보낼 때 가장 이른 changedAtMs를 잰다) */
type PendingEntry = BatchEntry & { changedAtMs: number };

interface Pending {
  seatEpoch: number;
  entries: PendingEntry[];
  /** 이 묶음을 보낼 때의 프레임 크기(머리 18 + 구역 항목마다 8 + 3 × 좌석 수 바이트) */
  frameBytes: number;
}

/** 묶음 프레임의 머리 크기(바이트) */
const BATCH_HEADER_BYTES = 18;
/** 구역 항목 하나의 크기(좌석 수 seats일 때, 바이트) */
const entryBytes = (seats: number): number => 8 + 3 * seats;

interface Conn {
  readonly c: StreamConnection;
  readonly eventId: string;
  readonly expiresAtMs: number;
  readonly tokenId: string;
  sections: Set<number>;
  /** 받은 SubscribeSections의 단조 시각(창 안의 것만 둔다) */
  subscribeTimes: number[];
  /** 마지막으로 답한 TimeSync의 단조 시각 */
  lastTimeSyncAnswerMs: number | undefined;
  /** 마지막 주기 하트비트(처음에는 맺은 때)의 단조 시각 */
  lastHeartbeatMs: number;
  pending: Pending | undefined;
  closed: boolean;
  /** 파드가 이 연결을 들인 차례(0부터). 1초 차례를 흩는 데 쓴다 */
  readonly serial: number;
  /** 지금 이 연결의 묶음 간격(마지막으로 보낸 BatchInterval의 값) */
  intervalMs: number;
  /** 1초 간격의 다음 차례(단조 시각, 고정 격자). 100ms 간격이면 쓰지 않는다 */
  nextTurnMs: number;
  /** 보내기 버퍼로 1초 간격이 되었나(파드 판정과 따로 든다) */
  bufferSlow: boolean;
  /** bufferSlow인 동안 차례 직전 버퍼가 SLOW_BUFFER_EXIT_BYTES 이하였던 이어진 차례 수(넘는 차례가 끼면 0) */
  lowTurns: number;
  /**
   * 버퍼 1초 연결이 뒤 고리 줄에 서 있는 까닭(보내면 지운다). turn은 열린 1초 차례,
   * switch는 1초로 바뀐 박자의 쌓인 것 보내기(차례를 넘기지 않고 버퍼 표본도 보지 않는다)
   */
  turnOpen: 'turn' | 'switch' | undefined;
}

export function createStreamHub(d: StreamHubDeps): StreamHub {
  const conns = new Map<StreamConnection, Conn>();
  /** 채널 → 그 구역을 구독한 연결 */
  const byChannel = new Map<string, Set<Conn>>();
  /** 토큰 jti → 그 토큰의 연결 */
  const byToken = new Map<string, Set<Conn>>();
  /** 부른 구독·해제의 약속(내릴 때 1초까지만 기다린다) */
  const inFlight = new Set<Promise<void>>();
  let stopped = false;
  /** 파드 판정(창은 허브를 만든 때부터 잰다) */
  const judge = createDegradeJudge(d.clock.monotonicMs());
  /** 버퍼로 1초 간격인 연결 수(게이지 realtime_gw_buffer_slow_connections) */
  let bufferSlowCount = 0;
  /** 다음에 들일 연결의 번호 */
  let nextSerial = 0;
  /** 지난 박자가 시작한 단조 시각(처음 박자 전에는 없다). 이 박자의 예정 시각 = 이것 + 100ms */
  let lastTickStartMs: number | undefined;
  /** 지금 박자의 예정 시각(박자 늦음 표본의 기준) */
  let tickDueMs = 0;
  /** 차례가 열린 버퍼 1초 연결의 줄(뒤 고리가 앞에서부터 보낸다. 몫을 넘겨 못 보낸 연결은 다음 박자에 맨 앞이다) */
  const openTurns: Conn[] = [];

  /** 1초 차례를 넘긴다: 지난 차례 + 1,000ms(고정 격자). 지금보다 1,000ms 넘게 뒤졌으면 지난 차례를 건너뛴다(ADR-0298 결정 5) */
  const advanceTurn = (conn: Conn, mono: number): void => {
    conn.nextTurnMs += DEGRADED_BATCH_INTERVAL_MS;
    const behind = mono - conn.nextTurnMs;
    if (behind > DEGRADED_BATCH_INTERVAL_MS) conn.nextTurnMs += Math.floor(behind / DEGRADED_BATCH_INTERVAL_MS) * DEGRADED_BATCH_INTERVAL_MS;
  };

  const metric = (name: string, labels: Record<string, string>, value: number): void => d.onMetric?.(name, labels, value);

  /** 이 연결이 지금 가져야 할 묶음 간격 */
  const wantedInterval = (conn: Conn): number => (judge.degraded || conn.bufferSlow ? DEGRADED_BATCH_INTERVAL_MS : BATCH_INTERVAL_MS);

  /** 1초가 된 박자(또는 맺은 때) t에서 첫 차례: t + 100 × ((연결 번호 mod 10) + 1)(ADR-0298 결정 5) */
  const firstTurn = (conn: Conn, t: number): number => t + BATCH_INTERVAL_MS * ((conn.serial % TURN_SPREAD_SLOTS) + 1);

  const setBufferSlow = (conn: Conn, slow: boolean): void => {
    if (conn.bufferSlow === slow) return;
    conn.bufferSlow = slow;
    conn.lowTurns = 0;
    bufferSlowCount += slow ? 1 : -1;
    metric('realtime_gw_buffer_slow_connections', {}, bufferSlowCount);
  };

  /** 구독기를 한 번 부른다. 결과로 상태를 정하지 않고 거절은 삼킨다(다시 보내기는 구독기 몫, ADR-0297 결정 1) */
  const call = (run: () => Promise<void>): void => {
    let p: Promise<void>;
    try {
      p = Promise.resolve(run());
    } catch (err) {
      p = Promise.reject(err);
    }
    const done = p.then(
      () => {},
      () => {},
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
    if (set.size !== 1) return;
    call(() => d.subscriber.subscribe(channel, (message: string) => onMessage(channel, message)));
  };

  const leave = (conn: Conn, sectionIndex: number): void => {
    const channel = sectionChannel(conn.eventId, sectionIndex);
    const set = byChannel.get(channel);
    if (!set || !set.delete(conn)) return;
    if (set.size === 0) {
      byChannel.delete(channel);
      call(() => d.subscriber.unsubscribe(channel));
    }
  };

  const detach = (conn: Conn): void => {
    conns.delete(conn.c);
    const same = byToken.get(conn.tokenId);
    if (same) {
      same.delete(conn);
      if (same.size === 0) byToken.delete(conn.tokenId);
    }
    for (const s of conn.sections) leave(conn, s);
    conn.sections = new Set();
    conn.pending = undefined;
    // 닫힌 연결은 버퍼 1초 연결 수에서 뺀다
    setBufferSlow(conn, false);
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

  /** 쌓인 묶음을 보낸다(없으면 아무것도 하지 않는다). inTick이면 박자 안에서 보낸 것이다 */
  const flush = (conn: Conn, inTick = false): void => {
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
    // 박자 안에서 보낸 묶음만 박자 늦음 표본으로 센다(보낸 단조 시각 − 예정 시각, 0 아래는 0).
    // 박자 밖에서 곧 보낸 묶음(세대 바뀜·항목 상한·바이트 상한)과 보내기 버퍼로 1초가 된 연결의 묶음은 세지 않는다(ADR-0298 결정 1, ASVS v5.0.0-2.4.1)
    if (inTick && !conn.bufferSlow) judge.record(Math.max(0, d.clock.monotonicMs() - tickDueMs));
  };

  const enqueue = (conn: Conn, m: SeatDeltaMessage): void => {
    // 쌓인 것과 세대가 다르면 쌓인 것을 바로 보내고 새로 쌓는다(한 묶음에는 한 세대만)
    if (conn.pending && conn.pending.seatEpoch !== m.seatEpoch) flush(conn);
    if (conn.closed) return;
    let p = conn.pending;
    if (!p) {
      p = { seatEpoch: m.seatEpoch, entries: [], frameBytes: BATCH_HEADER_BYTES };
      conn.pending = p;
    }
    // 같은 구역의 메시지는 합치지 않고 받은 차례대로 항목 하나씩(ADR-0296 결정 4)
    p.entries.push({ sectionIndex: m.sectionIndex, sectionVersion: m.sectionVersion, seats: m.seats, changedAtMs: m.changedAtMs });
    p.frameBytes += entryBytes(m.seats.length);
    // 항목 수 상한이나 프레임 64KiB에 닿으면 간격과 관계없이 그 자리에서 보낸다(한 연결이 쥐는 메모리를 묶는다, ADR-0298 결정 5)
    if (p.entries.length >= MAX_BATCH_ENTRIES || p.frameBytes >= MAX_PENDING_FRAME_BYTES) flush(conn);
  };

  function onMessage(channel: string, text: string): void {
    const m = parseSeatDeltaMessage(channel, text);
    if (!m) {
      metric('realtime_gw_pubsub_messages_total', { result: 'bad' }, 1);
      return;
    }
    // 좌석 Redis에서 realtime-gw까지의 퍼짐(받은 벽시각 − changedAtMs, 0 아래는 0). 시계 차이가 들어 판정에는 쓰지 않는다(ADR-0298 결정 7)
    metric('realtime_gw_pubsub_lag_ms', {}, Math.max(0, d.clock.now() - m.changedAtMs));
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
      conn.pending.frameBytes = BATCH_HEADER_BYTES + conn.pending.entries.reduce((sum, e) => sum + entryBytes(e.seats.length), 0);
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
      // 같은 입장 토큰의 파드 연결은 2개까지(다시 붙는 동안의 겹침 하나, ADR-0297 결정 3)
      const tokenId = typeof s.tokenId === 'string' ? s.tokenId : '';
      let same = byToken.get(tokenId);
      if (same && same.size >= MAX_CONNECTIONS_PER_TOKEN) {
        c.close(CLOSE.TOO_MANY, CLOSE_REASON.tooMany);
        return;
      }
      const openedMs = d.clock.monotonicMs();
      const conn: Conn = {
        c,
        eventId: s.eventId,
        expiresAtMs: s.expiresAtMs,
        tokenId,
        sections: new Set(),
        subscribeTimes: [],
        lastTimeSyncAnswerMs: undefined,
        lastHeartbeatMs: openedMs,
        pending: undefined,
        closed: false,
        serial: nextSerial++,
        intervalMs: BATCH_INTERVAL_MS,
        nextTurnMs: openedMs,
        bufferSlow: false,
        lowTurns: 0,
        turnOpen: undefined,
      };
      conn.intervalMs = wantedInterval(conn);
      // Degraded 중에 붙은 연결은 맺은 때를 1초가 된 때로 보고 차례를 흩는다
      conn.nextTurnMs = firstTurn(conn, openedMs);
      conns.set(c, conn);
      if (!same) byToken.set(tokenId, (same = new Set()));
      same.add(conn);
      // 첫 프레임은 그때의 간격(평시 100, 파드가 Degraded면 1000)의 BatchInterval(ADR-0240 결정 10, ADR-0298 결정 4)
      sendTo(conn, encodeBatchInterval(conn.intervalMs));
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
      const now = d.clock.now();
      const mono = d.clock.monotonicMs();
      // 이 박자의 예정 시각 = 지난 박자가 시작한 때 + 100ms(처음 박자는 그 박자의 시작). 타이머 밀림이 쌓이지 않는다(ADR-0298 결정 1)
      tickDueMs = lastTickStartMs === undefined ? mono : lastTickStartMs + BATCH_INTERVAL_MS;
      lastTickStartMs = mono;
      metric('realtime_gw_tick_lag_ms', {}, Math.max(0, mono - tickDueMs));
      // 파드 창 판정은 박자 앞에서 한다(이 박자와 이 박자에 보내는 묶음은 새 창에 센다)
      const changes: DegradedChange[] = judge.tick(mono);
      for (const e of changes) {
        metric('realtime_gw_degraded', {}, e.degraded ? 1 : 0);
        d.onDegradedChange?.({ degraded: e.degraded, batches: e.batches, overEnter: e.overEnter, overExit: e.overExit, ticks: e.ticks });
      }
      for (const conn of [...conns.values()]) {
        if (conn.closed) continue;
        // 토큰 exp 이상이 된 첫 박자에 4401(늦어도 박자 하나)
        if (now >= conn.expiresAtMs) {
          closeConn(conn, CLOSE.TOKEN_EXPIRED, CLOSE_REASON.tokenExpired);
          continue;
        }
        // 보낼 것이 없어도 보내기 버퍼가 상한을 넘은 연결은 닫는다(읽지 않는 연결이 다른 연결을 해치지 않게, ADR-0297 결정 2)
        const buffered = conn.c.bufferedAmount;
        if (buffered > MAX_BUFFERED_BYTES) {
          closeConn(conn, CLOSE.TRY_AGAIN_LATER, CLOSE_REASON.slowConsumer);
          continue;
        }
        if (conn.bufferSlow) {
          // 버퍼로 1초가 된 연결: 차례가 되면 열어 뒤 고리 줄 끝에 세운다(보내기는 다른 연결을 모두 돈 뒤, SEC-06)
          if (conn.turnOpen === undefined && mono >= conn.nextTurnMs) {
            conn.turnOpen = 'turn';
            openTurns.push(conn);
          }
        } else {
          // 1초 간격 연결(파드가 Degraded)의 차례 박자인가(고정 격자)
          const turn = conn.intervalMs !== BATCH_INTERVAL_MS && mono >= conn.nextTurnMs;
          // 보내기 버퍼로 그 연결만 바꾼다(ADR-0298 결정 3): 100ms 간격이면 박자마다 보고 256KiB 이상이면 1초
          if (conn.intervalMs === BATCH_INTERVAL_MS && buffered >= SLOW_BUFFER_ENTER_BYTES) setBufferSlow(conn, true);
          // 간격이 바뀐 박자에 BatchInterval을 한 번 보내고, 쌓인 것도 그 박자에 보낸다(같으면 다시 보내지 않는다, 결정 4)
          const wanted = wantedInterval(conn);
          if (wanted !== conn.intervalMs) {
            conn.intervalMs = wanted;
            // 1초가 된 박자 t에서 첫 차례는 t + 100 × ((연결 번호 mod 10) + 1)(전환 때 모든 연결이 한 박자에 몰리지 않게, 결정 5)
            if (wanted === DEGRADED_BATCH_INTERVAL_MS) conn.nextTurnMs = firstTurn(conn, mono);
            if (!sendTo(conn, encodeBatchInterval(wanted))) continue;
            if (conn.bufferSlow) {
              // 버퍼로 1초가 된 박자에 쌓인 것은 뒤 고리에서 보낸다(같은 박자 남의 표본을 늦추지 않게, SEC-06)
              conn.turnOpen = 'switch';
              openTurns.push(conn);
            } else {
              flush(conn, true);
            }
          } else if (conn.intervalMs === BATCH_INTERVAL_MS) {
            flush(conn, true);
          } else if (turn) {
            // 1초 간격: 차례가 된 뒤 첫 박자에 보낸다. 쌓인 것이 없어도 차례는 넘어간다(결정 5)
            advanceTurn(conn, mono);
            flush(conn, true);
          }
        }
        if (conn.closed) continue;
        // 마지막 주기 하트비트(처음에는 맺은 때)에서 15초가 지난 첫 박자(TimeSync 답은 이 주기를 옮기지 않는다)
        if (mono - conn.lastHeartbeatMs >= HEARTBEAT_EVERY_MS) {
          conn.lastHeartbeatMs = mono;
          sendTo(conn, encodeHeartbeat(now, 0n));
        }
      }

      // 뒤 고리: 버퍼 1초 연결의 차례 보내기. 뒤 고리를 시작한 때부터 20ms 몫 안에서만 보내고, 넘으면 남은 연결은
      // 차례를 연 채 다음 박자 뒤 고리의 맨 앞에 둔다(다음 차례 격자는 그대로, ADR-0298 결정 5, SEC-06).
      // 이 묶음은 박자 늦음 표본으로 세지 않는다(결정 1)
      const backStartMs = d.clock.monotonicMs();
      let done = 0;
      for (; done < openTurns.length; done += 1) {
        const conn = openTurns[done]!;
        const why = conn.turnOpen;
        if (conn.closed || !conn.bufferSlow || why === undefined) {
          conn.turnOpen = undefined;
          continue;
        }
        if (d.clock.monotonicMs() - backStartMs >= BUFFER_SLOW_SEND_BUDGET_MS) break;
        conn.turnOpen = undefined;
        if (why === 'switch') {
          // 1초로 바뀐 박자에 쌓인 것(BatchInterval 1000은 앞 고리에서 보냈다)
          flush(conn);
          continue;
        }
        // 보내기 바로 전 버퍼를 본다: 1MiB를 넘었으면 1013, 64KiB 이하인 차례가 30번 이어지면 되돌린다(넘는 차례가 끼면 처음부터, 결정 3)
        const buffered = conn.c.bufferedAmount;
        if (buffered > MAX_BUFFERED_BYTES) {
          closeConn(conn, CLOSE.TRY_AGAIN_LATER, CLOSE_REASON.slowConsumer);
          continue;
        }
        conn.lowTurns = buffered <= SLOW_BUFFER_EXIT_BYTES ? conn.lowTurns + 1 : 0;
        if (conn.lowTurns >= SLOW_BUFFER_EXIT_TURNS) setBufferSlow(conn, false);
        advanceTurn(conn, mono);
        const wanted = wantedInterval(conn);
        if (wanted !== conn.intervalMs) {
          // 버퍼에서 풀리고 파드도 평시면 그 차례에 100으로 되돌린다(파드가 Degraded면 1초 그대로라 알림 없음)
          conn.intervalMs = wanted;
          if (!sendTo(conn, encodeBatchInterval(wanted))) continue;
        }
        flush(conn);
      }
      openTurns.splice(0, done);
    },

    async shutdown() {
      stopped = true;
      for (const conn of [...conns.values()]) closeConn(conn, CLOSE.SERVER_RESTART, CLOSE_REASON.serverRestart);
      if (inFlight.size === 0) return;
      // 연결은 이미 닫혔다. 해제 응답은 1초까지만 기다린다(좌석 Redis가 멈춰도 내리기가 남지 않게)
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([Promise.allSettled([...inFlight]), new Promise<void>((r) => (timer = setTimeout(r, SHUTDOWN_UNSUBSCRIBE_WAIT_MS)))]);
      clearTimeout(timer);
    },
  };
}
