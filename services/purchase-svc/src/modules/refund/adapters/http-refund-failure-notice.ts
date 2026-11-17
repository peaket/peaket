// 환급 실패를 ops-svc CS 처리함 내부 HTTP로 보내는 어댑터(BAT-425 GAT-130). Kafka 소비자 조립 전의 첫 연결이다.
// POST /internal/v1/cs-cases, eventKey = 취소 ID(같은 취소는 같은 건), kind REFUND_FAILED·category REFUND, 내부 토큰 머리(생성자 값), 5초.
// 2xx를 받아야 연 것이다. 401·4xx·5xx는 CsCaseRejected, 시간 초과·연결 실패는 그 오류 그대로 던진다(BAT-420 다시 보기 2 N2, guidelines §8.1
// 'ops-svc CS 처리함 내부 HTTP'). 부른 쪽이 경고·지표를 남기고 연 시각(refund_failed_opened_at·failure_case_opened_at)을 비운 채 두어 다음 틱에 다시 연다.
// 환급 재시도·원장 상태는 부른 쪽이 이미 남겼다. 금액·개인정보는 본문에 싣지 않는다.
import type { ExternalHttpClient } from '@peaket/platform';
import { requireAccepted } from './cs-case-response.js';
import type { EventRefundFailureNotice } from '../domain/event-refund-ports.js';
import type { RefundFailureNotice } from '../domain/ports.js';

/** ops 내부 호출 한도 5초 [가정] */
const TIMEOUT_MS = 5_000;

interface Failure {
  readonly cancellationId: string;
  readonly orderId: string;
  readonly attempts: number;
  readonly lastError: string;
  readonly nowMs: number;
  readonly requestId?: string;
  readonly ticketId?: string;
}

export class HttpRefundFailureNotice implements RefundFailureNotice, EventRefundFailureNotice {
  /** 내부 토큰은 다른 두 CS 어댑터(차액·이상 표시)와 같이 생성자로 받는다(process.env를 읽지 않는다) */
  constructor(
    private readonly client: Pick<ExternalHttpClient, 'request'>,
    private readonly internalToken?: string,
  ) {}

  async open(q: Failure): Promise<void> {
    const res = await this.client.request({
      method: 'POST',
      path: '/internal/v1/cs-cases',
      headers: { 'content-type': 'application/json', ...(this.internalToken ? { 'x-peaket-internal-token': this.internalToken } : {}) },
      body: JSON.stringify({
        eventKey: q.cancellationId,
        kind: 'REFUND_FAILED',
        sourceId: q.cancellationId,
        category: 'REFUND',
        createdAt: new Date(q.nowMs).toISOString(),
      }),
      timeoutCapMs: TIMEOUT_MS,
    });
    await requireAccepted(res, 'refund-failed');
  }
}
