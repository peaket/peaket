// 웹훅 수신 기록의 payment DB 쪽(docs/data.md §5·§5.1 웹훅 줄, docs/features/payment.md §5 '웹훅 받기의 첫 구현', BUILD_ORDER HOT-150). 메서드의 약속은 domain/ports.ts PaymentWebhookStore에 있다.
// '지금'은 받는 쪽이 넘긴 앱 시계다. SQL now()를 쓰지 않는다.
import { type BatchDeleteOptions, type Clock, type Database, type DatabaseOptions, type DbTransaction, deleteInBatches, type MaintenanceTask, type RetentionResult } from '@peaket/platform';
import { sql } from 'drizzle-orm';
import { isLowerUuid, type PaymentLedgerStatus } from '../../domain/confirm-command.js';
import type { PgName } from '../../domain/payment-gateway.js';
import { PG_NAMES } from '../../domain/pg-call-guard.js';
import type { PaymentWebhookStore, WebhookReceiveRequest, WebhookReceiveResult } from '../../domain/ports.js';
import { decideDepositCallback, type DepositCallbackJudgement, decideWebhookLedger, WEBHOOK_QUERY_SIGNAL_MIN_INTERVAL_MS, WEBHOOK_RECEIPT_DELETE_BATCH, WEBHOOK_RECEIPT_RETENTION_MS, WEBHOOK_STATEMENT_TIMEOUT_MS, type WebhookLedgerRow, withLateDepositCheck, withReversalCheck } from '../../domain/webhook-receipt.js';

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

type LedgerRow = { id: string; order_id: string; pg: string; status: string; deposit_secret_hash: Uint8Array | null };

const ledgerOf = (row: LedgerRow | undefined): WebhookLedgerRow | undefined =>
  row === undefined
    ? undefined
    : { paymentId: row.id, orderId: row.order_id, pg: row.pg as PgName, status: row.status as PaymentLedgerStatus, ...(row.deposit_secret_hash ? { depositSecretHash: row.deposit_secret_hash } : {}) };

/**
 * 찾은 원장 행으로 할 일과 수신 기록을 쓸지 정한다.
 * 입금 통보는 secret 대조를 지난 뒤에만 쓴다(서명이 없어 위조가 키를 먼저 차지하지 못하게, BUILD_ORDER HOT-151).
 * 그 밖의 웹훅: 서명 없는 경로의 먼저 온 웹훅은 남기지 않는다. 누구나 전송 ID만 바꿔 표를 늘릴 수 있고, 찾을 원장이 없어 나중에 볼 일도 없다
 */
function judge(row: WebhookLedgerRow | undefined, request: WebhookReceiveRequest): DepositCallbackJudgement {
  const reversed = (judged: DepositCallbackJudgement): DepositCallbackJudgement => withReversalCheck(row, request.depositReversed === true, withLateDepositCheck(row, request.depositDone === true, judged));
  if (request.depositSecretHash !== undefined) return reversed(decideDepositCallback(row, request.allowedPgs, request.depositSecretHash));
  const decision = decideWebhookLedger(row, request.allowedPgs, request.signed);
  return reversed({ decision, receipt: !(decision.kind === 'LEDGER_NOT_FOUND' && !request.signed) });
}

export class DrizzleWebhookStore implements PaymentWebhookStore {
  constructor(private readonly o: DrizzleWebhookStoreOptions) {}

