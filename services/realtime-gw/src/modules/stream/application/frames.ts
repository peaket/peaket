// 좌석 델타 WebSocket 프레임(docs/frontend.md §4.4.1 표, docs/api/asyncapi.yaml `ws.seat-delta`, BUILD_ORDER HOT-090).
// 리틀 엔디언. 모든 프레임의 머리는 u8 version(=1), u8 type이다.
//   보냄: 1 SeatDeltaBatch, 2 Heartbeat, 3 BatchInterval. 받음: 16 SubscribeSections, 18 TimeSync.
// 받는 프레임 검사의 ①(모양)만 여기서 하고, 빈도·상한·구역 수 검사(②~④)는 허브가 한다(docs/features/seat-hold.md §7 '받는 프레임 검사').
// 허브(유스케이스 층)가 부르므로 유스케이스 층에 둔다(층 의존 방향 린트: 유스케이스는 받는 층을 가져오지 않는다).

export const FRAME_VERSION = 1;
export const TYPE_SEAT_DELTA_BATCH = 1;
export const TYPE_HEARTBEAT = 2;
export const TYPE_BATCH_INTERVAL = 3;
export const TYPE_SUBSCRIBE_SECTIONS = 16;
export const TYPE_TIME_SYNC = 18;

/** 받는 프레임 하나의 바이트 상한(seat-hold §7 '받는 프레임 검사' ①, [가정]) */
export const MAX_INBOUND_FRAME_BYTES = 1024;
/** TimeSync 길이(머리 2 + u64) */
export const TIME_SYNC_BYTES = 10;

export type InboundFrame = { type: 'subscribe'; sections: number[] } | { type: 'timeSync'; clientTimeMs: bigint };

/** 묶음 안 구역 항목 하나(같은 구역이 여러 번 올 수 있다. 받은 차례대로 싣는다, ADR-0296 결정 4) */
export interface BatchEntry {
  sectionIndex: number;
  sectionVersion: number;
  seats: ReadonlyArray<{ offset: number; state: number }>;
}

/**
 * 받은 프레임을 읽는다. 모양이 틀리면 undefined(부르는 쪽이 4403으로 닫는다).
 * 글 프레임, 1,024바이트를 넘는 프레임, version ≠ 1, type이 16·18이 아님(17 포함), SubscribeSections 길이 ≠ 4 + 2 × count, TimeSync 길이 ≠ 10이 틀린 모양이다
 */
export function decodeInbound(data: Uint8Array, isBinary: boolean): InboundFrame | undefined {
  if (!isBinary) return undefined;
  if (data.byteLength > MAX_INBOUND_FRAME_BYTES || data.byteLength < 2) return undefined;
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (v.getUint8(0) !== FRAME_VERSION) return undefined;
  const type = v.getUint8(1);
  if (type === TYPE_SUBSCRIBE_SECTIONS) {
    if (data.byteLength < 4) return undefined;
    const count = v.getUint16(2, true);
    if (data.byteLength !== 4 + 2 * count) return undefined;
    const sections: number[] = [];
    for (let i = 0; i < count; i++) sections.push(v.getUint16(4 + 2 * i, true));
    return { type: 'subscribe', sections };
  }
  if (type === TYPE_TIME_SYNC) {
    if (data.byteLength !== TIME_SYNC_BYTES) return undefined;
    return { type: 'timeSync', clientTimeMs: v.getBigUint64(2, true) };
  }
  return undefined;
}

/** BatchInterval{u16 intervalMs}(4바이트) */
export function encodeBatchInterval(intervalMs: number): Uint8Array {
  const u8 = new Uint8Array(4);
  const v = new DataView(u8.buffer);
  v.setUint8(0, FRAME_VERSION);
  v.setUint8(1, TYPE_BATCH_INTERVAL);
  v.setUint16(2, intervalMs, true);
  return u8;
}

/** Heartbeat{u64 serverTimeMs, u64 echoClientTimeMs}(18바이트) */
export function encodeHeartbeat(serverTimeMs: number, echoClientTimeMs: bigint): Uint8Array {
  const u8 = new Uint8Array(18);
  const v = new DataView(u8.buffer);
  v.setUint8(0, FRAME_VERSION);
  v.setUint8(1, TYPE_HEARTBEAT);
  v.setBigUint64(2, BigInt(serverTimeMs), true);
  v.setBigUint64(10, echoClientTimeMs, true);
  return u8;
}

/**
 * SeatDeltaBatch{u64 serverTimeMs, u16 maxWaitMs, u32 seatEpoch, u16 sectionCount, 구역마다 (u16 sectionIndex, u32 sectionVersion, u16 count, count × (u16 seatOffset, u8 state))}.
 * 묶음에는 좌석 거리와 상태만 싣는다(ASVS v5.0.0-8.1.2)
 */
export function encodeSeatDeltaBatch(b: { serverTimeMs: number; maxWaitMs: number; seatEpoch: number; entries: readonly BatchEntry[] }): Uint8Array {
  let size = 18;
  for (const e of b.entries) size += 8 + 3 * e.seats.length;
  const u8 = new Uint8Array(size);
  const v = new DataView(u8.buffer);
  v.setUint8(0, FRAME_VERSION);
  v.setUint8(1, TYPE_SEAT_DELTA_BATCH);
  v.setBigUint64(2, BigInt(b.serverTimeMs), true);
  v.setUint16(10, b.maxWaitMs, true);
  v.setUint32(12, b.seatEpoch, true);
  v.setUint16(16, b.entries.length, true);
  let p = 18;
  for (const e of b.entries) {
    v.setUint16(p, e.sectionIndex, true);
    v.setUint32(p + 2, e.sectionVersion, true);
    v.setUint16(p + 6, e.seats.length, true);
    p += 8;
    for (const s of e.seats) {
      v.setUint16(p, s.offset, true);
      v.setUint8(p + 2, s.state);
      p += 3;
    }
  }
  return u8;
}
