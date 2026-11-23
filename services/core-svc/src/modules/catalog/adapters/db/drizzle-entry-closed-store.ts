// core-svc 입장 기록 마감 알림 저장소(Drizzle, offline-gate §7.3 'core 알림', F-05-6, O-T29 ③).
// event 행을 잠그고 entry_closed_at이 비었을 때만 그 값과 판매 설정 사본(event_sale_config.payload.entryClosedAtMs)을
// 같은 트랜잭션에 쓴다. 사본의 rev는 올리지 않는다(판매 설정 값이 아니다). 사본 행이 없으면 event 칸만 쓴다.
import { Inject, Injectable } from '@nestjs/common';
import type { Database } from '@peaket/platform';
import { eq, sql } from 'drizzle-orm';
import { ENTRY_ROLE_END_AFTER_ENDS_MS, OPS_DATABASE, type EntryClosedResult, type EntryClosedStore } from '../../domain/sale-config-ports.js';
import { event } from './schema.js';

@Injectable()
export class DrizzleEntryClosedStore implements EntryClosedStore {
  constructor(@Inject(OPS_DATABASE) private readonly database: Database) {}

  async markEntryClosed(eventId: string, closedAtMs: number): Promise<EntryClosedResult> {
    return this.database.transaction(async (tx) => {
      const [row] = await tx.select({ endsAt: event.endsAt, entryClosedAt: event.entryClosedAt }).from(event).where(eq(event.id, eventId)).for('update');
      if (!row) return { status: 'not-found' } as const;
      if (row.entryClosedAt !== null) return { status: 'unchanged', entryClosedAtMs: row.entryClosedAt.getTime() } as const;
      if (closedAtMs < row.endsAt.getTime() + ENTRY_ROLE_END_AFTER_ENDS_MS) return { status: 'too-early' } as const;
      await tx.update(event).set({ entryClosedAt: new Date(closedAtMs) }).where(eq(event.id, eventId));
      // 사본 행이 없으면 아무것도 바뀌지 않는다(만들지 않는다). rev 칸은 그대로다
      await tx.execute(sql`update event_sale_config set payload = payload || jsonb_build_object('entryClosedAtMs', ${closedAtMs}::bigint), updated_at = now() where event_id = ${eventId}`);
      return { status: 'stored', entryClosedAtMs: closedAtMs } as const;
    });
  }
}
