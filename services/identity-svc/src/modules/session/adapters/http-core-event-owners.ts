// core-svc 내부 판매 설정 읽기 어댑터(BUILD_ORDER BAT-450B, ADR-0353).
// purchase·ticket·ops와 같은 읽기 전용 내부 HTTP GET /internal/v1/events/{eventId}/sale-config를 부른다.
// 404는 '없음'(없는 회차·판매 승인 전·다른 파트너 회차를 같은 404로 닫는다), 그 밖의 실패는 던져 부르는 쪽이 503으로 닫는다.
import type { ExternalHttpClient } from '@peaket/platform';
import type { CoreEventOwner, CoreEventOwners } from '../domain/staff.js';

/** core 내부 호출 한도(5초 [가정], ops-svc HttpCoreEventOwners와 같은 값) */
export const CORE_EVENT_OWNER_TIMEOUT_MS = 5_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** core-svc sale-config 응답에서 identity가 쓰는 칸만 읽는다. 모양이 틀리면 던진다(503으로 닫힌다) */
export function coreEventOwnerOf(raw: unknown): CoreEventOwner {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('core-svc sale config 모양이 다르다');
  const o = raw as Record<string, unknown>;
  if (typeof o.promoterId !== 'string' || o.promoterId === '') throw new Error('core-svc sale config promoterId가 없다');
  if (!finite(o.startsAtMs) || !finite(o.endsAtMs)) throw new Error('core-svc sale config 회차 시각이 없다');
  if (o.entryOpensAtMs !== undefined && o.entryOpensAtMs !== null && !finite(o.entryOpensAtMs)) throw new Error('core-svc sale config entryOpensAtMs가 틀렸다');
  return {
    promoterId: o.promoterId,
    startsAtMs: o.startsAtMs,
    endsAtMs: o.endsAtMs,
    ...(finite(o.entryOpensAtMs) ? { entryOpensAtMs: o.entryOpensAtMs } : {}),
  };
}

export class HttpCoreEventOwners implements CoreEventOwners {
  constructor(
    private readonly client: Pick<ExternalHttpClient, 'request'>,
    private readonly internalToken?: string,
  ) {}

  async find(eventId: string): Promise<CoreEventOwner | undefined> {
    if (!UUID.test(eventId)) return undefined;
    const res = await this.client.request({
      method: 'GET',
      path: '/internal/v1/events/{eventId}/sale-config',
      params: { eventId },
      headers: this.internalToken ? { 'x-peaket-internal-token': this.internalToken } : {},
      timeoutCapMs: CORE_EVENT_OWNER_TIMEOUT_MS,
    });
    if (res.status === 404) return undefined;
    if (!res.ok) throw new Error(`core-svc sale config ${res.status}`);
    return coreEventOwnerOf(await res.json());
  }
}
