// 우선 구매 권리 회수(GAT-135, ops-svc가 소명 인정 뒤 거둔다). OFFERED만 WITHDRAWN으로 바꾸고 판 번호를 올린다.
import { ProblemError } from '@peaket/platform';
import type { PriorityGrant } from '../domain/priority-grant.js';
import type { PriorityGrantStore } from '../domain/ports.js';

export class WithdrawPriorityGrant {
  constructor(
    private readonly grants: PriorityGrantStore,
    private readonly nowMs: () => number,
  ) {}

  async run(grantId: string): Promise<PriorityGrant> {
    const current = await this.grants.find(grantId);
    if (!current) throw new ProblemError({ type: 'priority-grant-not-found', status: 404, title: '쓸 수 있는 우선 구매 권리가 없습니다' });
    if (current.status === 'USED') throw new ProblemError({ type: 'priority-grant-already-used', status: 409, title: '이미 사용한 우선 구매 권리입니다' });
    if (current.status !== 'OFFERED') return current;
    const withdrawn = await this.grants.withdraw(grantId, this.nowMs());
    if (!withdrawn) throw new ProblemError({ type: 'priority-grant-not-found', status: 404, title: '쓸 수 있는 우선 구매 권리가 없습니다' });
    return withdrawn;
  }
}
