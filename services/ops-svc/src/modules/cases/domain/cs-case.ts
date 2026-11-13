// CS 처리함 건 계약(GAT-110 첫 몫, asyncapi support.cases-requested, docs/features/transfer-refund.md §7.1).
// 이 골격은 환급 실패(REFUND_FAILED) 건만 받는다. Kafka 소비자 조립은 후속이고, 계약·저장·멱등은 여기서 시험한다.
import { randomUUID } from 'node:crypto';

export const CS_CASE_KINDS = [
  'UNKNOWN_PAYMENT',
  'REFUND_FAILED',
  'FLAGGED',
  'REFUND_ACCOUNT_PENDING',
  'COMPENSATION_PENDING',
  'ABUSE_FLAG',
  'DISPUTE',
  'JUDGEMENT_PENDING',
  'STATEMENT_DISPUTE',
  'SELLER_KYC_REQUIRED',
  'PAYOUT_ERROR',
  'PAYOUT_FAILED',
  'PAYOUT_DELAYED',
  'PORTONE_PAYOUT_EXECUTION',
  'SCANNER_UNREPORTED',
  'KOPIS_REPORT_FAILED',
  'VERIFICATION_APPEAL',
  'APPROVAL_EXECUTION_FAILED',
  'RETURN_DELAYED',
  'MINOR_CONTRACT_CANCEL',
  'INQUIRY',
  'CONTENT_REPORT',
  'RIGHTS_REQUEST',
  'PORTONE_LEDGER_MISMATCH',
  'TICKET_NOT_ISSUED',
  'PG_BALANCE_MISMATCH',
  'APPEAL',
  'FRAUD_OBJECTION_COMPENSATION',
] as const;
export type CsCaseKind = (typeof CS_CASE_KINDS)[number];

/** asyncapi support.cases-requested의 본문(개인정보·본문 없이 ID와 종류만) */
export interface CaseRequested {
  readonly eventKey: string;
  readonly kind: CsCaseKind;
  readonly sourceId: string;
  readonly category: string;
  readonly followUp?: boolean;
  readonly hold?: boolean;
  readonly createdAt: string;
}

export interface CsCase {
  readonly caseId: string;
  readonly kind: CsCaseKind;
  readonly targetRef: string;
  readonly status: 'OPEN' | 'IN_PROGRESS' | 'RESOLVED';
  readonly createdAtMs: number;
}

export interface CsCaseStore {
  /** 같은 kind·targetRef의 열린 건이 있으면 그것을 돌려준다(멱등) */
  open(input: { caseId: string; kind: CsCaseKind; targetRef: string; nowMs: number }): Promise<CsCase>;
}
