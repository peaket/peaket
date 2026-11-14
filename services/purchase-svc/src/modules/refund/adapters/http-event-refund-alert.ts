// 자동 정지·신청 창 닫힘을 ops-svc 경보로 남기는 어댑터(BAT-425 GAT-130).
// 보내지 못해도 환급 상태는 그대로다(best effort). 실패는 로그·지표가 따로 본다.
import type { ExternalHttpClient } from '@peaket/platform';
import type { EventRefundAlert } from '../domain/event-refund-ports.js';

export class HttpEventRefundAlert implements EventRefundAlert {
  constructor(private readonly client: Pick<ExternalHttpClient, 'request'>) {}

  async raise(q: Parameters<EventRefundAlert['raise']>[0]): Promise<void> {
    try {
      const token = process.env.PEAKET_INTERNAL_TOKEN;
      await this.client.request({
        method: 'POST',
        path: '/internal/v1/ops-alerts',
        headers: { 'content-type': 'application/json', ...(token ? { 'x-peaket-internal-token': token } : {}) },
        body: JSON.stringify({
          // 같은 사유라도 1분 버킷이 지나면 새 경보를 남긴다(재개 뒤 다시 멈춘 경우를 묻지 않는다).
          eventKey: `event-refund:${q.requestId}:${q.pg ?? 'ALL'}:${q.reason}:${Math.floor(q.nowMs / 60_000)}`,
          kind: q.reason,
          severity: q.severity,
          source: 'purchase-svc',
          reason: q.reason,
          detail: { requestId: q.requestId, eventId: q.eventId, ...(q.pg ? { pg: q.pg } : {}), ...q.detail },
          createdAt: new Date(q.nowMs).toISOString(),
        }),
        timeoutCapMs: 5_000,
      });
    } catch {
      // 경보 연결은 best effort다. 자동 정지 상태는 purchase DB에 이미 남겼다.
    }
  }
}
