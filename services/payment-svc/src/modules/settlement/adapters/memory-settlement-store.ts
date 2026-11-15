// 정산 메모리 저장소(단위 시험·개발). Drizzle과 같은 포트를 쓴다.
import type { PayoutBatchAtomicInput, StatementFilter, StatementPage, SettlementStore } from '../domain/ports.js';
import { SettlementProblem, type DisputeRecord, type KycRecord, type PayoutAccountRecord, type PayoutBatchRecord, type PayoutRecord, type Pg, type PgStore, type ReceivableMoveRecord, type ReceivableRecord, type StatementAuditRecord, type StatementRecord, type StatementSource } from '../domain/settlement.js';

const cursorOf = (s: StatementRecord): string => Buffer.from(`${s.createdAt.getTime()}:${s.statementId}`).toString('base64url');
const decodeCursor = (cursor: string): { at: number; id: string } | undefined => {
  try {
    const [at, id] = Buffer.from(cursor, 'base64url').toString('utf8').split(':');
    const n = Number(at);
    return Number.isSafeInteger(n) && id ? { at: n, id } : undefined;
  } catch {
    return undefined;
  }
};

export class MemorySettlementStore implements SettlementStore {
  readonly statements = new Map<string, StatementRecord>();
  readonly sources = new Map<string, StatementSource[]>();
  readonly disputes = new Map<string, DisputeRecord>();
  readonly statementAudits: StatementAuditRecord[] = [];
  readonly batches = new Map<string, PayoutBatchRecord>();
  readonly payouts = new Map<string, PayoutRecord>();
  readonly kycs = new Map<string, KycRecord>();
  readonly accounts = new Map<string, PayoutAccountRecord>();
  readonly receivables = new Map<string, ReceivableRecord>();
  readonly receivableMoves: ReceivableMoveRecord[] = [];

