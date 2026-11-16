// 회차 취소 일괄 환불의 purchase DB 저장소(BAT-425 GAT-120·GAT-130). 요청·진행률과 티켓별 취소 ID·상태·신청·재시도를 남긴다.
// 팬 알림은 항목 상태를 바꾸는 같은 트랜잭션의 Outbox 마지막 문장으로 넣는다(ADR-0116 결정 3).
import { Inject, Injectable } from '@nestjs/common';
import { DATABASE, type Clock, type Database, systemClock, writeOutbox } from '@peaket/platform';
import { sql } from 'drizzle-orm';
import {
  EventRefundActiveConflict,
  type EventCancellationRequest,
  type EventRefundFault,
  type EventRefundItem,
  type EventRefundItemStatus,
  type EventRefundKind,
  type EventRefundProgress,
  type EventRefundStatus,
  type RefundPgProvider,
} from '../../domain/event-refund.js';
import type { EventRefundItemAdder, EventRefundOutboxMessage, EventRefundStore } from '../../domain/event-refund-ports.js';

interface RequestRow {
  id: string;
  event_id: string;
  kind: string;
  status: string;
  fault: string | null;
  fan_notice_reason: string | null;
  postponed_to: Date | string | null;
  refund_window_closes_at: Date | string | null;
  ruled_by: string | null;
  confirmed_by: string | null;
  target_orders: number;
  refund_total: number;
  compensation_targets: number;
  compensation_total: number;
  progress: EventRefundProgress | string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface ItemRow {
  request_id: string;
  ticket_id: string;
  order_id: string;
  cancellation_id: string;
  pg: string;
  status: string;
  attempts: number;
  last_error: string | null;
  applied_at: Date | string | null;
  next_attempt_at: Date | string | null;
  cancellation_status: string | null;
  refund_failed_at: Date | string | null;
}

const toRequest = (r: RequestRow): EventCancellationRequest => ({
  requestId: r.id,
  eventId: r.event_id,
  kind: r.kind as EventRefundKind,
  status: r.status as EventRefundStatus,
  ...(r.fault !== null ? { fault: r.fault as EventRefundFault } : {}),
  ...(r.fan_notice_reason !== null ? { fanNoticeReason: r.fan_notice_reason } : {}),
  ...(r.postponed_to !== null ? { postponedToMs: new Date(r.postponed_to).getTime() } : {}),
  ...(r.refund_window_closes_at !== null ? { refundWindowClosesAtMs: new Date(r.refund_window_closes_at).getTime() } : {}),
  targetOrders: Number(r.target_orders),
  refundTotal: Number(r.refund_total),
  compensationTargets: Number(r.compensation_targets),
  compensationTotal: Number(r.compensation_total),
  progress: typeof r.progress === 'string' ? (JSON.parse(r.progress) as EventRefundProgress) : r.progress,
  ...(r.ruled_by !== null ? { ruledBy: r.ruled_by } : {}),
  ...(r.confirmed_by !== null ? { confirmedBy: r.confirmed_by } : {}),
  createdAtMs: new Date(r.created_at).getTime(),
  updatedAtMs: new Date(r.updated_at).getTime(),
});

const toItem = (r: ItemRow): EventRefundItem => {
  // 환급 재시도 실행기가 order_cancellation을 REFUNDED/실패로 바꾸면 진행률도 그 값을 따른다.
  const status: EventRefundItemStatus =
    r.cancellation_status === 'REFUNDED' ? 'REFUNDED' : r.cancellation_status === 'VOIDED' || r.refund_failed_at !== null ? 'FAILED' : (r.status as EventRefundItemStatus);
  return {
    requestId: r.request_id,
    orderId: r.order_id,
    ticketId: r.ticket_id,
    cancellationId: r.cancellation_id,
    pg: r.pg as RefundPgProvider,
    status,
    attempts: Number(r.attempts),
    ...(r.last_error !== null ? { lastError: r.last_error } : {}),
    ...(r.applied_at !== null ? { appliedAtMs: new Date(r.applied_at).getTime() } : {}),
    ...(r.next_attempt_at !== null ? { nextAttemptAtMs: new Date(r.next_attempt_at).getTime() } : {}),
  };
};

@Injectable()
export class DrizzleEventRefundStore implements EventRefundStore, EventRefundItemAdder {
  private readonly clock: Clock;

