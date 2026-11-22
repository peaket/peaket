// 판매 중지·재개 저장소(ADR-0123, BAT-620 LCH-090). 운영 역할(core_ops) 연결로 쓴다.
// 한 트랜잭션 안에서 공연 행을 FOR NO KEY UPDATE로 잠그고 읽은 뒤 쓴다. 같은 트랜잭션에서 검색 동기화를 부르는 것은 유스케이스(withSearchSync)다.
// 정본 표: docs/data.md production(sale_review·pending_revision), docs/features/transfer-refund.md §2.1.
import type { Database, DbTransaction } from '@peaket/platform';
import { sql } from 'drizzle-orm';
import type { EventStatus, SaleReview } from '../../domain/production.js';
import type { LockedSaleSuspension, SaleSuspensionScope, SaleSuspensionStore, SaleSuspensionWrite } from '../../domain/sale-suspension.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ProductionRow {
  production_id: string;
  sale_review: SaleReview;
  sale_approved_at: Date | string | null;
  suspended_at: Date | string | null;
  suspension_approval_id: string | null;
  suspension_open_event_ids: unknown;
}

interface EventRow {
  event_id: string;
  status: EventStatus;
  open_at: Date | string;
  starts_at: Date | string;
}

const time = (v: Date | string): Date => (v instanceof Date ? v : new Date(v));
const openIds = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

export class DrizzleSaleSuspensionStore implements SaleSuspensionStore<DbTransaction> {
  constructor(private readonly db: Pick<Database, 'transaction'>) {}

  transaction<T>(work: (tx: DbTransaction) => Promise<T>): Promise<T> {
    return this.db.transaction(work);
  }

  async lockByEvent(tx: DbTransaction, eventId: string): Promise<LockedSaleSuspension | undefined> {
    if (!UUID.test(eventId)) return undefined;
    const p = await tx.execute(sql`
      select p.id::text as production_id, p.sale_review, p.sale_approved_at, p.suspended_at,
             p.suspension_approval_id, p.suspension_open_event_ids
        from production p
        join event e on e.production_id = p.id
       where e.id = ${eventId}::uuid
       for no key update of p`);
    const row = p.rows[0] as unknown as ProductionRow | undefined;
    if (!row) return undefined;
    const events = await tx.execute(sql`
      select id::text as event_id, status, open_at, starts_at
        from event
       where production_id = ${row.production_id}::uuid
       order by open_at, id`);
    return {
      productionId: row.production_id,
      saleReview: row.sale_review,
      saleApprovedAt: row.sale_approved_at === null ? null : time(row.sale_approved_at),
      suspendedAt: row.suspended_at === null ? null : time(row.suspended_at),
      suspensionApprovalId: row.suspension_approval_id,
      suspensionOpenEventIds: openIds(row.suspension_open_event_ids),
      events: (events.rows as unknown as EventRow[]).map((e) => ({ eventId: e.event_id, status: e.status, openAt: time(e.open_at), startsAt: time(e.starts_at) })),
    };
  }

  async write(tx: DbTransaction, productionId: string, write: SaleSuspensionWrite): Promise<void> {
    if (write.kind === 'SUSPENDED') {
      await tx.execute(sql`
        update production
           set sale_review = 'SUSPENDED',
               suspended_at = ${write.at}::timestamptz,
               suspension_reason_code = ${write.reasonCode ?? null},
               suspension_reason = ${write.reason ?? null},
               suspension_approval_id = ${write.approvalId},
               suspension_open_event_ids = ${JSON.stringify(write.openEventIds ?? [])}::jsonb,
               pending_revision = null,
               sale_submitted_at = null,
               rejection_reason = null
         where id = ${productionId}::uuid`);
      return;
    }
    // 재개: 마지막 승인본으로 돌아간다. sale_approved_at은 그대로 둔다(공개 여부의 기준).
    await tx.execute(sql`
      update production
         set sale_review = 'APPROVED',
             suspended_at = null,
             suspension_reason_code = null,
             suspension_reason = null,
             suspension_approval_id = null,
             suspension_open_event_ids = null,
             pending_revision = null,
             sale_submitted_at = null,
             rejection_reason = null
       where id = ${productionId}::uuid`);
  }

  async scope(eventId: string): Promise<SaleSuspensionScope | undefined> {
    if (!UUID.test(eventId)) return undefined;
    return this.db.transaction(async (tx) => {
      const p = await tx.execute(sql`
        select p.id::text as production_id, p.sale_review
          from production p
          join event e on e.production_id = p.id
         where e.id = ${eventId}::uuid`);
      const row = p.rows[0] as unknown as Pick<ProductionRow, 'production_id' | 'sale_review'> | undefined;
      if (!row) return undefined;
      const events = await tx.execute(sql`
        select id::text as event_id from event where production_id = ${row.production_id}::uuid and status <> 'CANCELLED' order by open_at, id`);
      return { productionId: row.production_id, saleReview: row.sale_review, eventIds: (events.rows as unknown as { event_id: string }[]).map((e) => e.event_id) };
    });
  }
}
