// 정산·지급·KYC Drizzle 저장소(docs/data.md settlement_statement…payout).
import { and, desc, eq, gte, inArray, lt, lte, or, sql } from 'drizzle-orm';
import type { Database } from '@peaket/platform';
import type { StatementFilter, StatementPage, SettlementStore } from '../../domain/ports.js';
import type { DisputeRecord, KycRecord, PayoutAccountRecord, PayoutBatchRecord, PayoutRecord, Pg, PgStore, StatementRecord, StatementSource } from '../../domain/settlement.js';
import { payout, payoutAccount, payoutBatch, sellerKyc, settlementStatement, statementDispute, statementSource } from './schema.js';

const statementRecord = (r: typeof settlementStatement.$inferSelect): StatementRecord => ({
  statementId: r.id,
  promoterId: r.promoterId,
  kind: r.kind as StatementRecord['kind'],
  eventId: r.eventId,
  pg: r.pg as Pg,
  pgStore: r.pgStore as PgStore,
  periodStart: r.periodStart,
  periodEnd: r.periodEnd,
  grossAmount: r.grossAmount,
  refundAmount: r.refundAmount,
  commissionAmount: r.commissionAmount,
  commissionVat: r.commissionVat,
  offsetAmount: r.offsetAmount,
  payoutAmount: r.payoutAmount,
  revision: r.revision,
  supersedesId: r.supersedesId,
  excludedPayments: r.excludedPayments ?? [],
  status: r.status as StatementRecord['status'],
  holdReason: r.holdReason as StatementRecord['holdReason'],
  disputeDueAt: r.disputeDueAt,
  payoutDate: r.payoutDate,
  payoutBankCode: r.payoutBankCode,
  payoutAccountLast4: r.payoutAccountLast4,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

const disputeRecord = (r: typeof statementDispute.$inferSelect): DisputeRecord => ({
  disputeId: r.id,
  statementId: r.statementId,
  reasonCode: r.reasonCode as DisputeRecord['reasonCode'],
  detail: r.detail,
  submittedBy: r.submittedBy,
  submittedAt: r.submittedAt,
  result: r.result as DisputeRecord['result'],
  resolvedAt: r.resolvedAt,
});

const batchRecord = (r: typeof payoutBatch.$inferSelect): PayoutBatchRecord => ({
  batchId: r.id,
  pg: r.pg as Pg,
  pgStore: r.pgStore as PgStore,
  payoutDate: r.payoutDate,
  totalAmount: r.totalAmount,
  statementCount: r.statementCount,
  approvalId: r.approvalId,
  portoneBulkPayoutId: r.portoneBulkPayoutId,
  pgBalanceKrw: r.pgBalanceKrw,
  pgBalanceSource: r.pgBalanceSource as PayoutBatchRecord['pgBalanceSource'],
  pgBalanceObservedAt: r.pgBalanceObservedAt,
  pgBalanceObservedBy: r.pgBalanceObservedBy,
  pgBalanceLedgerKrw: r.pgBalanceLedgerKrw,
  status: r.status as PayoutBatchRecord['status'],
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

const payoutRecord = (r: typeof payout.$inferSelect): PayoutRecord => ({
  payoutId: r.id,
  batchId: r.batchId,
  statementId: r.statementId,
  seq: r.seq,
  amount: r.amount,
  refPayoutId: r.refPayoutId,
  pgPayoutId: r.pgPayoutId,
  status: r.status as PayoutRecord['status'],
  errorCode: r.errorCode,
  pgTransferId: r.pgTransferId,
  transferCheck: r.transferCheck as PayoutRecord['transferCheck'],
  transferCheckedAt: r.transferCheckedAt,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

const encodeCursor = (s: StatementRecord): string => Buffer.from(`${s.createdAt.getTime()}:${s.statementId}`).toString('base64url');
const decodeCursor = (cursor: string): { at: number; id: string } | undefined => {
  try {
    const [at, id] = Buffer.from(cursor, 'base64url').toString('utf8').split(':');
    const n = Number(at);
    return Number.isSafeInteger(n) && id ? { at: n, id } : undefined;
  } catch {
    return undefined;
  }
};

export class DrizzleSettlementStore implements SettlementStore {
  constructor(private readonly db: Database) {}

  async insertStatement(record: StatementRecord, sources: readonly StatementSource[]): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.insert(settlementStatement).values({
        id: record.statementId,
        promoterId: record.promoterId,
        kind: record.kind,
        eventId: record.eventId,
        pg: record.pg,
        pgStore: record.pgStore,
        periodStart: record.periodStart,
        periodEnd: record.periodEnd,
        grossAmount: record.grossAmount,
        refundAmount: record.refundAmount,
        commissionAmount: record.commissionAmount,
        commissionVat: record.commissionVat,
        offsetAmount: record.offsetAmount,
        payoutAmount: record.payoutAmount,
        revision: record.revision,
        supersedesId: record.supersedesId,
        excludedPayments: record.excludedPayments,
        status: record.status,
        holdReason: record.holdReason,
        disputeDueAt: record.disputeDueAt,
        payoutDate: record.payoutDate,
        payoutBankCode: record.payoutBankCode,
        payoutAccountLast4: record.payoutAccountLast4,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      });
      if (sources.length > 0)
        await tx.insert(statementSource).values(sources.map((s) => ({ statementId: s.statementId, sourceId: s.sourceId, kind: s.kind, paymentId: s.paymentId, amount: s.amount })));
    });
  }

  async findStatement(promoterId: string, statementId: string): Promise<StatementRecord | undefined> {
    const rows = await this.db.db.select().from(settlementStatement).where(and(eq(settlementStatement.id, statementId), eq(settlementStatement.promoterId, promoterId))).limit(1);
    return rows[0] ? statementRecord(rows[0]) : undefined;
  }

  async findStatementById(statementId: string): Promise<StatementRecord | undefined> {
    const rows = await this.db.db.select().from(settlementStatement).where(eq(settlementStatement.id, statementId)).limit(1);
    return rows[0] ? statementRecord(rows[0]) : undefined;
  }

  async findEventStatement(promoterId: string, eventId: string, pg: Pg, pgStore: PgStore): Promise<StatementRecord | undefined> {
    const rows = await this.db.db
      .select()
      .from(settlementStatement)
      .where(
        and(
          eq(settlementStatement.promoterId, promoterId),
          eq(settlementStatement.kind, 'EVENT'),
          eq(settlementStatement.eventId, eventId),
          eq(settlementStatement.pg, pg),
          eq(settlementStatement.pgStore, pgStore),
          sql`${settlementStatement.status} <> 'SUPERSEDED'`,
        ),
      )
      .limit(1);
    return rows[0] ? statementRecord(rows[0]) : undefined;
  }

  async listEvent(promoterId: string, eventId: string): Promise<StatementRecord[]> {
    const rows = await this.db.db
      .select()
      .from(settlementStatement)
      .where(and(eq(settlementStatement.promoterId, promoterId), eq(settlementStatement.eventId, eventId), eq(settlementStatement.kind, 'EVENT')))
      .orderBy(desc(settlementStatement.createdAt));
    return rows.map(statementRecord);
  }

  async listProduct(promoterId: string, filter: StatementFilter): Promise<StatementPage> {
    const cursor = filter.cursor ? decodeCursor(filter.cursor) : undefined;
    const conditions = [eq(settlementStatement.promoterId, promoterId), eq(settlementStatement.kind, 'PRODUCT')];
    if (filter.from) conditions.push(gte(settlementStatement.periodStart, filter.from));
    if (filter.to) conditions.push(lte(settlementStatement.periodEnd, filter.to));
    if (filter.pgStore) conditions.push(eq(settlementStatement.pgStore, filter.pgStore));
    if (cursor) conditions.push(or(lt(settlementStatement.createdAt, new Date(cursor.at)), and(eq(settlementStatement.createdAt, new Date(cursor.at)), lt(settlementStatement.id, cursor.id)))!);
    const rows = await this.db.db
      .select()
      .from(settlementStatement)
      .where(and(...conditions))
      .orderBy(desc(settlementStatement.createdAt), desc(settlementStatement.id))
      .limit(filter.limit + 1);
    const items = rows.slice(0, filter.limit).map(statementRecord);
    return { items, nextCursor: rows.length > filter.limit ? encodeCursor(items[items.length - 1]!) : null };
  }

  async saveStatement(record: StatementRecord): Promise<void> {
    await this.db.db
      .update(settlementStatement)
      .set({
        status: record.status,
        holdReason: record.holdReason,
        disputeDueAt: record.disputeDueAt,
        payoutAmount: record.payoutAmount,
        payoutDate: record.payoutDate,
        payoutBankCode: record.payoutBankCode,
        payoutAccountLast4: record.payoutAccountLast4,
        updatedAt: record.updatedAt,
      })
      .where(eq(settlementStatement.id, record.statementId));
  }

  async insertDispute(record: DisputeRecord): Promise<void> {
    await this.db.db.insert(statementDispute).values({
      id: record.disputeId,
      statementId: record.statementId,
      reasonCode: record.reasonCode,
      detail: record.detail,
      submittedBy: record.submittedBy,
      submittedAt: record.submittedAt,
      result: record.result,
      resolvedAt: record.resolvedAt,
    });
  }

  async listDisputes(statementId: string): Promise<DisputeRecord[]> {
    const rows = await this.db.db.select().from(statementDispute).where(eq(statementDispute.statementId, statementId)).orderBy(desc(statementDispute.submittedAt));
    return rows.map(disputeRecord);
  }

  async insertPayoutBatch(record: PayoutBatchRecord): Promise<void> {
    await this.db.db.insert(payoutBatch).values({
      id: record.batchId,
      pg: record.pg,
      pgStore: record.pgStore,
      payoutDate: record.payoutDate,
      totalAmount: record.totalAmount,
      statementCount: record.statementCount,
      approvalId: record.approvalId,
      portoneBulkPayoutId: record.portoneBulkPayoutId,
      pgBalanceKrw: record.pgBalanceKrw,
      pgBalanceSource: record.pgBalanceSource,
      pgBalanceObservedAt: record.pgBalanceObservedAt,
      pgBalanceObservedBy: record.pgBalanceObservedBy,
      pgBalanceLedgerKrw: record.pgBalanceLedgerKrw,
      status: record.status,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    });
  }

  async findPayoutBatch(batchId: string): Promise<PayoutBatchRecord | undefined> {
    const rows = await this.db.db.select().from(payoutBatch).where(eq(payoutBatch.id, batchId)).limit(1);
    return rows[0] ? batchRecord(rows[0]) : undefined;
  }

  async listPayoutBatches(filter: { pg?: Pg | undefined; pgStore?: PgStore | undefined; payoutDate?: string | undefined; status?: readonly string[] | undefined; limit: number }): Promise<PayoutBatchRecord[]> {
    const conditions = [];
    if (filter.pg) conditions.push(eq(payoutBatch.pg, filter.pg));
    if (filter.pgStore) conditions.push(eq(payoutBatch.pgStore, filter.pgStore));
    if (filter.payoutDate) conditions.push(eq(payoutBatch.payoutDate, filter.payoutDate));
    if (filter.status && filter.status.length > 0) conditions.push(inArray(payoutBatch.status, [...filter.status]));
    const rows = await this.db.db
      .select()
      .from(payoutBatch)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(payoutBatch.payoutDate), desc(payoutBatch.createdAt))
      .limit(filter.limit);
    return rows.map(batchRecord);
  }

  async savePayoutBatch(record: PayoutBatchRecord): Promise<void> {
    await this.db.db
      .update(payoutBatch)
      .set({
        status: record.status,
        approvalId: record.approvalId,
        portoneBulkPayoutId: record.portoneBulkPayoutId,
        pgBalanceKrw: record.pgBalanceKrw,
        pgBalanceSource: record.pgBalanceSource,
        pgBalanceObservedAt: record.pgBalanceObservedAt,
        pgBalanceObservedBy: record.pgBalanceObservedBy,
        pgBalanceLedgerKrw: record.pgBalanceLedgerKrw,
        updatedAt: record.updatedAt,
      })
      .where(eq(payoutBatch.id, record.batchId));
  }

  async listConfirmed(pg: Pg, pgStore: PgStore, payoutDate: string): Promise<StatementRecord[]> {
    const rows = await this.db.db
      .select()
      .from(settlementStatement)
      .where(and(eq(settlementStatement.status, 'CONFIRMED'), eq(settlementStatement.pg, pg), eq(settlementStatement.pgStore, pgStore), eq(settlementStatement.payoutDate, payoutDate)))
      .orderBy(settlementStatement.promoterId, settlementStatement.id);
    return rows.map(statementRecord);
  }

  async insertPayouts(records: readonly PayoutRecord[]): Promise<void> {
    if (records.length === 0) return;
    await this.db.db.insert(payout).values(
      records.map((r) => ({
        id: r.payoutId,
        batchId: r.batchId,
        statementId: r.statementId,
        seq: r.seq,
        amount: r.amount,
        refPayoutId: r.refPayoutId,
        pgPayoutId: r.pgPayoutId,
        status: r.status,
        errorCode: r.errorCode,
        pgTransferId: r.pgTransferId,
        transferCheck: r.transferCheck,
        transferCheckedAt: r.transferCheckedAt,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      })),
    );
  }

  async listPayouts(batchId: string): Promise<PayoutRecord[]> {
    const rows = await this.db.db.select().from(payout).where(eq(payout.batchId, batchId)).orderBy(payout.seq);
    return rows.map(payoutRecord);
  }

  async findPayout(payoutId: string): Promise<PayoutRecord | undefined> {
    const rows = await this.db.db.select().from(payout).where(eq(payout.id, payoutId)).limit(1);
    return rows[0] ? payoutRecord(rows[0]) : undefined;
  }

  async savePayout(record: PayoutRecord): Promise<void> {
    await this.db.db
      .update(payout)
      .set({
        pgPayoutId: record.pgPayoutId,
        status: record.status,
        errorCode: record.errorCode,
        pgTransferId: record.pgTransferId,
        transferCheck: record.transferCheck,
        transferCheckedAt: record.transferCheckedAt,
        updatedAt: record.updatedAt,
      })
      .where(eq(payout.id, record.payoutId));
  }

  async findKyc(promoterId: string): Promise<KycRecord | undefined> {
    const rows = await this.db.db.select().from(sellerKyc).where(eq(sellerKyc.promoterId, promoterId)).limit(1);
    const r = rows[0];
    return r
      ? {
          promoterId: r.promoterId,
          status: r.status as KycRecord['status'],
          businessVerified: r.businessVerified,
          representativeVerified: r.representativeVerified,
          verifiedAt: r.verifiedAt,
          source: r.source,
          updatedAt: r.updatedAt,
        }
      : undefined;
  }

  async saveKyc(record: KycRecord): Promise<void> {
    await this.db.db
      .insert(sellerKyc)
      .values({
        promoterId: record.promoterId,
        status: record.status,
        businessVerified: record.businessVerified,
        representativeVerified: record.representativeVerified,
        verifiedAt: record.verifiedAt,
        source: record.source,
        updatedAt: record.updatedAt,
      })
      .onConflictDoUpdate({
        target: sellerKyc.promoterId,
        set: {
          status: record.status,
          businessVerified: record.businessVerified,
          representativeVerified: record.representativeVerified,
          verifiedAt: record.verifiedAt,
          source: record.source,
          updatedAt: record.updatedAt,
        },
      });
  }

  async findPayoutAccount(promoterId: string): Promise<PayoutAccountRecord | undefined> {
    const rows = await this.db.db.select().from(payoutAccount).where(eq(payoutAccount.promoterId, promoterId)).limit(1);
    const r = rows[0];
    return r
      ? {
          promoterId: r.promoterId,
          bankCode: r.bankCode,
          accountLast4: r.accountLast4,
          version: r.version,
          changedAt: r.changedAt,
          holdUntil: r.holdUntil,
          holderVerified: r.holderVerified,
        }
      : undefined;
  }

  async savePayoutAccount(record: PayoutAccountRecord): Promise<void> {
    await this.db.db
      .insert(payoutAccount)
      .values({
        promoterId: record.promoterId,
        bankCode: record.bankCode,
        accountLast4: record.accountLast4,
        version: record.version,
        changedAt: record.changedAt,
        holdUntil: record.holdUntil,
        holderVerified: record.holderVerified,
      })
      .onConflictDoUpdate({
        target: payoutAccount.promoterId,
        set: {
          bankCode: record.bankCode,
          accountLast4: record.accountLast4,
          version: record.version,
          changedAt: record.changedAt,
          holdUntil: record.holdUntil,
          holderVerified: record.holderVerified,
        },
      });
  }
}
