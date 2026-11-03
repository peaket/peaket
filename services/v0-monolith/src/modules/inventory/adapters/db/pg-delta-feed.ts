// 변경분 받기 포트의 PostgreSQL 어댑터: 전용 연결 하나로 LISTEN v0_seat_delta(§14 동작 6). 끊기면 다시 붙는다.
// 끊긴 동안의 알림은 잃는다(v0는 다시 맞추지 않는다. 브라우저가 다시 연결할 때 좌석 목록을 다시 받는다).
import pg from 'pg';
import type { SeatDelta } from '../../domain/inventory.js';
import type { DeltaFeed } from '../../domain/ports.js';

/** pg_notify 채널 이름 */
export const DELTA_CHANNEL = 'v0_seat_delta';
/** 다시 붙기 전 기다림 [가정] */
const RECONNECT_MS = 1_000;
/** TCP 생존 확인을 처음 보내기까지(0이면 운영체제 기본 2시간이라 조용히 죽은 연결을 늦게 안다, 2차 리뷰) [가정] */
const KEEPALIVE_INITIAL_DELAY_MS = 10_000;

export interface PgDeltaFeed extends DeltaFeed {
  /** LISTEN이 시작될 때까지 기다린다 */
  ready(): Promise<void>;
  close(): Promise<void>;
}

const STATUSES = new Set(['AVAILABLE', 'HELD', 'SOLD']);

/** 알림 본문이 변경분 모양인지(같은 DB를 쓰는 다른 무언가가 같은 채널에 낸 값은 버린다) */
function parse(payload: string): SeatDelta | undefined {
  try {
    const d = JSON.parse(payload) as SeatDelta;
    if (typeof d?.eventId !== 'string' || !Array.isArray(d.changes) || typeof d.atMs !== 'number') return undefined;
    if (!d.changes.every((c) => typeof c?.seatId === 'string' && STATUSES.has(c.status))) return undefined;
    return d;
  } catch {
    return undefined;
  }
}

/** DB 주소로 LISTEN 전용 연결을 연다 */
export function createPgDeltaFeed(databaseUrl: string): PgDeltaFeed {
  const listeners = new Set<(delta: SeatDelta, raw: string) => void>();
  const gapListeners = new Set<() => void>();
  let client: pg.Client | undefined;
  let closed = false;
  let first: Promise<void> | undefined;
  let retry: NodeJS.Timeout | undefined;
  /** 끊긴 뒤 아직 다시 듣지 못했다 */
  let lost = false;
  const gap = () => {
    for (const l of gapListeners) l();
  };

  const connect = async (): Promise<void> => {
    // 조용히 죽은 연결을 알아채게 TCP 생존 확인을 켠다
    const c = new pg.Client({ connectionString: databaseUrl, keepAlive: true, keepAliveInitialDelayMillis: KEEPALIVE_INITIAL_DELAY_MS });
    c.on('error', () => {
      // 끊김은 'end'로 다시 붙는다. 주소가 든 오류 문구를 따로 찍지 않는다
    });
    c.on('notification', (msg) => {
      if (msg.channel !== DELTA_CHANNEL || !msg.payload) return;
      const delta = parse(msg.payload);
      if (!delta) return;
      for (const l of listeners) {
        try {
          l(delta, msg.payload);
        } catch {
          // 받는 쪽 하나의 실패가 다른 쪽을 막지 않는다
        }
      }
    });
    let listening = false;
    c.on('end', () => {
      if (client === c) client = undefined;
      if (closed) return;
      // 듣던 연결이 끊겼으면 그동안의 변경분을 잃었을 수 있다(받는 쪽이 브라우저를 다시 붙게 한다, 새 맥락 리뷰)
      if (listening) {
        lost = true;
        gap();
      }
      retry = setTimeout(() => void connect().catch(() => {}), RECONNECT_MS);
    });
    await c.connect();
    try {
      await c.query(`LISTEN ${DELTA_CHANNEL}`);
    } catch (err) {
      // 연결은 됐는데 LISTEN이 실패하면 그 연결을 닫는다('end'가 다시 붙는다)
      await c.end().catch(() => {});
      throw err;
    }
    listening = true;
    if (closed) {
      await c.end();
      return;
    }
    client = c;
    // 끊긴 사이에 받아들인 연결도 그동안의 변경분을 잃었을 수 있어 한 번 더 알린다(2차 리뷰)
    if (lost) {
      lost = false;
      gap();
    }
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onGap(listener) {
      gapListeners.add(listener);
      return () => gapListeners.delete(listener);
    },
    isListening() {
      return client !== undefined && !closed;
    },
    ready() {
      first ??= connect();
      return first;
    },
    async close() {
      closed = true;
      if (retry) clearTimeout(retry);
      const c = client;
      client = undefined;
      await c?.end().catch(() => {});
    },
  };
}
