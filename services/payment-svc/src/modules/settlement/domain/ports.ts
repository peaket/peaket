// 정산·지급·KYC 저장 포트. 메모리(단위 시험)와 Drizzle(운영)이 같은 모양을 쓴다.
import type {
  DisputeRecord,
  KycRecord,
  PaymentFact,
  PayoutAccountRecord,
  PayoutBatchRecord,
  PayoutRecord,
  Pg,
  PgStore,
  StatementRecord,
  StatementSource,
} from './settlement.js';

export interface StatementFilter {
  from?: string | undefined;
  to?: string | undefined;
  pgStore?: PgStore | undefined;
  cursor?: string | undefined;
  limit: number;
}

export interface StatementPage {
  items: StatementRecord[];
  nextCursor: string | null;
}

export interface SettlementStore {
  insertStatement(record: StatementRecord, sources: readonly StatementSource[]): Promise<void>;
  findStatement(promoterId: string, statementId: string): Promise<StatementRecord | undefined>;
  findStatementById(statementId: string): Promise<StatementRecord | undefined>;
  findEventStatement(promoterId: string, eventId: string, pg: Pg, pgStore: PgStore): Promise<StatementRecord | undefined>;
  listEvent(promoterId: string, eventId: string): Promise<StatementRecord[]>;
  listProduct(promoterId: string, filter: StatementFilter): Promise<StatementPage>;
  saveStatement(record: StatementRecord): Promise<void>;
  insertDispute(record: DisputeRecord): Promise<void>;
  listDisputes(statementId: string): Promise<DisputeRecord[]>;
  insertPayoutBatch(record: PayoutBatchRecord): Promise<void>;
  findPayoutBatch(batchId: string): Promise<PayoutBatchRecord | undefined>;
  listPayoutBatches(filter: { pg?: Pg | undefined; pgStore?: PgStore | undefined; payoutDate?: string | undefined; status?: readonly string[] | undefined; limit: number }): Promise<PayoutBatchRecord[]>;
  savePayoutBatch(record: PayoutBatchRecord): Promise<void>;
  listConfirmed(pg: Pg, pgStore: PgStore, payoutDate: string): Promise<StatementRecord[]>;
  insertPayouts(records: readonly PayoutRecord[]): Promise<void>;
  listPayouts(batchId: string): Promise<PayoutRecord[]>;
  findPayout(payoutId: string): Promise<PayoutRecord | undefined>;
  savePayout(record: PayoutRecord): Promise<void>;
  findKyc(promoterId: string): Promise<KycRecord | undefined>;
  saveKyc(record: KycRecord): Promise<void>;
  findPayoutAccount(promoterId: string): Promise<PayoutAccountRecord | undefined>;
  savePayoutAccount(record: PayoutAccountRecord): Promise<void>;
}

export interface SettlementPaymentSource {
  /** 회차·결제사 결제 원장. 입금 오류 되돌림(FAILED·DEPOSIT_CANCELED)은 뺀다. */
  listEventPayments(eventId: string, pg: Pg): Promise<PaymentFact[]>;
}

export interface PayoutSubmitInput {
  batch: PayoutBatchRecord;
  payouts: readonly PayoutRecord[];
}

export interface PayoutSubmitResult {
  status: 'SUBMITTED' | 'COMPLETED';
  pgPayoutIds?: Record<string, string>;
}

/** 지급 실행 어댑터. 토스 지급대행 JWE·포트원 콘솔 실행은 이 경계 뒤에 둔다. */
export interface PayoutGateway {
  readonly pg: Pg;
  submit(input: PayoutSubmitInput): Promise<PayoutSubmitResult>;
}

export interface VerifiedReauth {
  jti: string;
  accountId: string;
  sessionId: string;
  act: string;
  factors: string[];
}

export interface ReauthVerifier {
  /** 없거나 틀리면 SettlementProblem('reauth-required', 403) */
  verify(token: string | undefined, o: { sessionId: string; act: string }): Promise<VerifiedReauth>;
}

export const SETTLEMENT_STORE = Symbol.for('peaket.settlement.store');
export const SETTLEMENT_PAYMENT_SOURCE = Symbol.for('peaket.settlement.payment-source');
export const PAYOUT_GATEWAY = Symbol.for('peaket.settlement.payout-gateway');
export const REAUTH_VERIFIER = Symbol.for('peaket.settlement.reauth-verifier');
