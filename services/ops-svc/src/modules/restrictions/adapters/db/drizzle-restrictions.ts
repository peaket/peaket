// 일반 남용 예매 제한 Drizzle 저장소(F-06-4). 표는 F-04-13 0037의 booking_restriction이고,
// 집행 사본 상태는 approval_request의 restriction_copy_* 칸에 둔다(승인 ID = 제한 ID).
import { and, eq, inArray } from 'drizzle-orm';
import type { Database } from '@peaket/platform';
import { appendAuditIn, type AuditRecord } from '../../../audit/audit.js';
import type { RestrictionRow } from '../../domain/booking-restriction.js';
import type { BookingRestrictionStore } from '../../domain/ports.js';
import { approvalRequest } from '../../../approvals/index.js';
import { bookingRestriction } from './schema.js';

const rowOf = (r: typeof bookingRestriction.$inferSelect, a: typeof approvalRequest.$inferSelect | null): RestrictionRow => ({
  restrictionId: r.id,
  approvalId: a ? r.id : null,
  accountId: r.accountId,
  reasonCode: r.reasonCode,
  fraudCaseId: r.fraudCaseId,
  confirmedBy: r.confirmedBy,
  startsAtMs: r.startsAt.getTime(),
  endsAtMs: r.endsAt.getTime(),
  appealDueAtMs: r.appealDueAt.getTime(),
  status: r.status as RestrictionRow['status'],
  version: Number(r.version),
  deliveryDone: a ? !a.restrictionCopyPending : true,
  copyNextAtMs: a?.restrictionCopyNextAt ? a.restrictionCopyNextAt.getTime() : null,
  copyAttempts: a?.restrictionCopyAttempts ?? 0,
});

export class DrizzleBookingRestrictionStore implements BookingRestrictionStore {
  constructor(private readonly database: Database) {}

  async rows(): Promise<RestrictionRow[]> {
    const result = await this.database.db
      .select({ r: bookingRestriction, a: approvalRequest })
      .from(bookingRestriction)
      .leftJoin(approvalRequest, eq(approvalRequest.id, bookingRestriction.id));
    return result.map(({ r, a }) => rowOf(r, a));
  }

  async find(restrictionId: string): Promise<RestrictionRow | undefined> {
    const result = await this.database.db
      .select({ r: bookingRestriction, a: approvalRequest })
      .from(bookingRestriction)
      .leftJoin(approvalRequest, eq(approvalRequest.id, bookingRestriction.id))
      .where(eq(bookingRestriction.id, restrictionId))
      .limit(1);
    return result[0] ? rowOf(result[0].r, result[0].a) : undefined;
  }

  async findByApproval(approvalId: string): Promise<RestrictionRow | undefined> {
    return this.find(approvalId);
  }

  async insert(row: RestrictionRow, audit?: AuditRecord): Promise<void> {
    await this.database.transaction(async (tx) => {
      await tx.insert(bookingRestriction).values(this.valuesOf(row));
      await tx
        .update(approvalRequest)
        .set({ restrictionCopyPending: !row.deliveryDone, restrictionCopyNextAt: row.copyNextAtMs === null ? null : new Date(row.copyNextAtMs), restrictionCopyAttempts: row.copyAttempts })
        .where(eq(approvalRequest.id, row.restrictionId));
      if (audit) await appendAuditIn(tx, audit);
    });
  }

  async update(row: RestrictionRow, audit?: AuditRecord): Promise<void> {
    await this.database.transaction(async (tx) => {
      await tx
        .update(bookingRestriction)
        .set({ status: row.status, version: row.version })
        .where(and(eq(bookingRestriction.id, row.restrictionId), inArray(bookingRestriction.status, ['ACTIVE', 'LIFTED', 'EXPIRED'])));
      await tx
        .update(approvalRequest)
        .set({ restrictionCopyPending: !row.deliveryDone, restrictionCopyNextAt: row.copyNextAtMs === null ? null : new Date(row.copyNextAtMs), restrictionCopyAttempts: row.copyAttempts })
        .where(eq(approvalRequest.id, row.restrictionId));
      if (audit) await appendAuditIn(tx, audit);
    });
  }

  async seed(row: RestrictionRow): Promise<void> {
    await this.database.db.insert(bookingRestriction).values(this.valuesOf(row)).onConflictDoNothing();
  }

  private valuesOf(row: RestrictionRow) {
    return {
      id: row.restrictionId,
      accountId: row.accountId,
      reasonCode: row.reasonCode,
      fraudCaseId: row.fraudCaseId,
      confirmedBy: row.confirmedBy,
      startsAt: new Date(row.startsAtMs),
      endsAt: new Date(row.endsAtMs),
      appealDueAt: new Date(row.appealDueAtMs),
      status: row.status,
      version: row.version,
    };
  }
}
