// 파트너 회차 소속 확인(BAT-420 GAT-110 P, transfer-refund §5 '요청 두 길'). core-svc 내부 판매 설정(GET /internal/v1/events/{eventId}/sale-config)을 읽는다.
// 404는 없음(판매 승인 전 회차와 다른 파트너 회차를 같은 404로 닫는다), 2xx는 소속·시작·끝 시각, 그 밖과 시간 초과는 던진다(503 authz-unavailable).
import type { ExternalHttpClient } from '@peaket/platform';
import type { EventOwnerLookup } from '../modules/event-cancellations/domain/ports.js';

/** core 내부 호출 한도(5초) */
const TIMEOUT_MS = 5_000;

export class HttpCoreEventOwners implements EventOwnerLookup {
  constructor(
    private readonly client: Pick<ExternalHttpClient, 'request'>,
    private readonly internalToken?: string,
  ) {}

  async find(eventId: string): Promise<{ promoterId: string; startsAtMs: number; endsAtMs?: number } | undefined> {
    const res = await this.client.request({
      method: 'GET',
      path: '/internal/v1/events/{eventId}/sale-config',
      params: { eventId },
      headers: this.internalToken ? { 'x-peaket-internal-token': this.internalToken } : {},
      timeoutCapMs: TIMEOUT_MS,
    });
    if (res.status === 404) return undefined;
    if (!res.ok) throw new Error(`core-svc sale config ${res.status}`);
    const body = (await res.json()) as { promoterId?: unknown; startsAtMs?: unknown; endsAtMs?: unknown };
    if (typeof body.promoterId !== 'string' || typeof body.startsAtMs !== 'number' || !Number.isFinite(body.startsAtMs)) throw new Error('core-svc sale config 모양이 다르다');
    return {
      promoterId: body.promoterId,
      startsAtMs: body.startsAtMs,
      ...(typeof body.endsAtMs === 'number' && Number.isFinite(body.endsAtMs) ? { endsAtMs: body.endsAtMs } : {}),
    };
  }
}
