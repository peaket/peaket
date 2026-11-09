// 좌석 스냅샷 이진 형식(docs/frontend.md §4.4.2, docs/features/seat-hold.md §2 '스냅샷 API의 첫 구현' 본문 글머리, BUILD_ORDER PRF-137).
// encodeSnapshot·decodeSnapshot·lsbFirstBits(src/modules/inventory/domain/snapshot.ts)를 손으로 계산한 바이트 벡터와 비트 단위 참조 구현으로 본다.
// 모든 수는 little endian. 헤더 = version u8, flags u8, layoutVersion u32, seatEpoch u32, sectionCount u16(12바이트) + 구역 표((sectionIndex u16, sectionVersion u32) × n) + 비트맵.
import { describe, expect, test } from 'vitest';
import {
  decodeSnapshot,
  encodeSnapshot,
  lsbFirstBits,
  SNAPSHOT_FLAG_SECTION_ONLY,
  SNAPSHOT_VERSION,
  type SnapshotBody,
  U16_MAX,
  U32_MAX,
} from '../src/modules/inventory/index.js';

/** 공백으로 끊은 16진 글 → 바이트 */
const hex = (s: string): Buffer => Buffer.from(s.replace(/\s+/g, ''), 'hex');
const bytesOf = (b: Uint8Array): number[] => Array.from(b);

const body = (over: Partial<SnapshotBody> = {}): SnapshotBody => ({
  layoutVersion: 1,
  seatEpoch: 1,
  sectionOnly: false,
  sections: [{ sectionIndex: 0, sectionVersion: 0 }],
  bitmap: Uint8Array.from([0x00]),
  ...over,
});

describe('상수', () => {
  test('FR009_ 형식 상수: version 1, 구역 하나만 flag는 비트 0(값 1), u16·u32 한도', () => {
    expect(SNAPSHOT_VERSION).toBe(1);
    expect(SNAPSHOT_FLAG_SECTION_ONLY).toBe(1);
    expect(U16_MAX).toBe(65535);
    expect(U32_MAX).toBe(4294967295);
  });
});

describe('encodeSnapshot: 손으로 계산한 바이트', () => {
  test('FR009_ 전체 본문 한 벡터: version 1·flags 0·layoutVersion 7·seatEpoch 0x01020304·구역 둘·비트맵 2바이트가 정해진 자리에 big endian으로 놓인다', () => {
    const out = encodeSnapshot({
      layoutVersion: 7,
      seatEpoch: 0x01020304,
      sectionOnly: false,
      sections: [
        { sectionIndex: 0, sectionVersion: 5 },
        { sectionIndex: 1, sectionVersion: 0x0a0b0c0d },
      ],
      bitmap: Uint8Array.from([0xa5, 0x01]),
    });
    // 01 | 00 | 00000007 | 01020304 | 0002 | 0000 00000005 | 0001 0a0b0c0d | a5 01
    expect(Buffer.isBuffer(out)).toBe(true);
    expect(out.toString('hex')).toBe(hex('01 00 07000000 04030201 0200 000005000000 01000d0c0b0a a501').toString('hex'));
    expect(out.length).toBe(26);
  });

  test('FR009_ 구역 하나만(flags 비트 0)에 u16·u32 끝값: 헤더 12바이트 + 구역 표 6바이트 + 비트맵, 끝값이 잘리거나 부호가 붙지 않는다', () => {
    const out = encodeSnapshot({
      layoutVersion: U32_MAX,
      seatEpoch: U32_MAX,
      sectionOnly: true,
      sections: [{ sectionIndex: U16_MAX, sectionVersion: U32_MAX }],
      bitmap: Uint8Array.from([0x80]),
    });
    expect(out.toString('hex')).toBe(hex('01 01 ffffffff ffffffff 0100 ffff ffffffff 80').toString('hex'));
    expect(out.length).toBe(19);
  });

  test('FR009_ 구역이 하나도 없어도 만들 수 있다: sectionCount 0이고 구역 표가 없어 바로 비트맵이 온다', () => {
    const out = encodeSnapshot({ layoutVersion: 0, seatEpoch: 0, sectionOnly: false, sections: [], bitmap: Uint8Array.from([0xff]) });
    expect(out.toString('hex')).toBe(hex('01 00 00000000 00000000 0000 ff').toString('hex'));
  });

  test('FR009_ 모든 값이 0인 가장 작은 본문: 구역 색인 0·일련번호 0·비트맵 0', () => {
    const out = encodeSnapshot({ layoutVersion: 0, seatEpoch: 0, sectionOnly: false, sections: [{ sectionIndex: 0, sectionVersion: 0 }], bitmap: Uint8Array.from([0x00]) });
    expect(out.toString('hex')).toBe(hex('01 00 00000000 00000000 0100 000000000000 00').toString('hex'));
  });

  test('FR009_ 구역 65535개(구역 색인 0 ~ 65534)까지 만들 수 있고 sectionCount는 0xffff다', () => {
    const sections = Array.from({ length: 65535 }, (_, i) => ({ sectionIndex: i, sectionVersion: i }));
    const out = encodeSnapshot(body({ sections, bitmap: Uint8Array.from([0x01]) }));
    expect(out.length).toBe(12 + 65535 * 6 + 1);
    expect(out.readUInt16LE(10)).toBe(65535);
    // 마지막 구역 표 칸 (65534, 65534)
    expect(out.readUInt16LE(12 + 65534 * 6)).toBe(65534);
    expect(out.readUInt32LE(12 + 65534 * 6 + 2)).toBe(65534);
    expect(out[out.length - 1]).toBe(0x01);
  });

  test('FR009_ 인자로 준 비트맵을 바꾸지 않고, 결과를 바꿔도 인자에 영향이 없다(복사)', () => {
    const bitmap = Uint8Array.from([0x12, 0x34]);
    const out = encodeSnapshot(body({ bitmap }));
    expect(bytesOf(bitmap)).toEqual([0x12, 0x34]);
    out[out.length - 1] = 0xff;
    expect(bytesOf(bitmap)).toEqual([0x12, 0x34]);
  });
});

