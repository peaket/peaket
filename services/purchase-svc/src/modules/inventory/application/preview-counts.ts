// purchase-svc 사전 모의 센 값(F-02-5 OPS-300, ADR-0365 결정 11·16, C-T6 ①).
// 세션 수는 정리 색인 s:{event:E}:sessions 멤버 수, Paying 수는 그 세션 해시의 pay=1 수,
// 5분 홀드·결제 접수는 seat_hold.held_at·payment_attempt.accepted_at 기록에서 센다. 원천이 없으면 0이 아니라 no-source다.
import { PREVIEW_DIVISOR, PREVIEW_WINDOW_MS, PURCHASE_PREVIEW_KEYS } from '../domain/preview.js';
import type { PreviewCount, PreviewUnavailable, PurchaseSessionCounter, SaleRecordCounter } from '../domain/preview.js';

export { PAYING_COUNT_MAX, PREVIEW_DIVISOR, PREVIEW_WINDOW_MS, PURCHASE_PREVIEW_KEYS } from '../domain/preview.js';
export type { PreviewCount, PreviewUnavailable, PurchaseSessionCounter, SaleRecordCounter } from '../domain/preview.js';

export interface PreviewCountsDeps {
  readonly sessions: PurchaseSessionCounter;
  readonly records: SaleRecordCounter;
  readonly clock: { now(): number };
}

export type PreviewCountsResult = { readonly counts: readonly PreviewCount[]; readonly unavailable: readonly PreviewUnavailable[] };

export class PreviewCounts {
  constructor(private readonly deps: PreviewCountsDeps) {}

  async run(q: { readonly eventId: string; readonly keys: readonly string[] }): Promise<PreviewCountsResult> {
    const now = this.deps.clock.now();
    const counts: PreviewCount[] = [];
    const unavailable: PreviewUnavailable[] = [];
    const sessionKeys = q.keys.filter((k) => k === 'purchaseSessions' || k === 'paymentSessions');
    const recordKeys = q.keys.filter((k) => k === 'holdsPerSecond5m' || k === 'paymentAcceptsPerSecond5m');
    const unknown = q.keys.filter((k) => !(PURCHASE_PREVIEW_KEYS as readonly string[]).includes(k));
    for (const key of unknown) unavailable.push({ key, reason: 'unknown-key' });

    if (sessionKeys.length > 0) {
      const s = await this.deps.sessions.count(q.eventId);
      if (s === 'too-many') {
        for (const key of sessionKeys) unavailable.push({ key, reason: 'too-many' });
      } else {
        for (const key of sessionKeys) {
          const value = key === 'purchaseSessions' ? s.sessions : s.paying;
          counts.push({ key, value, source: 'purchase-session-index', measuredAtMs: now });
        }
      }
    }

    if (recordKeys.length > 0) {
      const r = await this.deps.records.count(q.eventId, now - PREVIEW_WINDOW_MS);
      for (const key of recordKeys) {
        const raw = key === 'holdsPerSecond5m' ? r.holds : r.accepts;
        if (raw === undefined) unavailable.push({ key, reason: 'no-source' });
        else counts.push({ key, value: raw / PREVIEW_DIVISOR, source: key === 'holdsPerSecond5m' ? 'seat-hold-record' : 'payment-attempt-record', measuredAtMs: now });
      }
    }
    return { counts, unavailable };
  }
}
