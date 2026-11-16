// 입장 기록 대조로 나온 '취소한 뒤 들어옴'을 ops-svc CS 처리함 FLAGGED(category ENTRY_AFTER_CANCEL)로 여는 어댑터(BAT-420 GAT-090 A, P-T19 ①).
// POST /internal/v1/cs-cases, 본문 { eventKey: `entry-after-cancel:${cancellationId}`, kind: 'FLAGGED', sourceId, category, createdAt }, 내부 토큰 머리, 5초, 실패는 삼킨다.
import type { ExternalHttpClient } from '@peaket/platform';
import type { EntryFlagNotice } from '../domain/ports.js';

/** ops 내부 호출 한도 5초 [가정] */
const TIMEOUT_MS = 5_000;

export class HttpEntryFlagNotice implements EntryFlagNotice {
  constructor(
    private readonly client: Pick<ExternalHttpClient, 'request'>,
    private readonly internalToken?: string,
  ) {}

  async open(q: Parameters<EntryFlagNotice['open']>[0]): Promise<void> {
    try {
      // 같은 취소는 같은 eventKey·sourceId라 ops CS 처리함에서 한 건이다(다시 보내도 된다). 개인정보는 싣지 않는다
      await this.client.request({
        method: 'POST',
        path: '/internal/v1/cs-cases',
        headers: { 'content-type': 'application/json', ...(this.internalToken ? { 'x-peaket-internal-token': this.internalToken } : {}) },
        body: JSON.stringify({ eventKey: `entry-after-cancel:${q.cancellationId}`, kind: 'FLAGGED', sourceId: q.cancellationId, category: 'ENTRY_AFTER_CANCEL', createdAt: new Date(q.nowMs).toISOString() }),
        timeoutCapMs: TIMEOUT_MS,
      });
    } catch {
      // best effort: 행에는 entry_recorded_at이 남아 있다(CS 처리함 계약 전과 같은 꼴)
    }
  }
}
