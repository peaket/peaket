// 비상 런북 제어 묶음(F-02-7 OPS-310, ADR-0053 결정 11, ADR-0095).
// 정본: docs/features/control-tower.md §5 '런북 제어 묶음의 모양', docs/review/plans/F-02-7.md 6절.
// 이 파일은 프레임워크를 모른다. 정규화(RFC 8785)·모양 검사·서명·역할·요청 대조만 한다. 재생은 runbook-replay가 맡는다.
import { createHash, verify as cryptoVerify, type KeyObject } from 'node:crypto';

/** 묶음이 받을 수 있는 서비스(정본 6.1). 모르는 이름은 묶음 모양 오류다 */
export const RUNBOOK_SERVICES = ['purchase-svc', 'admission-ctrl', 'queue-svc', 'payment-svc'] as const;
export type RunbookService = (typeof RUNBOOK_SERVICES)[number];

/** 묶음 유효 시간 5분(ADR-0053 결정 11) */
export const RUNBOOK_BUNDLE_VALID_MS = 5 * 60_000;
/** issuedAt이 지금보다 앞서도 받는 시계 차이 30초 [가정] */
export const RUNBOOK_CLOCK_SKEW_MS = 30_000;
/** 적용한 commandId를 기억하는 시간(expiresAt 뒤) [가정] */
export const RUNBOOK_REPLAY_KEEP_MS = 5 * 60_000;
/** 런북 사유 상한(명령 사유 2,000자와 다르다) */
export const RUNBOOK_REASON_MAX = 200;

export type RunbookOperatorRole = 'commander' | 'operator';

export interface RunbookOperatorKey {
  readonly keyId: string;
  readonly operatorId: string;
  readonly role: RunbookOperatorRole;
  /** KMS GetPublicKey의 SPKI DER을 읽은 P-256 공개키 */
  readonly key: KeyObject;
}

export interface RunbookControlBundle {
  readonly v: 1;
  readonly commandId: string;
  readonly kind: string;
  readonly scope: string;
  readonly version: number;
  readonly reason: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly requests: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

export interface RunbookSignature {
  readonly keyId: string;
  readonly signature: Buffer;
}

export interface RunbookControlRequest {
  readonly commandId: string;
  readonly kind: string;
  readonly scope: string;
  readonly version: number;
  readonly desiredStateJson: string;
}

export type RunbookRejectReason =
  | 'bundle-malformed'
  | 'not-canonical'
  | 'signature-count'
  | 'same-operator'
  | 'unknown-key'
  | 'not-authorized-role'
  | 'bad-signature'
  | 'expired'
  | 'not-yet-valid'
  | 'window'
  | 'mismatch'
  | 'replayed'
  | 'conflict';

export type RunbookVerification = { readonly ok: true; readonly digest: string } | { readonly ok: false; readonly reason: RunbookRejectReason };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KIND = /^CONTROL_KIND_[A-Z0-9_]+$/;
const hasControl = (t: string): boolean => {
  for (let i = 0; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if (c < 0x20 || c === 0x7f || c === 0x2028 || c === 0x2029) return true;
  }
  return false;
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const onlyKeys = (o: Record<string, unknown>, allowed: readonly string[]): boolean => Object.keys(o).every((k) => allowed.includes(k));

/** RFC 8785(JCS)의 정규화. 묶음에 쓰는 값(문자열·안전한 정수·참거짓·null·배열·객체)만 받는다 */
export function canonicalizeRunbook(v: unknown): string {
  if (v === null) return 'null';
  if (typeof v === 'boolean' || typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v)) throw new TypeError(`runbook number is not a safe integer: ${v}`);
    return String(v);
  }
  if (Array.isArray(v)) return `[${v.map(canonicalizeRunbook).join(',')}]`;
  if (isObject(v)) {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalizeRunbook(v[k])}`)
      .join(',')}}`;
  }
  throw new TypeError(`runbook value is not serializable: ${typeof v}`);
}

/** 정규화한 바이트인지 먼저 보고, 통과한 바이트의 모양을 본다 */
export function parseRunbookControl(bytes: Buffer | Uint8Array): { ok: true; bundle: RunbookControlBundle } | { ok: false; reason: 'bundle-malformed' | 'not-canonical' } {
  const text = Buffer.from(bytes).toString('utf8');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'bundle-malformed' };
  }
  let canonical: string;
  try {
    canonical = canonicalizeRunbook(raw);
  } catch {
    return { ok: false, reason: 'bundle-malformed' };
  }
  if (canonical !== text) return { ok: false, reason: 'not-canonical' };
  if (!isObject(raw)) return { ok: false, reason: 'bundle-malformed' };
  if (!onlyKeys(raw, ['v', 'commandId', 'kind', 'scope', 'version', 'reason', 'issuedAt', 'expiresAt', 'requests'])) return { ok: false, reason: 'bundle-malformed' };
  if (raw.v !== 1) return { ok: false, reason: 'bundle-malformed' };
  if (typeof raw.commandId !== 'string' || !UUID.test(raw.commandId)) return { ok: false, reason: 'bundle-malformed' };
  if (typeof raw.kind !== 'string' || !KIND.test(raw.kind)) return { ok: false, reason: 'bundle-malformed' };
  if (typeof raw.scope !== 'string' || (raw.scope !== 'PLATFORM' && !UUID.test(raw.scope))) return { ok: false, reason: 'bundle-malformed' };
  const version = raw.version;
  const issuedAt = raw.issuedAt;
  const expiresAt = raw.expiresAt;
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version <= 0) return { ok: false, reason: 'bundle-malformed' };
  if (typeof issuedAt !== 'number' || typeof expiresAt !== 'number' || !Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(expiresAt)) return { ok: false, reason: 'bundle-malformed' };
  if (version !== issuedAt) return { ok: false, reason: 'bundle-malformed' };
  if (expiresAt <= issuedAt) return { ok: false, reason: 'bundle-malformed' };
  if (typeof raw.reason !== 'string' || raw.reason.length === 0 || raw.reason.length > RUNBOOK_REASON_MAX || hasControl(raw.reason)) return { ok: false, reason: 'bundle-malformed' };
  if (!isObject(raw.requests) || Object.keys(raw.requests).length === 0) return { ok: false, reason: 'bundle-malformed' };
  const requests: Record<string, Record<string, unknown>> = {};
  for (const [service, value] of Object.entries(raw.requests)) {
    if (!(RUNBOOK_SERVICES as readonly string[]).includes(service) || !isObject(value)) return { ok: false, reason: 'bundle-malformed' };
    requests[service] = value;
  }
  return {
    ok: true,
    bundle: {
      v: 1,
      commandId: raw.commandId,
      kind: raw.kind,
      scope: raw.scope,
      version,
      reason: raw.reason,
      issuedAt,
      expiresAt,
      requests,
    },
  };
}

