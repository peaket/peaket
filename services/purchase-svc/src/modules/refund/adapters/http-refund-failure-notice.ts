// 환급 실패를 ops-svc CS 처리함 내부 HTTP로 보내는 어댑터(BAT-425 GAT-130). Kafka 소비자 조립 전의 첫 연결이다.
// 보내지 못해도 환급 재시도·원장은 멈추지 않는다(best effort). 로그·경보가 그 실패를 따로 본다.
import type { ExternalHttpClient } from '@peaket/platform';
import type { EventRefundFailureNotice } from '../domain/event-refund-ports.js';
import type { RefundFailureNotice } from '../domain/ports.js';

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
  // 다시 보기 2 N2 빈 뼈대(시험 담당): 둘째 인자 내부 토큰은 구현 담당이 쓴다(다른 두 CS 어댑터와 같은 생성자)
  constructor(
    private readonly client: Pick<ExternalHttpClient, 'request'>,
    _internalToken?: string,
  ) {}

  async open(q: Failure): Promise<void> {
    try {
      const token = process.env.PEAKET_INTERNAL_TOKEN;
      await this.client.request({
        method: 'POST',
        path: '/internal/v1/cs-cases',
        headers: { 'content-type': 'application/json', ...(token ? { 'x-peaket-internal-token': token } : {}) },
        body: JSON.stringify({
          eventKey: q.cancellationId,
          kind: 'REFUND_FAILED',
          sourceId: q.cancellationId,
          category: 'REFUND',
          createdAt: new Date(q.nowMs).toISOString(),
        }),
        timeoutCapMs: 5_000,
      });
    } catch {
      // CS 처리함 연결은 best effort다. 환급 재시도·원장 상태는 caller가 이미 남겼다.
    }
  }
}
