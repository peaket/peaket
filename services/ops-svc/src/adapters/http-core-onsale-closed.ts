// 끝난 온세일 회차 목록(BAT-360 OPS-280, ADR-0348 결정 9, docs/api/guidelines.md §8.1 'core-svc 끝난 회차 목록 읽기' 행).
// core-svc 읽기 전용 내부 경로 GET /internal/v1/events/onsale-closed?closedFrom&closedTo(서비스 사이 토큰)를 게시 작업 audit-anchor가 부른다.
// 답은 회차 ID와 마감 시각(판매 시작 + 60분)뿐이다. 5초 [가정] 무응답·연결 실패·5xx·4xx·모양이 틀린 답은 던진다(그 실행의 회차 마감 체크포인트만 미룬다).
import type { ExternalHttpClient } from '@peaket/platform';
import type { ClosedEvent, ClosedOnsaleSource } from '../modules/audit/index.js';

/** core 내부 호출 한도(5초) */
const TIMEOUT_MS = 5_000;
/** 한 번 읽는 구간 상한(하루)·행 상한(500) [가정] */
export const ONSALE_CLOSED_MAX_RANGE_MS = 24 * 60 * 60_000;
export const ONSALE_CLOSED_MAX_ROWS = 500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class HttpCoreOnsaleClosed implements ClosedOnsaleSource {
  constructor(
    private readonly client: Pick<ExternalHttpClient, 'request'>,
    private readonly internalToken?: string,
  ) {}

  async closedBetween(fromMs: number, toMs: number): Promise<readonly ClosedEvent[]> {
    if (!Number.isSafeInteger(fromMs) || !Number.isSafeInteger(toMs) || toMs <= fromMs || toMs - fromMs > ONSALE_CLOSED_MAX_RANGE_MS) throw new RangeError('끝난 회차 구간은 하루 이하의 양의 구간이다');
    const res = await this.client.request({
      method: 'GET',
      path: '/internal/v1/events/onsale-closed',
      query: { closedFrom: new Date(fromMs).toISOString(), closedTo: new Date(toMs).toISOString() },
      headers: this.internalToken ? { 'x-peaket-internal-token': this.internalToken } : {},
      timeoutCapMs: TIMEOUT_MS,
    });
    if (!res.ok) throw new Error(`core-svc onsale-closed ${res.status}`);
    const body = (await res.json()) as { items?: unknown };
    if (!Array.isArray(body.items) || body.items.length > ONSALE_CLOSED_MAX_ROWS) throw new Error('core-svc onsale-closed 모양이 다르다');
    return body.items.map((x) => {
      const it = x as { eventId?: unknown; closedAt?: unknown };
      const closedAtMs = typeof it.closedAt === 'string' ? Date.parse(it.closedAt) : Number.NaN;
      if (typeof it.eventId !== 'string' || !UUID.test(it.eventId) || !Number.isFinite(closedAtMs) || closedAtMs < fromMs || closedAtMs >= toMs) {
        throw new Error('core-svc onsale-closed 항목 모양이 다르다');
      }
      return { eventId: it.eventId, closedAtMs };
    });
  }
}
