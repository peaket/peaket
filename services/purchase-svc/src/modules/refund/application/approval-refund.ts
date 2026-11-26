// 승인된 예외 환불 실행(F-06-3 R-T26, transfer-refund §3.2·§7.2, POL-038 ①②⑧).
// ops가 승인 ID를 멱등키로 부른다. 시스템 잘못 환불은 EXCEPTION·공제 0원 전액, 재량 면제는 부분 환급만,
// 미성년 계약 취소는 MINOR_CONTRACT_CANCEL·공제 0원 전액이며 입장 시작·입장 기록이 있으면 거절한다.
import { ProblemError, type Clock } from '@peaket/platform';
import type { CancellationOrders, CancellationWrites, ApprovalEntryRecords, PaymentCancellations, TicketCancellations } from '../domain/ports.js';
import type { CancellationReason } from '../domain/cancellation.js';

export type ApprovalRefundKind = 'SYSTEM_FAULT_REFUND' | 'DISCRETIONARY_WAIVER' | 'MINOR_CONTRACT_CANCEL';
export type ApprovalRefundStatus = 'REFUNDED' | 'REFUND_PENDING' | 'REQUESTED';
export interface ApprovalRefundResult {
  status: ApprovalRefundStatus;
  cancellationId: string;
  refundAmount: number;
}
export interface ApprovalRefundInput {
  kind: ApprovalRefundKind;
  orderId: string;
  amount: number;
  reasonText?: string;
}

export class ApprovalRefundProblem extends Error {
  constructor(
    readonly type: string,
    readonly status: number,
    readonly title: string,
  ) {
    super(title);
    this.name = 'ApprovalRefundProblem';
  }
}

export interface ApprovalRefundDeps {
  readonly orders: CancellationOrders;
  readonly writes: CancellationWrites;
  readonly tickets: TicketCancellations;
  readonly payments: PaymentCancellations;
  readonly entryRecords?: ApprovalEntryRecords;
  readonly clock: Clock;
}

const guard = async <T>(fn: () => Promise<T>): Promise<T> => {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ApprovalRefundProblem) throw new ProblemError({ type: e.type, status: e.status, title: e.title });
    throw e;
  }
};
const DEADLINE_MS = 300_000;

export class ApprovalRefunds {
  readonly #kinds = new Map<string, ApprovalRefundKind>();

  constructor(private readonly d: ApprovalRefundDeps) {}

