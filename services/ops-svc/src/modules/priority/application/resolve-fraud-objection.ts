// 소명(부정 예매 이의) 인정·기각 뒤 우선 구매 권리를 자동으로 발급·회수한다(GAT-135, POL-046 ⑦, transfer-refund §7.4).
// 인정이면 취소한 표마다 GrantPriority를, 되돌림(기각·철회)이면 그 권리를 WithdrawPriority로 거둔다.
// 실제 사건 저장소가 붙기 전의 첫 연결이라 호출자가 사건·표·권리 ID를 넘긴다(작업 워커가 같은 입력으로 다시 보내도 멱등이다).
import type { GrantPriority } from './grant-priority.js';
import type { WithdrawPriority } from './withdraw-priority.js';
import type { GrantPriorityView } from '../domain/priority.js';

export interface FraudObjectionDecisionInput {
  readonly caseId: string;
  readonly accountId: string;
  readonly eventId: string;
  /** 취소한 표들(order_cancellation.ticket_id) */
  readonly cancelledTicketIds: readonly string[];
  readonly decision: 'ACCEPTED' | 'REJECTED';
  /** 기각·철회 때 거둘 권리(있으면) */
  readonly grantId?: string;
  readonly actedBy: string;
}

export interface FraudObjectionDecisionView {
  readonly decision: 'ACCEPTED' | 'REJECTED';
  readonly grants: readonly GrantPriorityView[];
  readonly withdrawnGrantId?: string;
}

export class ResolveFraudObjection {
  constructor(
    private readonly grant: Pick<GrantPriority, 'run'>,
    private readonly withdraw: Pick<WithdrawPriority, 'run'>,
  ) {}

  async run(i: FraudObjectionDecisionInput): Promise<FraudObjectionDecisionView> {
    if (i.decision === 'REJECTED') {
      if (i.grantId === undefined) return { decision: 'REJECTED', grants: [] };
      const w = await this.withdraw.run(i.grantId);
      return { decision: 'REJECTED', grants: [], withdrawnGrantId: w.grantId };
    }
    const grants: GrantPriorityView[] = [];
    for (const cancelledTicketId of i.cancelledTicketIds) {
      grants.push(
        await this.grant.run({
          fraudCaseId: i.caseId,
          eventId: i.eventId,
          accountId: i.accountId,
          cancelledTicketId,
          actedBy: i.actedBy,
        }),
      );
    }
    return { decision: 'ACCEPTED', grants };
  }
}
