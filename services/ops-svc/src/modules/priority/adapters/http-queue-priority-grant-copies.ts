// queue-svc 내부 HTTP 클라이언트(GAT-135). SetPriorityGrant 사본을 판 번호·만료와 함께 쓴다.
import type { ExternalHttpClient } from '@peaket/platform';
import { PriorityDependencyUnavailable, type QueuePriorityGrantCopies } from '../domain/priority.js';

export class HttpQueuePriorityGrantCopies implements QueuePriorityGrantCopies {
  constructor(
    private readonly client: Pick<ExternalHttpClient, 'request'>,
    private readonly internalToken?: string,
  ) {}

  async set(i: Parameters<QueuePriorityGrantCopies['set']>[0]): Promise<void> {
    const res = await this.client.request({
      method: 'POST',
      path: '/internal/v1/priority-grants',
      headers: { 'content-type': 'application/json', ...(this.internalToken ? { 'x-peaket-internal-token': this.internalToken } : {}) },
      body: JSON.stringify(i),
      timeoutCapMs: 2_000,
    });
    if (!res.ok) throw new PriorityDependencyUnavailable('queue-svc', res.status);
  }
}
