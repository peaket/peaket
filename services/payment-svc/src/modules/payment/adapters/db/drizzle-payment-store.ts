// 승인 명령 저장소와 결과 조회(docs/data.md §5·§5.1 '승인 명령 접수'·'결제 결과 당기기 서버', BUILD_ORDER PRF-180).
// ConfirmPayment는 핫패스 풀(풀 대기 100ms), BatchGetPayments는 일반 풀을 쓴다(docs/verification.md §4.1). 둘 다 쓰기 인스턴스다.
// 데드라인(docs/api/proto/README.md §2): 플랫폼의 풀 대기 한도는 풀마다 하나라(일반 1초) 호출별로 줄일 수 없다. 그래서 연결을 받은 뒤 남은 시간을 다시 재서,
// 모자라면 아무 문장도 보내지 않고 PaymentDeadlineError를 던지고, 넉넉하면 그 시간으로 문장 시간 한도를 건다(플랫폼 statementTimeoutMs는 연결을 받기 전에 값을 정해 풀 대기를 뺄 수 없다).
import type { Database, DbTransaction } from '@peaket/platform';
import { and, desc, eq, ne, sql } from 'drizzle-orm';
import { type ConfirmPaymentCommand, type ConfirmPaymentRef, type GetPaymentKey, MIN_CALL_REMAINING_MS, PaymentDeadlineError, type PaymentLedgerStatus, type PaymentDetailRow, type PaymentRecord, type PaymentState } from '../../domain/confirm-command.js';
import { confirmIdemKey, type FailureCategory, type PgName } from '../../domain/payment-gateway.js';
import type { CallBudget, NewPaymentValues, PaymentCommandStore, PaymentDetailReader, PaymentStateReader, StoreCommandResult } from '../../domain/ports.js';
import { payment, paymentConfirmJob, paymentEvent } from './schema.js';

/** ConfirmPayment 문장 시간 한도 상한 200ms [가정](데드라인 200ms와 같다, docs/architecture.md §5) */
export const CONFIRM_STATEMENT_TIMEOUT_MS = 200;
/** BatchGetPayments 문장 시간 한도 상한 400ms [가정](데드라인 500ms 안, docs/data.md §5.1) */
export const BATCH_GET_STATEMENT_TIMEOUT_MS = 400;

/** 겹친 쪽이 INSERT 0행을 받은 뒤 다음 문장에서 앞 쪽이 커밋한 행을 읽는 것이 READ COMMITTED에 기댄다. 데이터베이스 기본값에 맡기지 않는다 */
const CONFIRM_TRANSACTION = { isolationLevel: 'read committed' } as const;

/**
 * 트랜잭션 첫 문장으로 문장 시간 한도를 건다(= SET LOCAL statement_timeout. 값을 매개변수로 묶으려 set_config를 쓴다). 값은 min(capMs, 남은 시간)이다.
 * @param startedAt 호출을 시작한 performance.now()(연결을 기다린 시간을 뺀다)
 * @throws PaymentDeadlineError 남은 시간이 MIN_CALL_REMAINING_MS보다 모자람(문장을 보내지 않는다)
 */
export async function armStatementLimit(tx: DbTransaction, capMs: number, budget: CallBudget | undefined, startedAt: number): Promise<void> {
  const leftMs = budget ? budget.remainingMs - (performance.now() - startedAt) : Number.POSITIVE_INFINITY;
  if (leftMs < MIN_CALL_REMAINING_MS) throw new PaymentDeadlineError();
  await tx.execute(sql`select set_config('statement_timeout', ${String(Math.min(capMs, Math.floor(leftMs)))}, true)`);
}

export interface DrizzlePaymentStoreOptions {
  /** 핫패스 풀. 승인 명령 쓰기 */
  readonly database: Database;
  /** 일반 풀(payment-svc-batch). 결과 조회 */
  readonly batchDatabase: Database;
}

/** 원장 칸 셋(토스·시뮬레이터 paymentKey 또는 포트원 paymentId, 포트원 토큰, 포트원 결제 시도 ID. 결제 시도 ID는 승인 검증과 조회 대조에 쓴다, BUILD_ORDER HOT-140 코드 리뷰) */
const refColumnsOf = (ref: ConfirmPaymentRef): { pgPaymentRef: string; pgConfirmToken: string | null; pgTxId: string | null } =>
  ref.kind === 'toss' ? { pgPaymentRef: ref.paymentKey, pgConfirmToken: null, pgTxId: null } : { pgPaymentRef: ref.paymentId, pgConfirmToken: ref.paymentToken, pgTxId: ref.txId };

export class DrizzlePaymentStore implements PaymentCommandStore, PaymentStateReader, PaymentDetailReader {
  constructor(private readonly o: DrizzlePaymentStoreOptions) {}

