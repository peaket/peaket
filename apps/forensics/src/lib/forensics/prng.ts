// F-04-9 고정 시드 의사난수(xoshiro128**). 정본: docs/features/forensic-replay.md §5.3·§8 FX-T1.
// 32비트 정수 연산과 Math.imul만 쓴다. 실행 중 난수·시계를 쓰지 않는다(린트가 막는다).
// 같은 시드 문자열은 네 낱말 상태로 바뀌고, 같은 상태는 같은 열을 낸다.

export type SeedState = readonly [number, number, number, number];

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
const SALTS: SeedState = [0x9e3779b9, 0x85ebca6b, 0xc2b2ae35, 0x27d4eb2f];
export const DEFAULT_SEED = 'peaket-demo';

/** 문자열을 128비트(네 낱말) 상태로 바꾼다. FNV-1a를 낱말마다 다른 소금으로 돌린다. */
export function hashSeed(text: string): SeedState {
  const words: [number, number, number, number] = [0, 0, 0, 0];
  for (let w = 0; w < 4; w += 1) {
    let h = (FNV_OFFSET ^ SALTS[w]) >>> 0;
    for (let i = 0; i < text.length; i += 1) {
      h = (h ^ text.charCodeAt(i)) >>> 0;
      h = Math.imul(h, FNV_PRIME) >>> 0;
    }
    words[w] = h;
  }
  return words;
}

function rotl(value: number, bits: number): number {
  return ((value << bits) | (value >>> (32 - bits))) >>> 0;
}

export class Xoshiro128 {
  private s0: number;
  private s1: number;
  private s2: number;
  private s3: number;

  constructor(seed: string | SeedState | readonly number[]) {
    const state = typeof seed === 'string' ? hashSeed(seed) : seed;
    if (state.length !== 4) throw new Error('xoshiro128** 시드는 네 낱말이어야 한다');
    this.s0 = state[0] >>> 0;
    this.s1 = state[1] >>> 0;
    this.s2 = state[2] >>> 0;
    this.s3 = state[3] >>> 0;
    if ((this.s0 | this.s1 | this.s2 | this.s3) === 0) {
      this.s0 = 0x9e3779b9;
      this.s1 = 0x243f6a88;
      this.s2 = 0xb7e15162;
      this.s3 = 0xdeadbeef;
    }
  }

  nextUint32(): number {
    const result = Math.imul(rotl(Math.imul(this.s1, 5), 7), 9) >>> 0;
    const t = (this.s1 << 9) >>> 0;
    this.s2 = (this.s2 ^ this.s0) >>> 0;
    this.s3 = (this.s3 ^ this.s1) >>> 0;
    this.s1 = (this.s1 ^ this.s2) >>> 0;
    this.s0 = (this.s0 ^ this.s3) >>> 0;
    this.s2 = (this.s2 ^ t) >>> 0;
    this.s3 = rotl(this.s3, 11);
    return result;
  }

  /** 0 이상 1 미만. 위 24비트만 쓴다. */
  nextUnit(): number {
    return (this.nextUint32() >>> 8) / 0x1000000;
  }

  /** float32로 정확히 표현되는 0 이상 1 미만. */
  nextFloat32(): number {
    return Math.fround(this.nextUnit());
  }

  /** 0 이상 maxExclusive 미만의 정수. 나머지 편향을 거절 표본으로 없앤다. */
  nextInt(maxExclusive: number): number {
    if (!Number.isInteger(maxExclusive) || maxExclusive <= 0 || maxExclusive > 0x100000000) {
      throw new Error('nextInt 상한은 1 이상 2^32 이하의 정수여야 한다');
    }
    const limit = 0x100000000 - (0x100000000 % maxExclusive);
    let value = this.nextUint32();
    while (value >= limit) value = this.nextUint32();
    return value % maxExclusive;
  }

  /** min 이상 max 미만의 정수. */
  nextBetween(min: number, maxExclusive: number): number {
    return min + this.nextInt(maxExclusive - min);
  }
}
