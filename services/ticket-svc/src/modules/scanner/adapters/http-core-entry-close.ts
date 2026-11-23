// core-svc 내부 입구 PUT /internal/v1/events/{eventId}/entry-closed 어댑터(offline-gate §7.3 'core 알림').
// 본문은 closedAt(ISO, 오프셋), 내부 토큰은 x-peaket-internal-token(guidelines §8.1). 2xx면 알린 것으로 본다.
// 2xx 본문의 entryClosedAt이 자기 마감 시각과 다르면 부르는 쪽이 경고 로그만 남긴다(core가 먼저 정한 값이 이긴다).
import type { ExternalHttpClient } from '@peaket/platform';
import type { EntryCloseCoreSink } from '../domain/ports.js';

export class HttpCoreEntryClose implements EntryCloseCoreSink {
  constructor(
    private readonly client: Pick<ExternalHttpClient, 'request'>,
    private readonly internalToken?: string,
  ) {}

  async notify(eventId: string, closedAtMs: number): Promise<{ ok: true; storedAtMs: number } | { ok: false; status?: number }> {
    const res = await this.client.request({
      method: 'PUT',
      path: '/internal/v1/events/{eventId}/entry-closed',
      params: { eventId },
      headers: { 'content-type': 'application/json', ...(this.internalToken ? { 'x-peaket-internal-token': this.internalToken } : {}) },
      body: JSON.stringify({ closedAt: new Date(closedAtMs).toISOString() }),
    });
    if (!res.ok) return { ok: false, status: res.status };
    let storedAtMs = closedAtMs;
    try {
      const body = (await res.json()) as { entryClosedAt?: unknown };
      if (typeof body.entryClosedAt === 'string') {
        const parsed = Date.parse(body.entryClosedAt);
        if (Number.isFinite(parsed)) storedAtMs = parsed;
      }
    } catch {
      // 본문을 읽지 못해도 2xx면 알린 것이다(마감 시각은 자기 값을 그대로 둔다)
    }
    return { ok: true, storedAtMs };
  }
}
