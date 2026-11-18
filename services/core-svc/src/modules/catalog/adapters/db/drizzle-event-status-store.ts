// 회차 상태 쓰기(core 회차 상태 반영, docs/features/transfer-refund.md §5 'core 반영의 구현에서 정한 것', BUILD_ORDER GAT-110).
// 운영 역할(core_ops) 연결로 쓴다: 테넌트와 관계없는 내부 경로이고(0012 event_ops 정책), event.status 고치기 권한은 0029가 더한다.
// 한 트랜잭션 안에서 회차 행을 FOR UPDATE로 잠그고 읽은 뒤 쓴다. 같은 트랜잭션에서 검색 동기화를 부르는 것은 유스케이스(withSearchSync)다.
import type { Database, DbTransaction } from '@peaket/platform';
import { sql } from 'drizzle-orm';
import type { CoreEventStatus, EventStatusStore, EventStatusWrite, LockedEventStatus } from '../../domain/event-cancellation-status.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class DrizzleEventStatusStore implements EventStatusStore<DbTransaction> {
  constructor(private readonly db: Pick<Database, 'transaction'>) {}

  transaction<T>(work: (tx: DbTransaction) => Promise<T>): Promise<T> {
    return this.db.transaction(work);
  }

  async lock(tx: DbTransaction, eventId: string): Promise<LockedEventStatus | undefined> {
    if (!UUID.test(eventId)) return undefined;
    const r = await tx.execute(sql`
      select production_id::text as production_id, status, starts_at, ends_at, entry_opens_at
        from event where id = ${eventId}::uuid for update`);
    const row = r.rows[0] as { production_id: string; status: CoreEventStatus; starts_at: Date | string; ends_at: Date | string; entry_opens_at: Date | string | null } | undefined;
    if (!row) return undefined;
    return {
      productionId: row.production_id,
      status: row.status,
      startsAt: new Date(row.starts_at),
      endsAt: new Date(row.ends_at),
      ...(row.entry_opens_at !== null ? { entryOpensAt: new Date(row.entry_opens_at) } : {}),
    };
  }

  async write(tx: DbTransaction, eventId: string, next: EventStatusWrite): Promise<void> {
    if (next.status === 'CANCELLED') {
      await tx.execute(sql`update event set status = 'CANCELLED', version = version + 1 where id = ${eventId}::uuid`);
      return;
    }
    await tx.execute(sql`
      update event
         set status = 'POSTPONED',
             starts_at = ${next.startsAt ?? null}::timestamptz,
             ends_at = ${next.endsAt ?? null}::timestamptz,
             entry_opens_at = coalesce(${next.entryOpensAt ?? null}::timestamptz, entry_opens_at),
             version = version + 1
       where id = ${eventId}::uuid`);
  }
}
