// purchase DB의 우선 구매 권리 표 priority_grant(GAT-135, docs/data.md §2 ERD·§4 열일곱 번째 마이그레이션, ADR-0171, POL-046 ⑦).
// 부정 예매 표 취소의 이의가 인정된 계정에 ops-svc가 GrantPriorityPurchase로 만든다. 표마다 권리 하나(UNIQUE cancelled_ticket_id).
// kind PRIORITY인 seat_hold 행의 priority_grant_id가 이 표를 가리킨다(ops 논리 DB라 외래키 없음).
import { sql } from 'drizzle-orm';
import { bigint, check, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

const at = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const priorityGrant = pgTable(
  'priority_grant',
  {
    id: uuid('id').primaryKey(),
    eventId: uuid('event_id').notNull(),
    accountId: uuid('account_id').notNull(),
    fraudCaseId: uuid('fraud_case_id').notNull(),
    // 되돌리는 취소한 표(ticket 논리 DB라 외래키 없음). 표마다 권리 하나
    cancelledTicketId: uuid('cancelled_ticket_id').notNull(),
    grantKind: text('grant_kind').notNull(),
    // 잡아 둔 좌석(seat_hold kind PRIORITY)
    seatId: uuid('seat_id').notNull(),
    tierId: text('tier_id').notNull(),
    // 원래 표의 가격(원). 이 값으로 주문을 만든다
    price: integer('price').notNull(),
    status: text('status').notNull(),
    // 연 때부터 48시간 [가정]과 입장 시작 가운데 이른 때
    expiresAt: at('expires_at').notNull(),
    // 진행 중인 주문(결제 전·결제 중). 한 권리에 하나만이고 있으면 새 주문은 409다
    activeOrderId: uuid('active_order_id'),
    // USED일 때 결제를 마친 주문
    usedOrderId: uuid('used_order_id'),
    // queue-svc q:prio 사본의 판 번호. 만들 때 1, 회수할 때 1 올린다
    version: bigint('version', { mode: 'number' }).notNull().default(1),
    createdAt: at('created_at').notNull(),
    updatedAt: at('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('priority_grant_cancelled_ticket_key').on(t.cancelledTicketId),
    // 한 계정의 그 회차 권리를 찾는다(입장·주문 확인)
    index('priority_grant_account_event_idx').on(t.accountId, t.eventId),
    check('priority_grant_kind_check', sql`${t.grantKind} in ('SAME_SEAT', 'SAME_TIER')`),
    check('priority_grant_status_check', sql`${t.status} in ('OFFERED', 'USED', 'EXPIRED', 'WITHDRAWN')`),
    check('priority_grant_price_check', sql`${t.price} >= 0`),
    check('priority_grant_version_check', sql`${t.version} >= 1`),
  ],
);
