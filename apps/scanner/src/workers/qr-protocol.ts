// QR 디코딩·판정 Worker 메시지 경계(ASVS offline-gate v5.0.0-3.5.5).
// 같은 출처의 자기 작업자만 보내지만, 모르는 종류·모양은 버린다.
export type ScanWorkerRequest =
  | { type: 'prepare'; state: unknown }
  | { type: 'decode'; id: number; bitmap: unknown }
  | { type: 'judge'; id: number; raw: string; nowMs: number; clockOffsetMs: number };

export type ScanWorkerResponse =
  | { type: 'decoded'; id: number; raw?: string }
  | { type: 'decode-failed'; id: number; reason: 'EMPTY' | 'NO_DECODER' | 'DECODE_ERROR' }
  | { type: 'judged'; id: number; outcome: unknown }
  | { type: 'worker-error'; id: number };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isId = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const onlyKeys = (v: Record<string, unknown>, allowed: readonly string[]): boolean => Object.keys(v).every((k) => allowed.includes(k));

export function parseScanWorkerRequest(data: unknown): ScanWorkerRequest | undefined {
  if (!isRecord(data)) return undefined;
  if (data.type === 'prepare' && onlyKeys(data, ['type', 'state'])) return { type: 'prepare', state: data.state };
  if (data.type === 'decode' && onlyKeys(data, ['type', 'id', 'bitmap'])) {
    if (!isId(data.id) || data.bitmap === undefined) return undefined;
    return { type: 'decode', id: data.id, bitmap: data.bitmap };
  }
  if (data.type === 'judge' && onlyKeys(data, ['type', 'id', 'raw', 'nowMs', 'clockOffsetMs'])) {
    if (!isId(data.id) || typeof data.raw !== 'string') return undefined;
    if (typeof data.nowMs !== 'number' || !Number.isFinite(data.nowMs)) return undefined;
    if (typeof data.clockOffsetMs !== 'number' || !Number.isFinite(data.clockOffsetMs)) return undefined;
    return { type: 'judge', id: data.id, raw: data.raw, nowMs: data.nowMs, clockOffsetMs: data.clockOffsetMs };
  }
  return undefined;
}

export function parseScanWorkerResponse(data: unknown): ScanWorkerResponse | undefined {
  if (!isRecord(data)) return undefined;
  if (data.type === 'decoded' && onlyKeys(data, ['type', 'id', 'raw'])) {
    if (!isId(data.id)) return undefined;
    if (data.raw !== undefined && typeof data.raw !== 'string') return undefined;
    return { type: 'decoded', id: data.id, ...(data.raw !== undefined ? { raw: data.raw } : {}) };
  }
  if (data.type === 'decode-failed' && onlyKeys(data, ['type', 'id', 'reason'])) {
    if (!isId(data.id)) return undefined;
    if (data.reason !== 'EMPTY' && data.reason !== 'NO_DECODER' && data.reason !== 'DECODE_ERROR') return undefined;
    return { type: 'decode-failed', id: data.id, reason: data.reason };
  }
  if (data.type === 'judged' && onlyKeys(data, ['type', 'id', 'outcome'])) {
    if (!isId(data.id)) return undefined;
    return { type: 'judged', id: data.id, outcome: data.outcome };
  }
  if (data.type === 'worker-error' && onlyKeys(data, ['type', 'id'])) {
    if (!isId(data.id)) return undefined;
    return { type: 'worker-error', id: data.id };
  }
  return undefined;
}
