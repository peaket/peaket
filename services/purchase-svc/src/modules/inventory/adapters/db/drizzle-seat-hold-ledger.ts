// 홀드 원장 seat_hold 쓰기의 purchase DB 구현(BUILD_ORDER PRF-141, 규칙은 docs/features/seat-hold.md §6 '적재 소비자').
// 사건 하나가 READ COMMITTED 트랜잭션 하나다. 다시 받은 사건은 기본 키 (event_id, seat_id, fencing_token)가 거른다.
// hold_id·purchase_session_id(BUILD_ORDER PRF-143, docs/data.md §4 '다시 만들기 표와 원장 칸')는 행을 넣을 때(HELD, HELD보다 먼저 온 끝 사건) 쓰고,
// 이미 있는 행을 고칠 때는 건드리지 않는다(뒤에 온 HELD가 끝 사건이 쓴 값을 지우지 않는다).
// hold_limit(W9-fix2 HOT-252, docs/features/seat-hold.md §6 '1인 한도 되살리기' 원장)은 HELD만 싣는다. 끝 사건이 먼저 넣은 행은 뒤에 온 HELD가 held_at과 함께 채우고,
// 이미 값이 있으면 덮지 않는다. 1 이상 int4 상한 이하 정수가 아니면 NULL로 넣고 사건은 그대로 적재한다.
import type { Database } from '@peaket/platform';
import { sql } from 'drizzle-orm';
import type { SeatHoldLedger } from '../../domain/ports.js';
import { type LedgerHoldEvent, ledgerHoldLimitOf } from '../../domain/seat-event.js';
import { SALE_UUID_PATTERN } from '../../domain/seat-sale.js';

/** 원장 hold_id(uuid 칸): 없거나 빈 글이면 NULL. 소문자 UUID가 아닌 값도 NULL이다(칸 변환 오류로 적재가 막히지 않게. 다시 만들기는 그 홀드를 되살리지 않는다) */
const holdIdOf = (e: LedgerHoldEvent): string | null => (e.holdId !== undefined && SALE_UUID_PATTERN.test(e.holdId) ? e.holdId : null);
/** 원장 purchase_session_id(text 칸): 없거나 빈 글이면 NULL */
const sessionIdOf = (e: LedgerHoldEvent): string | null => (e.purchaseSessionId ? e.purchaseSessionId : null);
/** 원장 hold_limit(int4 칸): HELD·FAN의 1 이상 int4 상한 이하 정수만, 그 밖은 NULL(CHECK·칸 변환 오류로 적재가 막히지 않게) */
const holdLimitOf = (e: LedgerHoldEvent): number | null => ledgerHoldLimitOf(e.type, e.holdKind, e.holdLimit) ?? null;

export class DrizzleSeatHoldLedger implements SeatHoldLedger {
  constructor(private readonly database: Database) {}

  async apply(e: LedgerHoldEvent): Promise<void> {
    const at = new Date(e.occurredAtMs);
    const expiresAt = new Date(e.expiresAtMs);
    const grant = e.priorityGrantId ?? null;
    const holdId = holdIdOf(e);
    const sessionId = sessionIdOf(e);
    const holdLimit = holdLimitOf(e);
    await this.database.transaction(
      async (tx) => {
        if (e.type !== 'HELD') {
          // 끝 사건: 그 홀드의 행을 그 상태로. 없으면(HELD보다 먼저 옴) 그 상태로 넣고 held_at은 비워 둔다
          await tx.execute(sql`
            insert into seat_hold (event_id, seat_id, account_id, fencing_token, status, kind, priority_grant_id, held_at, expires_at, hold_id, purchase_session_id)
            values (${e.eventId}::uuid, ${e.seatId}::uuid, ${e.accountId}::uuid, ${e.fencingToken}::bigint, ${e.type}, ${e.holdKind}, ${grant}::uuid, null, ${expiresAt}::timestamptz,
                    ${holdId}::uuid, ${sessionId}::text)
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
        // 판매·환불·회수로 끝난 PRIORITY 권리의 늦은 HELD 사건은 HELD로 남기지 않는다(B1-07)
        if (status === 'HELD' && e.holdKind === 'PRIORITY' && grant !== null) {
          const g = await tx.execute(sql`select status from priority_grant where id = ${grant}::uuid`);
          const gs = (g.rows[0] as { status?: string } | undefined)?.status;
          if (gs !== undefined && gs !== 'OFFERED') status = 'RELEASED';
        }
        // 이미 있는 행(끝 사건이 먼저 넣은 행·다시 받은 HELD)은 비어 있는 held_at·hold_limit만 채운다(있는 값은 덮지 않는다)
        await tx.execute(sql`
          insert into seat_hold (event_id, seat_id, account_id, fencing_token, status, kind, priority_grant_id, held_at, expires_at, hold_id, purchase_session_id, hold_limit)
          values (${e.eventId}::uuid, ${e.seatId}::uuid, ${e.accountId}::uuid, ${e.fencingToken}::bigint, ${status}, ${e.holdKind}, ${grant}::uuid, ${at}::timestamptz, ${expiresAt}::timestamptz,
                  ${holdId}::uuid, ${sessionId}::text, ${holdLimit}::integer)
          on conflict (event_id, seat_id, fencing_token) do update
            set held_at = coalesce(seat_hold.held_at, excluded.held_at), hold_limit = coalesce(seat_hold.hold_limit, excluded.hold_limit)
            where seat_hold.held_at is null or (seat_hold.hold_limit is null and excluded.hold_limit is not null)`);
      },
      { isolationLevel: 'read committed' },
    );
  }
}
