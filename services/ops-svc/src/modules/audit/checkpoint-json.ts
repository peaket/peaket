// 공개 감사 체크포인트 JSON(ADR-0348 결정 3, ADR-0075 결정 3).
// 칸: {v: 'PEAKET-checkpoint-v1', no, firstSeq, lastSeq, leafCount, merkleRoot, prevCheckpointHash, accessLogDayAnchor(일 체크포인트에만), closedEvents(회차 마감 체크포인트에만), createdAt}.
// 해시는 16진 소문자 64자, createdAt은 UTC 밀리초 ISO 8601(Z), 첫 체크포인트의 prevCheckpointHash는 빈 글, 해당 없는 칸은 뺀다.
// 정규화는 RFC 8785 라이브러리(canonicalize, Apache-2.0)로 하고, 만든 글을 그대로 audit_checkpoint.checkpoint_json에 저장·게시한다(다시 만들지 않는다).
// 체크포인트 해시 = SHA-256(UTF-8 checkpoint_json) 16진. 다음 체크포인트의 prevCheckpointHash가 이 값이다.
import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';

export const CHECKPOINT_JSON_VERSION = 'PEAKET-checkpoint-v1';
const HEX64 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface CheckpointJsonInput {
  readonly no: number;
  readonly firstSeq: number;
  readonly lastSeq: number;
  readonly leafCount: number;
  /** 머클 루트(16진 소문자 64자) */
  readonly merkleRoot: string;
  /** 직전 공개 체크포인트 해시(첫 체크포인트는 빈 글) */
  readonly prevCheckpointHash: string;
  /** 그날 법정 접속기록 일 앵커(16진 소문자 64자). 일 체크포인트에만, 원천(OPS-330) 전에는 뺀다 */
  readonly accessLogDayAnchor?: string;
  /** 온세일 윈도우가 끝난 회차 ID(소문자 UUID). 회차 마감 체크포인트에만 */
  readonly closedEvents?: readonly string[];
  readonly createdAtMs: number;
}

/** 공개 JSON의 값 모양(읽은 쪽이 쓰는 꼴) */
export interface CheckpointJsonBody {
  readonly v: typeof CHECKPOINT_JSON_VERSION;
  readonly no: number;
  readonly firstSeq: number;
  readonly lastSeq: number;
  readonly leafCount: number;
  readonly merkleRoot: string;
  readonly prevCheckpointHash: string;
  readonly accessLogDayAnchor?: string;
  readonly closedEvents?: readonly string[];
  readonly createdAt: string;
}

const posInt = (v: number, what: string, min = 1): void => {
  if (!Number.isSafeInteger(v) || v < min) throw new RangeError(`${what}는 ${min} 이상의 안전한 정수다`);
};

/**
 * 체크포인트 JSON 글(RFC 8785). 값이 틀리면 던진다(만들기 전에 막는다).
 * 회차 ID는 차례를 정하려고 정렬하고 겹친 값은 하나로 둔다.
 */
export function canonicalCheckpointJson(c: CheckpointJsonInput): string {
  posInt(c.no, 'no');
  posInt(c.firstSeq, 'firstSeq');
  posInt(c.lastSeq, 'lastSeq');
  posInt(c.leafCount, 'leafCount');
  if (c.lastSeq < c.firstSeq || c.lastSeq - c.firstSeq + 1 !== c.leafCount) throw new RangeError('leafCount는 lastSeq − firstSeq + 1이다');
  if (!HEX64.test(c.merkleRoot)) throw new TypeError('merkleRoot는 16진 소문자 64자다');
  if (c.prevCheckpointHash !== '' && !HEX64.test(c.prevCheckpointHash)) throw new TypeError('prevCheckpointHash는 빈 글이거나 16진 소문자 64자다');
  if (c.no === 1 && c.prevCheckpointHash !== '') throw new RangeError('첫 체크포인트의 prevCheckpointHash는 빈 글이다');
  if (c.no > 1 && c.prevCheckpointHash === '') throw new RangeError('두 번째부터는 prevCheckpointHash가 있다');
  if (c.accessLogDayAnchor !== undefined && !HEX64.test(c.accessLogDayAnchor)) throw new TypeError('accessLogDayAnchor는 16진 소문자 64자다');
  if (!Number.isSafeInteger(c.createdAtMs) || c.createdAtMs < 0) throw new RangeError('createdAtMs가 틀렸다');
  let closed: string[] | undefined;
  if (c.closedEvents !== undefined) {
    if (c.closedEvents.length === 0) throw new RangeError('closedEvents는 회차 마감 체크포인트에만 있고 비지 않는다');
    for (const id of c.closedEvents) if (!UUID.test(id)) throw new TypeError('closedEvents는 소문자 UUID다');
    closed = [...new Set(c.closedEvents)].sort();
  }
  const body: CheckpointJsonBody = {
    v: CHECKPOINT_JSON_VERSION,
    no: c.no,
    firstSeq: c.firstSeq,
    lastSeq: c.lastSeq,
    leafCount: c.leafCount,
    merkleRoot: c.merkleRoot,
    prevCheckpointHash: c.prevCheckpointHash,
    ...(c.accessLogDayAnchor !== undefined ? { accessLogDayAnchor: c.accessLogDayAnchor } : {}),
    ...(closed !== undefined ? { closedEvents: closed } : {}),
    createdAt: new Date(c.createdAtMs).toISOString(),
  };
  const text = canonicalize(body);
  if (text === undefined) throw new Error('체크포인트 JSON을 만들지 못했다');
  return text;
}

/** 체크포인트 해시 SHA-256(UTF-8 글) 16진 소문자 */
export function checkpointHashOf(json: string): string {
  return createHash('sha256').update(json, 'utf8').digest('hex');
}

/** 저장된 JSON 글을 읽는다. 판·칸 모양이 틀리면 undefined */
export function parseCheckpointJson(json: string): CheckpointJsonBody | undefined {
  try {
    const v = JSON.parse(json) as Record<string, unknown>;
    if (v.v !== CHECKPOINT_JSON_VERSION) return undefined;
    for (const k of ['no', 'firstSeq', 'lastSeq', 'leafCount']) if (!Number.isSafeInteger(v[k])) return undefined;
    if (typeof v.merkleRoot !== 'string' || typeof v.prevCheckpointHash !== 'string' || typeof v.createdAt !== 'string') return undefined;
    // 저장 글이 정규화 꼴 그대로인가(한 글자라도 다르면 해시가 달라진다)
    if (canonicalize(v) !== json) return undefined;
    return v as unknown as CheckpointJsonBody;
  } catch {
    return undefined;
  }
}
