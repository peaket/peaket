// 포트원 출금 대사(settlement §5.3, ADR-0370 결정 8 ①, J-T20). 순수 함수다. 이체 원장의 출금마다 PEAKET 지급 건과 금액·계좌·예금주를 견준다.
// 지급 건과 이어지지 않는 출금은 이체 쪽 결과 UNLINKED(payoutId null), 완료인데 출금이 없는 지급 건은 MISSING이다.
// 예금주는 비교만 하고 결과에 이름을 싣지 않는다.
import { holderMatches } from './holder-name.js';

export interface PortonePayoutFact {
  payoutId: string;
  statementId: string;
  amount: number;
  bankCode: string | null;
  accountLast4: string | null;
  status: 'REQUESTED' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED' | 'CANCELED';
}

export interface PortoneTransferFact {
  transferId: string;
  withdrawalType: string;
  payoutId: string | null;
  amount: number;
  bankCode: string | null;
  accountLast4: string | null;
  holderName: string | null;
  transferredAt: Date;
}

export interface PortonePartnerAccountFact {
  promoterId: string;
  legalName: string;
  representative: string;
  bankCode: string;
  accountLast4: string;
}

export type WithdrawalCheck = 'MATCHED' | 'MISMATCH' | 'MISSING' | 'UNLINKED';

export interface WithdrawalReconciliation {
  /** UNLINKED(이어진 PEAKET 지급 건이 없는 출금)는 null */
  payoutId: string | null;
  transferId: string | null;
  check: WithdrawalCheck;
  reasons: string[];
}

/**
 * 포트원 출금 대사(settlement §5.3, J-T20). 지급 건마다 이체 ID·금액·계좌·예금주를 본다.
 * 지급 건과 이어지지 않는 출금은 UNLINKED, 완료인데 출금이 없으면 MISSING이다.
 */
export function reconcilePortoneWithdrawals(input: {
  payouts: readonly PortonePayoutFact[];
  transfers: readonly PortoneTransferFact[];
  accounts: ReadonlyMap<string, PortonePartnerAccountFact>;
  promoterOfPayout: (payoutId: string) => string | undefined;
}): WithdrawalReconciliation[] {
  const used = new Set<string>();
  const out: WithdrawalReconciliation[] = [];
  for (const p of input.payouts) {
    const promoterId = input.promoterOfPayout(p.payoutId);
    const account = promoterId ? input.accounts.get(promoterId) : undefined;
    const transfer = input.transfers.find((t) => !used.has(t.transferId) && (t.payoutId === p.payoutId || (t.amount === p.amount && t.bankCode === p.bankCode && t.accountLast4 === p.accountLast4)));
    if (!transfer) {
      if (p.status === 'COMPLETED') out.push({ payoutId: p.payoutId, transferId: null, check: 'MISSING', reasons: ['no-withdrawal'] });
      continue;
    }
    used.add(transfer.transferId);
    const reasons: string[] = [];
    if (transfer.amount !== p.amount) reasons.push('amount');
    if (transfer.bankCode !== p.bankCode || transfer.accountLast4 !== p.accountLast4) reasons.push('account');
    if (account && transfer.holderName && !holderMatches(transfer.holderName, { legalName: account.legalName, representative: account.representative })) reasons.push('holder');
    out.push({ payoutId: p.payoutId, transferId: transfer.transferId, check: reasons.length === 0 ? 'MATCHED' : 'MISMATCH', reasons });
  }
  for (const t of input.transfers) if (!used.has(t.transferId)) out.push({ payoutId: null, transferId: t.transferId, check: 'UNLINKED', reasons: ['not-linked'] });
  return out;
}