  async insertStatement(record: StatementRecord, sources: readonly StatementSource[]): Promise<boolean> {
    const conflicts = [...this.statements.values()].some((s) => {
      if (s.statementId === record.statementId) return true;
      if (s.status === 'SUPERSEDED' || record.status === 'SUPERSEDED') return false;
      if (s.kind !== record.kind || s.promoterId !== record.promoterId || s.pg !== record.pg || s.pgStore !== record.pgStore) return false;
      if (record.kind === 'EVENT') return s.eventId === record.eventId;
      return s.periodStart === record.periodStart && s.periodEnd === record.periodEnd;
    });
    if (conflicts) return false;
    this.statements.set(record.statementId, { ...record, excludedPayments: [...record.excludedPayments] });
    this.sources.set(record.statementId, sources.map((s) => ({ ...s })));
    return true;
  }
  async findStatement(promoterId: string, statementId: string) {
    const s = this.statements.get(statementId);
    return s?.promoterId === promoterId ? s : undefined;
  }
  async findStatementById(statementId: string) {
    return this.statements.get(statementId);
  }
  async findEventStatement(promoterId: string, eventId: string, pg: Pg, pgStore: PgStore) {
    return [...this.statements.values()].find((s) => s.promoterId === promoterId && s.kind === 'EVENT' && s.eventId === eventId && s.pg === pg && s.pgStore === pgStore && s.status !== 'SUPERSEDED');
  }
  async listEvent(promoterId: string, eventId: string) {
    return [...this.statements.values()].filter((s) => s.promoterId === promoterId && s.eventId === eventId).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }
  async listProduct(promoterId: string, filter: StatementFilter): Promise<StatementPage> {
    const cursor = filter.cursor ? decodeCursor(filter.cursor) : undefined;
    let rows = [...this.statements.values()]
      .filter((s) => s.promoterId === promoterId && s.kind === 'PRODUCT')
      .filter((s) => !filter.from || (s.periodStart !== null && s.periodStart >= filter.from))
      .filter((s) => !filter.to || (s.periodEnd !== null && s.periodEnd <= filter.to))
      .filter((s) => !filter.pgStore || s.pgStore === filter.pgStore)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.statementId.localeCompare(a.statementId));
    if (cursor) rows = rows.filter((s) => s.createdAt.getTime() < cursor.at || (s.createdAt.getTime() === cursor.at && s.statementId < cursor.id));
    const page = rows.slice(0, filter.limit + 1);
    const items = page.slice(0, filter.limit);
    return { items, nextCursor: page.length > filter.limit ? cursorOf(items[items.length - 1]!) : null };
  }
  async saveStatement(record: StatementRecord) {
    this.statements.set(record.statementId, { ...record, excludedPayments: [...record.excludedPayments] });
  }
  async insertStatementAudit(record: StatementAuditRecord) {
    this.statementAudits.push(record);
  }
  async insertDispute(record: DisputeRecord) {
    this.disputes.set(record.disputeId, record);
  }
  async saveDispute(record: DisputeRecord) {
    this.disputes.set(record.disputeId, record);
  }
  async listDisputes(statementId: string) {
    return [...this.disputes.values()].filter((d) => d.statementId === statementId);
  }
  async insertPayoutBatch(record: PayoutBatchRecord) {
    this.batches.set(record.batchId, record);
  }
  async createPayoutBatchWithStatements(record: PayoutBatchRecord, statementIds: readonly string[]) {
    const duplicate = [...this.batches.values()].some((b) => b.pg === record.pg && b.pgStore === record.pgStore && b.payoutDate === record.payoutDate && b.status !== 'COMPLETED' && b.status !== 'PARTIAL_FAILED');
    if (duplicate) throw new SettlementProblem('payout-batch-exists', 409, '이미 지급 묶음이 있습니다');
    const bound: StatementRecord[] = [];
    for (const id of statementIds) {
      const s = this.statements.get(id);
      if (!s || s.status !== 'CONFIRMED' || s.payoutBatchId !== null) throw new SettlementProblem('payout-batch-statement-conflict', 409, '확정 정산서가 아닌 건이 지급 묶음에 섞였습니다');
      bound.push(s);
    }
    this.batches.set(record.batchId, record);
    for (const s of bound) this.statements.set(s.statementId, { ...s, status: 'SCHEDULED', payoutBatchId: record.batchId, updatedAt: record.updatedAt });
  }
  async createPayoutBatchAtomically(input: PayoutBatchAtomicInput) {
    const { batch: record } = input;
    const duplicate = [...this.batches.values()].some((b) => b.pg === record.pg && b.pgStore === record.pgStore && b.payoutDate === record.payoutDate && b.status !== 'COMPLETED' && b.status !== 'PARTIAL_FAILED');
    if (duplicate) throw new SettlementProblem('payout-batch-exists', 409, '이미 지급 묶음이 있습니다');
    for (const u of input.statementUpdates) if (!this.statements.has(u.statementId)) throw new SettlementProblem('payout-batch-statement-conflict', 409, '정산서를 찾지 못했습니다');
    for (const u of input.receivableUpdates) if (!this.receivables.has(u.receivableId)) throw new SettlementProblem('payout-batch-statement-conflict', 409, '미수금을 찾지 못했습니다');
    const bound: StatementRecord[] = [];
    for (const id of input.statementIds) {
      const s = this.statements.get(id);
      if (!s || s.status !== 'CONFIRMED' || s.payoutBatchId !== null) throw new SettlementProblem('payout-batch-statement-conflict', 409, '확정 정산서가 아닌 건이 지급 묶음에 섞였습니다');
      bound.push(s);
    }
    for (const u of input.statementUpdates) {
      const s = this.statements.get(u.statementId)!;
      this.statements.set(u.statementId, { ...s, status: u.status, holdReason: u.holdReason, offsetAmount: u.offsetAmount, payoutAmount: u.payoutAmount, updatedAt: u.updatedAt });
    }
    for (const u of input.receivableUpdates) {
      const r = this.receivables.get(u.receivableId)!;
      const moved = input.receivableMoves.filter((m) => m.receivableId === u.receivableId).reduce((sum, m) => sum + m.amount, 0);
      if (r.remaining !== u.remaining + moved) throw new SettlementProblem('payout-batch-statement-conflict', 409, '미수금 잔액이 다른 지급 묶음과 겹쳤습니다');
      this.receivables.set(u.receivableId, { ...r, remaining: u.remaining, status: u.status, updatedAt: u.updatedAt });
    }
    this.receivableMoves.push(...input.receivableMoves);
    this.batches.set(record.batchId, record);
    for (const s of bound) this.statements.set(s.statementId, { ...this.statements.get(s.statementId)!, status: 'SCHEDULED', payoutBatchId: record.batchId, updatedAt: record.updatedAt });
  }
  async releasePayoutBatch(batchId: string): Promise<boolean> {
    const batch = this.batches.get(batchId);
    if (!batch || (batch.status !== 'PENDING_APPROVAL' && batch.status !== 'APPROVED')) return false;
    if ([...this.payouts.values()].some((p) => p.batchId === batchId)) return false;
    for (const s of this.statements.values()) if (s.payoutBatchId === batchId) this.statements.set(s.statementId, { ...s, payoutBatchId: null, status: 'CONFIRMED' });
    this.batches.delete(batchId);
    return true;
  }
  async findPayoutBatch(batchId: string) {
    return this.batches.get(batchId);
  }
  async listPayoutBatches(filter: { pg?: Pg | undefined; pgStore?: PgStore | undefined; payoutDate?: string | undefined; status?: readonly string[] | undefined; limit: number }) {
    return [...this.batches.values()]
      .filter((b) => !filter.pg || b.pg === filter.pg)
      .filter((b) => !filter.pgStore || b.pgStore === filter.pgStore)
      .filter((b) => !filter.payoutDate || b.payoutDate === filter.payoutDate)
      .filter((b) => !filter.status || filter.status.length === 0 || filter.status.includes(b.status))
      .sort((a, b) => b.payoutDate.localeCompare(a.payoutDate) || b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, filter.limit);
  }
  async savePayoutBatch(record: PayoutBatchRecord) {
    this.batches.set(record.batchId, record);
  }
  async listConfirmed(pg: Pg, pgStore: PgStore, payoutDate: string) {
    return [...this.statements.values()].filter((s) => s.status === 'CONFIRMED' && s.payoutBatchId === null && s.pg === pg && s.pgStore === pgStore && s.payoutDate === payoutDate);
  }
  async listStatementsByBatch(batchId: string) {
    return [...this.statements.values()].filter((s) => s.payoutBatchId === batchId).sort((a, b) => a.promoterId.localeCompare(b.promoterId) || a.statementId.localeCompare(b.statementId));
  }
  async listDueConfirmation(now: Date, limit: number) {
    return [...this.statements.values()]
      .filter((s) => s.status === 'NOTIFIED' && s.disputeDueAt !== null && s.disputeDueAt.getTime() <= now.getTime())
      .sort((a, b) => a.disputeDueAt!.getTime() - b.disputeDueAt!.getTime() || a.statementId.localeCompare(b.statementId))
      .slice(0, limit);
  }
  async insertPayouts(records: readonly PayoutRecord[]) {
    for (const r of records) this.payouts.set(r.payoutId, r);
  }
  async listPayouts(batchId: string) {
    return [...this.payouts.values()].filter((p) => p.batchId === batchId).sort((a, b) => a.seq - b.seq);
  }
  async findPayout(payoutId: string) {
    return this.payouts.get(payoutId);
  }
  async savePayout(record: PayoutRecord) {
    this.payouts.set(record.payoutId, record);
  }
  async findKyc(promoterId: string) {
    return this.kycs.get(promoterId);
  }
  async saveKyc(record: KycRecord) {
    this.kycs.set(record.promoterId, record);
  }
  async findPayoutAccount(promoterId: string) {
    return this.accounts.get(promoterId);
  }
  async savePayoutAccount(record: PayoutAccountRecord) {
    this.accounts.set(record.promoterId, record);
  }
  async listStatements(filter: { kind?: 'EVENT' | 'PRODUCT' | undefined; status?: string | undefined; pg?: Pg | undefined; pgStore?: PgStore | undefined; payoutDate?: string | undefined; limit: number }) {
    return [...this.statements.values()]
      .filter((s) => !filter.kind || s.kind === filter.kind)
      .filter((s) => !filter.status || s.status === filter.status)
      .filter((s) => !filter.pg || s.pg === filter.pg)
      .filter((s) => !filter.pgStore || s.pgStore === filter.pgStore)
      .filter((s) => !filter.payoutDate || s.payoutDate === filter.payoutDate)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.statementId.localeCompare(a.statementId))
      .slice(0, filter.limit);
  }
  async findProductStatement(promoterId: string, pg: Pg, pgStore: PgStore, periodStart: string, periodEnd: string) {
    return [...this.statements.values()].find((s) => s.promoterId === promoterId && s.kind === 'PRODUCT' && s.pg === pg && s.pgStore === pgStore && s.periodStart === periodStart && s.periodEnd === periodEnd && s.status !== 'SUPERSEDED');
  }
  async insertReceivable(record: ReceivableRecord) {
    this.receivables.set(record.receivableId, record);
  }
  async saveReceivable(record: ReceivableRecord) {
    this.receivables.set(record.receivableId, record);
  }
  async listReceivables(filter: { promoterId?: string | undefined; pg?: Pg | undefined; status?: readonly ReceivableRecord['status'][] | undefined; limit: number }) {
    return [...this.receivables.values()]
      .filter((r) => !filter.promoterId || r.promoterId === filter.promoterId)
      .filter((r) => !filter.pg || r.pg === filter.pg)
      .filter((r) => !filter.status || filter.status.includes(r.status))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .slice(0, filter.limit);
  }
  async listOpenReceivables(promoterId: string, pg: Pg) {
    return [...this.receivables.values()]
      .filter((r) => r.promoterId === promoterId && (r.pg === pg || r.cause === 'COMPENSATION_ADVANCE') && r.status === 'OPEN' && r.remaining > 0)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }
  async insertReceivableMove(record: ReceivableMoveRecord) {
    this.receivableMoves.push(record);
  }
  async listReceivableMoves(statementId: string) {
    return this.receivableMoves.filter((m) => m.statementId === statementId);
  }
}
