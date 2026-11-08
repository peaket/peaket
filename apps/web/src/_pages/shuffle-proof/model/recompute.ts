// SCR-019 내 순번 다시 계산(ADR-0232 결정 9). 재현 규격(ADR-0050 결정 7, docs/features/queue-admission.md §3 '재현 규격의 세부')을 브라우저 WebCrypto로 쓴 것이다.
// @peaket/shuffle은 Node.js crypto에 묶여 있어 브라우저에서 돌지 않는다. 같은 값을 내는지는 파이썬 참조 구현의 기준값(vectors.json)으로 시험한다.
// 토큰 해시는 브라우저 안에서만 쓰고 서버로 보내지 않는다.

const COMMIT_DOMAIN = new TextEncoder().encode('PEAKET-shuffle-v1');
const LEAF = new Uint8Array([0x00]);
const NODE = new Uint8Array([0x01]);
const TWO32 = 2 ** 32;
/** 한 번에 기다리는 해시 수(100만 건의 약속을 한꺼번에 만들지 않게) [가정] */
const HASH_CHUNK = 4096;

const concat = (parts: readonly Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
const sha = async (...parts: Uint8Array[]): Promise<Uint8Array> => new Uint8Array(await crypto.subtle.digest('SHA-256', concat(parts) as Uint8Array<ArrayBuffer>));
const toHex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const fromHex = (h: string): Uint8Array => {
  // 잘못된 16진을 0으로 바꾸면 틀린 값으로 계산을 이어 간다. 거절한다
  if (!/^(?:[0-9a-fA-F]{2})*$/.test(h)) throw new Error('16진 값이 아니다');
  return Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));
};

async function mapChunks<T, U>(items: readonly T[], fn: (x: T, i: number) => Promise<U>): Promise<U[]> {
  const out: U[] = [];
  for (let i = 0; i < items.length; i += HASH_CHUNK) {
    const part = await Promise.all(items.slice(i, i + HASH_CHUNK).map((x, j) => fn(x, i + j)));
    for (const v of part) out.push(v);
  }
  return out;
}

/** 커밋 = SHA-256("PEAKET-shuffle-v1" ‖ 회차 ID ‖ 시드)(POL-005) */
export async function commitmentHex(eventId: string, seedHex: string): Promise<string> {
  return toHex(await sha(COMMIT_DOMAIN, new TextEncoder().encode(eventId), fromHex(seedHex)));
}

/** drand quicknet의 라운드 값은 SHA-256(서명)이다. BLS 서명 자체의 검증은 하지 않는다(OPEN[27]) */
export async function beaconOfSignatureHex(signatureHex: string): Promise<string> {
  return toHex(await sha(fromHex(signatureHex)));
}

/** 정렬한 토큰 해시(16진)의 머클 루트. 짝이 없는 끝 마디는 그대로 올린다(RFC 6962와 같은 값) */
export async function merkleRootHex(sortedTokens: readonly string[]): Promise<string> {
  if (sortedTokens.length === 0) return toHex(await sha());
  let level = await mapChunks(sortedTokens, (h) => sha(LEAF, fromHex(h)));
  while (level.length > 1) {
    const pairs: [Uint8Array, Uint8Array | null][] = [];
    for (let i = 0; i < level.length; i += 2) pairs.push([level[i]!, i + 1 < level.length ? level[i + 1]! : null]);
    level = await mapChunks(pairs, ([l, r]) => (r ? sha(NODE, l, r) : Promise.resolve(l)));
  }
  return toHex(level[0]!);
}

/** 편향 없는 Fisher–Yates. 난수는 SHA-256(K ‖ u64be(i)) 블록의 32비트 큰 끝 단어 여덟 개 */
async function shuffleWithKey(items: readonly string[], key: Uint8Array): Promise<string[]> {
  const a = [...items];
  let block: DataView = new DataView(new ArrayBuffer(0));
  let used = 8;
  let counter = 0n;
  for (let i = a.length - 1; i > 0; i--) {
    const bound = i + 1;
    const limit = Math.floor(TWO32 / bound) * bound;
    for (;;) {
      if (used === 8) {
        const c = new Uint8Array(8);
        new DataView(c.buffer).setBigUint64(0, counter++);
        const digest = await sha(key, c);
        block = new DataView(digest.buffer, digest.byteOffset, digest.byteLength);
        used = 0;
      }
      const r = block.getUint32(used * 4);
      used += 1;
      if (r < limit) {
        const j = r % bound;
        const t = a[i]!;
        a[i] = a[j]!;
        a[j] = t;
        break;
      }
    }
  }
  return a;
}