/** 판매 정지는 commander 1명, 판매 재개는 commander 2명, 그 밖은 운영자 2명. 판매 정지의 세 서비스 값이 갈리면 MIXED */
export function runbookApprovalOf(b: RunbookControlBundle): 'ONE_COMMANDER' | 'TWO_COMMANDERS' | 'TWO_OPERATORS' | 'MIXED' {
  if (b.kind !== 'CONTROL_KIND_SALE_PAUSE') return 'TWO_OPERATORS';
  const values = Object.values(b.requests).map((r) => r.paused);
  if (values.length === 0) return 'MIXED';
  if (values.every((v) => v === true)) return 'ONE_COMMANDER';
  if (values.every((v) => v === false)) return 'TWO_COMMANDERS';
  return 'MIXED';
}

function sameDesired(left: unknown, rightJson: string): boolean {
  try {
    return canonicalizeRunbook(left) === canonicalizeRunbook(JSON.parse(rightJson));
  } catch {
    return false;
  }
}

/** 묶음·서명·요청을 확인한다. 재생 기록은 여기서 보지 않는다(runbook-control이 begin/commit/abort를 맡는다) */
export function verifyRunbookControl(o: {
  readonly bundle: RunbookControlBundle;
  readonly bytes: Buffer;
  readonly signatures: readonly RunbookSignature[];
  readonly keys: ReadonlyMap<string, RunbookOperatorKey>;
  readonly service: RunbookService;
  readonly request: RunbookControlRequest;
  readonly nowMs: number;
}): RunbookVerification {
  const b = o.bundle;
  if (o.nowMs > b.expiresAt) return { ok: false, reason: 'expired' };
  if (b.issuedAt > o.nowMs + RUNBOOK_CLOCK_SKEW_MS) return { ok: false, reason: 'not-yet-valid' };
  if (b.expiresAt - b.issuedAt > RUNBOOK_BUNDLE_VALID_MS) return { ok: false, reason: 'window' };

  if (o.request.commandId !== b.commandId || o.request.kind !== b.kind || o.request.scope !== b.scope || o.request.version !== b.version) return { ok: false, reason: 'mismatch' };
  const wanted = b.requests[o.service];
  if (!wanted || !sameDesired(wanted, o.request.desiredStateJson)) return { ok: false, reason: 'mismatch' };

  const policy = runbookApprovalOf(b);
  if (policy === 'MIXED') return { ok: false, reason: 'mismatch' };
  const expected = policy === 'ONE_COMMANDER' ? 1 : 2;
  if (o.signatures.length !== expected) return { ok: false, reason: 'signature-count' };

  const entries: { key: RunbookOperatorKey; publicKey: KeyObject; signature: Buffer }[] = [];
  for (const s of o.signatures) {
    const key = o.keys.get(s.keyId);
    if (!key) return { ok: false, reason: 'unknown-key' };
    // 시험·옛 키 목록은 publicKey, 새 목록은 key에 공개키를 둔다(둘 다 받는다)
    const publicKey = key.key ?? (key as RunbookOperatorKey & { publicKey?: KeyObject }).publicKey;
    if (!publicKey) return { ok: false, reason: 'bad-signature' };
    entries.push({ key, publicKey, signature: s.signature });
  }
  if (new Set(entries.map((e) => e.key.operatorId)).size !== entries.length) return { ok: false, reason: 'same-operator' };
  if (policy === 'ONE_COMMANDER' && entries[0]!.key.role !== 'commander') return { ok: false, reason: 'not-authorized-role' };
  if (policy === 'TWO_COMMANDERS' && entries.some((e) => e.key.role !== 'commander')) return { ok: false, reason: 'not-authorized-role' };
  if (policy === 'TWO_OPERATORS' && entries.some((e) => e.key.role !== 'commander' && e.key.role !== 'operator')) return { ok: false, reason: 'not-authorized-role' };

  for (const e of entries) {
    let good = false;
    try {
      good = cryptoVerify('sha256', o.bytes, { key: e.publicKey, dsaEncoding: 'der' }, e.signature);
    } catch {
      good = false;
    }
    if (!good) return { ok: false, reason: 'bad-signature' };
  }
  return { ok: true, digest: createHash('sha256').update(o.bytes).digest('hex') };
}