  constructor(
    @Inject(DATABASE) private readonly database: Database,
    clock: Clock = systemClock,
  ) {
    this.clock = clock;
  }

  async find(requestId: string): Promise<EventCancellationRequest | undefined> {
    const r = await this.database.db.execute(sql`select * from event_cancellation_request where id = ${requestId}::uuid`);
    return r.rows[0] ? toRequest(r.rows[0] as unknown as RequestRow) : undefined;
  }

  async create(request: EventCancellationRequest, items: readonly EventRefundItem[], outbox: readonly EventRefundOutboxMessage[] = []): Promise<EventCancellationRequest> {
    return this.database.transaction(async (tx) => {
      const inserted = await tx.execute(sql`
        insert into event_cancellation_request
          (id, event_id, kind, status, fault, fan_notice_reason, postponed_to, refund_window_closes_at, ruled_by, confirmed_by, target_orders, refund_total, compensation_targets, compensation_total, progress, created_at, updated_at)
        values (${request.requestId}::uuid, ${request.eventId}::uuid, ${request.kind}, ${request.status}, ${request.fault ?? null}, ${request.fanNoticeReason ?? null},
                ${request.postponedToMs !== undefined ? new Date(request.postponedToMs) : null}::timestamptz,
                ${request.refundWindowClosesAtMs !== undefined ? new Date(request.refundWindowClosesAtMs) : null}::timestamptz,
                ${request.ruledBy ?? null}, ${request.confirmedBy ?? null}, ${request.targetOrders}, ${request.refundTotal}, ${request.compensationTargets}, ${request.compensationTotal},
                ${JSON.stringify(request.progress)}::jsonb, ${new Date(request.createdAtMs)}::timestamptz, ${new Date(request.updatedAtMs)}::timestamptz)
        on conflict do nothing
        returning *`);
      if (!inserted.rows[0]) {
        const existing = await tx.execute(sql`select * from event_cancellation_request where id = ${request.requestId}::uuid`);
        if (existing.rows[0]) return toRequest(existing.rows[0] as unknown as RequestRow);
        // id가 아니라 event_cancellation_active_key(같은 회차의 진행 중 요청)와 부딪혔다. 500이 아니라 409 근거를 준다
        const active = await tx.execute(sql`
          select * from event_cancellation_request
           where event_id = ${request.eventId}::uuid
             and status in ('REQUESTED', 'JUDGED', 'PENDING_APPROVAL', 'APPROVED', 'RUNNING', 'PAUSED', 'REFUND_WINDOW')
           order by created_at limit 1`);
        const row = active.rows[0] as unknown as RequestRow | undefined;
        if (row) throw new EventRefundActiveConflict(row.id, row.event_id);
        throw new Error('event_cancellation_request를 쓰지 못했고 기존 요청도 없다');
      }
      for (const item of items) {
        await tx.execute(sql`
          insert into event_refund_item (request_id, ticket_id, order_id, cancellation_id, pg, status, attempts, last_error, applied_at, next_attempt_at, updated_at)
          values (${item.requestId}::uuid, ${item.ticketId}::uuid, ${item.orderId}::uuid, ${item.cancellationId}::uuid, ${item.pg}, ${item.status}, ${item.attempts}, ${item.lastError ?? null},
                  ${item.appliedAtMs !== undefined ? new Date(item.appliedAtMs) : null}::timestamptz,
                  ${item.nextAttemptAtMs !== undefined ? new Date(item.nextAttemptAtMs) : null}::timestamptz,
                  ${new Date(request.updatedAtMs)}::timestamptz)
          on conflict (request_id, ticket_id) do nothing`);
      }
      if (outbox.length > 0) await writeOutbox(tx, this.clock, outbox.map((m) => ({ topic: m.topic, key: m.key, payload: m.payload })));
      return toRequest(inserted.rows[0] as unknown as RequestRow);
    });
  }

