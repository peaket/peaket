// 회차 취소 요청 중 보류 취소의 환급 미룸 저장소(BAT-420 몫 D, OPEN[45], docs/data.md event_refund_hold, refund.proto SetEventRefundHold).
// 회차 하나에 한 줄이다. 걸기: 줄이 없거나 풀렸거나 기한이 지났으면 새 요청의 줄로 바꾸고, 같은 요청 ID면 기한만 바꾼다(건 시각은 처음 값).
// 다른 요청 ID의 열린 미룸(풀리지 않고 기한 안)이 있으면 ALREADY_EXISTS다. 풀기는 같은 요청 ID의 열린 줄만 released_at을 쓴다.
// 기한 판단은 '기한 = 지금'이면 지난 것으로 본다(집기 SQL의 expires_at > 지금과 같다).
// 걸기·늘리기는 그 요청 ID의 일괄 환불 요청(event_cancellation_request)이 이미 있으면 미룸을 열지 않고 held 거짓을 준다. 확정이 커밋된 뒤 답을 잃은
// ops가 다시 확정할 때 풀린 미룸이 다시 걸려 72시간 뒤 거짓 SEV2가 나지 않게 한다(BAT-420 리뷰 D3, transfer-refund §5 '미룸 풀기'). 회차가 아니라 요청 ID로 본다.
import type { Database } from '@peaket/platform';
import { sql } from 'drizzle-orm';
import { EventRefundHoldError, type EventRefundHoldInput, type EventRefundHoldState } from '../../domain/event-refund-hold.js';
import type { EventRefundHolds } from '../../domain/event-refund-ports.js';

const ms = (v: Date | string): number => new Date(v).getTime();

export class DrizzleEventRefundHolds implements EventRefundHolds {
  constructor(private readonly database: Database) {}

  async set(i: EventRefundHoldInput): Promise<EventRefundHoldState> {
    const now = new Date(i.nowMs);
    if (i.held) {
      if (i.expiresAtMs === undefined) throw new EventRefundHoldError('INVALID', '걸 때는 expires_at이 필요하다');
      const r = await this.database.db.execute(sql`
        insert into event_refund_hold (event_id, cancellation_request_id, held_at, expires_at, released_at)
        select ${i.eventId}::uuid, ${i.cancellationRequestId}::uuid, ${now}::timestamptz, ${new Date(i.expiresAtMs)}::timestamptz, null
         where not exists (select 1 from event_cancellation_request r where r.id = ${i.cancellationRequestId}::uuid)
        on conflict (event_id) do update set
          held_at = case
            when event_refund_hold.cancellation_request_id = excluded.cancellation_request_id and event_refund_hold.released_at is null then event_refund_hold.held_at
            else excluded.held_at end,
          cancellation_request_id = excluded.cancellation_request_id,
          expires_at = excluded.expires_at,
          released_at = null
        where (event_refund_hold.cancellation_request_id = excluded.cancellation_request_id
           or event_refund_hold.released_at is not null
           or event_refund_hold.expires_at <= ${now}::timestamptz)
          and not exists (select 1 from event_cancellation_request r where r.id = excluded.cancellation_request_id)
        returning expires_at`);
      const row = r.rows[0] as { expires_at: Date | string } | undefined;
      if (!row) {
        if (await this.#requestExists(i.cancellationRequestId)) return { held: false };
        throw new EventRefundHoldError('ALREADY_EXISTS', '그 회차에 다른 요청의 미룸이 걸려 있다');
      }
      return { held: true, expiresAtMs: ms(row.expires_at) };
    }
    await this.database.db.execute(sql`
      update event_refund_hold set released_at = ${now}::timestamptz
       where event_id = ${i.eventId}::uuid and cancellation_request_id = ${i.cancellationRequestId}::uuid and released_at is null`);
    const r = await this.database.db.execute(sql`
      select expires_at from event_refund_hold
       where event_id = ${i.eventId}::uuid and released_at is null and expires_at > ${now}::timestamptz`);
    const open = r.rows[0] as { expires_at: Date | string } | undefined;
    return open ? { held: true, expiresAtMs: ms(open.expires_at) } : { held: false };
  }

  /** 그 요청 ID의 일괄 환불 요청이 이미 있는가(확정이 커밋됐다) */
  async #requestExists(requestId: string): Promise<boolean> {
    const r = await this.database.db.execute(sql`select 1 from event_cancellation_request where id = ${requestId}::uuid`);
    return r.rows.length > 0;
  }

  /** 기한이 지났는데(기한 <= 지금) 풀리지 않은 미룸을 풀고 그 줄을 준다. 둘이 같이 돌아도 줄 잠금 건너뛰기와 조건부 갱신으로 한 번만 준다 */
  async releaseExpired(nowMs: number, limit: number): Promise<readonly { eventId: string; cancellationRequestId: string }[]> {
    const now = new Date(nowMs);
    const r = await this.database.db.execute(sql`
      update event_refund_hold set released_at = ${now}::timestamptz
       where event_id in (
               select event_id from event_refund_hold
                where released_at is null and expires_at <= ${now}::timestamptz
                order by expires_at, event_id
                limit ${limit}
                for update skip locked)
         and released_at is null and expires_at <= ${now}::timestamptz
       returning event_id, cancellation_request_id`);
    return (r.rows as { event_id: string; cancellation_request_id: string }[]).map((x) => ({ eventId: x.event_id, cancellationRequestId: x.cancellation_request_id }));
  }
}