describe('encodeSnapshot: 범위 밖 값은 RangeError', () => {
  test('FR009_ layoutVersion·seatEpoch가 0 ~ 2^32 − 1의 정수가 아니면 RangeError다(음수·2^32·소수·NaN·Infinity·글)', () => {
    for (const bad of [-1, U32_MAX + 1, 2 ** 53, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '1' as unknown as number]) {
      expect(() => encodeSnapshot(body({ layoutVersion: bad })), `layoutVersion ${String(bad)}`).toThrow(RangeError);
      expect(() => encodeSnapshot(body({ seatEpoch: bad })), `seatEpoch ${String(bad)}`).toThrow(RangeError);
    }
  });

  test('FR009_ 구역 색인이 0 ~ 65535의 정수가 아니면 RangeError다', () => {
    for (const bad of [-1, U16_MAX + 1, 1.5, Number.NaN]) {
      expect(() => encodeSnapshot(body({ sections: [{ sectionIndex: bad, sectionVersion: 0 }] })), `sectionIndex ${bad}`).toThrow(RangeError);
    }
  });

  test('FR009_ 구역 일련번호가 0 ~ 2^32 − 1의 정수가 아니면 RangeError다', () => {
    for (const bad of [-1, U32_MAX + 1, 1.5, Number.NaN]) {
      expect(() => encodeSnapshot(body({ sections: [{ sectionIndex: 0, sectionVersion: bad }] })), `sectionVersion ${bad}`).toThrow(RangeError);
    }
  });

  test('FR009_ 구역 색인이 오름차순이 아니거나 겹치면 RangeError다(정렬 안 된 구역 표를 내보내지 않는다)', () => {
    expect(() =>
      encodeSnapshot(
        body({
          sections: [
            { sectionIndex: 1, sectionVersion: 0 },
            { sectionIndex: 0, sectionVersion: 0 },
          ],
        }),
      ),
    ).toThrow(RangeError);
    expect(() =>
      encodeSnapshot(
        body({
          sections: [
            { sectionIndex: 3, sectionVersion: 1 },
            { sectionIndex: 3, sectionVersion: 2 },
          ],
        }),
      ),
    ).toThrow(RangeError);
    expect(() =>
      encodeSnapshot(
        body({
          sections: [
            { sectionIndex: 0, sectionVersion: 0 },
            { sectionIndex: 5, sectionVersion: 0 },
            { sectionIndex: 4, sectionVersion: 0 },
          ],
        }),
      ),
    ).toThrow(RangeError);
  });

  test('FR009_ 구역이 65536개(sectionCount가 u16에 들어가지 않음)면 RangeError다', () => {
    const sections = Array.from({ length: 65536 }, (_, i) => ({ sectionIndex: i, sectionVersion: 0 }));
    expect(() => encodeSnapshot(body({ sections }))).toThrow(RangeError);
  });
});

