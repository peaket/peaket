// 좌석 스냅샷 이진 형식(docs/frontend.md §4.4.2, docs/features/seat-hold.md §2 '스냅샷 API의 첫 구현', BUILD_ORDER PRF-137).
// 순수 함수라 프레임워크·플랫폼 형을 가져오지 않는다. 클라이언트의 해독 규칙을 TypeScript로 옮긴 decodeSnapshot은 시험·참고용이다.
import { KEY_PART } from './hold.js';
import type { SnapshotReadInput } from './ports.js';

/** 이진 본문의 판(version 칸) */
export const SNAPSHOT_VERSION = 1;
/** flags 비트 0: `?section=`으로 구역 하나만 실었다 */
export const SNAPSHOT_FLAG_SECTION_ONLY = 1;
/** u16·u32 한도 */
export const U16_MAX = 0xffff;
export const U32_MAX = 0xffff_ffff;

/** version u8 + flags u8 + layoutVersion u32 + seatEpoch u32 + sectionCount u16 */
const HEADER_BYTES = 12;
/** 구역 표 한 줄: sectionIndex u16 + sectionVersion u32 */
const SECTION_ROW_BYTES = 6;

/**
 * SeatSnapshots.read 입력의 모양 검사(두 구현이 같이 쓴다). 틀리면 RangeError(아무것도 부르지 않는다):
 * eventId가 KEY_PART, firstBit가 0 이상의 안전한 정수, bitCount가 1 이상의 안전한 정수(끝 비트도 안전한 정수), sectionIndexes가 1개 이상이고 0 ~ 65535의 정수이며 겹치지 않음
 */
export function assertSnapshotInput(i: SnapshotReadInput): void {
  if (typeof i.eventId !== 'string' || !KEY_PART.test(i.eventId)) throw new RangeError('eventId가 키 조각 모양이 아니다');
  if (!isInt(i.firstBit, Number.MAX_SAFE_INTEGER)) throw new RangeError('firstBit가 0 이상의 안전한 정수가 아니다');
  if (!isInt(i.bitCount, Number.MAX_SAFE_INTEGER) || i.bitCount < 1) throw new RangeError('bitCount가 1 이상의 안전한 정수가 아니다');
  if (!Number.isSafeInteger(i.firstBit + i.bitCount)) throw new RangeError('읽을 비트 범위가 안전한 정수를 넘는다');
  if (!Array.isArray(i.sectionIndexes) || i.sectionIndexes.length < 1) throw new RangeError('sectionIndexes가 비었다');
  const seen = new Set<number>();
  for (const s of i.sectionIndexes) {
    if (!isInt(s, U16_MAX)) throw new RangeError('구역 색인이 0 ~ 65535의 정수가 아니다');
    if (seen.has(s)) throw new RangeError('구역 색인이 겹친다');
    seen.add(s);
  }
}

/** 본문 하나가 담는 값 */
export interface SnapshotBody {
  /** 좌석맵 판 번호(0 ~ 2^32 − 1) */
  layoutVersion: number;
  /** 회차 세대(0 ~ 2^32 − 1) */
  seatEpoch: number;
  /** 구역 하나만 실었는가(flags 비트 0) */
  sectionOnly: boolean;
  /** 실은 구역의 (구역 색인 0 ~ 65535, 구역 일련번호 0 ~ 2^32 − 1). 구역 색인 오름차순으로 싣는다 */
  sections: ReadonlyArray<{ sectionIndex: number; sectionVersion: number }>;
  /** 본문의 비트맵 바이트(좌석 색인 순서, 바이트 안에서 낮은 비트부터). lsbFirstBits의 결과 */
  bitmap: Uint8Array;
}

const isInt = (v: unknown, max: number): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= max;

/**
 * 본문을 만든다: version u8, flags u8, layoutVersion u32, seatEpoch u32, sectionCount u16, 구역 표(sectionIndex u16, sectionVersion u32) × sectionCount, 비트맵. 모두 big endian.
 * 값이 범위를 벗어나거나(RangeError) 구역 색인이 오름차순이 아니거나 겹치거나 구역이 65535개를 넘으면 RangeError
 */
export function encodeSnapshot(body: SnapshotBody): Buffer {
  if (!isInt(body.layoutVersion, U32_MAX)) throw new RangeError('layoutVersion이 0 ~ 2^32 − 1의 정수가 아니다');
  if (!isInt(body.seatEpoch, U32_MAX)) throw new RangeError('seatEpoch가 0 ~ 2^32 − 1의 정수가 아니다');
  const n = body.sections.length;
  if (n > U16_MAX) throw new RangeError('구역이 65535개를 넘는다');
  let prev = -1;
  for (const s of body.sections) {
    if (!isInt(s.sectionIndex, U16_MAX)) throw new RangeError('sectionIndex가 0 ~ 65535의 정수가 아니다');
    if (!isInt(s.sectionVersion, U32_MAX)) throw new RangeError('sectionVersion이 0 ~ 2^32 − 1의 정수가 아니다');
    if (s.sectionIndex <= prev) throw new RangeError('구역 색인이 오름차순이 아니거나 겹친다');
    prev = s.sectionIndex;
  }
  const out = Buffer.allocUnsafe(HEADER_BYTES + SECTION_ROW_BYTES * n + body.bitmap.length);
  out.writeUInt8(SNAPSHOT_VERSION, 0);
  out.writeUInt8(body.sectionOnly ? SNAPSHOT_FLAG_SECTION_ONLY : 0, 1);
  out.writeUInt32BE(body.layoutVersion, 2);
  out.writeUInt32BE(body.seatEpoch, 6);
  out.writeUInt16BE(n, 10);
  let at = HEADER_BYTES;
  for (const s of body.sections) {
    out.writeUInt16BE(s.sectionIndex, at);
    out.writeUInt32BE(s.sectionVersion, at + 2);
    at += SECTION_ROW_BYTES;
  }
  out.set(body.bitmap, at);
  return out;
}

