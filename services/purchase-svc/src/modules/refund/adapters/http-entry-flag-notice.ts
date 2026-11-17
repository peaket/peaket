// 입장 기록 대조로 나온 '취소한 뒤 들어옴'을 ops-svc CS 처리함 FLAGGED(category ENTRY_AFTER_CANCEL)로 여는 어댑터(BAT-420 GAT-090 A, P-T19 ①).
// POST /internal/v1/cs-cases, 본문 { eventKey, kind: 'FLAGGED', sourceId, category, createdAt }, 내부 토큰 머리, 5초.
// 2xx를 받아야 연 것이다. 401·5xx·시간 초과·연결 실패는 던진다(웨이브 끝 리뷰 S1): 부른 쪽(환급 실행기)이 경고·지표를 남기고
// 행의 entry_flag_opened_at이 빈 채로 두어 다음 틱에 다시 연다.
// eventKey는 `entry-after-cancel:{취소 ID}`의 SHA-256 앞 16바이트 UUID다(transfer-refund §3.1 ②, asyncapi CaseRequested.eventKey format uuid, BAT-420 리뷰 D2).
import type { ExternalHttpClient } from '@peaket/platform';
import { caseEventKey } from '../domain/case-event-key.js';
import { requireAccepted } from './cs-case-response.js';
import type { EntryFlagNotice } from '../domain/ports.js';

/** ops 내부 호출 한도 5초 [가정] */
const TIMEOUT_MS = 5_000;

export class HttpEntryFlagNotice implements EntryFlagNotice {
  constructor(
    private readonly client: Pick<ExternalHttpClient, 'request'>,
    private readonly internalToken?: string,
  ) {}

  async open(q: Parameters<EntryFlagNotice['open']>[0]): Promise<void> {
    // 같은 취소는 같은 eventKey·sourceId라 ops CS 처리함에서 한 건이다(다시 보내도 된다). 개인정보는 싣지 않는다
    const res = await this.client.request({
      method: 'POST',
      path: '/internal/v1/cs-cases',
      headers: { 'content-type': 'application/json', ...(this.internalToken ? { 'x-peaket-internal-token': this.internalToken } : {}) },
      body: JSON.stringify({ eventKey: caseEventKey('entry-after-cancel', q.cancellationId), kind: 'FLAGGED', sourceId: q.cancellationId, category: 'ENTRY_AFTER_CANCEL', createdAt: new Date(q.nowMs).toISOString() }),
      timeoutCapMs: TIMEOUT_MS,
    });
    await requireAccepted(res, 'entry-after-cancel');
  }
}
