// 우선 구매 권리 발급(GAT-135). purchase-svc가 만든 권리의 판 번호·만료를 queue-svc 사본에 그대로 잇는다.
// NO_SEAT·ENTRY_STARTED면 권리가 없으므로 queue-svc를 부르지 않는다.
import type { GrantPriorityInput, GrantPriorityView, PurchasePriorityGrants, QueuePriorityGrantCopies } from '../domain/priority.js';

export class GrantPriority {
  constructor(
    private readonly purchase: PurchasePriorityGrants,
    private readonly copies: QueuePriorityGrantCopies,
  ) {}

  async run(i: GrantPriorityInput): Promise<GrantPriorityView> {
    const g = await this.purchase.grant(i);
    if (g.grantId !== undefined && g.expiresAt !== undefined && g.version !== undefined) {
      await this.copies.set({ accountId: i.accountId, eventId: i.eventId, grantId: g.grantId, state: 'OFFERED', expiresAt: g.expiresAt, version: g.version });
    }
    return g;
  }
}
