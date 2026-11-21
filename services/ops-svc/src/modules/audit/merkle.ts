// 감사 공개 체크포인트의 머클 트리(ADR-0348 결정 2, ADR-0075 결정 2, RFC 9162 §2.1).
// 잎 입력 = ASCII 'PEAKET-audit-leaf-v1'(20바이트) ‖ seq(부호 없는 64비트 big-endian) ‖ 기록 해시(record_sha256, 32바이트) ‖ 잎 솔트(leaf_salt, 32바이트).
// 잎 해시 = SHA-256(0x00 ‖ 잎 입력), 안쪽 노드 = SHA-256(0x01 ‖ 왼쪽 ‖ 오른쪽). 나누는 자리 k는 n보다 작은 가장 큰 2의 거듭제곱이다(RFC 9162 §2.1.1).
// 포함 증명은 RFC 9162 §2.1.3.1 PATH(m, D[n])의 형제 해시 목록(잎 쪽부터 뿌리 쪽 차례)이고, 확인은 §2.1.3.2 알고리즘 그대로다.
// 빈 트리는 쓰지 않는다(기록 0개 체크포인트는 만들지 않는다): 잎이 없으면 던진다.
import { createHash } from 'node:crypto';

/** 잎 입력 앞머리(도메인 글). 바이트 꼴을 바꾸면 v2로 올린다 */
export const AUDIT_LEAF_DOMAIN = 'PEAKET-audit-leaf-v1';
const DOMAIN = Buffer.from(AUDIT_LEAF_DOMAIN, 'ascii');
const LEAF_PREFIX = Buffer.from([0x00]);
const NODE_PREFIX = Buffer.from([0x01]);
const HEX64 = /^[0-9a-f]{64}$/;

const bytes32 = (v: Uint8Array | string, what: string): Buffer => {
  const b = typeof v === 'string' ? (HEX64.test(v) ? Buffer.from(v, 'hex') : undefined) : Buffer.from(v);
  if (!b || b.length !== 32) throw new TypeError(`${what}는 32바이트(16진 소문자 64자)여야 한다`);
  return b;
};

/**
 * 잎 입력 바이트(84바이트).
 * @param recordSha256 기록 해시(32바이트 또는 16진 소문자 64자)
 * @param leafSalt 잎 솔트(32바이트 또는 16진 소문자 64자)
 */
export function leafInput(seq: number | bigint, recordSha256: Uint8Array | string, leafSalt: Uint8Array | string): Buffer {
  const n = typeof seq === 'bigint' ? seq : BigInt(seq);
  if (typeof seq === 'number' && !Number.isSafeInteger(seq)) throw new RangeError('seq는 안전한 정수여야 한다');
  if (n < 1n || n > 0xffff_ffff_ffff_ffffn) throw new RangeError('seq는 1 이상 2^64 미만이다');
  const seqBytes = Buffer.alloc(8);
  seqBytes.writeBigUInt64BE(n);
  return Buffer.concat([DOMAIN, seqBytes, bytes32(recordSha256, 'record_sha256'), bytes32(leafSalt, 'leaf_salt')]);
}

/** 잎 해시 SHA-256(0x00 ‖ 잎 입력) */
export function leafHash(input: Uint8Array): Buffer {
  return createHash('sha256').update(LEAF_PREFIX).update(input).digest();
}

/** 안쪽 노드 SHA-256(0x01 ‖ 왼쪽 ‖ 오른쪽) */
export function nodeHash(left: Uint8Array, right: Uint8Array): Buffer {
  return createHash('sha256').update(NODE_PREFIX).update(left).update(right).digest();
}

/** n보다 작은 가장 큰 2의 거듭제곱(n ≥ 2) */
function splitPoint(n: number): number {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}

function mthOfHashes(hashes: readonly Buffer[], from: number, to: number): Buffer {
  const n = to - from;
  if (n === 1) return hashes[from]!;
  const k = splitPoint(n);
  return nodeHash(mthOfHashes(hashes, from, from + k), mthOfHashes(hashes, from + k, to));
}

/** 잎 해시 목록의 머클 트리 해시. 잎이 없으면 던진다 */
export function merkleRootOfLeafHashes(hashes: readonly Buffer[]): Buffer {
  if (hashes.length === 0) throw new RangeError('빈 머클 트리는 쓰지 않는다(기록 0개)');
  return mthOfHashes(hashes, 0, hashes.length);
}

/** 잎 입력 목록의 머클 트리 해시 MTH(D[n])(RFC 9162 §2.1.1). 잎이 없으면 던진다 */
export function merkleTreeHash(leafInputs: readonly Uint8Array[]): Buffer {
  return merkleRootOfLeafHashes(leafInputs.map(leafHash));
}

function pathOf(hashes: readonly Buffer[], m: number, from: number, to: number): Buffer[] {
  const n = to - from;
  if (n === 1) return [];
  const k = splitPoint(n);
  if (m < k) return [...pathOf(hashes, m, from, from + k), mthOfHashes(hashes, from + k, to)];
  return [...pathOf(hashes, m - k, from + k, to), mthOfHashes(hashes, from, from + k)];
}

/** 잎 해시 목록에서 m번째(0부터) 잎의 포함 증명. 범위 밖이면 던진다 */
export function inclusionProofOfLeafHashes(hashes: readonly Buffer[], m: number): Buffer[] {
  if (!Number.isSafeInteger(m) || m < 0 || m >= hashes.length) throw new RangeError('잎 번호가 트리 밖이다');
  return pathOf(hashes, m, 0, hashes.length);
}

/** 잎 입력 목록에서 m번째(0부터) 잎의 포함 증명 PATH(m, D[n])(RFC 9162 §2.1.3.1, 잎 쪽부터) */
export function inclusionProof(leafInputs: readonly Uint8Array[], m: number): Buffer[] {
  return inclusionProofOfLeafHashes(leafInputs.map(leafHash), m);
}

/**
 * 포함 증명 확인(RFC 9162 §2.1.3.2). 잎 해시·증명 경로·루트가 맞으면 참.
 * @param leafIndex 잎 번호(0부터) @param treeSize 트리 크기 @param leaf 잎 해시(32바이트)
 */
export function verifyInclusion(leafIndex: number, treeSize: number, leaf: Uint8Array, path: readonly Uint8Array[], root: Uint8Array): boolean {
  if (!Number.isSafeInteger(leafIndex) || !Number.isSafeInteger(treeSize) || leafIndex < 0 || leafIndex >= treeSize) return false;
  let fn = leafIndex;
  let sn = treeSize - 1;
  let r: Buffer = Buffer.from(leaf);
  for (const p of path) {
    if (sn === 0) return false;
    if (fn % 2 === 1 || fn === sn) {
      r = nodeHash(p, r);
      if (fn % 2 === 0) {
        while (fn % 2 === 0 && fn !== 0) {
          fn = Math.floor(fn / 2);
          sn = Math.floor(sn / 2);
        }
      }
    } else {
      r = nodeHash(r, p);
    }
    fn = Math.floor(fn / 2);
    sn = Math.floor(sn / 2);
  }
  return sn === 0 && Buffer.compare(r, Buffer.from(root)) === 0;
}
