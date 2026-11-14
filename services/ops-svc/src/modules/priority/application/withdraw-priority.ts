// 우선 구매 권리 회수(GAT-135). purchase-svc가 OFFERED를 WITHDRAWN으로 바꾸고 판 번호를 올리면,
// queue-svc 사본도 같은 판 번호로 WITHDRAWN을 받아 입장 확인에서 404가 되게 한다.
import type { PurchasePriorityGrants, QueuePriorityGrantCopies, WithdrawPriorityView } from '../domain/priority.js';

export class WithdrawPriority {
  constructor(
    private readonly purchase: PurchasePriorityGrants,
    private readonly copies: QueuePriorityGrantCopies,
  ) {}

  async run(grantId: string): Promise<WithdrawPriorityView> {
    const g = await this.purchase.withdraw(grantId);
    await this.copies.set({
      accountId: g.accountId,
      eventId: g.eventId,
      grantId: g.grantId,
      state: 'WITHDRAWN',
      // WITHDRAWN 사본은 권리 만료 전까지 남겨 404 근거로 쓴다(queue.proto 주석)
      expiresAt: g.expiresAt,
      version: g.version,
    });
    return g;
  }
}
