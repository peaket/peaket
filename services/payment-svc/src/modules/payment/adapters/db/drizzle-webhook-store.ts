// 웹훅 수신 기록의 payment DB 쪽(docs/data.md §5·§5.1 웹훅 줄, docs/features/payment.md §5 '웹훅 받기의 첫 구현', BUILD_ORDER HOT-150). 메서드의 약속은 domain/ports.ts PaymentWebhookStore에 있다.
// '지금'은 받는 쪽이 넘긴 앱 시계다. SQL now()를 쓰지 않는다.
import { type BatchDeleteOptions, type Clock, type Database, type DatabaseOptions, type DbTransaction, deleteInBatches, type MaintenanceTask, type RetentionResult } from '@peaket/platform';
import { sql } from 'drizzle-orm';
import { isLowerUuid, type PaymentLedgerStatus } from '../../domain/confirm-command.js';
import type { PgName } from '../../domain/payment-gateway.js';
import { PG_NAMES } from '../../domain/pg-call-guard.js';
import type { PaymentWebhookStore, WebhookReceiveRequest, WebhookReceiveResult } from '../../domain/ports.js';
import { decideWebhookLedger, WEBHOOK_QUERY_SIGNAL_MIN_INTERVAL_MS, WEBHOOK_RECEIPT_DELETE_BATCH, WEBHOOK_RECEIPT_RETENTION_MS, WEBHOOK_STATEMENT_TIMEOUT_MS, type WebhookLedgerRow } from '../../domain/webhook-receipt.js';

/** 파드마다 웹훅 전용 일반 풀 연결 4개 [가정](docs/verification.md §4.1) */
export const WEBHOOK_DB_MAX = 4;

/** 웹훅 받기의 payment DB 풀 설정: 일반 풀(연결을 1초까지 기다린다)·연결 WEBHOOK_DB_MAX개·이름 payment-svc-webhook(main.ts가 createDatabase에 넘기고 종료 때 닫는다) */
export function webhookDatabaseOptions(url: string): DatabaseOptions {
  return { url, profile: 'general', max: WEBHOOK_DB_MAX, applicationName: 'payment-svc-webhook' };
}

export interface DrizzleWebhookStoreOptions {
  readonly database: Database;
}

const TX = { isolationLevel: 'read committed', statementTimeoutMs: WEBHOOK_STATEMENT_TIMEOUT_MS } as const;

type LedgerRow = { id: string; order_id: string; pg: string; status: string };

const ledgerOf = (row: LedgerRow | undefined): WebhookLedgerRow | undefined => (row === undefined ? undefined : { paymentId: row.id, orderId: row.order_id, pg: row.pg as PgName, status: row.status as PaymentLedgerStatus });

export class DrizzleWebhookStore implements PaymentWebhookStore {
  constructor(private readonly o: DrizzleWebhookStoreOptions) {}

