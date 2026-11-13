// BAS-100 셔플 100만 PoC: Fisher–Yates로 100만 명 순번을 섞고, 참가 토큰 해시 앞 세 자리(4,096개 [가정])로
// 결과 파일을 나눠 만들 때의 시간·크기를 잰다(docs/architecture.md §9.4, queue-admission §2, FR-038).
// 이 스크립트는 로컬 PoC다. 운영의 drand 라운드·Redis 파이프라인·S3 게시는 넣지 않는다.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

/** 재현 가능한 32비트 PRNG(mulberry32). 씨앗은 실행마다 같게 둘 수 있다 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 0..n-1을 Fisher–Yates로 섞는다(제자리) */
export function shuffle(n, random) {
  const a = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    const t = a[i];
    a[i] = a[j];
    a[j] = t;
  }
  return a;
}

/** 참가 토큰 해시 앞 세 자리(000~fff) */
export function prefixOf(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 3);
}

/** 순번 배열을 4,096개 파일 묶음으로 나눈다. 각 줄은 `해시 → 순번`이다 */
export function bucketize(order) {
  const buckets = Array.from({ length: 4096 }, () => []);
  for (let seq = 0; seq < order.length; seq += 1) {
    const hash = prefixOf(`token-${order[seq]}`);
    buckets[Number.parseInt(hash, 16)].push([hash, seq]);
  }
  return buckets;
}

/** 순번 배열이 0..n-1의 순열인지 확인한다 */
export function isPermutation(order) {
  const seen = new Uint8Array(order.length);
  for (const v of order) {
    if (!Number.isInteger(v) || v < 0 || v >= order.length || seen[v]) return false;
    seen[v] = 1;
  }
  return true;
}

/** PoC 한 번. 파일을 쓰지 않고 직렬화 크기만 잰다 */
export function run({ n = 1_000_000, seed = 20261113 } = {}) {
  const random = mulberry32(seed);
  const t0 = performance.now();
  const order = shuffle(n, random);
  const t1 = performance.now();
  const buckets = bucketize(order);
  const t2 = performance.now();
  let bytes = 0;
  let maxFileBytes = 0;
  let minFileBytes = Number.POSITIVE_INFINITY;
  for (const b of buckets) {
    const text = JSON.stringify(b);
    bytes += Buffer.byteLength(text);
    maxFileBytes = Math.max(maxFileBytes, Buffer.byteLength(text));
    minFileBytes = Math.min(minFileBytes, Buffer.byteLength(text));
  }
  const t3 = performance.now();
  return {
    n,
    seed,
    valid: isPermutation(order),
    shuffleMs: Math.round((t1 - t0) * 10) / 10,
    bucketMs: Math.round((t2 - t1) * 10) / 10,
    serializeMs: Math.round((t3 - t2) * 10) / 10,
    totalMs: Math.round((t3 - t0) * 10) / 10,
    files: buckets.length,
    bytes,
    maxFileBytes,
    minFileBytes: Number.isFinite(minFileBytes) ? minFileBytes : 0,
    heapUsedMb: Math.round((process.memoryUsage().heapUsed / 1024 / 1024) * 10) / 10,
  };
}

/** 결과 파일을 실제로 쓴다(선택). 운영 S3 게시를 흉내 내는 용도가 아니라 모양 확인용이다 */
export function writeBuckets(order, dir) {
  mkdirSync(dir, { recursive: true });
  const buckets = bucketize(order);
  buckets.forEach((b, i) => writeFileSync(join(dir, `${i.toString(16).padStart(3, '0')}.json`), JSON.stringify(b)));
  return buckets.length;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const n = Number(process.argv[2] ?? 1_000_000);
  const out = process.argv[3];
  const result = run({ n });
  if (out) result.written = writeBuckets(shuffle(n, mulberry32(result.seed)), out);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
