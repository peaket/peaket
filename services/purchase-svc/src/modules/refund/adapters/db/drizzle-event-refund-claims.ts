// 일괄 환불 항목의 주문 단위 잡기·조건부 끝내기(웨이브 끝 리뷰 K2, transfer-refund §5 '일괄 환불 항목의 주인과 겹침 막기', docs/data.md event_refund_item).
// event_refund_item.claim_token·claimed_until(0025)을 쓴다. 같은 요청의 잡기는 요청 행 잠금(for no key update)으로 한 줄로 세워,
// '그 주문의 어떤 항목도 살아 있는 다른 잡기가 없을 때만'을 한 문장(조건부 갱신)으로 판단한다. 잡기 기한은 지금 + 60초 [가정]이고,
// 기한이 지난 잡기(claimed_until <= 지금)는 다른 쪽이 다시 잡는다. 끝내기는 잡기 값이 같고 상태가 PENDING·UNKNOWN일 때만 쓴다(끝난 상태를 덮지 않는다).
// 시험이 Object.create로 감싸 쓰므로 # 비공개 칸을 쓰지 않는다.
import { randomUUID } from 'node:crypto';
import { type Clock, type Database, systemClock } from '@peaket/platform';
import { sql } from 'drizzle-orm';
import { EVENT_REFUND_CLAIM_MS, type EventRefundClaims } from '../../domain/event-refund-ports.js';
import { finishSideWrites, toItem, type ItemRow } from './drizzle-event-refund-store.js';

/** 결제사 열거 값(event_refund_item_pg_check와 같다). 멈춘 결제사 목록을 배열 글로 넘길 때 다른 글이 섞이지 않게 거른다 */
const PGS: ReadonlySet<string> = new Set(['TOSS', 'PORTONE', 'SIMULATOR']);
/** 잡을 수 있는 요청 상태(멈춘 요청·끝난 요청의 항목은 잡지 않는다) */
const RUNNABLE: ReadonlySet<string> = new Set(['RUNNING', 'REFUND_WINDOW']);

interface ProgressShape {
  readonly perPg?: readonly { readonly pg?: unknown; readonly state?: unknown }[];
}

export class DrizzleEventRefundClaims implements EventRefundClaims {
  constructor(
    private readonly database: Database,
    private readonly clock: Clock = systemClock,
  ) {}