  async execute(approvalId: string, input: ApprovalRefundInput): Promise<ApprovalRefundResult> {
    return guard(async () => {
      const existing = await this.d.orders.findCancellation(approvalId);
      if (existing) {
        const known = existing.kind ?? this.#kinds.get(approvalId);
        if (existing.orderId !== input.orderId || existing.refundAmount !== input.amount || (known !== undefined && known !== input.kind)) throw new ApprovalRefundProblem('approval-refund-conflict', 409, '같은 승인 ID에 다른 환불 요청이 왔습니다');
        return { status: existing.state === 'REFUNDED' ? 'REFUNDED' : existing.state === 'REQUESTED' ? 'REQUESTED' : 'REFUND_PENDING', cancellationId: existing.cancellationId, refundAmount: existing.refundAmount };
      }
      const orders = (await (this.d.orders.byOrder ? this.d.orders.byOrder(input.orderId) : Promise.resolve([]))) ?? [];
      if (orders.length === 0) throw new ApprovalRefundProblem('not-found', 404, '주문을 찾지 못했습니다');
      const order = orders[0]!;
      if (order.orderStatus === 'REFUNDED' || order.orderStatus === 'CANCELED' || order.orderStatus === 'CANCELLED') {
        throw new ApprovalRefundProblem('approval-refund-conflict', 409, '이미 환급·취소된 주문입니다');
      }
      const tickets = new Set(orders.map((o) => o.ticketId));
      const prior = (await this.d.orders.cancellationsOf?.(input.orderId)) ?? [];
      if (prior.some((c) => tickets.has(c.ticketId) && c.state !== 'VOIDED')) throw new ApprovalRefundProblem('approval-refund-conflict', 409, '이미 취소·환급 기록이 있는 티켓입니다');
      const refundable = orders.reduce((sum, o) => sum + (o.refundableAmount ?? o.ticketPrice), 0);
      this.#kinds.set(approvalId, input.kind);
      if (input.kind === 'DISCRETIONARY_WAIVER') {
        if (input.amount <= 0 || input.amount > refundable) throw new ApprovalRefundProblem('approval-refund-amount-mismatch', 422, '면제 금액이 남은 환급 금액을 넘습니다');
      } else if (input.amount !== refundable) {
        throw new ApprovalRefundProblem('approval-refund-amount-mismatch', 422, '승인 금액이 남은 환급 금액과 다릅니다');
      }
      const nowMs = this.d.clock.now();
      const entryStarted = order.entryOpensAtMs !== undefined && nowMs >= order.entryOpensAtMs;
      if (input.kind === 'MINOR_CONTRACT_CANCEL') {
        const recorded = this.d.entryRecords ? (await Promise.all(orders.map((o) => this.d.entryRecords!.hasEntry(o.ticketId)))).some(Boolean) : false;
        if (entryStarted || recorded) throw new ApprovalRefundProblem('minor-contract-entry-started', 409, '입장이 시작되어 미성년 계약 취소를 할 수 없습니다');
      }
      const cancellationId = approvalId;
      const reason: CancellationReason = input.kind === 'MINOR_CONTRACT_CANCEL' ? 'MINOR_CONTRACT_CANCEL' : 'EXCEPTION';
      if (input.kind === 'DISCRETIONARY_WAIVER') {
        const outcome = await this.d.payments.cancel({ cancellationId, orderId: input.orderId, amount: input.amount, reason, deadlineMs: nowMs + DEADLINE_MS });
        const status: ApprovalRefundStatus = outcome === 'CANCELLED' ? 'REFUNDED' : 'REFUND_PENDING';
        await this.#create({ approvalId, cancellationId, orderId: input.orderId, ticketId: order.ticketId, kind: input.kind, reason, amount: input.amount, status, nowMs });
        return { status, cancellationId, refundAmount: input.amount };
      }
      // 시스템 잘못 환불이 입장 시작 뒤면 지금 환급하지 않고 마감 뒤 실행기가 맡는다(REQUESTED).
      if (input.kind === 'SYSTEM_FAULT_REFUND' && entryStarted) {
        await this.#createAll(orders, { approvalId, cancellationId, kind: input.kind, reason, status: 'REQUESTED', nowMs });
        return { status: 'REQUESTED', cancellationId, refundAmount: input.amount };
      }
      const ticketIds = orders.map((o) => o.ticketId).filter((id) => id !== '');
      if (ticketIds.length > 0) {
        const ticket = await this.d.tickets.cancel({ orderId: input.orderId, ticketIds, requestedByAccountId: order.payerAccountId, cancellationId, deadlineMs: nowMs + DEADLINE_MS, reason });
        if (ticket === 'REFUND_AFTER_CLOSE') {
          await this.#createAll(orders, { approvalId, cancellationId, kind: input.kind, reason, status: 'REQUESTED', nowMs });
          return { status: 'REQUESTED', cancellationId, refundAmount: input.amount };
        }
        if (ticket !== 'REFUND_NOW') throw new ApprovalRefundProblem('approval-refund-conflict', 409, '티켓을 취소할 수 없는 상태입니다');
      }
      const outcome = await this.d.payments.cancel({ cancellationId, orderId: input.orderId, amount: input.amount, reason, deadlineMs: nowMs + DEADLINE_MS });
      const status: ApprovalRefundStatus = outcome === 'CANCELLED' ? 'REFUNDED' : 'REFUND_PENDING';
      await this.#createAll(orders, { approvalId, cancellationId, kind: input.kind, reason, status, nowMs });
      return { status, cancellationId, refundAmount: input.amount };
    });
  }

  async #createAll(orders: readonly { orderId: string; ticketId: string; refundableAmount?: number; ticketPrice: number }[], i: { approvalId: string; cancellationId: string; kind: ApprovalRefundKind; reason: CancellationReason; status: ApprovalRefundStatus; nowMs: number }): Promise<void> {
    let first = true;
    for (const o of orders) {
      const cancellationId = first ? i.cancellationId : `${i.cancellationId}:${o.ticketId}`;
      first = false;
      await this.#create({ approvalId: i.approvalId, cancellationId, orderId: o.orderId, ticketId: o.ticketId || '00000000-0000-0000-0000-000000000000', kind: i.kind, reason: i.reason, amount: o.refundableAmount ?? o.ticketPrice, status: i.status, nowMs: i.nowMs });
    }
  }

  async #create(i: { approvalId: string; cancellationId: string; orderId: string; ticketId: string; kind: ApprovalRefundKind; reason: CancellationReason; amount: number; status: ApprovalRefundStatus; nowMs: number }): Promise<void> {
    const out = await this.d.writes.create({
      cancellationId: i.cancellationId,
      orderId: i.orderId,
      ticketId: i.ticketId,
      reason: i.reason,
      daysBefore: 0,
      within24h: false,
      deductionBp: 0,
      deductionAmount: 0,
      refundAmount: i.amount,
      status: i.status,
      nowMs: i.nowMs,
      actor: `approval:${i.approvalId}`,
      kind: i.kind,
      ...({ approvalId: i.approvalId } as Record<string, unknown>),
    } as never);
    if ((out as { status?: string }).status === 'CONFLICT') throw new ApprovalRefundProblem('approval-refund-conflict', 409, '같은 주문·티켓의 취소가 이미 진행 중입니다');
  }
}

export type Input = ApprovalRefundInput;
