// 배상 송금 기록 저장소(payment DB compensation_transfer, BAT-425, ADR-0317).
// compensation_id 유일이라 같은 멱등 키의 다시 부름은 첫 행을 그대로 준다. 계좌는 끝 4자리만 저장한다(POL-014).
// 송금 전에 선점 행(transfer_id = `claim:`…, status REQUESTED)을 유일 인덱스로 잡는다(RV-23): 같은 DB를 보는 두 파드가 겹쳐도
// 한 쪽만 선점하고 포트를 부른다. 포트가 오래 걸려 죽은 선점(포트 호출 전에 프로세스가 죽음)은 30초 [가정] 뒤 넘겨받는다.
import { and, eq, isNull, lt, sql } from 'drizzle-orm';
import { type Clock, type Database, uuidv7 } from '@peaket/platform';
import type { CompensationTransferRecord, CompensationTransferStatus, CompensationTransferStore } from '../../domain/ports.js';
import { compensationTransfer } from './schema.js';

export const COMPENSATION_TRANSFER_STATEMENT_TIMEOUT_MS = 400;
/** 송금 전 선점 행의 transfer_id 접두어(지급대행 ID와 겹치지 않게 예약) */
const CLAIM_PREFIX = 'claim:';
/** 포트 호출 전에 죽은 선점을 다른 요청이 넘겨받는 시간 30초 [가정](포트 기한 5초 [가정]보다 넉넉히 길다) */
export const COMPENSATION_CLAIM_TAKEOVER_MS = 30_000;

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

  /**
   * 송금 전 선점(RV-23). compensation_id 유일 인덱스에 먼저 넣은 쪽만 claimed=true다.
   * 이미 있으면 그 행을 준다(진 쪽은 부르는 쪽이 답을 기다린다). 오래된 선점 행만 넘겨받는다.
   */
  async claim(record: {
    readonly compensationId: string;
    readonly orderId: string;
    readonly accountId: string;
    readonly amount: number;
    readonly accountLast4: string;
    readonly promoterId: string;
    readonly eventId?: string;
  }): Promise<{ readonly record: CompensationTransferRecord; readonly claimed: boolean }> {
    const now = new Date(this.o.clock.now());
    const claimTransferId = `${CLAIM_PREFIX}${uuidv7(this.o.clock)}`;
    const inserted = await this.o.database.db
      .insert(compensationTransfer)
      .values({
        id: uuidv7(this.o.clock),
        compensationId: record.compensationId,
        transferId: claimTransferId,
        orderId: record.orderId,
        accountId: record.accountId,
        promoterId: record.promoterId,
        eventId: record.eventId ?? null,
        amount: record.amount,
        accountLast4: record.accountLast4,
        status: 'REQUESTED',
        failureReason: null,
        receivableId: null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({ target: compensationTransfer.compensationId })
      .returning({ id: compensationTransfer.id });
    if (inserted.length > 0) {
      const row = await this.#required(record.compensationId);
      return { record: row, claimed: true };
    }
    // 포트를 부르기 전에 죽은 선점은 30초 [가정] 뒤 넘겨받는다(실제 지급대행도 compensation_id로 멱등해야 한다, 포트 계약)
    const takenOver = await this.o.database.db
      .update(compensationTransfer)
      .set({
        transferId: claimTransferId,
        orderId: record.orderId,
        accountId: record.accountId,
        promoterId: record.promoterId,
        eventId: record.eventId ?? null,
        amount: record.amount,
        accountLast4: record.accountLast4,
        status: 'REQUESTED',
        failureReason: null,
        receivableId: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(compensationTransfer.compensationId, record.compensationId),
          sql`${compensationTransfer.transferId} like ${`${CLAIM_PREFIX}%`}`,
          lt(compensationTransfer.updatedAt, new Date(now.getTime() - COMPENSATION_CLAIM_TAKEOVER_MS)),
        ),
      )
      .returning({ id: compensationTransfer.id });
    const row = await this.#required(record.compensationId);
    return { record: row, claimed: takenOver.length > 0 };
  }

  /** 선점 행에 포트 답을 쓴다. 그사이 다른 쪽이 먼저 썼으면 그 행을 그대로 준다 */
  async settle(compensationId: string, record: CompensationTransferRecord & { readonly accountLast4: string; readonly promoterId: string; readonly eventId?: string }): Promise<CompensationTransferRecord> {
    const now = new Date(this.o.clock.now());
    await this.o.database.db
      .update(compensationTransfer)
      .set({
        transferId: record.transferId,
        orderId: record.orderId,
        accountId: record.accountId,
        promoterId: record.promoterId,
        eventId: record.eventId ?? null,
        amount: record.amount,
        accountLast4: record.accountLast4,
        status: record.status,
        failureReason: record.failureReason ?? null,
        updatedAt: now,
      })
      // 답을 받기 전 선점 행에만 쓴다. 이미 답이 있는 행은 덮지 않는다
      .where(and(eq(compensationTransfer.compensationId, compensationId), sql`${compensationTransfer.transferId} like ${`${CLAIM_PREFIX}%`}`));
    const saved = await this.#required(compensationId);
    // 다른 파드의 답이 먼저 들어갔으면 그 행을 그대로 준다(같은 멱등 키 = 같은 답)
    return saved;
  }

  async attachReceivable(compensationId: string, receivableId: string): Promise<CompensationTransferRecord> {
    await this.o.database.db
      .update(compensationTransfer)
      .set({ receivableId, updatedAt: new Date(this.o.clock.now()) })
      .where(and(eq(compensationTransfer.compensationId, compensationId), isNull(compensationTransfer.receivableId)));
    return this.#required(compensationId);
  }

  async #required(compensationId: string): Promise<CompensationTransferRecord> {
    const saved = await this.findByCompensationId(compensationId);
    if (saved === undefined) throw new Error('배상 송금 기록을 쓰지 못했습니다');
    return saved;
  }
}
