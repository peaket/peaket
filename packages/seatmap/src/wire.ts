// 좌석 상태 두 층의 이진 형식(docs/frontend.md §4.4, docs/api/openapi.yaml `GET /v1/events/{eventId}/seatmap-snapshot`,
// docs/api/asyncapi.yaml `ws.seat-delta`, docs/features/seat-hold.md §2·§7, BUILD_ORDER HOT-110). 모두 리틀 엔디언.
//   스냅샷: u8 version=1, u8 flags(비트0 = 한 구역만), u32 layoutVersion, u32 seatEpoch, u16 sectionCount,
//           구역마다 (u16 sectionIndex, u32 sectionVersion), 비트맵(좌석 색인 순서, 바이트 안 낮은 비트부터, 1 = 점유)
//   프레임 머리: u8 version=1, u8 type. 1 SeatDeltaBatch, 2 Heartbeat, 3 BatchInterval, 16 SubscribeSections(보냄), 18 TimeSync(보냄)

/** Worker 안 좌석 상태(§3.5): 0 가능, 1 다른 분 선택, 2 판매, 3 선택 불가(스냅샷의 점유. 무엇 때문인지 모른다) */
export const STATE = { AVAILABLE: 0, HELD: 1, SOLD: 2, UNAVAILABLE: 3 } as const;

export class WireError extends Error {
  constructor(message: string) {
    super(`좌석 상태 자료가 틀렸다: ${message}`);
    this.name = 'WireError';
  }
}

export interface Snapshot {
  flags: number;
  layoutVersion: number;
  seatEpoch: number;
  sections: Array<{ sectionIndex: number; sectionVersion: number }>;
  bitmap: Uint8Array;
}

export function decodeSnapshot(buf: ArrayBuffer | Uint8Array): Snapshot {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const v = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (u8.byteLength < 12) throw new WireError('스냅샷 머리가 짧다');
  if (v.getUint8(0) !== 1) throw new WireError(`스냅샷 판 ${v.getUint8(0)}`);
  const flags = v.getUint8(1);
  const layoutVersion = v.getUint32(2, true);
  const seatEpoch = v.getUint32(6, true);
  const count = v.getUint16(10, true);
  let p = 12;
  if (u8.byteLength < p + count * 6) throw new WireError('구역 목록이 짧다');
  const sections = [];
  for (let i = 0; i < count; i++, p += 6) sections.push({ sectionIndex: v.getUint16(p, true), sectionVersion: v.getUint32(p + 2, true) });
  return { flags, layoutVersion, seatEpoch, sections, bitmap: u8.subarray(p) };
}

/**
 * 스냅샷을 상태 배열에 쓴다. 점유(1)는 '선택 불가'(3)로 그린다(무엇 때문인지 모른다, seat-hold §2 첫 그림).
 * flags 비트0(한 구역만)이면 비트맵은 그 구역 좌석만이고 구역 시작부터 쓴다.
 * @param range 구역 색인 → [시작, 끝(포함)] 좌석 색인
 */
export function applySnapshot(state: Uint8Array, snap: Snapshot, range: (section: number) => [number, number] | undefined): void {
  const one = (snap.flags & 1) === 1;
  if (one && snap.sections.length !== 1) throw new WireError('한 구역 스냅샷인데 구역이 하나가 아니다');
  const r = one ? range(snap.sections[0]!.sectionIndex) : [0, state.length - 1];
  if (!r) throw new WireError(`없는 구역 ${snap.sections[0]!.sectionIndex}`);
  const [from, to] = r;
  const n = to - from + 1;
  if (snap.bitmap.byteLength < Math.ceil(n / 8)) throw new WireError(`비트맵 ${snap.bitmap.byteLength}B < 좌석 ${n}석`);
  for (let i = 0; i < n; i++) state[from + i] = (snap.bitmap[i >> 3]! >> (i & 7)) & 1 ? STATE.UNAVAILABLE : STATE.AVAILABLE;
}

export type Frame =
  | { type: 'delta'; serverTimeMs: number; maxWaitMs: number; seatEpoch: number; sections: Array<{ sectionIndex: number; sectionVersion: number; offsets: Uint16Array; states: Uint8Array }> }
  | { type: 'heartbeat'; serverTimeMs: number; echoClientTimeMs: number }
  | { type: 'batchInterval'; intervalMs: number };

const u64 = (v: DataView, p: number) => Number(v.getBigUint64(p, true));

/** 서버에서 받은 프레임 하나 */
export function decodeFrame(buf: ArrayBuffer | Uint8Array): Frame {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const v = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const need = (n: number) => {
    if (u8.byteLength < n) throw new WireError(`프레임이 짧다(${u8.byteLength} < ${n})`);
  };
  need(2);
  if (v.getUint8(0) !== 1) throw new WireError(`프레임 판 ${v.getUint8(0)}`);
  const type = v.getUint8(1);
  if (type === 1) {
    need(18);
    const serverTimeMs = u64(v, 2);
    const maxWaitMs = v.getUint16(10, true);
    const seatEpoch = v.getUint32(12, true);
    const count = v.getUint16(16, true);
    let p = 18;
    const sections = [];
    for (let i = 0; i < count; i++) {
      need(p + 8);
      const sectionIndex = v.getUint16(p, true);
      const sectionVersion = v.getUint32(p + 2, true);
      const n = v.getUint16(p + 6, true);
      p += 8;
      need(p + n * 3);
      const offsets = new Uint16Array(n);
      const states = new Uint8Array(n);
      for (let j = 0; j < n; j++, p += 3) {
        offsets[j] = v.getUint16(p, true);
        const st = v.getUint8(p + 2);
        if (st > 2) throw new WireError(`델타 상태 ${st}(0·1·2만)`);
        states[j] = st;
      }
      sections.push({ sectionIndex, sectionVersion, offsets, states });
    }
    return { type: 'delta', serverTimeMs, maxWaitMs, seatEpoch, sections };
  }
  if (type === 2) {
    need(18);
    return { type: 'heartbeat', serverTimeMs: u64(v, 2), echoClientTimeMs: u64(v, 10) };
  }
  if (type === 3) {
    need(4);
    return { type: 'batchInterval', intervalMs: v.getUint16(2, true) };
  }
  throw new WireError(`모르는 프레임 종류 ${type}`);
}

