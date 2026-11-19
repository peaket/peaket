// 배상 행의 purchase DB 어댑터(BAT-425 GAT-130 잔여, ADR-0317, purchase 0030, docs/data.md compensation).
// 목록·상세는 그 주문의 결제자(purchase_order.account_id)가 같은 건만 준다. 같은 목록에서 남의 건과 없는 건은 둘 다 없다(404).
// 계좌는 끝 4자리만 저장하고(계좌번호 원문은 받지 않는다, POL-014), 송금 결과는 ACCOUNT_PENDING일 때만 쓴다.
import { Inject, Injectable } from '@nestjs/common';
import { DATABASE, type Database } from '@peaket/platform';
import { sql } from 'drizzle-orm';
import type { CompensationPage, CompensationRecord, CompensationStatus, CompensationView } from '../../domain/compensation.js';
import type { CompensationStore } from '../../domain/ports.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 목록 커서는 (만든 시각, ID)를 base64url로 감춘 값이다(guidelines §3). 해석할 수 없으면 처음부터 준다 */
const cursorOf = (createdAtMs: number, id: string): string => Buffer.from(`${createdAtMs}:${id}`, 'utf8').toString('base64url');
const afterOf = (cursor: string | undefined): { readonly createdAtMs: number; readonly id: string } | undefined => {
  if (cursor === undefined || cursor === '') return undefined;
  const text = Buffer.from(cursor, 'base64url').toString('utf8');
  const at = text.indexOf(':');
  const createdAtMs = Number(text.slice(0, at));
  const id = text.slice(at + 1);
  if (at <= 0 || !Number.isSafeInteger(createdAtMs) || !UUID.test(id)) return undefined;
  return { createdAtMs, id };
};

interface Row {
  readonly id: string;
  readonly event_cancellation_request_id: string;
  readonly order_id: string;
  readonly event_id: string;
  readonly account_id: string;
  readonly promoter_id: string | null;
  readonly base_amount: number | string;
  readonly amount: number | string;
  readonly status: string;
  readonly account_last4: string | null;
  readonly transfer_id: string | null;
  readonly receivable_id: string | null;
  readonly failure_reason: string | null;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly fault: string | null;
}

const recordOf = (r: Row): CompensationRecord => ({
  compensationId: r.id,
  eventCancellationRequestId: r.event_cancellation_request_id,
  orderId: r.order_id,
  eventId: r.event_id,
  accountId: r.account_id,
  ...(r.promoter_id !== null ? { promoterId: r.promoter_id } : {}),
  baseAmount: Number(r.base_amount),
  amount: Number(r.amount),
  status: r.status as CompensationStatus,
  ...(r.account_last4 !== null ? { accountLast4: r.account_last4 } : {}),
  ...(r.transfer_id !== null ? { transferId: r.transfer_id } : {}),
  ...(r.receivable_id !== null ? { receivableId: r.receivable_id } : {}),
  ...(r.failure_reason !== null ? { failureReason: r.failure_reason } : {}),
  createdAtMs: r.created_at.getTime(),
  updatedAtMs: r.updated_at.getTime(),
});

const viewOf = (r: Row): CompensationView => ({
  compensationId: r.id,
  orderId: r.order_id,
  amount: Number(r.amount),
  status: r.status as CompensationStatus,
  ...(r.account_last4 !== null ? { accountLast4: r.account_last4 } : {}),
  eventId: r.event_id,
  ...(r.fault === 'ORGANIZER' || r.fault === 'CONTENT_CHANGE' ? { reason: r.fault } : {}),
  createdAt: r.created_at.toISOString(),
});

@Injectable()
export class DrizzleCompensations implements CompensationStore {
  constructor(@Inject(DATABASE) private readonly database: Database) {}

  async list(accountId: string, q: { readonly cursor?: string; readonly limit?: number } = {}): Promise<CompensationPage> {
    if (!UUID.test(accountId)) return { items: [], nextCursor: null };
    const limit = Math.min(100, Math.max(1, Math.floor(q.limit ?? 20)));
    const after = afterOf(q.cursor);
    const rows = await this.database.db.execute(sql`
      select c.*, r.fault
        from compensation c
        join purchase_order o on o.id = c.order_id
        left join event_cancellation_request r on r.id = c.event_cancellation_request_id
       where o.account_id = ${accountId}::uuid
         ${after ? sql`and (c.created_at, c.id) < (${new Date(after.createdAtMs)}::timestamptz, ${after.id}::uuid)` : sql``}
       order by c.created_at desc, c.id desc
       limit ${limit + 1}`);
    const all = rows.rows as unknown as Row[];
    const page = all.slice(0, limit);
    const last = page.at(-1);
    return { items: page.map(viewOf), nextCursor: all.length > limit && last ? cursorOf(last.created_at.getTime(), last.id) : null };
  }

  async get(accountId: string, compensationId: string): Promise<CompensationView | undefined> {
    const row = await this.#find(accountId, compensationId);
    return row === undefined ? undefined : viewOf(row);
  }

  async findForAccount(accountId: string, compensationId: string): Promise<CompensationRecord | undefined> {
    const row = await this.#find(accountId, compensationId);
    return row === undefined ? undefined : recordOf(row);
  }

  async saveTransfer(q: {
    readonly compensationId: string;
    readonly status: Exclude<CompensationStatus, 'ACCOUNT_PENDING'>;
    readonly accountLast4: string;
    readonly transferId?: string;
    readonly receivableId?: string;
    readonly failureReason?: string;
    readonly nowMs: number;
  }): Promise<CompensationRecord | undefined> {
    const updated = await this.database.db.execute(sql`
      update compensation
         set status = ${q.status},
             account_last4 = ${q.accountLast4},
             transfer_id = ${q.transferId ?? null},
             receivable_id = ${q.receivableId ?? null},
             failure_reason = ${q.failureReason ?? null},
             updated_at = ${new Date(q.nowMs)}::timestamptz
       where id = ${q.compensationId}::uuid and status = 'ACCOUNT_PENDING'
       returning *`);
    const row = (updated.rows[0] as unknown as Row | undefined) ?? (await this.database.db.execute(sql`select * from compensation where id = ${q.compensationId}::uuid`)).rows[0];
    return row === undefined ? undefined : recordOf(row as unknown as Row);
  }

  async #find(accountId: string, compensationId: string): Promise<Row | undefined> {
    if (!UUID.test(accountId) || !UUID.test(compensationId)) return undefined;
    const rows = await this.database.db.execute(sql`
      select c.*, r.fault
        from compensation c
        join purchase_order o on o.id = c.order_id
        left join event_cancellation_request r on r.id = c.event_cancellation_request_id
       where c.id = ${compensationId}::uuid and o.account_id = ${accountId}::uuid
       limit 1`);
    return rows.rows[0] as unknown as Row | undefined;
  }
}