/** 본문을 읽는다(encodeSnapshot의 거울). 길이가 모자라거나 version이 1이 아니거나 모르는 flags 비트가 있으면 RangeError */
export function decodeSnapshot(buf: Uint8Array): SnapshotBody {
  if (buf.length < HEADER_BYTES) throw new RangeError('스냅샷 본문이 머리보다 짧다');
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  if (b.readUInt8(0) !== SNAPSHOT_VERSION) throw new RangeError('스냅샷 본문의 version이 1이 아니다');
  const flags = b.readUInt8(1);
  if ((flags & ~SNAPSHOT_FLAG_SECTION_ONLY) !== 0) throw new RangeError('스냅샷 본문의 flags에 모르는 비트가 있다');
  const n = b.readUInt16BE(10);
  if (b.length < HEADER_BYTES + SECTION_ROW_BYTES * n) throw new RangeError('스냅샷 본문이 구역 표보다 짧다');
  const sections: Array<{ sectionIndex: number; sectionVersion: number }> = [];
  let at = HEADER_BYTES;
  for (let i = 0; i < n; i++) {
    sections.push({ sectionIndex: b.readUInt16BE(at), sectionVersion: b.readUInt32BE(at + 2) });
    at += SECTION_ROW_BYTES;
  }
  return {
    layoutVersion: b.readUInt32BE(2),
    seatEpoch: b.readUInt32BE(6),
    sectionOnly: (flags & SNAPSHOT_FLAG_SECTION_ONLY) !== 0,
    sections,
    bitmap: Uint8Array.from(b.subarray(at)),
  };
}

/** 바이트 안의 비트 순서를 뒤집는 표(높은 비트부터 ↔ 낮은 비트부터) */
const REVERSED = (() => {
  const t = new Uint8Array(256);
  for (let v = 0; v < 256; v++) {
    let r = 0;
    for (let k = 0; k < 8; k++) if (v & (1 << k)) r |= 0x80 >> k;
    t[v] = r;
  }
  return t;
})();

/**
 * 좌석 Redis 비트맵 바이트(바이트 안에서 높은 비트부터)에서 `firstBit`번째 비트부터 `bitCount`개를 꺼내 처음 비트부터 채운 바이트(바이트 안에서 낮은 비트부터)로 바꾼다.
 * `redisBytes`는 비트 `8 * firstByte`부터 시작하는 바이트들이다(스냅샷 읽기 Lua가 돌려준 범위). 범위를 넘는 비트는 0으로 본다. 결과 길이는 ceil(bitCount / 8)이고 마지막 바이트의 남는 비트는 0이다.
 * @param redisBytes 읽어 온 바이트들
 * @param firstByte redisBytes[0]이 비트맵의 몇 번째 바이트인가
 * @param firstBit 꺼낼 첫 비트(좌석 색인, 0 이상의 안전한 정수, 8 * firstByte 이상)
 * @param bitCount 꺼낼 비트 수(0 이상의 안전한 정수)
 * @throws RangeError 인자가 위 범위가 아님
 */
export function lsbFirstBits(redisBytes: Uint8Array, firstByte: number, firstBit: number, bitCount: number): Buffer {
  if (!isInt(firstByte, Number.MAX_SAFE_INTEGER) || !isInt(firstBit, Number.MAX_SAFE_INTEGER) || !isInt(bitCount, Number.MAX_SAFE_INTEGER)) {
    throw new RangeError('firstByte·firstBit·bitCount는 0 이상의 안전한 정수여야 한다');
  }
  if (firstBit < 8 * firstByte) throw new RangeError('firstBit가 읽어 온 첫 바이트보다 앞이다');
  const out = Buffer.alloc(Math.ceil(bitCount / 8));
  if (bitCount === 0) return out;
  const startByte = Math.floor(firstBit / 8) - firstByte;
  const shift = firstBit % 8;
  if (shift === 0) {
    // 바이트 경계에서 시작하면 바이트마다 비트 순서만 뒤집는다
    for (let i = 0; i < out.length; i++) out[i] = REVERSED[redisBytes[startByte + i] ?? 0]!;
  } else {
    for (let i = 0; i < bitCount; i++) {
      const at = shift + i;
      const src = redisBytes[startByte + (at >> 3)] ?? 0;
      if ((src >> (7 - (at & 7))) & 1) out[i >> 3]! |= 1 << (i & 7);
    }
    return out;
  }
  const rest = bitCount & 7;
  if (rest !== 0) out[out.length - 1]! &= (1 << rest) - 1;
  return out;
}
