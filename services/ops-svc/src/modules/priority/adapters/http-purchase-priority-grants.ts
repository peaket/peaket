// purchase-svc 내부 HTTP 클라이언트(GAT-135). 정본 gRPC PriorityPurchaseService의 첫 내부 경로다.
// 응답이 2xx가 아니면 PriorityDependencyUnavailable로 바꿔 받는 층이 503 dependency-unavailable로 답하게 한다.
import { type ExternalHttpClient, ProblemError } from '@peaket/platform';
import { PriorityDependencyUnavailable, type GrantPriorityInput, type GrantPriorityView, type PurchasePriorityGrants, type WithdrawPriorityView } from '../domain/priority.js';

/** purchase-svc의 4xx 문제 상세를 그대로 ops 응답으로 옮긴다(404 priority-grant-not-found·409 priority-grant-already-used) */
async function rejected(res: { status: number; json(): Promise<unknown> }): Promise<never> {
  const body = (await res.json().catch(() => undefined)) as { type?: unknown; title?: unknown } | undefined;
  const slug = typeof body?.type === 'string' ? body.type.split('/').pop() : undefined;
  throw new ProblemError({
    status: res.status,
    type: slug !== undefined && /^[a-z0-9-]+$/.test(slug) ? slug : 'priority-grant-request-rejected',
    title: typeof body?.title === 'string' ? body.title : '우선 구매 권리 요청이 거절되었습니다',
  });
}

export class HttpPurchasePriorityGrants implements PurchasePriorityGrants {
  constructor(
    private readonly client: Pick<ExternalHttpClient, 'request'>,
    private readonly internalToken?: string,
  ) {}

  #headers(): Record<string, string> {
    return { 'content-type': 'application/json', ...(this.internalToken ? { 'x-peaket-internal-token': this.internalToken } : {}) };
  }

  async grant(i: GrantPriorityInput): Promise<GrantPriorityView> {
    const res = await this.client.request({ method: 'POST', path: '/internal/v1/priority-grants', headers: this.#headers(), body: JSON.stringify(i), timeoutCapMs: 5_000 });
    if (!res.ok) {
      if (res.status >= 500) throw new PriorityDependencyUnavailable('purchase-svc', res.status);
      return rejected(res);
    }
    return (await res.json()) as GrantPriorityView;
  }

  async withdraw(grantId: string): Promise<WithdrawPriorityView> {
    const res = await this.client.request({
      method: 'POST',
      path: `/internal/v1/priority-grants/${grantId}/withdrawals`,
      headers: this.#headers(),
      body: JSON.stringify({}),
      timeoutCapMs: 5_000,
    });
    if (!res.ok) {
      if (res.status >= 500) throw new PriorityDependencyUnavailable('purchase-svc', res.status);
      return rejected(res);
    }
    return (await res.json()) as WithdrawPriorityView;
  }
}
