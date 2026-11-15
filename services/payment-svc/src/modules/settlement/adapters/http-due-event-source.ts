// core-svc 회차 정산 원천 HTTP 클라이언트(GET /internal/v1/events/settlement-due).
// 회차 종료 뒤 5영업일이 지난 회차를 하루 한 번 읽어 스케줄러가 정산서를 만든다(A2-06).
import { createExternalHttpClient, ProblemError, type ExternalHttpClient } from '@peaket/platform';
import type { DueEvent, DueEventSettlementSource } from '../domain/ports.js';

export class HttpDueEventSettlementSource implements DueEventSettlementSource {
  readonly #client: Pick<ExternalHttpClient, 'request'>;
  constructor(
    baseUrl: string,
    private readonly internalToken?: string,
  ) {
    this.#client = createExternalHttpClient({ provider: 'core-svc', baseUrl, timeoutCapMs: 5_000 });
  }

  async listDue(through: string, limit: number): Promise<DueEvent[]> {
    const res = await this.#client.request({
      method: 'GET',
      path: '/internal/v1/events/settlement-due',
      query: { through, limit },
      headers: this.internalToken ? { 'x-peaket-internal-token': this.internalToken } : {},
      timeoutCapMs: 5_000,
    });
    if (!res.ok) throw new ProblemError({ type: 'event-settlement-source-unavailable', status: 503, title: '회차 정산 원천을 읽을 수 없습니다' });
    return ((await res.json()) as { items: DueEvent[] }).items;
  }
}

/** 원천 주소가 없는 개발·시험 조립. 회차 정산 스케줄러는 돌지 않는다. */
export class UnavailableDueEventSettlementSource implements DueEventSettlementSource {
  async listDue(): Promise<DueEvent[]> {
    throw new ProblemError({ type: 'event-settlement-source-unavailable', status: 503, title: '회차 정산 원천을 읽을 수 없습니다' });
  }
}
