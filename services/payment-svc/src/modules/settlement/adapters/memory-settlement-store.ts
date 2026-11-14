// 정산 메모리 저장소(단위 시험·개발). Drizzle과 같은 포트를 쓴다.
import type { StatementFilter, StatementPage, SettlementStore } from '../domain/ports.js';
import type { DisputeRecord, KycRecord, PayoutAccountRecord, PayoutBatchRecord, PayoutRecord, Pg, PgStore, ReceivableMoveRecord, ReceivableRecord, StatementRecord, StatementSource } from '../domain/settlement.js';

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
  readonly batches = new Map<string, PayoutBatchRecord>();
  readonly payouts = new Map<string, PayoutRecord>();
  readonly kycs = new Map<string, KycRecord>();
  readonly accounts = new Map<string, PayoutAccountRecord>();
  readonly receivables = new Map<string, ReceivableRecord>();
  readonly receivableMoves: ReceivableMoveRecord[] = [];

  async insertStatement(record: StatementRecord, sources: readonly StatementSource[]) {
    this.statements.set(record.statementId, { ...record, excludedPayments: [...record.excludedPayments] });
    this.sources.set(record.statementId, sources.map((s) => ({ ...s })));
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
  async insertDispute(record: DisputeRecord) {
    this.disputes.set(record.disputeId, record);
  }
  async listDisputes(statementId: string) {
    return [...this.disputes.values()].filter((d) => d.statementId === statementId);
  }
  async insertPayoutBatch(record: PayoutBatchRecord) {
    this.batches.set(record.batchId, record);
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
    return [...this.statements.values()].filter((s) => s.status === 'CONFIRMED' && s.pg === pg && s.pgStore === pgStore && s.payoutDate === payoutDate);
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
    return [...this.receivables.values()].filter((r) => r.promoterId === promoterId && r.pg === pg && r.status === 'OPEN' && r.remaining > 0).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }
  async insertReceivableMove(record: ReceivableMoveRecord) {
    this.receivableMoves.push(record);
  }
  async listReceivableMoves(statementId: string) {
    return this.receivableMoves.filter((m) => m.statementId === statementId);
  }
}