  async update(request: EventCancellationRequest): Promise<void> {
    await this.database.db.execute(sql`
      update event_cancellation_request
         set status = ${request.status}, fault = ${request.fault ?? null}, fan_notice_reason = ${request.fanNoticeReason ?? null},
             postponed_to = ${request.postponedToMs !== undefined ? new Date(request.postponedToMs) : null}::timestamptz,
             refund_window_closes_at = ${request.refundWindowClosesAtMs !== undefined ? new Date(request.refundWindowClosesAtMs) : null}::timestamptz,
             ruled_by = ${request.ruledBy ?? null}, confirmed_by = ${request.confirmedBy ?? null}, target_orders = ${request.targetOrders},
             refund_total = ${request.refundTotal}, compensation_targets = ${request.compensationTargets}, compensation_total = ${request.compensationTotal},
             progress = ${JSON.stringify(request.progress)}::jsonb, updated_at = ${new Date(request.updatedAtMs)}::timestamptz
       where id = ${request.requestId}::uuid`);
  }

  async updateActive(request: EventCancellationRequest): Promise<boolean> {
    const r = await this.database.db.execute(sql`
      update event_cancellation_request
         set status = ${request.status}, fault = ${request.fault ?? null}, fan_notice_reason = ${request.fanNoticeReason ?? null},
             postponed_to = ${request.postponedToMs !== undefined ? new Date(request.postponedToMs) : null}::timestamptz,
             refund_window_closes_at = ${request.refundWindowClosesAtMs !== undefined ? new Date(request.refundWindowClosesAtMs) : null}::timestamptz,
             ruled_by = ${request.ruledBy ?? null}, confirmed_by = ${request.confirmedBy ?? null}, target_orders = ${request.targetOrders},
             refund_total = ${request.refundTotal}, compensation_targets = ${request.compensationTargets}, compensation_total = ${request.compensationTotal},
             progress = ${JSON.stringify(request.progress)}::jsonb, updated_at = ${new Date(request.updatedAtMs)}::timestamptz
       where id = ${request.requestId}::uuid and status in ('RUNNING', 'REFUND_WINDOW')
       returning id`);
    return r.rows.length > 0;
  }

  /**
   * 확정 뒤 끝난 주문의 표 더하기(BAT-420 GAT-110 H, ADR-0280 결정 4). 없는 (요청, 표)만 PENDING으로 더한다((request_id, ticket_id)·cancellation_id 유일).
   * 팬 확정 알림 Outbox는 같은 트랜잭션에, 실제로 더한 항목이 있을 때만 남긴다. 더한 항목을 돌려준다
   */
  async addItems(requestId: string, items: readonly EventRefundItem[], outbox: readonly EventRefundOutboxMessage[] = []): Promise<readonly EventRefundItem[]> {
    return this.database.transaction(async (tx) => {
      const added: EventRefundItem[] = [];
      const nowMs = this.clock.now();
      for (const item of items) {
        const r = await tx.execute(sql`
          insert into event_refund_item (request_id, ticket_id, order_id, cancellation_id, pg, status, attempts, last_error, applied_at, next_attempt_at, updated_at)
          values (${requestId}::uuid, ${item.ticketId}::uuid, ${item.orderId}::uuid, ${item.cancellationId}::uuid, ${item.pg}, ${item.status}, ${item.attempts}, ${item.lastError ?? null},
                  ${item.appliedAtMs !== undefined ? new Date(item.appliedAtMs) : null}::timestamptz,
                  ${item.nextAttemptAtMs !== undefined ? new Date(item.nextAttemptAtMs) : null}::timestamptz,
                  ${new Date(nowMs)}::timestamptz)
          on conflict do nothing
          returning ticket_id`);
        if (r.rows.length > 0) added.push({ ...item, requestId });
      }
      if (added.length > 0 && outbox.length > 0) await writeOutbox(tx, this.clock, outbox.map((m) => ({ topic: m.topic, key: m.key, payload: m.payload })));
      return added;
    });
  }