  /**
   * 그 요청의 처리할 항목을 주문 limitOrders개까지 잡는다. 잡는 주문: 처리할 항목(PENDING·UNKNOWN, 신청됨, 다음 시각 <= 지금, 그 취소 행이 환급·무효·실패 표시가 아님)이 있고,
   * 그 주문의 어떤 항목도 살아 있는 잡기(claimed_until > 지금)가 없으며, 재시도를 기다리는 결과 모름 항목(다음 시각 > 지금)이 없고(리뷰 B4), 결제사가 멈추지 않은 것.
   * 잡은 주문의 처리할 항목에 같은 잡기 값을 쓰고 그 항목을 주문·표 순으로 준다
   */
  async claimOrders(requestId: string, nowMs: number, limitOrders: number): ReturnType<EventRefundClaims['claimOrders']> {
    const claimToken = randomUUID();
    if (!(Number.isInteger(limitOrders) && limitOrders > 0)) return { claimToken, items: [] };
    const now = new Date(nowMs);
    const until = new Date(nowMs + EVENT_REFUND_CLAIM_MS);
    return this.database.transaction(async (tx) => {
      // 같은 요청의 잡기를 한 줄로 세운다(아래 '살아 있는 다른 잡기 없음' 판단이 먼저 커밋한 잡기를 본다)
      const head = await tx.execute(sql`select status, progress from event_cancellation_request where id = ${requestId}::uuid for no key update`);
      const request = head.rows[0] as { status: string; progress: ProgressShape | string | null } | undefined;
      if (!request || !RUNNABLE.has(request.status)) return { claimToken, items: [] };
      const progress = (typeof request.progress === 'string' ? JSON.parse(request.progress) : request.progress) as ProgressShape | null;
      const paused = (progress?.perPg ?? []).flatMap((p) => (p.state === 'PAUSED' && typeof p.pg === 'string' && PGS.has(p.pg) ? [p.pg] : []));
      const pausedList = `{${paused.join(',')}}`;
      const r = await tx.execute(sql`
        with picked as (
          select d.order_id
            from event_refund_item d
            left join order_cancellation c on c.id = d.cancellation_id
           where d.request_id = ${requestId}::uuid
             and d.status in ('PENDING', 'UNKNOWN')
             and d.applied_at is not null
             and (d.next_attempt_at is null or d.next_attempt_at <= ${now}::timestamptz)
             and (c.id is null or (c.status not in ('REFUNDED', 'VOIDED') and c.refund_failed_at is null))
             and d.pg <> all(${pausedList}::text[])
             and not exists (
               select 1 from event_refund_item o
                where o.request_id = d.request_id and o.order_id = d.order_id
                  and o.claim_token is not null and o.claimed_until > ${now}::timestamptz)
             and not exists (
               select 1 from event_refund_item w
                where w.request_id = d.request_id and w.order_id = d.order_id
                  and w.status = 'UNKNOWN' and w.next_attempt_at > ${now}::timestamptz)
           group by d.order_id
           order by min(d.ticket_id::text), d.order_id
           limit ${limitOrders}
        ), claimed as (
          update event_refund_item i
             set claim_token = ${claimToken}::uuid, claimed_until = ${until}::timestamptz
            from picked
           where i.request_id = ${requestId}::uuid
             and i.order_id = picked.order_id
             and i.status in ('PENDING', 'UNKNOWN')
             and i.applied_at is not null
             and (i.next_attempt_at is null or i.next_attempt_at <= ${now}::timestamptz)
             and (i.claim_token is null or i.claimed_until <= ${now}::timestamptz)
             and i.pg <> all(${pausedList}::text[])
             and not exists (
               select 1 from order_cancellation x
                where x.id = i.cancellation_id and (x.status in ('REFUNDED', 'VOIDED') or x.refund_failed_at is not null))
          returning i.*
        )
        select claimed.*, c.status as cancellation_status, c.refund_failed_at
          from claimed
          left join order_cancellation c on c.id = claimed.cancellation_id
         order by claimed.order_id, claimed.ticket_id`);
      return { claimToken, items: (r.rows as unknown as ItemRow[]).map(toItem) };
    });
  }

  /**
   * 잡기 값이 같고 끝나지 않은 항목만 쓴다. 0행이면 false이고 Outbox·취소 행 표시도 남기지 않는다(같은 트랜잭션).
   * FAILED로 끝내며 failureCase가 있으면 같은 문장에서 일괄 환불 실패 건을 열 대상(failure_case_at)으로 표시한다(다시 보기 2 N2)
   */
  async finish(q: Parameters<EventRefundClaims['finish']>[0]): Promise<boolean> {
    return this.database.transaction(async (tx) => {
      const failureCaseAt = q.failureCase === true && q.status === 'FAILED' ? new Date(this.clock.now()) : null;
      const updated = await tx.execute(sql`
        update event_refund_item
           set status = ${q.status}, attempts = ${q.attempts}, last_error = ${q.lastError ?? null},
               next_attempt_at = ${q.nextAttemptAtMs !== undefined ? new Date(q.nextAttemptAtMs) : null}::timestamptz,
               failure_case_at = coalesce(failure_case_at, ${failureCaseAt}::timestamptz),
               updated_at = now()
         where request_id = ${q.requestId}::uuid and ticket_id = ${q.ticketId}::uuid
           and claim_token = ${q.claimToken}::uuid
           and status in ('PENDING', 'UNKNOWN')
         returning cancellation_id`);
      const row = updated.rows[0] as { cancellation_id: string } | undefined;
      if (!row) return false;
      await finishSideWrites(tx, this.clock, {
        requestId: q.requestId,
        cancellationId: row.cancellation_id,
        ...(q.outbox ? { outbox: q.outbox } : {}),
        ...(q.cancellationFailure ? { cancellationFailure: q.cancellationFailure } : {}),
        ...(q.deductionGap ? { deductionGap: q.deductionGap } : {}),
      });
      return true;
    });
  }

  /** 그 잡기 값의 남은 잡기를 푼다(처리하지 않은 항목을 다른 쪽이 기한을 기다리지 않고 잡게) */
  async release(requestId: string, claimToken: string): Promise<void> {
    await this.database.db.execute(sql`
      update event_refund_item set claim_token = null, claimed_until = null
       where request_id = ${requestId}::uuid and claim_token = ${claimToken}::uuid`);
  }
}
