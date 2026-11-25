// queue-svc 사전 모의 센 값(F-02-5 OPS-300, ADR-0365 결정 11·16, C-T6 ①).
// waiting = 발급 번호 seq − serving − serving보다 크고 seq 이하인 건너뛴 번호 수.
import type { QueuePreviewCount, QueuePreviewUnavailable, QueueWaitingReader } from '../domain/preview.js';

export { QUEUE_PREVIEW_KEYS } from '../domain/preview.js';
export type { QueuePreviewCount, QueuePreviewUnavailable, QueueWaitingReader } from '../domain/preview.js';

/** 읽기 전용 대기 인원 사전 모의. waiting을 묻지 않으면 읽기 포트를 부르지 않는다 */
export class PreviewWaiting {
  constructor(private readonly deps: { readonly reader: QueueWaitingReader }) {}

  async run(q: { readonly eventId: string; readonly keys: readonly string[] }): Promise<{ readonly counts: readonly QueuePreviewCount[]; readonly unavailable: readonly QueuePreviewUnavailable[] }> {
    const counts: QueuePreviewCount[] = [];
    const unavailable: QueuePreviewUnavailable[] = [];
    for (const key of q.keys) {
      if (key !== 'waiting') {
        unavailable.push({ key, reason: 'unknown-key' });
        continue;
      }
      const r = await this.deps.reader.waiting(q.eventId);
      if (r === undefined) unavailable.push({ key, reason: 'no-source' });
      else counts.push({ key, value: r.waiting, source: 'queue-slot', measuredAtMs: r.measuredAtMs });
    }
    return { counts, unavailable };
  }
}