describe('decodeSnapshot', () => {
  test('FR009_ 손으로 만든 바이트를 읽는다: 헤더·구역 표·비트맵이 정해진 자리에서 나온다', () => {
    const r = decodeSnapshot(hex('01 00 07000000 04030201 0200 000005000000 01000d0c0b0a a501'));
    expect(r.layoutVersion).toBe(7);
    expect(r.seatEpoch).toBe(0x01020304);
    expect(r.sectionOnly).toBe(false);
    expect(r.sections).toEqual([
      { sectionIndex: 0, sectionVersion: 5 },
      { sectionIndex: 1, sectionVersion: 0x0a0b0c0d },
    ]);
    expect(bytesOf(r.bitmap)).toEqual([0xa5, 0x01]);
  });

  test('FR009_ flags 비트 0이 켜져 있으면 sectionOnly이고 u32 끝값을 부호 없이 읽는다', () => {
    const r = decodeSnapshot(hex('01 01 ffffffff ffffffff 0100 ffff ffffffff 80'));
    expect(r).toMatchObject({ layoutVersion: U32_MAX, seatEpoch: U32_MAX, sectionOnly: true });
    expect(r.sections).toEqual([{ sectionIndex: U16_MAX, sectionVersion: U32_MAX }]);
    expect(bytesOf(r.bitmap)).toEqual([0x80]);
  });

  test('FR009_ 구역 표가 비어 있으면 sections가 [] 이고 나머지는 비트맵이다', () => {
    const r = decodeSnapshot(hex('01 00 00000000 00000000 0000 ff'));
    expect(r.sections).toEqual([]);
    expect(bytesOf(r.bitmap)).toEqual([0xff]);
  });

  test('FR009_ encode → decode가 처음 값으로 돌아온다(여러 구역·구역 하나만·끝값)', () => {
    const cases: SnapshotBody[] = [
      body({ layoutVersion: 3, seatEpoch: 1762226400, sections: [{ sectionIndex: 0, sectionVersion: 0 }, { sectionIndex: 2, sectionVersion: 41 }], bitmap: Uint8Array.from([1, 2, 3, 4]) }),
      body({ sectionOnly: true, sections: [{ sectionIndex: 9, sectionVersion: U32_MAX }], bitmap: Uint8Array.from([0xff]) }),
      body({ layoutVersion: U32_MAX, seatEpoch: 0, sections: [], bitmap: Uint8Array.from([0, 0, 0]) }),
    ];
    for (const c of cases) {
      const r = decodeSnapshot(encodeSnapshot(c));
      expect({ ...r, bitmap: bytesOf(r.bitmap) }).toEqual({ ...c, bitmap: bytesOf(c.bitmap) });
    }
  });

  test('FR009_ 헤더 12바이트보다 짧으면 RangeError다(0·1·11바이트)', () => {
    const full = hex('01 00 07000000 04030201 0200 000005000000 01000d0c0b0a a501');
    for (const n of [0, 1, 2, 11]) expect(() => decodeSnapshot(full.subarray(0, n)), `${n}바이트`).toThrow(RangeError);
  });

  test('FR009_ sectionCount가 가리키는 구역 표가 입력보다 길면 RangeError다(구역 표 중간에서 잘림)', () => {
    const full = hex('01 00 07000000 04030201 0200 000005000000 01000d0c0b0a a501');
    // 구역 표 두 칸 가운데 둘째 칸 중간(헤더 12 + 6 + 3)에서 자른다
    expect(() => decodeSnapshot(full.subarray(0, 12 + 6 + 3))).toThrow(RangeError);
    // sectionCount만 크게 고친 입력
    const lying = Buffer.from(full);
    lying.writeUInt16LE(500, 10);
    expect(() => decodeSnapshot(lying)).toThrow(RangeError);
  });

  test('FR009_ version이 1이 아니면 RangeError다(0·2·255)', () => {
    for (const v of [0, 2, 255]) {
      const b = Buffer.from(hex('01 00 07000000 04030201 0100 000005000000 a5'));
      b[0] = v;
      expect(() => decodeSnapshot(b), `version ${v}`).toThrow(RangeError);
    }
  });

  test('FR009_ 입력 바이트를 바꾸지 않고, 순수 Uint8Array(Buffer가 아닌 입력)도 읽는다', () => {
    const raw = hex('01 00 07000000 04030201 0100 000005000000 a5');
    const input = Uint8Array.from(raw);
    const r = decodeSnapshot(input);
    expect(bytesOf(r.bitmap)).toEqual([0xa5]);
    expect(r.sections).toEqual([{ sectionIndex: 0, sectionVersion: 5 }]);
    expect(bytesOf(input)).toEqual(bytesOf(raw));
  });
});

