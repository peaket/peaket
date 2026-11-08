// 로비·동시 도착 묶음 셔플의 재현 규격(ADR-0050 결정 7, docs/features/queue-admission.md §2·§3 '묶음의 첫 구현').
// 검증 화면(SCR-019)과 공개 스크립트(reference/shuffle.py)가 같은 결과를 내도록 바이트 단위로 정한다.
// - 토큰 해시·시드·비콘·머클 루트는 바이트(16진을 푼 32바이트), 회차 ID는 UTF-8 바이트다
// - 커밋 = SHA-256("PEAKET-shuffle-v1" ‖ 회차 ID ‖ 시드), 결합 키 K = SHA-256(시드 ‖ 비콘 ‖ 머클 루트 ‖ 회차 ID)
// - 난수는 SHA-256(K ‖ i) 블록(i는 0부터 세는 64비트 큰 끝)의 32비트 큰 끝 단어 여덟 개를 차례로 쓴다
// - Fisher–Yates는 뒤에서부터 j를 [0, i]에서 뽑고, 단어 r이 floor(2^32 ÷ (i+1)) × (i+1) 이상이면 버린다(편향 없는 거부 표본추출)
// - 머클 트리는 RFC 6962(잎 0x00, 노드 0x01, n보다 작은 가장 큰 2의 거듭제곱에서 나눔). 빈 목록은 SHA-256("")
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';

/** drand quicknet의 공개 값(3초 주기, 서명만으로 검증하는 unchained 체인, ADR-0231 결정 7). 체인·판을 바꾸면 커밋에 공시한 값도 바뀐다 */
export const DRAND_CHAIN = 'quicknet';
export const DRAND_CHAIN_HASH = '52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971';
export const DRAND_GENESIS_MS = 1_692_803_367_000;
export const DRAND_PERIOD_MS = 3_000;
/** 목록 고정 뒤 기다리는 최소 시간 3초 [가정, Phase 2 2.4.1에서 확정] */
export const BEACON_MIN_DELAY_MS = 3_000;
export const drandRoundTimeMs = (round: number): number => DRAND_GENESIS_MS + (round - 1) * DRAND_PERIOD_MS;
/** 시각 atMs + minDelayMs 이후(같아도 된다)의 첫 라운드 */
export const drandRoundAfter = (atMs: number, minDelayMs: number = BEACON_MIN_DELAY_MS): number => Math.ceil((atMs + minDelayMs - DRAND_GENESIS_MS) / DRAND_PERIOD_MS) + 1;

/** 셔플 구간: 로비(`lobby`)와 동시 도착 묶음 번호(한 회차는 1) */
export type ShuffleGroup = 'lobby' | number;
/** 봉인의 용도 표시(KMS 암호화 컨텍스트의 purpose, 시험 대역의 AAD) */
export const SEAL_PURPOSE = 'peaket-shuffle-seed-v1';
/** 시드 봉인. 운영은 KMS(HOT-041), local·ci·demo는 TestSeedSealer */
export interface SeedSealer {
  seal(eventId: string, group: ShuffleGroup, seed: Uint8Array): Promise<string>;
  open(eventId: string, group: ShuffleGroup, sealed: string): Promise<Buffer>;
}

/** 시험 봉인을 켜는 값(base64 32바이트 이상, 묶음 시험 시드·비콘과 같은 값, local·ci·demo만) */
export const TEST_SEAL_ENV = 'PEAKET_TEST_BATCH_RANDOMNESS';
const TEST_SEAL_ENVS = ['local', 'ci', 'demo'];

/** local·ci·demo의 시험 봉인: AES-256-GCM과 회차·구간을 묶은 AAD. 비밀을 아는 사람이 풀 수 있어 공정성 증명이 되지 않는다 */
export class TestSeedSealer implements SeedSealer {
  readonly #key: Buffer;

  constructor(secret: Buffer) {
    if (secret.length < 32) throw new Error('시험 봉인 비밀은 32바이트 이상이다');
    this.#key = createHmac('sha256', secret).update('seed-sealer').digest();
  }

  static fromEnv(env: Record<string, string | undefined>): TestSeedSealer {
    if (!TEST_SEAL_ENVS.includes(env.PEAKET_ENV ?? '')) throw new Error('시험 봉인은 local·ci·demo에서만 켠다(운영은 KMS, BUILD_ORDER HOT-041)');
    const raw = env[TEST_SEAL_ENV];
    if (!raw) throw new Error(`${TEST_SEAL_ENV}가 없다(base64 32바이트 이상)`);
    return new TestSeedSealer(Buffer.from(raw, 'base64'));
  }

  async seal(eventId: string, group: ShuffleGroup, seed: Uint8Array): Promise<string> {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.#key, iv).setAAD(aadOf(eventId, group));
    const body = Buffer.concat([c.update(seed), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), body]).toString('base64');
  }

  async open(eventId: string, group: ShuffleGroup, sealed: string): Promise<Buffer> {
    const b = Buffer.from(sealed, 'base64');
    const d = createDecipheriv('aes-256-gcm', this.#key, b.subarray(0, 12)).setAAD(aadOf(eventId, group));
    d.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([d.update(b.subarray(28)), d.final()]);
  }
}

const aadOf = (eventId: string, group: ShuffleGroup): Buffer => Buffer.from(`${SEAL_PURPOSE}\0${eventId}\0${group}`, 'utf8');

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
