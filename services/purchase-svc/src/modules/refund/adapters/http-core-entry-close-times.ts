// core-svc 판매 설정 내부 경로에서 입장 기록 마감 시각(entryClosedAtMs)만 읽는 어댑터(offline-gate §7.3 '환급 잇기').
// ticket-svc와 같은 GET /internal/v1/events/{eventId}/sale-config를 쓴다. 404·5xx·모양 틀림은 '모름'(undefined)이고,
// 200의 null은 '아직 마감 전'이다. 읽기 실패로 환급을 세우지 않는다(0행).
import type { ExternalHttpClient } from '@peaket/platform';
import type { EntryCloseTimes } from '../domain/entry-close-due.js';

export class HttpCoreEntryCloseTimes implements EntryCloseTimes {
  constructor(
    private readonly o: {
      client: Pick<ExternalHttpClient, 'request'>;
      internalToken?: string;
      timeoutCapMs?: number;
    },
  ) {}

  async closedAtMs(eventId: string): Promise<number | null | undefined> {
    const res = await this.o.client.request({
      method: 'GET',
      path: '/internal/v1/events/{eventId}/sale-config',
      params: { eventId },
      ...(this.o.internalToken ? { headers: { 'x-peaket-internal-token': this.o.internalToken } } : {}),
      timeoutCapMs: this.o.timeoutCapMs ?? 2_000,
    });
    if (!res.ok) return undefined;
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return undefined;
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) return undefined;
    const v = (body as Record<string, unknown>).entryClosedAtMs;
    if (v === null) return null;
    return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : undefined;
  }
}
