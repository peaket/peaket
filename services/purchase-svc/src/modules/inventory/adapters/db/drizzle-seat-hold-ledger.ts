// 홀드 원장 seat_hold 쓰기의 purchase DB 구현(BUILD_ORDER PRF-141, 규칙은 docs/features/seat-hold.md §6 '적재 소비자').
// 사건 하나가 READ COMMITTED 트랜잭션 하나다. 다시 받은 사건은 기본 키 (event_id, seat_id, fencing_token)가 거른다.
import type { Database } from '@peaket/platform';
import { sql } from 'drizzle-orm';
import type { SeatHoldLedger } from '../../domain/ports.js';
import type { LedgerHoldEvent } from '../../domain/seat-event.js';

export class DrizzleSeatHoldLedger implements SeatHoldLedger {
  constructor(private readonly database: Database) {}

  async apply(e: LedgerHoldEvent): Promise<void> {
    const at = new Date(e.occurredAtMs);
    const expiresAt = new Date(e.expiresAtMs);
    const grant = e.priorityGrantId ?? null;
    await this.database.transaction(
      async (tx) => {
        if (e.type !== 'HELD') {
          // 끝 사건: 그 홀드의 행을 그 상태로. 없으면(HELD보다 먼저 옴) 그 상태로 넣고 held_at은 비워 둔다
          await tx.execute(sql`
            insert into seat_hold (event_id, seat_id, account_id, fencing_token, status, kind, priority_grant_id, held_at, expires_at)
            values (${e.eventId}::uuid, ${e.seatId}::uuid, ${e.accountId}::uuid, ${e.fencingToken}::bigint, ${e.type}, ${e.holdKind}, ${grant}::uuid, null, ${expiresAt}::timestamptz)
            on conflict (event_id, seat_id, fencing_token) do update set status = excluded.status`);
          return;
        }
        // HELD: 같은 좌석의 낮은 토큰 HELD 행은 이미 끝난 홀드다(좌석에는 홀드가 하나뿐)
        await tx.execute(sql`
          update seat_hold set status = case when expires_at <= ${at}::timestamptz then 'EXPIRED' else 'RELEASED' end
          where event_id = ${e.eventId}::uuid and seat_id = ${e.seatId}::uuid and status = 'HELD' and fencing_token < ${e.fencingToken}::bigint`);
        // 같은 좌석에 더 높은 토큰 행이 있으면 이 HELD는 늦게 온 것이라 끝 상태로 넣는다
        const newer = await tx.execute(sql`
          select held_at from seat_hold
          where event_id = ${e.eventId}::uuid and seat_id = ${e.seatId}::uuid and fencing_token > ${e.fencingToken}::bigint
          order by fencing_token limit 1`);
        let status = 'HELD';
        if (newer.rows.length > 0) {
          const nextHeldAt = (newer.rows[0] as { held_at: Date | null }).held_at;
          status = nextHeldAt !== null && expiresAt.getTime() <= new Date(nextHeldAt).getTime() ? 'EXPIRED' : 'RELEASED';
        }
        await tx.execute(sql`
          insert into seat_hold (event_id, seat_id, account_id, fencing_token, status, kind, priority_grant_id, held_at, expires_at)
          values (${e.eventId}::uuid, ${e.seatId}::uuid, ${e.accountId}::uuid, ${e.fencingToken}::bigint, ${status}, ${e.holdKind}, ${grant}::uuid, ${at}::timestamptz, ${expiresAt}::timestamptz)
          on conflict (event_id, seat_id, fencing_token) do update set held_at = excluded.held_at where seat_hold.held_at is null`);
      },
      { isolationLevel: 'read committed' },
    );
  }
}
