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
  ProductSettlementItem,
  ReceivableMoveRecord,
  ReceivableRecord,
  ReceivableStatus,
  StatementAuditRecord,
  StatementKind,
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

export interface StatementUpdate {
  statementId: string;
  status: StatementRecord['status'];
  holdReason: StatementRecord['holdReason'];
  offsetAmount: number;
  payoutAmount: number;
  updatedAt: Date;
}

export interface ReceivableUpdate {
  receivableId: string;
  remaining: number;
  status: ReceivableRecord['status'];
  updatedAt: Date;
}

export interface PayoutBatchAtomicInput {
  batch: PayoutBatchRecord;
  statementIds: readonly string[];
  statementUpdates: readonly StatementUpdate[];
  receivableUpdates: readonly ReceivableUpdate[];
  receivableMoves: readonly ReceivableMoveRecord[];
}

export interface SettlementStore {
  /** 부분 유일 인덱스에 걸려 넣지 못하면 false(원본 목록도 쓰지 않는다). */
  insertStatement(record: StatementRecord, sources: readonly StatementSource[]): Promise<boolean>;
  findStatement(promoterId: string, statementId: string): Promise<StatementRecord | undefined>;
  findStatementById(statementId: string): Promise<StatementRecord | undefined>;
  findEventStatement(promoterId: string, eventId: string, pg: Pg, pgStore: PgStore): Promise<StatementRecord | undefined>;
  listEvent(promoterId: string, eventId: string): Promise<StatementRecord[]>;
  listProduct(promoterId: string, filter: StatementFilter): Promise<StatementPage>;
  saveStatement(record: StatementRecord): Promise<void>;
  insertStatementAudit(record: StatementAuditRecord): Promise<void>;
  insertDispute(record: DisputeRecord): Promise<void>;
  saveDispute(record: DisputeRecord): Promise<void>;
  listDisputes(statementId: string): Promise<DisputeRecord[]>;
  insertPayoutBatch(record: PayoutBatchRecord): Promise<void>;
  /** 배치와 정산서 결속을 한 트랜잭션으로 쓴다. 결속할 수 없는 정산서가 섞이면 롤백하고 409다. */
  createPayoutBatchWithStatements(record: PayoutBatchRecord, statementIds: readonly string[]): Promise<void>;
  /** 상계·보류·배치·정산서 결속을 한 트랜잭션으로 쓴다(M1-F1). 하나라도 실패하면 전부 롤백한다. */
  createPayoutBatchAtomically(input: PayoutBatchAtomicInput): Promise<void>;
  /** 반려·취소한 배치를 풀어 정산서를 CONFIRMED로 되돌리고 같은 지급일의 새 배치를 가능하게 한다(CONS-V02). */
  releasePayoutBatch(batchId: string): Promise<boolean>;
  findPayoutBatch(batchId: string): Promise<PayoutBatchRecord | undefined>;
  listPayoutBatches(filter: { pg?: Pg | undefined; pgStore?: PgStore | undefined; payoutDate?: string | undefined; status?: readonly string[] | undefined; limit: number }): Promise<PayoutBatchRecord[]>;
  savePayoutBatch(record: PayoutBatchRecord): Promise<void>;
  /** 아직 어느 지급 묶음에도 붙지 않은 확정 정산서만. */
  listConfirmed(pg: Pg, pgStore: PgStore, payoutDate: string): Promise<StatementRecord[]>;
  listStatementsByBatch(batchId: string): Promise<StatementRecord[]>;
  /** 이의 기간이 끝난 NOTIFIED 정산서(자동 확정 대상, M1-F3). */
  listDueConfirmation(now: Date, limit: number): Promise<StatementRecord[]>;
  insertPayouts(records: readonly PayoutRecord[]): Promise<void>;
  listPayouts(batchId: string): Promise<PayoutRecord[]>;
  findPayout(payoutId: string): Promise<PayoutRecord | undefined>;
  savePayout(record: PayoutRecord): Promise<void>;
  findKyc(promoterId: string): Promise<KycRecord | undefined>;
  saveKyc(record: KycRecord): Promise<void>;
  findPayoutAccount(promoterId: string): Promise<PayoutAccountRecord | undefined>;
  savePayoutAccount(record: PayoutAccountRecord): Promise<void>;
  /** 관제 목록(테넌트를 가리지 않는다) */
  listStatements(filter: { kind?: StatementKind | undefined; status?: string | undefined; pg?: Pg | undefined; pgStore?: PgStore | undefined; payoutDate?: string | undefined; limit: number }): Promise<StatementRecord[]>;
  findProductStatement(promoterId: string, pg: Pg, pgStore: PgStore, periodStart: string, periodEnd: string): Promise<StatementRecord | undefined>;
  // ---- 미수금 상계(settlement §7) ----
  insertReceivable(record: ReceivableRecord): Promise<void>;
  saveReceivable(record: ReceivableRecord): Promise<void>;
  listReceivables(filter: { promoterId?: string | undefined; pg?: Pg | undefined; status?: readonly ReceivableStatus[] | undefined; limit: number }): Promise<ReceivableRecord[]>;
  listOpenReceivables(promoterId: string, pg: Pg): Promise<ReceivableRecord[]>;
  insertReceivableMove(record: ReceivableMoveRecord): Promise<void>;
  listReceivableMoves(statementId: string): Promise<ReceivableMoveRecord[]>;
}

export interface ProductSettlementSource {
  /** core-svc shop의 상품 정산 원천(정산 기준일이 [from, to]에 든 항목). */
  listProductItems(from: string, to: string): Promise<ProductSettlementItem[]>;
}

export interface DueEvent {
  promoterId: string;
  eventId: string;
  endsAt: string;
}

/** 회차 종료 뒤 정산할 회차 목록(core-svc event_sale_config). 스케줄러가 하루 한 번 읽는다. */
export interface DueEventSettlementSource {
  listDue(through: string, limit: number): Promise<DueEvent[]>;
}

/** 회차 수수료율(core-svc 공연 설정·계약). 없으면 정산을 만들지 않는다(A1-H10). */
export interface EventCommissionRateSource {
  rateBp(eventId: string): Promise<number | undefined>;
}

export interface SettlementPaymentSource {
  /** 회차·결제사·결제 상점 결제 원장. 입금 오류 되돌림(FAILED·DEPOSIT_CANCELED)은 뺀다. */
  listEventPayments(eventId: string, pg: Pg, pgStore: PgStore): Promise<PaymentFact[]>;
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
export const SETTLEMENT_PRODUCT_SOURCE = Symbol.for('peaket.settlement.product-source');
export const SETTLEMENT_EVENT_SOURCE = Symbol.for('peaket.settlement.event-source');
export const SETTLEMENT_COMMISSION_SOURCE = Symbol.for('peaket.settlement.commission-source');
export const PAYOUT_GATEWAY = Symbol.for('peaket.settlement.payout-gateway');
export const REAUTH_VERIFIER = Symbol.for('peaket.settlement.reauth-verifier');