  async receive(request: WebhookReceiveRequest): Promise<WebhookReceiveResult> {
    return this.o.database.transaction(async (tx) => {
      const decision = decideWebhookLedger(await this.#find(tx, request), request.allowedPgs);
      // 서명 없는 경로의 먼저 온 웹훅은 남기지 않는다. 누구나 전송 ID만 바꿔 표를 늘릴 수 있고, 찾을 원장이 없어 나중에 볼 일도 없다
      if (decision.kind === 'LEDGER_NOT_FOUND' && !request.signed) return decision;
      const paymentId = decision.kind === 'QUERY_SIGNAL' || decision.kind === 'STATE_IGNORED' ? decision.paymentId : null;
      const at = new Date(request.nowMs);
      const inserted = await tx.execute(sql`
        insert into webhook_receipt (pg, dedup_key, payment_id, received_at)
        values (${request.pg}, ${request.dedupKey}, ${paymentId}::uuid, ${at}::timestamptz)
        on conflict (pg, dedup_key) do nothing
        returning dedup_key`);
      if (inserted.rows.length === 0) return { kind: 'DUPLICATE' } as const;
      if (decision.kind !== 'QUERY_SIGNAL') return decision;
      // 잡기와 같은 칸만 쓴다. 이미 더 이른 시각이거나 직전 신호·잡기로부터 최소 간격 안이면 그대로 둔다('UNKNOWN'은 부분 인덱스 조건과 맞도록 문장에 그대로 적는다)
      const touchedBefore = new Date(request.nowMs - WEBHOOK_QUERY_SIGNAL_MIN_INTERVAL_MS);
      const updated = await tx.execute(sql`
        update payment set next_query_at = ${at}::timestamptz, query_touched_at = ${at}::timestamptz
        where id = ${decision.paymentId}::uuid and status = 'UNKNOWN' and next_query_at > ${at}::timestamptz
          and (query_touched_at is null or query_touched_at <= ${touchedBefore}::timestamptz)
        returning id`);
      return updated.rows.length === 0 ? ({ kind: 'QUERY_SIGNAL_SKIPPED' } as const) : decision;
    }, TX);
  }

  /** 한 문장으로 찾는다(문장 수가 시간 예산을 정한다). 주문 참조가 먼저다. 결제 참조는 결제사 셋을 모두 찾아(다른 결제사의 참조를 담은 웹훅도 잡는다) 경로가 받는 결제사의 행을 먼저 본다 */
  async #find(tx: DbTransaction, request: WebhookReceiveRequest): Promise<WebhookLedgerRow | undefined> {
    const byOrder = request.orderRef !== undefined && isLowerUuid(request.orderRef) ? sql`order_id = ${request.orderRef}::uuid` : undefined;
    const byRef = request.paymentRef === undefined ? undefined : sql`(pg = any(${sql.param([...PG_NAMES])}::text[]) and pg_payment_ref = ${request.paymentRef})`;
    const where = byOrder !== undefined && byRef !== undefined ? sql`${byOrder} or ${byRef}` : (byOrder ?? byRef);
    if (where === undefined) return undefined;
    const found = await tx.execute(sql`
      select id::text as id, order_id::text as order_id, pg, status from payment
      where ${where}
      order by case when ${byOrder ?? sql`false`} then 0 else 1 end, case when pg = any(${sql.param([...request.allowedPgs])}::text[]) then 0 else 1 end
      limit 1`);
    return ledgerOf(found.rows[0] as LedgerRow | undefined);
  }
}

/**
 * 보관 기한이 지난 수신 기록을 묶음으로 지운다. 멈춤 조건과 묶음 사이 쉬기는 플랫폼 deleteInBatches다(docs/data.md §2 보존 규칙. 기본 키가 복합이라 deleteExpiredRows는 못 쓴다).
 * 안쪽과 바깥쪽 모두 기한 조건을 둔다(지우려던 행이 그 사이 바뀌어도 새 행을 지우지 않는다).
 */
export async function deleteExpiredWebhookReceipts(database: Database, o: BatchDeleteOptions & { readonly clock: Clock; readonly retentionMs?: number }): Promise<RetentionResult> {
  const before = new Date(o.clock.now() - (o.retentionMs ?? WEBHOOK_RECEIPT_RETENTION_MS));
  const { clock, batchSize = WEBHOOK_RECEIPT_DELETE_BATCH, ...pacing } = o;
  return deleteInBatches(
    clock,
    async (batch) => {
      const r = await database.db.execute(sql`
        delete from webhook_receipt
        where received_at <= ${before}::timestamptz and (pg, dedup_key) in (
          select pg, dedup_key from webhook_receipt where received_at <= ${before}::timestamptz order by received_at limit ${batch}::int)`);
      return r.rowCount ?? 0;
    },
    { ...pacing, batchSize },
  );
}

/** 정비 일 webhook-receipts-delete(정비 시간). 다 못 지우고 멈추면(정비 시간 끝, 지키는 선) 실패로 남겨 다음 깨어남에 이어 한다(플랫폼 retentionTask와 같다) */
export function webhookReceiptsDeleteTask(database: Database, clock: Clock, o: { readonly guard?: () => Promise<string | undefined> } = {}): MaintenanceTask {
  return {
    name: 'webhook-receipts-delete',
    when: 'window',
    run: async (signal) => {
      const r = await deleteExpiredWebhookReceipts(database, { clock, signal, guard: o.guard });
      if (r.stopped === 'window' || r.stopped === 'guard') throw new Error(`webhook_receipt 지우기를 멈췄다(${r.stopped}${r.reason ? `: ${r.reason}` : ''}), 지운 ${r.deleted}건`);
      return r;
    },
  };
}
