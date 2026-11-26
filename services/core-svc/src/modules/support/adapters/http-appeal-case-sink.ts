// FRAUD_CASE 소명이 대상 아님·기한 경과로 닫힐 때 ops CS 건·보류를 닫게 알리는 내부 HTTP 클라이언트(IR-07).
import type { ExternalHttpClient } from '@peaket/platform';
import type { AppealCaseSink } from '../domain/ports.js';

export interface HttpAppealCaseSinkOptions {
  readonly url: string;
  readonly token: string;
  readonly deadlineMs?: number;
}

export class HttpAppealCaseSink implements AppealCaseSink {
  readonly #url: string;
  readonly #injected?: Pick<ExternalHttpClient, 'request'>;
  readonly #token: string;
  readonly #deadlineMs: number;
  #client?: Pick<ExternalHttpClient, 'request'>;

  constructor(o: HttpAppealCaseSinkOptions & { client?: Pick<ExternalHttpClient, 'request'> }) {
    this.#url = o.url;
    this.#injected = o.client;
    this.#token = o.token;
    this.#deadlineMs = o.deadlineMs ?? 1_500;
  }

  async #requestClient(): Promise<Pick<ExternalHttpClient, 'request'>> {
    if (this.#injected) return this.#injected;
    this.#client ??= (await import('@peaket/platform')).createExternalHttpClient({ provider: 'ops-svc', baseUrl: this.#url, timeoutCapMs: this.#deadlineMs });
    return this.#client;
  }

  async invalid(i: { appealId: string; reason: string }): Promise<void> {
    const client = await this.#requestClient();
    const r = await client.request({
      method: 'POST',
      path: '/internal/v1/cs-cases/appeals/{appealId}/invalid',
      params: { appealId: i.appealId },
      headers: { 'content-type': 'application/json', 'x-peaket-internal-token': this.#token, 'x-peaket-caller': 'core-svc' },
      body: JSON.stringify({ reason: i.reason }),
      timeoutCapMs: this.#deadlineMs,
    });
    if (!r.ok) throw new Error(`ops CS 건 닫기 ${r.status}`);
  }
}
