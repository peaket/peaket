// F-04-9 역누적분포 표 읽기. 정본: docs/features/forensic-replay.md §5.3.
// 위 12비트로 칸을 고르고 아래 20비트로 두 칸 사이를 사칙연산으로 잇는다. 로그·지수 함수를 쓰지 않는다.
import type { Xoshiro128 } from './prng.ts';
import {
  INV_ENTROPY_BOT_Q6,
  INV_ENTROPY_HUMAN_Q6,
  INV_EXP_Q6,
  INV_RESPONSE_BOT_Q6,
  INV_RESPONSE_HUMAN_Q6,
} from './inv-cdf-table.ts';

export const TABLE_SIZE = 4_096;
const SCALE = 1_000_000;

export function sampleTable(table: readonly number[], bits: number): number {
  const cell = (bits >>> 20) & (TABLE_SIZE - 1);
  const fraction = (bits & 0xfffff) / 0x100000;
  const low = table[cell] / SCALE;
  const high = table[Math.min(cell + 1, TABLE_SIZE - 1)] / SCALE;
  return low + (high - low) * fraction;
}

/** 평균 1인 지수분포 표본. 도착 간격은 호출한 쪽이 평균을 곱해 쓴다. */
export function sampleExponential(prng: Xoshiro128): number {
  return sampleTable(INV_EXP_Q6, prng.nextUint32());
}

/** 반응 시간(ms). 사람은 중앙값 1,200ms·시그마 0.5, 봇은 150ms·0.35의 로그 정규 표다. */
export function sampleResponse(prng: Xoshiro128, kind: 'human' | 'bot'): number {
  return sampleTable(kind === 'human' ? INV_RESPONSE_HUMAN_Q6 : INV_RESPONSE_BOT_Q6, prng.nextUint32());
}

/** 포인터 이동 엔트로피 요약값. 사람은 1.8±0.45, 봇은 0.35±0.18의 정규 표다. */
export function sampleEntropy(prng: Xoshiro128, kind: 'human' | 'bot'): number {
  return sampleTable(kind === 'human' ? INV_ENTROPY_HUMAN_Q6 : INV_ENTROPY_BOT_Q6, prng.nextUint32());
}
