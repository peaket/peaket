// core-svc support 내부 소명 API 클라이언트(F-06-4). ops-svc만 내부 토큰과 호출자 머리로 부른다.
// 바깥 호출은 공용 ExternalHttpClient만 쓴다(ASVS 15.3.2, ADR-0259). 무거운 플랫폼 모듈은 첫 호출 때 싣는다(시작 조립 시험 5초).
import type { ExternalHttpClient } from '@peaket/platform';
import type { AppealSource, AppealSourceRecord } from '../domain/ports.js';

export interface HttpAppealSourceOptions {
  readonly url: string;
  readonly token: string;
  readonly deadlineMs?: number;
}

export class HttpAppealSource implements AppealSource {
  readonly #url: string;
  readonly #injected?: Pick<ExternalHttpClient, 'request'>;
  readonly #token: string;
  readonly #deadlineMs: number;
  #client?: Pick<ExternalHttpClient, 'request'>;

  constructor(o: HttpAppealSourceOptions & { client?: Pick<ExternalHttpClient, 'request'> }) {
    this.#url = o.url;
    this.#injected = o.client;
    this.#token = o.token;
    this.#deadlineMs = o.deadlineMs ?? 1_500;
  }

  async #requestClient(): Promise<Pick<ExternalHttpClient, 'request'>> {
    if (this.#injected) return this.#injected;
    this.#client ??= (await import('@peaket/platform')).createExternalHttpClient({ provider: 'core-svc', baseUrl: this.#url, timeoutCapMs: this.#deadlineMs });
    return this.#client;
  }

  async read(appealId: string): Promise<AppealSourceRecord | undefined> {
    const client = await this.#requestClient();
    const r = await client.request({
      method: 'GET',
      path: '/internal/v1/appeals/{appealId}',
      params: { appealId },
      headers: { 'x-peaket-internal-token': this.#token, 'x-peaket-caller': 'ops-svc' },
      timeoutCapMs: this.#deadlineMs,
    });
    if (r.status === 404) return undefined;
    if (!r.ok) {
      const { ProblemError } = await import('@peaket/platform');
      throw new ProblemError({ type: 'dependency-unavailable', status: 503, title: '소명 원본에 닿지 못했습니다' });
    }
    const body = (await r.json()) as Record<string, unknown>;
    if (typeof body.accountId !== 'string' || (body.kind !== 'RESTRICTION' && body.kind !== 'FRAUD_CASE') || typeof body.targetId !== 'string') return undefined;
    return {
      appealId: typeof body.appealId === 'string' ? body.appealId : appealId,
      accountId: body.accountId,
      kind: body.kind,
      targetId: body.targetId,
      body: typeof body.body === 'string' ? body.body : '',
      submittedAtMs: Date.parse(String(body.submittedAt ?? '')) || Date.now(),
    };
  }

  async result(appealId: string, r: { status: 'DECIDED' | 'INVALID'; result?: string; resultNote?: string; reason?: string }): Promise<void> {
    const client = await this.#requestClient();
    const res = await client.request({
      method: 'POST',
      path: '/internal/v1/appeals/{appealId}/result',
      params: { appealId },
      headers: { 'content-type': 'application/json', 'x-peaket-internal-token': this.#token, 'x-peaket-caller': 'ops-svc' },
      body: JSON.stringify(r),
      timeoutCapMs: this.#deadlineMs,
    });
    if (!res.ok && res.status !== 409) {
      const { ProblemError } = await import('@peaket/platform');
      throw new ProblemError({ type: 'dependency-unavailable', status: 503, title: '소명 결과를 적지 못했습니다' });
    }
  }
}
