// core-svc 내부 판매 설정 GET /internal/v1/events/{eventId}/sale-config(서비스 사이 토큰)에서 회차 일정을 읽는다(F-03-3, ADR-0371 결정 1).
// commands 모듈의 HttpCoreSaleStart는 opensAtMs만 읽고 다른 컨텍스트 내부라 가져오지 않는다. 5초 [가정] 한도, 회차마다 30초 [가정] 캐시.
// 404는 판매 설정이 없는 회차(undefined), 그 밖의 실패·모양 틀림은 ReadinessSourceUnavailable(503 readiness-source-unavailable).
import { createExternalHttpClient, type ExternalHttpClient } from '@peaket/platform';
import { ReadinessSourceUnavailable, type SaleSchedule, type SaleScheduleSource } from '../domain/readiness.js';

/** core 판매 설정 한 번 읽기의 한도 5초 [가정](계획 6-1) */
export const CORE_SALE_CONFIG_TIMEOUT_MS = 5_000;
/** 회차마다 일정을 들고 있는 시간 30초 [가정](계획 6-1). 판매 시각이 바뀌어도 30초 안에 따라간다 */
export const CORE_SALE_CONFIG_CACHE_MS = 30_000;

const finiteMs = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const optionalMs = (v: unknown): number | null | false => (v === null || v === undefined ? null : finiteMs(v) ? v : false);

/** 응답 본문에서 일정만 꺼낸다. 칸이 틀리면 undefined */
export function scheduleOf(body: unknown): SaleSchedule | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const b = body as Record<string, unknown>;
  const entryOpensAtMs = optionalMs(b.entryOpensAtMs);
  const entryClosedAtMs = optionalMs(b.entryClosedAtMs);
  if (!finiteMs(b.opensAtMs) || !finiteMs(b.saleEndsAtMs) || entryOpensAtMs === false || entryClosedAtMs === false) return undefined;
  return { opensAtMs: b.opensAtMs, saleEndsAtMs: b.saleEndsAtMs, entryOpensAtMs, entryClosedAtMs };
}

export class HttpCoreSaleSchedule implements SaleScheduleSource {
  readonly #cache = new Map<string, { atMs: number; value: SaleSchedule | undefined }>();

  constructor(
    private readonly client: Pick<ExternalHttpClient, 'request'>,
    private readonly now: () => number,
    private readonly internalToken?: string,
  ) {}

  static fromUrl(baseUrl: string, now: () => number, internalToken?: string): HttpCoreSaleSchedule {
    return new HttpCoreSaleSchedule(createExternalHttpClient({ provider: 'core-svc', baseUrl, timeoutCapMs: CORE_SALE_CONFIG_TIMEOUT_MS }), now, internalToken);
  }

  async get(eventId: string): Promise<SaleSchedule | undefined> {
    const nowMs = this.now();
    const hit = this.#cache.get(eventId);
    if (hit && nowMs - hit.atMs >= 0 && nowMs - hit.atMs < CORE_SALE_CONFIG_CACHE_MS) return hit.value;
    let res: Response;
    try {
      res = await this.client.request({
        method: 'GET',
        path: '/internal/v1/events/{eventId}/sale-config',
        params: { eventId },
        headers: this.internalToken ? { 'x-peaket-internal-token': this.internalToken } : {},
        timeoutCapMs: CORE_SALE_CONFIG_TIMEOUT_MS,
      });
    } catch (err) {
      throw new ReadinessSourceUnavailable(err instanceof Error ? err.name : 'request');
    }
    let value: SaleSchedule | undefined;
    if (res.status === 404) {
      value = undefined;
    } else {
      if (!res.ok) throw new ReadinessSourceUnavailable(`core-svc sale config ${res.status}`);
      value = scheduleOf(await res.json().catch(() => undefined));
      if (!value) throw new ReadinessSourceUnavailable('core-svc sale config 모양');
    }
    this.#cache.set(eventId, { atMs: nowMs, value });
    if (this.#cache.size > 1_000) this.#cache.delete(this.#cache.keys().next().value!);
    return value;
  }
}

/** 원천 주소가 없을 때(PEAKET_CORE_HTTP_URL 없음): 늘 읽지 못함 */
export class UnavailableSaleSchedule implements SaleScheduleSource {
  async get(): Promise<SaleSchedule | undefined> {
    throw new ReadinessSourceUnavailable('PEAKET_CORE_HTTP_URL이 없다');
  }
}
