// 서비스 워커와 창 사이 메시지 경계(ASVS offline-gate v5.0.0-3.5.5).
// 창이 보낸 메시지는 출처를 믿지 않고, 같은 출처의 창과 정해진 모양만 받는다.
export type ScannerSwClientMessage = { type: 'SKIP_WAITING' } | { type: 'BACKGROUND_UPLOAD_DONE'; accepted: number };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function parseServiceWorkerMessage(data: unknown): ScannerSwClientMessage | undefined {
  if (!isRecord(data)) return undefined;
  if (data.type === 'SKIP_WAITING') return { type: 'SKIP_WAITING' };
  if (data.type === 'BACKGROUND_UPLOAD_DONE') {
    if (typeof data.accepted !== 'number' || !Number.isSafeInteger(data.accepted) || data.accepted < 0) return undefined;
    return { type: 'BACKGROUND_UPLOAD_DONE', accepted: data.accepted };
  }
  return undefined;
}

function originOf(url: unknown): string | undefined {
  if (typeof url !== 'string' || url.length === 0) return undefined;
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

/**
 * 서비스 워커의 message 사건이 같은 출처 창에서 왔는가.
 * event.origin과 event.source.url의 출처가 모두 기대 출처와 같아야 한다.
 */
export function isTrustedClientMessage(
  i: { origin?: string; source?: { url?: string } | null; data: unknown },
  o: { origin: string },
): boolean {
  if (i.origin !== o.origin) return false;
  if (!i.source) return false;
  return originOf(i.source.url) === o.origin;
}