describe('lsbFirstBits: Redis(바이트 안에서 높은 비트부터) → 본문(낮은 비트부터)', () => {
  test('FR009_ 바이트 하나의 비트 뒤집기: 0x80(맨 앞 좌석만 1) → 0x01, 0x01(맨 뒤 좌석만 1) → 0x80, 0xd2 → 0x4b', () => {
    expect(bytesOf(lsbFirstBits(Uint8Array.from([0x80]), 0, 0, 8))).toEqual([0x01]);
    expect(bytesOf(lsbFirstBits(Uint8Array.from([0x01]), 0, 0, 8))).toEqual([0x80]);
    // 0xd2 = 1101 0010 → 좌석 0,1,3,6이 1 → 낮은 비트부터: 1 + 2 + 8 + 64 = 75 = 0x4b
    expect(bytesOf(lsbFirstBits(Uint8Array.from([0xd2]), 0, 0, 8))).toEqual([0x4b]);
  });

  test('FR009_ 좌석 색인 순서가 보존된다: 여러 바이트를 바이트마다 따로 뒤집을 뿐 바이트 순서는 그대로다', () => {
    expect(bytesOf(lsbFirstBits(Uint8Array.from([0x80, 0x01, 0xd2]), 0, 0, 24))).toEqual([0x01, 0x80, 0x4b]);
  });

  test('FR009_ firstBit가 바이트 경계가 아니면 그 비트부터 처음 비트로 당겨 채운다(비트 3 ~ 10 → 0x89)', () => {
    // 0xd2 = 1101 0010, 0x3c = 0011 1100 → 좌석 3..10 = 1,0,0,1,0,0,0,1 → 1 + 8 + 128 = 137
    expect(bytesOf(lsbFirstBits(Uint8Array.from([0xd2, 0x3c]), 0, 3, 8))).toEqual([0x89]);
  });

  test('FR009_ 비트 범위가 바이트에 걸쳐도 되고 걸치지 않아도 된다(6 ~ 10은 두 바이트에 걸침 → 0x11, 8 ~ 15는 한 바이트 → 0x3c를 뒤집은 값)', () => {
    expect(bytesOf(lsbFirstBits(Uint8Array.from([0xd2, 0x3c]), 0, 6, 5))).toEqual([0x11]);
    // 0x3c = 0011 1100 → 좌석 8..15 = 0,0,1,1,1,1,0,0 → 4 + 8 + 16 + 32 = 60 = 0x3c(대칭이라 같다)
    expect(bytesOf(lsbFirstBits(Uint8Array.from([0xd2, 0x3c]), 0, 8, 8))).toEqual([0x3c]);
    // 대칭이 아닌 0x2c = 0010 1100 → 좌석 8..15 = 0,0,1,0,1,1,0,0 → 4 + 16 + 32 = 52 = 0x34
    expect(bytesOf(lsbFirstBits(Uint8Array.from([0x00, 0x2c]), 0, 8, 8))).toEqual([0x34]);
  });

  test('FR009_ 마지막 바이트의 남는 비트는 0이다: 비트 12개는 2바이트(0xff, 0x0f), 5개는 1바이트(0x1f)', () => {
    const r12 = lsbFirstBits(Uint8Array.from([0xff, 0xff]), 0, 0, 12);
    expect(bytesOf(r12)).toEqual([0xff, 0x0f]);
    const r5 = lsbFirstBits(Uint8Array.from([0xff, 0xff]), 0, 0, 5);
    expect(bytesOf(r5)).toEqual([0x1f]);
    // 뒤에 1이 더 있어도 bitCount 밖은 싣지 않는다
    expect(bytesOf(lsbFirstBits(Uint8Array.from([0xff, 0xff, 0xff]), 0, 0, 4))).toEqual([0x0f]);
  });

  test('FR009_ 결과 길이는 ceil(bitCount / 8)이고 Buffer다. bitCount 0이면 빈 Buffer다', () => {
    for (const [count, len] of [[0, 0], [1, 1], [8, 1], [9, 2], [16, 2], [17, 3]] as const) {
      const r = lsbFirstBits(Uint8Array.from([0xff, 0xff, 0xff]), 0, 0, count);
      expect(Buffer.isBuffer(r)).toBe(true);
      expect({ count, len: r.length }).toEqual({ count, len });
    }
  });

  test('FR009_ 읽어 온 바이트 밖의 비트는 0으로 본다: 바이트가 모자라도, 아예 없어도 bitCount만큼 채운다', () => {
    expect(bytesOf(lsbFirstBits(Uint8Array.from([0xff]), 0, 0, 16))).toEqual([0xff, 0x00]);
    // 비트 4 ~ 11: 4..7은 1, 8..11은 범위 밖 → 0x0f
    expect(bytesOf(lsbFirstBits(Uint8Array.from([0xff]), 0, 4, 8))).toEqual([0x0f]);
    expect(bytesOf(lsbFirstBits(new Uint8Array(0), 0, 0, 10))).toEqual([0x00, 0x00]);
  });

  test('FR009_ firstByte: redisBytes[0]은 비트맵의 firstByte번째 바이트다(바이트 2는 비트 16 ~ 23)', () => {
    expect(bytesOf(lsbFirstBits(Uint8Array.from([0x80]), 2, 16, 1))).toEqual([0x01]);
    expect(bytesOf(lsbFirstBits(Uint8Array.from([0x80]), 2, 17, 1))).toEqual([0x00]);
    expect(bytesOf(lsbFirstBits(Uint8Array.from([0x80]), 2, 16, 3))).toEqual([0x01]);
    // 읽어 온 바이트 바로 다음 바이트(비트 24 ~)는 범위 밖이라 0
    expect(bytesOf(lsbFirstBits(Uint8Array.from([0xff]), 2, 20, 8))).toEqual([0x0f]);
  });

  test('FR009_ 입력 바이트를 바꾸지 않는다', () => {
    const input = Uint8Array.from([0xd2, 0x3c]);
    lsbFirstBits(input, 0, 3, 8);
    expect(bytesOf(input)).toEqual([0xd2, 0x3c]);
  });

  test('FR009_ 인자가 범위를 벗어나면 RangeError다(firstByte·firstBit·bitCount가 음수·소수·NaN·안전한 정수 밖, firstBit < 8 × firstByte)', () => {
    const b = Uint8Array.from([0xff, 0xff]);
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
      expect(() => lsbFirstBits(b, bad, 0, 8), `firstByte ${bad}`).toThrow(RangeError);
      expect(() => lsbFirstBits(b, 0, bad, 8), `firstBit ${bad}`).toThrow(RangeError);
      expect(() => lsbFirstBits(b, 0, 0, bad), `bitCount ${bad}`).toThrow(RangeError);
    }
    // 읽어 온 첫 바이트보다 앞의 비트는 줄 수 없다
    expect(() => lsbFirstBits(b, 2, 15, 1)).toThrow(RangeError);
    expect(() => lsbFirstBits(b, 2, 0, 1)).toThrow(RangeError);
    // 경계(firstBit = 8 × firstByte)는 된다
    expect(() => lsbFirstBits(b, 2, 16, 1)).not.toThrow();
  });
});

