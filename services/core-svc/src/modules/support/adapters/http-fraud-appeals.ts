// ops-svc 부정 예매 소명 입구(F-04-13 가지) HTTP 클라이언트(F-06-4). 내부 토큰과 x-peaket-caller: core-svc를 싣는다.
// 바깥 호출은 공용 ExternalHttpClient만 쓴다(ASVS 15.3.2, ADR-0259). 무거운 플랫폼 모듈은 첫 호출 때 싣는다(시작 조립 시험 5초).
import type { ExternalHttpClient } from '@peaket/platform';
import type { FraudAppealClient } from '../domain/ports.js';

export interface HttpFraudAppealOptions {
  readonly url: string;
  readonly token: string;
  readonly caller?: string;
  readonly deadlineMs?: number;
}

export class HttpFraudAppealClient implements FraudAppealClient {
  readonly #url: string;
  readonly #injected?: Pick<ExternalHttpClient, 'request'>;
  readonly #token: string;
  readonly #caller: string;
  readonly #deadlineMs: number;
  #client?: Pick<ExternalHttpClient, 'request'>;

  constructor(o: HttpFraudAppealOptions & { client?: Pick<ExternalHttpClient, 'request'> }) {
    this.#url = o.url;
    this.#injected = o.client;
    this.#token = o.token;
    this.#caller = o.caller ?? 'core-svc';
    this.#deadlineMs = o.deadlineMs ?? 1_500;
  }

  async #requestClient(): Promise<Pick<ExternalHttpClient, 'request'>> {
    if (this.#injected) return this.#injected;
    this.#client ??= (await import('@peaket/platform')).createExternalHttpClient({ provider: 'ops-svc', baseUrl: this.#url, timeoutCapMs: this.#deadlineMs });
    return this.#client;
  }

  async send(i: { caseId: string; appealId: string; accountId: string; party: 'PAYER' | 'HOLDER'; submittedAtMs: number }): Promise<{ result: 'ACCEPTED' | 'EXPIRED' | 'NOT_TARGET' | 'RETRY' }> {
    let res: Response;
    try {
      const client = await this.#requestClient();
      res = await client.request({
        method: 'POST',
        path: '/internal/v1/fraud-cases/{caseId}/appeals',
        params: { caseId: i.caseId },
        headers: { 'content-type': 'application/json', 'x-peaket-internal-token': this.#token, 'x-peaket-caller': this.#caller },
        body: JSON.stringify({ appealId: i.appealId, accountId: i.accountId, party: i.party, submittedAt: new Date(i.submittedAtMs).toISOString() }),
        timeoutCapMs: this.#deadlineMs,
      });
    } catch {
      return { result: 'RETRY' };
    }
    if (res.status === 401 || res.status >= 500) return { result: 'RETRY' };
    if (res.status === 403 || res.status === 404) return { result: 'NOT_TARGET' };
    if (!res.ok) return { result: 'RETRY' };
    const body = (await res.json().catch(() => ({}))) as { result?: unknown };
    return body.result === 'EXPIRED' ? { result: 'EXPIRED' } : { result: 'ACCEPTED' };
  }
}