  async store(command: ConfirmPaymentCommand, values: NewPaymentValues, budget?: CallBudget): Promise<StoreCommandResult> {
    const now = new Date(values.nowMs);
    const startedAt = performance.now();
    return this.o.database.transaction(async (tx) => {
      await armStatementLimit(tx, CONFIRM_STATEMENT_TIMEOUT_MS, budget, startedAt);
      const inserted = await tx
        .insert(payment)
        .values({
          id: values.paymentId,
          orderId: command.orderId,
          eventId: command.eventId,
          attemptId: command.attemptId,
          attemptNo: command.attemptNo,
          pg: command.pg,
          ...refColumnsOf(command.paymentRef),
          amount: command.amount,
          status: 'ACCEPTED',
          idempotencyKey: confirmIdemKey(command.orderId),
          authenticatedAt: new Date(command.authenticatedAtMs),
          ...(command.entryOpensAtMs === undefined ? {} : { entryOpensAt: new Date(command.entryOpensAtMs) }),
          createdAt: now,
          statusChangedAt: now,
        })
        .onConflictDoNothing({ target: payment.orderId })
        .returning({ id: payment.id });

      if (inserted.length === 0) {
        // 겹친 쪽은 앞 쪽이 커밋할 때까지 유일 확인에서 기다렸다가 0행을 받는다. READ COMMITTED의 다음 문장은 커밋된 행을 본다
        const [row] = await tx
          .select({ paymentId: payment.id, orderId: payment.orderId, attemptId: payment.attemptId, pg: payment.pg, amount: payment.amount, status: payment.status, approvedAt: payment.approvedAt, failureCategory: payment.failureCategory })
          .from(payment)
          .where(eq(payment.orderId, command.orderId));
        if (!row) throw new Error('유일 제약에 걸린 결제 행을 읽지 못했다');
        const { approvedAt, failureCategory, ...rest } = row;
        const record: PaymentRecord = {
          ...rest,
          pg: rest.pg as PgName,
          status: rest.status as PaymentLedgerStatus,
          ...(approvedAt ? { approvedAtMs: approvedAt.getTime() } : {}),
          ...(failureCategory ? { failureCategory: failureCategory as FailureCategory } : {}),
        };
        return { kind: 'EXISTING', record };
      }

      await tx.insert(paymentEvent).values({ paymentId: values.paymentId, seq: 1, eventKey: values.eventKey, type: 'ACCEPTED', exported: false, occurredAt: now });
      await tx.insert(paymentConfirmJob).values({ paymentId: values.paymentId, pg: command.pg, nextAttemptAt: now, createdAt: now });
      return { kind: 'CREATED', record: { paymentId: values.paymentId, orderId: command.orderId, attemptId: command.attemptId, pg: command.pg, amount: command.amount, status: 'ACCEPTED' } };
    }, CONFIRM_TRANSACTION);
  }

  async getDetail(key: GetPaymentKey, budget?: CallBudget): Promise<PaymentDetailRow | undefined> {
    const startedAt = performance.now();
    const [r] = await this.o.batchDatabase.transaction(async (tx) => {
      await armStatementLimit(tx, BATCH_GET_STATEMENT_TIMEOUT_MS, budget, startedAt);
      return tx
        .select({
          paymentId: payment.id,
          orderId: payment.orderId,
          pg: payment.pg,
          status: payment.status,
          amount: payment.amount,
          approvedAt: payment.approvedAt,
          bank: payment.virtualAccountBank,
          accountNo: payment.virtualAccountNo,
          dueAt: payment.depositDueAt,
        })
        .from(payment)
        .where(key.kind === 'orderId' ? eq(payment.orderId, key.orderId) : eq(payment.id, key.paymentId));
    });
    if (r === undefined) return undefined;
    return {
      paymentId: r.paymentId,
      orderId: r.orderId,
      pg: r.pg as PgName,
      status: r.status as PaymentLedgerStatus,
      amount: r.amount,
      ...(r.approvedAt ? { approvedAtMs: r.approvedAt.getTime() } : {}),
      ...(r.bank === null ? {} : { virtualAccountBank: r.bank }),
      ...(r.accountNo === null ? {} : { virtualAccountNoSealed: r.accountNo }),
      ...(r.dueAt ? { depositDueAtMs: r.dueAt.getTime() } : {}),
    };
  }

  async batchGet(orderIds: readonly string[], budget?: CallBudget): Promise<PaymentState[]> {
    const startedAt = performance.now();
    const rows = await this.o.batchDatabase.transaction(
      async (tx) => {
        await armStatementLimit(tx, BATCH_GET_STATEMENT_TIMEOUT_MS, budget, startedAt);
        const lastExported = tx
          .select({ eventKey: paymentEvent.eventKey, eventSeq: paymentEvent.seq })
          .from(paymentEvent)
          .where(and(eq(paymentEvent.paymentId, payment.id), eq(paymentEvent.exported, true), ne(paymentEvent.type, 'RESOLVED')))
          .orderBy(desc(paymentEvent.seq))
          .limit(1)
          .as('ev');
        return tx
          .select({
            orderId: payment.orderId,
            paymentId: payment.id,
            pg: payment.pg,
            status: payment.status,
            amount: payment.amount,
            approvedAt: payment.approvedAt,
            failureCategory: payment.failureCategory,
            depositDueAt: payment.depositDueAt,
            eventKey: lastExported.eventKey,
            eventSeq: lastExported.eventSeq,
          })
          .from(payment)
          .leftJoinLateral(lastExported, sql`true`)
          // 배열 하나를 매개변수 하나로 묶는다(sql 조각에 배열을 그대로 넣으면 값마다 펼쳐진다)
          .where(sql`${payment.orderId} = any(${sql.param([...orderIds])}::uuid[])`);
      },
    );
    return rows.map((r) => ({
      orderId: r.orderId,
      paymentId: r.paymentId,
      pg: r.pg as PgName,
      status: r.status as PaymentLedgerStatus,
      amount: r.amount,
      ...(r.approvedAt ? { approvedAtMs: r.approvedAt.getTime() } : {}),
      ...(r.failureCategory ? { failureCategory: r.failureCategory as FailureCategory } : {}),
      ...(r.eventKey !== null && r.eventSeq !== null ? { lastEvent: { eventKey: r.eventKey, eventSeq: r.eventSeq } } : {}),
      ...(r.depositDueAt ? { depositDueAtMs: r.depositDueAt.getTime() } : {}),
    }));
  }
}
