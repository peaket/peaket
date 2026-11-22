// core-svc 판매 중지 회차 조회(BAT-625 LCH-100, ADR-0123, settlement §6).
// 지급 묶음 하나에 든 회차를 100개씩 묶어 한 번에 묻는다. core가 5xx·시간 초과·모양 위반이면 503으로 닫는다.
import { createExternalHttpClient, type ExternalHttpClient } from '@peaket/platform';
import { z } from 'zod';
import { SettlementProblem } from '../domain/settlement.js';
import type { SaleSuspensionSource } from '../domain/ports.js';

const CHUNK = 100;
const SuspendedEvents = z.object({ suspendedEventIds: z.array(z.string()) });

const unavailable = () => new SettlementProblem('dependency-unavailable', 503, '판매 중지 상태를 확인할 수 없습니다');

export class HttpSaleSuspensionSource implements SaleSuspensionSource {
  readonly #client: Pick<ExternalHttpClient, 'request'>;
  constructor(
    baseUrl: string,
    private readonly internalToken?: string,
    fetchImpl?: typeof fetch,
    timeoutCapMs = 3_000,
  ) {
    this.#client = createExternalHttpClient({ provider: 'core-svc', baseUrl, timeoutCapMs, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
  }

  async listSuspended(eventIds: readonly string[]): Promise<ReadonlySet<string>> {
    const ids = [...new Set(eventIds.filter((id) => typeof id === 'string' && id !== ''))];
    const out = new Set<string>();
    for (let at = 0; at < ids.length; at += CHUNK) {
      const chunk = ids.slice(at, at + CHUNK);
      let res: Awaited<ReturnType<ExternalHttpClient['request']>>;
      try {
        res = await this.#client.request({
          method: 'GET',
          path: '/internal/v1/events/sale-suspensions',
          query: { eventIds: chunk.join(',') },
          headers: this.internalToken ? { 'x-peaket-internal-token': this.internalToken } : {},
          timeoutCapMs: 3_000,
        });
      } catch {
        throw unavailable();
      }
      if (!res.ok) throw unavailable();
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        throw unavailable();
      }
      const parsed = SuspendedEvents.safeParse(body);
      if (!parsed.success) throw unavailable();
      for (const id of parsed.data.suspendedEventIds) if (chunk.includes(id)) out.add(id);
    }
    return out;
  }
}

/** core 주소가 없는 조립에서 판매 중지 확인을 무조건 막는다. */
export class UnavailableSaleSuspensionSource implements SaleSuspensionSource {
  async listSuspended(): Promise<ReadonlySet<string>> {
    throw unavailable();
  }
}