export interface OrderInput {
  eventId: string;
  seedHex: string;
  beaconHex: string;
  sortedTokens: readonly string[];
  rootHex: string;
}

/** 결합 키 K = SHA-256(시드 ‖ 비콘 ‖ 머클 루트 ‖ 회차 ID)로 섞은 순서 */
export async function recomputeOrder(i: OrderInput): Promise<string[]> {
  const key = await sha(fromHex(i.seedHex), fromHex(i.beaconHex), fromHex(i.rootHex), new TextEncoder().encode(i.eventId));
  return shuffleWithKey(i.sortedTokens, key);
}

export interface VerifyInput {
  eventId: string;
  seedHex: string;
  /** 공시한 커밋. 시드가 이 값과 맞아야 한다 */
  commitHex: string;
  beaconHex: string;
  /** 공시한 drand 서명. SHA-256(서명)이 비콘 값과 맞아야 한다 */
  signatureHex: string;
  merkleRootHex: string;
  firstSeq: number;
  tokenHash: string;
  /** 결과 파일을 모은 표(토큰 해시 → 번호) */
  entries: Readonly<Record<string, number>>;
}

export interface VerifyResult {
  commitMatches: boolean;
  beaconMatches: boolean;
  rootMatches: boolean;
  fileSeq: number | null;
  recomputedSeq: number | null;
}

/**
 * 시드를 커밋과, 비콘을 서명과, 머클 루트를 결과 파일과 대조하고, 모두 맞을 때만 내 번호를 다시 계산한다.
 * 머클 루트만 보면 운영자가 비콘을 본 뒤 원하는 순서가 나오는 시드를 골라도 드러나지 않는다(commit-reveal이 막으려는 경우)
 */
export async function verifyRank(i: VerifyInput): Promise<VerifyResult> {
  const fileSeq = i.entries[i.tokenHash] ?? null;
  const commitMatches = (await commitmentHex(i.eventId, i.seedHex)) === i.commitHex;
  const beaconMatches = (await beaconOfSignatureHex(i.signatureHex)) === i.beaconHex;
  if (!commitMatches || !beaconMatches) return { commitMatches, beaconMatches, rootMatches: false, fileSeq, recomputedSeq: null };
  const sortedTokens = Object.keys(i.entries).sort();
  if ((await merkleRootHex(sortedTokens)) !== i.merkleRootHex) return { commitMatches, beaconMatches, rootMatches: false, fileSeq, recomputedSeq: null };
  const order = await recomputeOrder({ eventId: i.eventId, seedHex: i.seedHex, beaconHex: i.beaconHex, sortedTokens, rootHex: i.merkleRootHex });
  const rank = order.indexOf(i.tokenHash);
  return { commitMatches, beaconMatches, rootMatches: true, fileSeq, recomputedSeq: rank < 0 ? null : i.firstSeq + rank };
}

export type FetchFile = (url: string) => Promise<{ status: number; body?: unknown }>;

/** 동시에 받는 결과 파일 수 [가정] */
const FETCH_PARALLEL = 16;

/** 결과 파일 전체를 모은다. 파일 수는 16진 앞 세 자리의 개수이고, 하나라도 200이 아니면 던진다(공시가 끝나지 않았거나 게시에 실패한 파일) */
export async function collectEntries(base: string, count: number, fetchFile: FetchFile, o: { signal?: AbortSignal; onFile?: (done: number) => void } = {}): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const prefixes = Array.from({ length: count }, (_, i) => i.toString(16).padStart(3, '0'));
  let next = 0;
  let done = 0;
  await Promise.all(
    Array.from({ length: Math.min(FETCH_PARALLEL, prefixes.length) }, async () => {
      while (next < prefixes.length) {
        throwIfAborted(o.signal);
        const prefix = prefixes[next++]!;
        const r = await fetchFile(`${base}${prefix}.json`);
        if (r.status !== 200) throw new Error(`결과 파일을 받지 못했다: ${prefix}`);
        Object.assign(out, r.body as Record<string, number>);
        done += 1;
        o.onFile?.(done);
      }
    }),
  );
  return out;
}

/** 취소한 계산을 멈춘다 */
export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException('취소했습니다', 'AbortError');
}
