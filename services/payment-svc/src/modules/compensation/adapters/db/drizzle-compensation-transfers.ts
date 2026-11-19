// 배상 송금 기록 저장소(payment DB compensation_transfer, BAT-425, ADR-0317).
// compensation_id 유일이라 같은 멱등 키의 다시 부름은 첫 행을 그대로 준다. 계좌는 끝 4자리만 저장한다(POL-014).
import { and, eq, isNull } from 'drizzle-orm';
import { type Clock, type Database, uuidv7 } from '@peaket/platform';
import type { CompensationTransferRecord, CompensationTransferStatus, CompensationTransferStore } from '../../domain/ports.js';
import { compensationTransfer } from './schema.js';

export const COMPENSATION_TRANSFER_STATEMENT_TIMEOUT_MS = 400;

export interface DrizzleCompensationTransfersOptions {
  readonly database: Database;
  readonly clock: Clock;
}

const recordOf = (r: typeof compensationTransfer.$inferSelect): CompensationTransferRecord => ({
  transferId: r.transferId,
  compensationId: r.compensationId,
  orderId: r.orderId,
  accountId: r.accountId,
  amount: r.amount,
  status: r.status as CompensationTransferStatus,
  ...(r.failureReason === null ? {} : { failureReason: r.failureReason }),
  accountLast4: r.accountLast4,
  ...(r.receivableId === null ? {} : { receivableId: r.receivableId }),
});

export class DrizzleCompensationTransfers implements CompensationTransferStore {
  constructor(private readonly o: DrizzleCompensationTransfersOptions) {}

  async findByCompensationId(compensationId: string): Promise<CompensationTransferRecord | undefined> {
    const rows = await this.o.database.db.select().from(compensationTransfer).where(eq(compensationTransfer.compensationId, compensationId)).limit(1);
    return rows[0] === undefined ? undefined : recordOf(rows[0]);
  }

  async findByTransferId(transferId: string): Promise<CompensationTransferRecord | undefined> {
    if (transferId === '') return undefined;
    const rows = await this.o.database.db.select().from(compensationTransfer).where(eq(compensationTransfer.transferId, transferId)).limit(1);
    return rows[0] === undefined ? undefined : recordOf(rows[0]);
  }

  async save(record: CompensationTransferRecord & { readonly accountLast4: string; readonly promoterId: string; readonly eventId?: string }): Promise<CompensationTransferRecord> {
    const now = new Date(this.o.clock.now());
    await this.o.database.db
      .insert(compensationTransfer)
      .values({
        id: uuidv7(this.o.clock),
        compensationId: record.compensationId,
        transferId: record.transferId,
        orderId: record.orderId,
        accountId: record.accountId,
        promoterId: record.promoterId,
        eventId: record.eventId ?? null,
        amount: record.amount,
        accountLast4: record.accountLast4,
        status: record.status,
        failureReason: record.failureReason ?? null,
        receivableId: null,
        createdAt: now,
        updatedAt: now,
      })
      // 같은 compensation_id의 겹친 두 요청은 첫 행만 남긴다(0014 유일). 아래 읽기가 그 행을 돌려준다
      .onConflictDoNothing({ target: compensationTransfer.compensationId });
    const saved = await this.findByCompensationId(record.compensationId);
    if (saved === undefined) throw new Error('배상 송금 기록을 쓰지 못했습니다');
    return saved;
  }

  async attachReceivable(compensationId: string, receivableId: string): Promise<CompensationTransferRecord> {
    await this.o.database.db
      .update(compensationTransfer)
      .set({ receivableId, updatedAt: new Date(this.o.clock.now()) })
      .where(and(eq(compensationTransfer.compensationId, compensationId), isNull(compensationTransfer.receivableId)));
    const saved = await this.findByCompensationId(compensationId);
    if (saved === undefined) throw new Error('배상 송금 기록을 찾지 못했습니다');
    return saved;
  }
}
