// 우선 구매 권리 표의 Drizzle 저장소(GAT-135, docs/data.md priority_grant). 판 번호와 상태 전이는 조건부 UPDATE로 지킨다.
import { type Database, type DbTransaction } from '@peaket/platform';
import { sql, type SQL } from 'drizzle-orm';
import { PrioritySeatConflict, type NewPriorityGrant, type PriorityGrant, type PriorityGrantStatus } from '../../domain/priority-grant.js';
import type { PriorityGrantStore } from '../../domain/ports.js';

type Executor = Pick<DbTransaction, 'execute'>;

interface Row {
  id: string;
  event_id: string;
  account_id: string;
  fraud_case_id: string;
  cancelled_ticket_id: string;
  grant_kind: string;
  seat_id: string;
  tier_id: string;
  price: number | string;
  status: string;
  expires_at: Date | string;
  active_order_id: string | null;
  used_order_id: string | null;
  acted_by: string | null;
  withdrawn_by: string | null;
  version: number | string;
  created_at: Date | string;
  updated_at: Date | string;
}

const ms = (v: Date | string): number => new Date(v).getTime();

const grantOf = (r: Row): PriorityGrant => ({
  grantId: r.id,
  eventId: r.event_id,
  accountId: r.account_id,
  fraudCaseId: r.fraud_case_id,
  cancelledTicketId: r.cancelled_ticket_id,
  grantKind: r.grant_kind as PriorityGrant['grantKind'],
  seatId: r.seat_id,
  tierId: r.tier_id,
  price: Number(r.price),
  status: r.status as PriorityGrantStatus,
  expiresAtMs: ms(r.expires_at),
  ...(r.active_order_id !== null ? { activeOrderId: r.active_order_id } : {}),
  ...(r.used_order_id !== null ? { usedOrderId: r.used_order_id } : {}),
  ...(r.acted_by !== null ? { actedBy: r.acted_by } : {}),
  ...(r.withdrawn_by !== null ? { withdrawnBy: r.withdrawn_by } : {}),
  version: Number(r.version),
  createdAtMs: ms(r.created_at),
  updatedAtMs: ms(r.updated_at),
});

const COLUMNS = sql`id, event_id, account_id, fraud_case_id, cancelled_ticket_id, grant_kind, seat_id, tier_id, price, status, expires_at, active_order_id, used_order_id, acted_by, withdrawn_by, version, created_at, updated_at`;

async function one(exec: Executor, q: SQL): Promise<PriorityGrant | undefined> {
  const r = await exec.execute(q);
  const row = r.rows[0] as unknown as Row | undefined;
  return row ? grantOf(row) : undefined;
}

export class DrizzlePriorityGrantStore implements PriorityGrantStore {
  constructor(private readonly database: Database) {}

  findByCancelledTicket(cancelledTicketId: string): Promise<PriorityGrant | undefined> {
    return one(this.database.db, sql`select ${COLUMNS} from priority_grant where cancelled_ticket_id = ${cancelledTicketId}::uuid`);
  }

  find(grantId: string): Promise<PriorityGrant | undefined> {
    return one(this.database.db, sql`select ${COLUMNS} from priority_grant where id = ${grantId}::uuid`);
  }

  async create(input: NewPriorityGrant): Promise<PriorityGrant> {
    return this.database.transaction(async (tx: DbTransaction) => {
      const inserted = await one(
        tx,
        sql`insert into priority_grant (id, event_id, account_id, fraud_case_id, cancelled_ticket_id, grant_kind, seat_id, tier_id, price, status, expires_at, acted_by, version, created_at, updated_at)
            values (${input.grantId}::uuid, ${input.eventId}::uuid, ${input.accountId}::uuid, ${input.fraudCaseId}::uuid, ${input.cancelledTicketId}::uuid,
                    ${input.grantKind}, ${input.seatId}::uuid, ${input.tierId}, ${input.price}::int, 'OFFERED', ${new Date(input.expiresAtMs)}::timestamptz,
                    ${input.actedBy ?? null}, 1, ${new Date(input.nowMs)}::timestamptz, ${new Date(input.nowMs)}::timestamptz)
            on conflict do nothing
            returning ${COLUMNS}`,
      );
      if (inserted) return inserted;
      // 같은 표로 먼저 만든 권리를 돌려준다(멱등)
      const existing = await one(tx, sql`select ${COLUMNS} from priority_grant where cancelled_ticket_id = ${input.cancelledTicketId}::uuid`);
      if (existing) return existing;
      // 같은 좌석에 다른 OFFERED 권리가 먼저 만들어졌다(0020 부분 유일 인덱스). 잡은 보류를 풀고 다음 후보로 간다
      const sameSeat = await one(
        tx,
        sql`select ${COLUMNS} from priority_grant where event_id = ${input.eventId}::uuid and seat_id = ${input.seatId}::uuid and status = 'OFFERED' limit 1`,
      );
      if (sameSeat) throw new PrioritySeatConflict(input.seatId);
      throw new Error('priority_grant를 넣지 못했고 기존 행도 없다');
    });
  }

  async beginOrder(grantId: string, orderId: string, nowMs: number): Promise<boolean> {
    const r = await this.database.db.execute(sql`
      update priority_grant set active_order_id = ${orderId}::uuid, updated_at = ${new Date(nowMs)}::timestamptz
      where id = ${grantId}::uuid and status = 'OFFERED' and active_order_id is null and expires_at > ${new Date(nowMs)}::timestamptz`);
    return (r.rowCount ?? 0) === 1;
  }

  async markUsed(grantId: string, orderId: string, nowMs: number): Promise<PriorityGrant | undefined> {
    return one(
      this.database.db,
      sql`update priority_grant set status = 'USED', used_order_id = ${orderId}::uuid, active_order_id = null, version = version + 1, updated_at = ${new Date(nowMs)}::timestamptz
          where id = ${grantId}::uuid returning ${COLUMNS}`,
    );
  }

  async withdraw(grantId: string, actedBy: string, nowMs: number): Promise<PriorityGrant | undefined> {
    return one(
      this.database.db,
      sql`update priority_grant set status = 'WITHDRAWN', withdrawn_by = ${actedBy}, version = version + 1, updated_at = ${new Date(nowMs)}::timestamptz
          where id = ${grantId}::uuid and status = 'OFFERED' and active_order_id is null returning ${COLUMNS}`,
    );
  }

  async expire(grantId: string, nowMs: number): Promise<PriorityGrant | undefined> {
    return one(
      this.database.db,
      sql`update priority_grant set status = 'EXPIRED', active_order_id = null, version = version + 1, updated_at = ${new Date(nowMs)}::timestamptz
          where id = ${grantId}::uuid and status = 'OFFERED' and active_order_id is null returning ${COLUMNS}`,
    );
  }

  async releaseOrder(grantId: string, orderId: string, nowMs: number): Promise<boolean> {
    const r = await this.database.db.execute(sql`
      update priority_grant set active_order_id = null, updated_at = ${new Date(nowMs)}::timestamptz
      where id = ${grantId}::uuid and status = 'OFFERED' and active_order_id = ${orderId}::uuid`);
    return (r.rowCount ?? 0) === 1;
  }
}
