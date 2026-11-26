// 정산서별 지급 대상 지문(payeeDigest, F-06-3, BAT-625 RV-02, docs/features/settlement.md §5.1).
// 정산서를 ID 차례로 정렬해 statementId|payoutAmount|promoterId|payeeBankCode|payeeAccountLast4를 줄바꿈으로 잇고 SHA-256 16진으로 만든다.
// 정산 계좌가 없으면 두 계좌 자리에 NO_PAYEE를 쓴다.
import { createHash } from 'node:crypto';

export interface PayeeDigestRow {
  readonly statementId: string;
  readonly payoutAmount: number;
  readonly promoterId: string;
  readonly bankCode?: string | null;
  readonly accountLast4?: string | null;
}

export const NO_PAYEE = 'NO_PAYEE';

export function payeeDigestOf(rows: readonly PayeeDigestRow[]): string {
  const lines = [...rows]
    .sort((a, b) => (a.statementId < b.statementId ? -1 : a.statementId > b.statementId ? 1 : 0))
    .map((r) => `${r.statementId}|${r.payoutAmount}|${r.promoterId}|${r.bankCode ?? NO_PAYEE}|${r.accountLast4 ?? NO_PAYEE}`);
  return createHash('sha256').update(lines.join('\n'), 'utf8').digest('hex');
}

/** 지급일 전 영업일 15:00 KST(토·일만 뺀다). 지급일이 토·일이면 직전 금요일 15:00이다. */
export function payoutApprovalDueAt(payoutDate: string): Date {
  const [y, m, d] = payoutDate.split('-').map(Number);
  const base = new Date(Date.UTC(y!, m! - 1, d!));
  do {
    base.setUTCDate(base.getUTCDate() - 1);
  } while (base.getUTCDay() === 0 || base.getUTCDay() === 6);
  const yyyy = base.getUTCFullYear();
  const mm = String(base.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(base.getUTCDate()).padStart(2, '0');
  return new Date(`${yyyy}-${mm}-${dd}T15:00:00+09:00`);
}