/** 시드 고정 의사 난수(mulberry32) */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 비트 하나씩 계산하는 참조 구현(정본의 정의 그대로) */
function referenceBits(redisBytes: Uint8Array, firstByte: number, firstBit: number, bitCount: number): number[] {
  const out = new Array<number>(Math.ceil(bitCount / 8)).fill(0);
  for (let j = 0; j < bitCount; j++) {
    const k = firstBit + j;
    const i = (k >> 3) - firstByte;
    const bit = i >= 0 && i < redisBytes.length ? (redisBytes[i]! >> (7 - (k & 7))) & 1 : 0;
    out[j >> 3]! |= bit << (j & 7);
  }
  return out;
}

describe('속성 시험(시드 고정)', () => {
  test('FR009_ 무작위 비트맵과 무작위 구간 500개에서 lsbFirstBits는 비트 단위 참조 구현과 같다', () => {
    const next = rng(20261104);
    const int = (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1));
    for (let n = 0; n < 500; n++) {
      const redisBytes = Uint8Array.from({ length: int(0, 24) }, () => int(0, 255));
      const firstByte = int(0, 6);
      const firstBit = firstByte * 8 + int(0, 90);
      const bitCount = int(0, 130);
      const got = bytesOf(lsbFirstBits(redisBytes, firstByte, firstBit, bitCount));
      expect({ n, firstByte, firstBit, bitCount, len: redisBytes.length, got }).toEqual({ n, firstByte, firstBit, bitCount, len: redisBytes.length, got: referenceBits(redisBytes, firstByte, firstBit, bitCount) });
    }
  });

  test('FR009_ 무작위 본문 200개는 encode → decode로 그대로 돌아오고 길이는 12 + 6 × 구역 수 + 비트맵 길이다', () => {
    const next = rng(4242);
    const int = (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1));
    for (let n = 0; n < 200; n++) {
      const count = int(0, 40);
      const used = new Set<number>();
      while (used.size < count) used.add(int(0, U16_MAX));
      const sections = [...used].sort((a, b) => a - b).map((sectionIndex) => ({ sectionIndex, sectionVersion: int(0, 1) === 0 ? int(0, 1000) : int(0, U32_MAX) }));
      const original: SnapshotBody = {
        layoutVersion: int(0, U32_MAX),
        seatEpoch: int(0, U32_MAX),
        sectionOnly: next() < 0.5,
        sections,
        bitmap: Uint8Array.from({ length: int(1, 64) }, () => int(0, 255)),
      };
      const encoded = encodeSnapshot(original);
      expect(encoded.length).toBe(12 + 6 * sections.length + original.bitmap.length);
      const back = decodeSnapshot(encoded);
      expect({ n, back: { ...back, bitmap: bytesOf(back.bitmap) } }).toEqual({ n, back: { ...original, bitmap: bytesOf(original.bitmap) } });
    }
  });
});

describe('화면 복호기와 맞물림(BUILD_ORDER HOT-358 리뷰 V2)', () => {
  test('HOT-358 V2 서버가 만든 스냅샷을 화면 복호기(packages/seatmap wire)가 같은 값으로 읽는다', async () => {
    const { decodeSnapshot: browserDecode } = await import('../../../packages/seatmap/src/wire.js');
    const bytes = encodeSnapshot({ layoutVersion: 2, seatEpoch: 7, sectionOnly: false, sections: [{ sectionIndex: 0, sectionVersion: 1 }, { sectionIndex: 5, sectionVersion: 300 }], bitmap: new Uint8Array([1, 2, 3]) });
    const s = browserDecode(new Uint8Array(bytes));
    expect(s.layoutVersion).toBe(2);
    expect(s.seatEpoch).toBe(7);
    expect(s.sections).toEqual([{ sectionIndex: 0, sectionVersion: 1 }, { sectionIndex: 5, sectionVersion: 300 }]);
    expect(Array.from(s.bitmap)).toEqual([1, 2, 3]);
  });
});
