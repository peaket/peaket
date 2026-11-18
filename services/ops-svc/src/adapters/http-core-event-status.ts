// core 회차 상태 반영 어댑터(BAT-420-rest GAT-110, R-T41, docs/features/transfer-refund.md §5 'core 회차 상태 반영', ADR-0280 결정 6).
// core-svc 내부 HTTP POST /internal/v1/events/{eventId}/cancellation-status를 서비스 사이 토큰(x-peaket-internal-token)과 함께 부른다. 시간 상한 3초 [가정].
// 2xx(204)만 반영한 것이다. 4xx는 계약 결함이라 CoreEventStatusRejected, 5xx·시간 초과·연결 실패는 그 오류를 던진다(부른 쪽이 다시 하기로 잇는다).
// 실패 모양은 docs/api/guidelines.md §8.1의 판매 설정 읽기 행과 같다(HttpCoreEventOwners와 같은 꼴).
import type { ExternalHttpClient } from '@peaket/platform';
import { type CoreEventStatus, CoreEventStatusRejected } from '../modules/event-cancellations/domain/ports.js';

/** core 회차 상태 반영 호출 한도 3초 [가정] */
export const CORE_EVENT_STATUS_TIMEOUT_MS = 3_000;

export class HttpCoreEventStatus implements CoreEventStatus {
  constructor(
    private readonly client: Pick<ExternalHttpClient, 'request'>,
    private readonly internalToken?: string,
  ) {}

  async apply(q: Parameters<CoreEventStatus['apply']>[0]): Promise<void> {
    const res = await this.client.request({
      method: 'POST',
      path: '/internal/v1/events/{eventId}/cancellation-status',
      params: { eventId: q.eventId },
      headers: { 'content-type': 'application/json', ...(this.internalToken ? { 'x-peaket-internal-token': this.internalToken } : {}) },
      body: JSON.stringify({ requestId: q.requestId, kind: q.kind, ...(q.postponedTo !== undefined ? { postponedTo: q.postponedTo.toISOString() } : {}) }),
      timeoutCapMs: CORE_EVENT_STATUS_TIMEOUT_MS,
    });
    // 본문은 읽어 버린다(연결을 붙잡지 않게)
    await res.text().catch(() => undefined);
    if (res.status >= 200 && res.status <= 299) return;
    if (res.status >= 400 && res.status <= 499) throw new CoreEventStatusRejected(res.status);
    throw new Error(`core-svc 회차 상태 반영 ${res.status}`);
  }
}