  async items(requestId: string): Promise<readonly EventRefundItem[]> {
    const r = await this.database.db.execute(sql`
      select i.*, c.status as cancellation_status, c.refund_failed_at
        from event_refund_item i
        left join order_cancellation c on c.id = i.cancellation_id
       where i.request_id = ${requestId}::uuid
       order by i.ticket_id`);
    return (r.rows as unknown as ItemRow[]).map(toItem);
  }

  async updateItem(item: EventRefundItem, outbox: readonly EventRefundOutboxMessage[] = []): Promise<void> {
    await this.database.transaction(async (tx) => {
      await tx.execute(sql`
        update event_refund_item
           set status = ${item.status}, attempts = ${item.attempts}, last_error = ${item.lastError ?? null},
               applied_at = ${item.appliedAtMs !== undefined ? new Date(item.appliedAtMs) : null}::timestamptz,
               next_attempt_at = ${item.nextAttemptAtMs !== undefined ? new Date(item.nextAttemptAtMs) : null}::timestamptz,
               updated_at = now()
         where request_id = ${item.requestId}::uuid and ticket_id = ${item.ticketId}::uuid`);
      if (outbox.length > 0) await writeOutbox(tx, this.clock, outbox.map((m) => ({ topic: m.topic, key: m.key, payload: m.payload })));
    });
  }

  async markApplied(requestId: string, ticketId: string, appliedAtMs: number): Promise<boolean> {
    const r = await this.database.db.execute(sql`
      update event_refund_item
         set applied_at = ${new Date(appliedAtMs)}::timestamptz,
             next_attempt_at = ${new Date(appliedAtMs)}::timestamptz,
             updated_at = now()
       where request_id = ${requestId}::uuid
         and ticket_id = ${ticketId}::uuid
         and applied_at is null
         and status in ('PENDING', 'UNKNOWN')
       returning ticket_id`);
    return r.rows.length > 0;
  }

  async markNotApplied(requestId: string, ticketId: string): Promise<boolean> {
    const r = await this.database.db.execute(sql`
      update event_refund_item
         set status = 'NOT_APPLIED', next_attempt_at = null, updated_at = now()
       where request_id = ${requestId}::uuid
         and ticket_id = ${ticketId}::uuid
         and applied_at is null
         and status <> 'NOT_APPLIED'
       returning ticket_id`);
    return r.rows.length > 0;
  }

  async activeRequests(limit: number): Promise<readonly EventCancellationRequest[]> {
    const r = await this.database.db.execute(sql`
      select * from event_cancellation_request
       where status in ('RUNNING', 'PAUSED', 'REFUND_WINDOW')
       order by updated_at, id
       limit ${limit}`);
    return (r.rows as unknown as RequestRow[]).map(toRequest);
  }

  async dueItems(requestId: string, nowMs: number, limit: number): Promise<readonly EventRefundItem[]> {
    const r = await this.database.db.execute(sql`
      select i.*, c.status as cancellation_status, c.refund_failed_at
        from event_refund_item i
        left join order_cancellation c on c.id = i.cancellation_id
       where i.request_id = ${requestId}::uuid
         and i.status in ('PENDING', 'UNKNOWN')
         and i.applied_at is not null
         and (i.next_attempt_at is null or i.next_attempt_at <= ${new Date(nowMs)}::timestamptz)
       order by i.ticket_id
       limit ${limit}`);
    return (r.rows as unknown as ItemRow[]).map(toItem);
  }

  async dueWindowClosures(nowMs: number, limit: number): Promise<readonly EventCancellationRequest[]> {
    const r = await this.database.db.execute(sql`
      select * from event_cancellation_request
       where kind = 'POSTPONE'
         and status not in ('COMPLETED', 'REJECTED')
         and refund_window_closes_at is not null
         and refund_window_closes_at <= ${new Date(nowMs)}::timestamptz
       order by refund_window_closes_at, id
       limit ${limit}`);
    return (r.rows as unknown as RequestRow[]).map(toRequest);
  }
}