  async receive(request: WebhookReceiveRequest): Promise<WebhookReceiveResult> {
    return this.o.database.transaction(async (tx) => {
      const row = await this.#find(tx, request);
      const { decision, receipt } = judge(row, request);
      const at = new Date(request.nowMs);
      if (receipt) {
        const paymentId = decision.kind === 'QUERY_SIGNAL' || decision.kind === 'STATE_IGNORED' || decision.kind === 'LATE_DEPOSIT_CHECK' || decision.kind === 'REVERSAL_CHECK' ? decision.paymentId : null;
        const inserted = await tx.execute(sql`
          insert into webhook_receipt (pg, dedup_key, payment_id, received_at)
          values (${request.pg}, ${request.dedupKey}, ${paymentId}::uuid, ${at}::timestamptz)
          on conflict (pg, dedup_key) do nothing
          returning dedup_key`);
        if (inserted.rows.length === 0) return { kind: 'DUPLICATE' } as const;
      }
      if (decision.kind === 'LATE_DEPOSIT_CHECK') {
        // 결제마다 한 번만 건다. 통보 시각이 차 있으면 이미 건 행이다(토스 경로는 해시를 지운 뒤라 보낸 쪽을 확인할 수 없어 횟수로 묶는다)
        const armed = await tx.execute(sql`
          update payment set next_query_at = ${at}::timestamptz, query_touched_at = ${at}::timestamptz, deposit_notified_at = ${at}::timestamptz
          where id = ${decision.paymentId}::uuid and status = 'FAILED' and deposit_notified_at is null
          returning id`);
        return armed.rows.length === 0 ? ({ kind: 'STATE_IGNORED', paymentId: decision.paymentId, orderId: decision.orderId } as const) : decision;
      }
      if (decision.kind === 'REVERSAL_CHECK') {
        // 통보 시각의 처음 값을 지키고, 5초 간격 안이면 간격이 끝나는 때로 당긴다(수신 기록을 쓴 통보의 신호를 버리지 않는다, BUILD_ORDER HOT-152)
        const armed = await tx.execute(sql`
          update payment
          set next_query_at = least(coalesce(next_query_at, 'infinity'::timestamptz), greatest(${at}::timestamptz, coalesce(query_touched_at + ${WEBHOOK_QUERY_SIGNAL_MIN_INTERVAL_MS}::int * interval '1 millisecond', ${at}::timestamptz))),
              query_attempts = case when deposit_notified_at is null then 0 else query_attempts end,
              overdue_at = case when deposit_notified_at is null then null else overdue_at end,
              deposit_notified_at = coalesce(deposit_notified_at, ${at}::timestamptz)
          where id = ${decision.paymentId}::uuid and status = 'APPROVED'
          returning next_query_at <= ${at}::timestamptz as pulled`);
        return (armed.rows[0] as { pulled?: boolean } | undefined)?.pulled === true ? decision : ({ kind: 'QUERY_SIGNAL_SKIPPED' } as const);
      }
      if (decision.kind !== 'QUERY_SIGNAL') return decision;
      // 보낸 쪽을 확인한 입금 완료 통보: 통보 시각을 남기고(처음 시각을 지킨다), 5초 간격 안이면 간격이 끝나는 때로 당긴다. 신호를 버리면 다음 조회가 기한 + 10분까지 밀린다(코드 리뷰 M3)
      if (request.depositDone === true && receipt && row?.status === 'AWAITING_DEPOSIT') {
        const notified = await tx.execute(sql`
          update payment
          set next_query_at = least(next_query_at, greatest(${at}::timestamptz, query_touched_at + ${WEBHOOK_QUERY_SIGNAL_MIN_INTERVAL_MS}::int * interval '1 millisecond')),
              query_attempts = case when deposit_notified_at is null then 0 else query_attempts end,
              deposit_notified_at = coalesce(deposit_notified_at, ${at}::timestamptz)
          where id = ${decision.paymentId}::uuid and status = 'AWAITING_DEPOSIT'
          returning next_query_at <= ${at}::timestamptz as pulled`);
        return (notified.rows[0] as { pulled?: boolean } | undefined)?.pulled === true ? decision : ({ kind: 'QUERY_SIGNAL_SKIPPED' } as const);
      }
      // 잡기와 같은 칸만 쓴다. 이미 더 이른 시각이거나 직전 신호·잡기로부터 최소 간격 안이면 그대로 둔다(상태 목록은 부분 인덱스 조건과 맞도록 문장에 그대로 적는다)
      const touchedBefore = new Date(request.nowMs - WEBHOOK_QUERY_SIGNAL_MIN_INTERVAL_MS);
      const updated = await tx.execute(sql`
        update payment set next_query_at = ${at}::timestamptz, query_touched_at = ${at}::timestamptz
        where id = ${decision.paymentId}::uuid and status in ('UNKNOWN', 'AWAITING_DEPOSIT') and next_query_at > ${at}::timestamptz
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
      select id::text as id, order_id::text as order_id, pg, status, deposit_secret_hash from payment
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