/** 구독할 구역(매번 전체 집합, 4 + 2n 바이트) */
/** 한 연결의 구독 구역 수 상한(docs/frontend.md §4.4 한도 표, 넘으면 서버가 4429로 닫는다) [가정] */
export const MAX_SUBSCRIBED_SECTIONS = 16;

export function encodeSubscribe(sections: readonly number[]): Uint8Array {
  if (sections.length > MAX_SUBSCRIBED_SECTIONS) throw new WireError(`구독은 ${MAX_SUBSCRIBED_SECTIONS}구역까지다(${sections.length})`);
  if (new Set(sections).size !== sections.length) throw new WireError('구독 구역이 겹친다');
  if (sections.some((s) => !Number.isInteger(s) || s < 0 || s > 65_535)) throw new WireError('구역 색인은 0~65535다');
  const u8 = new Uint8Array(4 + sections.length * 2);
  const v = new DataView(u8.buffer);
  v.setUint8(0, 1);
  v.setUint8(1, 16);
  v.setUint16(2, sections.length, true);
  sections.forEach((s, i) => v.setUint16(4 + i * 2, s, true));
  return u8;
}

/** 첫 메시지 인증(type 17, 게이트웨이가 하위 프로토콜을 못 읽을 때의 대체, docs/frontend.md §4.4.1) */
export function encodeAuth(token: string): Uint8Array {
  const bytes = new TextEncoder().encode(token);
  if (bytes.byteLength > 65_535) throw new WireError('토큰이 너무 길다');
  const u8 = new Uint8Array(4 + bytes.byteLength);
  const v = new DataView(u8.buffer);
  v.setUint8(0, 1);
  v.setUint8(1, 17);
  v.setUint16(2, bytes.byteLength, true);
  u8.set(bytes, 4);
  return u8;
}

/** 시계 맞추기 요청(10바이트) */
export function encodeTimeSync(clientTimeMs: number): Uint8Array {
  const u8 = new Uint8Array(10);
  const v = new DataView(u8.buffer);
  v.setUint8(0, 1);
  v.setUint8(1, 18);
  v.setBigUint64(2, BigInt(Math.floor(clientTimeMs)), true);
  return u8;
}

/** 구역마다 마지막으로 반영한 판과 세대. 델타를 받을지 정한다(§4.4 '적용 순서') */
export interface SectionVersions {
  seatEpoch: number;
  version: Uint32Array;
}

export type DeltaDecision =
  | { kind: 'resync-all' } // 세대가 커졌다: 구독 구역을 모두 스냅샷으로 다시 맞춘다(0~1초 무작위 지연)
  | { kind: 'apply'; sections: number[]; resync: number[]; dropped: number[] };

/**
 * 델타 묶음을 상태 배열에 반영한다. 같은 세대에서 구역 판이 +1이면 반영, 같거나 작으면 버림, 건너뛰면 그 구역만 스냅샷.
 * 세대가 작으면(옛 세대) 묶음 전체를 버린다.
 */
export function applyDelta(state: Uint8Array, versions: SectionVersions, frame: Extract<Frame, { type: 'delta' }>, sectionStart: Uint32Array, sectionEnd: Uint32Array): DeltaDecision {
  if (frame.seatEpoch > versions.seatEpoch) return { kind: 'resync-all' };
  const sections: number[] = [];
  const resync: number[] = [];
  const dropped: number[] = [];
  if (frame.seatEpoch < versions.seatEpoch) return { kind: 'apply', sections, resync, dropped: frame.sections.map((s) => s.sectionIndex) };
  for (const s of frame.sections) {
    const cur = versions.version[s.sectionIndex];
    if (cur === undefined) throw new WireError(`없는 구역 ${s.sectionIndex}`);
    if (s.sectionVersion <= cur) {
      dropped.push(s.sectionIndex);
      continue;
    }
    if (s.sectionVersion !== cur + 1) {
      resync.push(s.sectionIndex);
      continue;
    }
    const base = sectionStart[s.sectionIndex]!;
    const last = sectionEnd[s.sectionIndex]!;
    // 먼저 모두 검사하고 쓴다(중간에 멈추면 상태가 반쯤 바뀐 채 판이 그대로 남는다)
    for (let j = 0; j < s.offsets.length; j++) {
      if (base + s.offsets[j]! > last) throw new WireError(`구역 ${s.sectionIndex} 밖 좌석 거리 ${s.offsets[j]}`);
    }
    for (let j = 0; j < s.offsets.length; j++) state[base + s.offsets[j]!] = s.states[j]!;
    versions.version[s.sectionIndex] = s.sectionVersion;
    sections.push(s.sectionIndex);
  }
  return { kind: 'apply', sections, resync, dropped };
}
