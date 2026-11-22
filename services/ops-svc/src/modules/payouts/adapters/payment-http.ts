// payment-svc 내부 정산·지급 HTTP 클라이언트. 5xx·연결 실패는 503으로 닫는다.
import { createExternalHttpClient, ProblemError, type ExternalHttpClient } from '@peaket/platform';
import type { PayoutPaymentClient } from '../domain/ports.js';
import type { PayoutBatchDetailView, PayoutBatchView } from '../domain/payout-approval.js';

const headers = (token?: string): Record<string, string> => ({ 'content-type': 'application/json', ...(token ? { 'x-peaket-internal-token': token } : {}) });

export class HttpPayoutPaymentClient implements PayoutPaymentClient {
  readonly #client: Pick<ExternalHttpClient, 'request'>;
  constructor(
    baseUrl: string,
    private readonly token?: string,
  ) {
    this.#client = createExternalHttpClient({ provider: 'payment-svc', baseUrl, timeoutCapMs: 10_000 });
  }

  async #json<T>(res: { ok: boolean; status: number; json(): Promise<unknown> }, title: string): Promise<T> {
    if (!res.ok) {
      if (res.status >= 500) throw new ProblemError({ type: 'payout-dependency-unavailable', status: 503, title });
      const body = (await res.json().catch(() => undefined)) as { type?: unknown; title?: unknown } | undefined;
      const slug = typeof body?.type === 'string' ? body.type.split('/').pop() : undefined;
      throw new ProblemError({ type: slug && /^[a-z0-9-]+$/.test(slug) ? slug : 'payout-request-rejected', status: res.status, title: typeof body?.title === 'string' ? body.title : title });
    }
    return (await res.json()) as T;
  }

  async createBatch(input: { pg: 'TOSS' | 'PORTONE'; pgStore: 'STANDARD' | 'ESCROW'; payoutDate: string; portoneBalance?: { amount: number; observedAt: string } | undefined; actor: string }) {
    return this.#json<PayoutBatchView>(
      await this.#client.request({ method: 'POST', path: '/internal/v1/settlements/payout-batches', headers: headers(this.token), body: JSON.stringify(input), timeoutCapMs: 10_000 }),
      '지급 묶음을 만들지 못했습니다',
    );
  }

  async listBatches(filter: { payoutDate?: string | undefined; pg?: string | undefined; pgStore?: string | undefined; status?: readonly string[] | undefined; limit: number }) {
    const params = Object.fromEntries(Object.entries({ payoutDate: filter.payoutDate, pg: filter.pg, pgStore: filter.pgStore, status: filter.status?.join(','), limit: String(filter.limit) }).filter(([, v]) => v !== undefined)) as Record<string, string>;
    const res = await this.#client.request({ method: 'GET', path: '/internal/v1/settlements/payout-batches', params, headers: headers(this.token), timeoutCapMs: 10_000 });
    return (await this.#json<{ items: PayoutBatchView[] }>(res, '지급 묶음 목록을 읽지 못했습니다')).items;
  }

  async getBatchDetail(batchId: string) {
    return this.#json<PayoutBatchDetailView>(
      await this.#client.request({ method: 'GET', path: `/internal/v1/settlements/payout-batches/${batchId}`, headers: headers(this.token), timeoutCapMs: 10_000 }),
      '지급 묶음 상세를 읽지 못했습니다',
    );
  }

  async collectGuarantee(receivableId: string, input: { actor: string; sessionId: string; reauthToken?: string | undefined; idempotencyKey: string; reason: string }) {
    return this.#json<unknown>(
      await this.#client.request({ method: 'POST', path: `/internal/v1/settlements/receivables/${receivableId}/guarantee-collections`, headers: headers(this.token), body: JSON.stringify(input), timeoutCapMs: 10_000 }),
      '보증 충당을 저장하지 못했습니다',
    );
  }

  async approveBatch(batchId: string, approvalId: string) {
    return this.#json<PayoutBatchView>(
      await this.#client.request({ method: 'POST', path: `/internal/v1/settlements/payout-batches/${batchId}/approvals`, headers: headers(this.token), body: JSON.stringify({ approvalId }), timeoutCapMs: 10_000 }),
      '지급 묶음을 승인하지 못했습니다',
    );
  }

  async executeBatch(batchId: string) {
    return this.#json<PayoutBatchView>(
      await this.#client.request({ method: 'POST', path: `/internal/v1/settlements/payout-batches/${batchId}/execution`, headers: headers(this.token), body: JSON.stringify({}), timeoutCapMs: 10_000 }),
      '지급 묶음을 실행하지 못했습니다',
    );
  }

  async releaseBatch(batchId: string): Promise<void> {
    await this.#json<{ released: true }>(
      await this.#client.request({ method: 'POST', path: `/internal/v1/settlements/payout-batches/${batchId}/release`, headers: headers(this.token), body: JSON.stringify({}), timeoutCapMs: 10_000 }),
      '지급 묶음을 풀지 못했습니다',
    );
  }

  async recordPortoneExecution(batchId: string, bulkPayoutId: string) {
    return this.#json<PayoutBatchView>(
      await this.#client.request({ method: 'POST', path: `/internal/v1/settlements/payout-batches/${batchId}/portone-execution`, headers: headers(this.token), body: JSON.stringify({ bulkPayoutId }), timeoutCapMs: 10_000 }),
      '포트원 실행을 기록하지 못했습니다',
    );
  }

  async listStatements(filter: { kind?: string | undefined; status?: string | undefined; pg?: string | undefined; pgStore?: string | undefined; payoutDate?: string | undefined; limit: number }) {
    const params = Object.fromEntries(Object.entries({ ...filter, limit: String(filter.limit) }).filter(([, v]) => v !== undefined)) as Record<string, string>;
    const res = await this.#client.request({ method: 'GET', path: '/internal/v1/settlements/statements', params, headers: headers(this.token), timeoutCapMs: 10_000 });
    return (await this.#json<{ items: unknown[] }>(res, '정산서 목록을 읽지 못했습니다')).items;
  }

  async listReceivables(filter: { limit: number }) {
    const res = await this.#client.request({ method: 'GET', path: '/internal/v1/settlements/receivables', params: { limit: String(filter.limit) }, headers: headers(this.token), timeoutCapMs: 10_000 });
    return (await this.#json<{ items: unknown[] }>(res, '미수금 목록을 읽지 못했습니다')).items;
  }

  async listCircuits() {
    const res = await this.#client.request({ method: 'GET', path: '/internal/v1/circuits', headers: headers(this.token), timeoutCapMs: 5_000 });
    return this.#json<{ items: { pg: 'TOSS' | 'PORTONE' | 'SIMULATOR'; state: 'closed' | 'half_open' | 'open' }[] }>(res, '결제사 서킷 상태를 읽지 못했습니다');
  }
}

export class UnavailablePayoutPaymentClient implements PayoutPaymentClient {
  async createBatch(): Promise<PayoutBatchView> {
    throw new ProblemError({ type: 'payout-dependency-unavailable', status: 503, title: '지급 서비스에 연결하지 못했습니다' });
  }
  async listBatches(): Promise<PayoutBatchView[]> {
    throw new ProblemError({ type: 'payout-dependency-unavailable', status: 503, title: '지급 서비스에 연결하지 못했습니다' });
  }
  async getBatchDetail(): Promise<PayoutBatchDetailView> {
    throw new ProblemError({ type: 'payout-dependency-unavailable', status: 503, title: '지급 서비스에 연결하지 못했습니다' });
  }
  async collectGuarantee(): Promise<unknown> {
    throw new ProblemError({ type: 'payout-dependency-unavailable', status: 503, title: '지급 서비스에 연결하지 못했습니다' });
  }
  async approveBatch(): Promise<PayoutBatchView> {
    throw new ProblemError({ type: 'payout-dependency-unavailable', status: 503, title: '지급 서비스에 연결하지 못했습니다' });
  }
  async executeBatch(): Promise<PayoutBatchView> {
    throw new ProblemError({ type: 'payout-dependency-unavailable', status: 503, title: '지급 서비스에 연결하지 못했습니다' });
  }
  async releaseBatch(): Promise<void> {
    throw new ProblemError({ type: 'payout-dependency-unavailable', status: 503, title: '지급 서비스에 연결하지 못했습니다' });
  }
  async recordPortoneExecution(): Promise<PayoutBatchView> {
    throw new ProblemError({ type: 'payout-dependency-unavailable', status: 503, title: '지급 서비스에 연결하지 못했습니다' });
  }
  async listStatements(): Promise<unknown[]> {
    throw new ProblemError({ type: 'payout-dependency-unavailable', status: 503, title: '지급 서비스에 연결하지 못했습니다' });
  }
  async listReceivables(): Promise<unknown[]> {
    throw new ProblemError({ type: 'payout-dependency-unavailable', status: 503, title: '지급 서비스에 연결하지 못했습니다' });
  }
  async listCircuits(): Promise<{ items: { pg: 'TOSS' | 'PORTONE' | 'SIMULATOR'; state: 'closed' | 'half_open' | 'open' }[] }> {
    throw new ProblemError({ type: 'payout-dependency-unavailable', status: 503, title: '지급 서비스에 연결하지 못했습니다' });
  }
}
