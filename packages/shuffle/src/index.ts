// 로비·동시 도착 묶음 셔플의 재현 규격(ADR-0050 결정 7, docs/features/queue-admission.md §2·§3 '묶음의 첫 구현').
// 검증 화면(SCR-019)과 공개 스크립트(reference/shuffle.py)가 같은 결과를 내도록 바이트 단위로 정한다.
// - 토큰 해시·시드·비콘·머클 루트는 바이트(16진을 푼 32바이트), 회차 ID는 UTF-8 바이트다
// - 커밋 = SHA-256("PEAKET-shuffle-v1" ‖ 회차 ID ‖ 시드), 결합 키 K = SHA-256(시드 ‖ 비콘 ‖ 머클 루트 ‖ 회차 ID)
// - 난수는 SHA-256(K ‖ i) 블록(i는 0부터 세는 64비트 큰 끝)의 32비트 큰 끝 단어 여덟 개를 차례로 쓴다
// - Fisher–Yates는 뒤에서부터 j를 [0, i]에서 뽑고, 단어 r이 floor(2^32 ÷ (i+1)) × (i+1) 이상이면 버린다(편향 없는 거부 표본추출)
// - 머클 트리는 RFC 6962(잎 0x00, 노드 0x01, n보다 작은 가장 큰 2의 거듭제곱에서 나눔). 빈 목록은 SHA-256("")
import { createHash } from 'node:crypto';

/** 알고리즘 판(커밋과 함께 공시한다) */
export const ALGORITHM = 'v1';
const COMMIT_DOMAIN = Buffer.from('PEAKET-shuffle-v1', 'utf8');
const LEAF = Buffer.from([0x00]);
const NODE = Buffer.from([0x01]);
const TWO32 = 2 ** 32;

const sha256 = (...parts: Uint8Array[]): Buffer => {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest();
};

export function commitment(eventId: string, seed: Uint8Array): Buffer {
  return sha256(COMMIT_DOMAIN, Buffer.from(eventId, 'utf8'), seed);
}

/**
 * 정렬한 잎(토큰 해시 바이트)의 머클 루트. 아래에서 위로 둘씩 묶고 짝이 없는 끝 마디는 그대로 올린다.
 * 이 방식은 RFC 6962의 '가장 큰 2의 거듭제곱에서 나누기'와 같은 값을 낸다(참조 구현과 견주는 시험)
 */
export function merkleRoot(sortedLeaves: readonly Uint8Array[]): Buffer {
  if (sortedLeaves.length === 0) return sha256();
  let level = sortedLeaves.map((l) => sha256(LEAF, l));
  while (level.length > 1) {
    const next: Buffer[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(i + 1 < level.length ? sha256(NODE, level[i]!, level[i + 1]!) : level[i]!);
    level = next;
  }
  return level[0]!;
}

export function combinedKey(seed: Uint8Array, beacon: Uint8Array, root: Uint8Array, eventId: string): Buffer {
  return sha256(seed, beacon, root, Buffer.from(eventId, 'utf8'));
}

/** 32비트 큰 끝 단어의 흐름: SHA-256(K ‖ u64be(i)) 블록마다 여덟 개, i는 0부터 */
export function* wordStream(key: Uint8Array): Generator<number> {
  const counter = Buffer.alloc(8);
  for (let i = 0n; ; i++) {
    counter.writeBigUInt64BE(i);
    const block = sha256(key, counter);
    for (let o = 0; o < 32; o += 4) yield block.readUInt32BE(o);
  }
}

/** 편향 없는 Fisher–Yates. 입력은 바꾸지 않고 섞은 사본을 돌려준다 */
export function shuffle<T>(items: readonly T[], key: Uint8Array): T[] {
  const w = wordStream(key);
  return shuffleWith(items, () => w.next().value as number);
}

/** 단어를 주는 함수로 섞는다. 거부 표본추출은 2^32분의 몇 확률이라 시험은 이 함수에 고른 단어를 넣어 일으킨다 */
export function shuffleWith<T>(items: readonly T[], next: () => number): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const bound = i + 1;
    const limit = Math.floor(TWO32 / bound) * bound;
    let r = next();
    while (r >= limit) r = next();
    const j = r % bound;
    const t = a[i]!;
    a[i] = a[j]!;
    a[j] = t;
  }
  return a;
}

/** 셔플 전 배열: 토큰 해시(16진 소문자)의 오름차순. 바이트 순서와 같다 */
export function sortHashes(hexes: readonly string[]): string[] {
  return [...hexes].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
}
