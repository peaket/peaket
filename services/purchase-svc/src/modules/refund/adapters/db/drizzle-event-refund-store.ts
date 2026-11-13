// 회차 취소 일괄 환불의 purchase DB 저장소(BAT-425). 요청·진행률과 티켓별 취소 ID·상태를 남긴다.
import { Inject, Injectable } from '@nestjs/common';
import { DATABASE, type Database } from '@peaket/platform';
import { sql } from 'drizzle-orm';
import type {
  EventCancellationRequest,
  EventRefundFault,
  EventRefundItem,
  EventRefundItemStatus,
  EventRefundKind,
  EventRefundProgress,
  EventRefundStatus,
  RefundPgProvider,
} from '../../domain/event-refund.js';
import type { EventRefundStore } from '../../domain/event-refund-ports.js';

interface RequestRow {
  id: string;
  event_id: string;
  kind: string;
  status: string;
  fault: string | null;
  fan_notice_reason: string | null;
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
  };
};

@Injectable()
export class DrizzleEventRefundStore implements EventRefundStore {
  constructor(@Inject(DATABASE) private readonly database: Database) {}

  async find(requestId: string): Promise<EventCancellationRequest | undefined> {
    const r = await this.database.db.execute(sql`select * from event_cancellation_request where id = ${requestId}::uuid`);
    return r.rows[0] ? toRequest(r.rows[0] as unknown as RequestRow) : undefined;
  }

  async create(request: EventCancellationRequest, items: readonly EventRefundItem[]): Promise<EventCancellationRequest> {
    return this.database.transaction(async (tx) => {
      const inserted = await tx.execute(sql`
        insert into event_cancellation_request
          (id, event_id, kind, status, fault, fan_notice_reason, ruled_by, confirmed_by, target_orders, refund_total, compensation_targets, compensation_total, progress, created_at, updated_at)
        values (${request.requestId}::uuid, ${request.eventId}::uuid, ${request.kind}, ${request.status}, ${request.fault ?? null}, ${request.fanNoticeReason ?? null},
                ${request.ruledBy ?? null}, ${request.confirmedBy ?? null}, ${request.targetOrders}, ${request.refundTotal}, ${request.compensationTargets}, ${request.compensationTotal},
                ${JSON.stringify(request.progress)}::jsonb, ${new Date(request.createdAtMs)}::timestamptz, ${new Date(request.updatedAtMs)}::timestamptz)
        on conflict (id) do nothing
        returning *`);
      if (!inserted.rows[0]) {
        const existing = await tx.execute(sql`select * from event_cancellation_request where id = ${request.requestId}::uuid`);
        return toRequest(existing.rows[0] as unknown as RequestRow);
      }
      for (const item of items) {
        await tx.execute(sql`
          insert into event_refund_item (request_id, ticket_id, order_id, cancellation_id, pg, status, attempts, last_error, updated_at)
          values (${item.requestId}::uuid, ${item.ticketId}::uuid, ${item.orderId}::uuid, ${item.cancellationId}::uuid, ${item.pg}, ${item.status}, ${item.attempts}, ${item.lastError ?? null}, ${new Date(request.updatedAtMs)}::timestamptz)
          on conflict (request_id, ticket_id) do nothing`);
      }
      return toRequest(inserted.rows[0] as unknown as RequestRow);
    });
  }

  async update(request: EventCancellationRequest): Promise<void> {
    await this.database.db.execute(sql`
      update event_cancellation_request
         set status = ${request.status}, fault = ${request.fault ?? null}, fan_notice_reason = ${request.fanNoticeReason ?? null},
             ruled_by = ${request.ruledBy ?? null}, confirmed_by = ${request.confirmedBy ?? null}, target_orders = ${request.targetOrders},
             refund_total = ${request.refundTotal}, compensation_targets = ${request.compensationTargets}, compensation_total = ${request.compensationTotal},
             progress = ${JSON.stringify(request.progress)}::jsonb, updated_at = ${new Date(request.updatedAtMs)}::timestamptz
       where id = ${request.requestId}::uuid`);
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

  async updateItem(item: EventRefundItem): Promise<void> {
    await this.database.db.execute(sql`
      update event_refund_item
         set status = ${item.status}, attempts = ${item.attempts}, last_error = ${item.lastError ?? null}, updated_at = now()
       where request_id = ${item.requestId}::uuid and ticket_id = ${item.ticketId}::uuid`);
  }
}
