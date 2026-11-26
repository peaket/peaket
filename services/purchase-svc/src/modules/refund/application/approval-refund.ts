// 승인된 예외 환불 실행(F-06-3 R-T26, transfer-refund §3.2·§7.2, POL-038 ①②⑧).
// ops가 승인 ID를 멱등키로 부른다. 시스템 잘못 환불은 EXCEPTION·공제 0원 전액, 재량 면제는 부분 환급만,
// 미성년 계약 취소는 MINOR_CONTRACT_CANCEL·공제 0원 전액이며 입장 시작·입장 기록이 있으면 거절한다.
// 다중 티켓은 티켓마다 실제 UUID 취소 행을 남기고, 다중 주문(orderIds)은 주문마다 티켓 취소·결제사 취소를 부른다.
import { randomUUID } from 'node:crypto';
import { ProblemError, type Clock } from '@peaket/platform';
import type { CancellationOrderView, CancellationRecord, CancellationStatus } from '../domain/cancellation.js';
import type { ApprovalEntryRecords, CancellationOrders, CancellationWrites, PaymentCancellations, TicketCancellations } from '../domain/ports.js';
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
  /** 같은 승인에 묶인 다른 주문(재량 면제의 relatedOrderIds). 없으면 orderId 하나다 */
  orderIds?: readonly string[];
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

const moneyOf = (o: CancellationOrderView): number => o.refundableAmount ?? o.ticketPrice;
const isUuid = (v: string): boolean => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);

export class ApprovalRefunds {
  readonly #kinds = new Map<string, ApprovalRefundKind>();

  constructor(private readonly d: ApprovalRefundDeps) {}

  async execute(approvalId: string, input: ApprovalRefundInput): Promise<ApprovalRefundResult> {
    return guard(async () => {
      const orderIds = [...new Set([input.orderId, ...(input.orderIds ?? [])])].filter((id) => id.length > 0);
      if (!isUuid(approvalId)) throw new ApprovalRefundProblem('invalid-query', 400, '승인 ID가 맞지 않습니다');

      const existing = await this.#approvalRows(approvalId);
      if (existing.length > 0) {
        this.#assertReplay(approvalId, existing, input, orderIds);
        return this.#resultOf(existing);
      }

      const ordersByOrder = new Map<string, CancellationOrderView[]>();
      for (const orderId of orderIds) {
        const rows = (await (this.d.orders.byOrder ? this.d.orders.byOrder(orderId) : Promise.resolve([]))) ?? [];
        if (rows.length === 0) throw new ApprovalRefundProblem('not-found', 404, '주문을 찾지 못했습니다');
        ordersByOrder.set(orderId, rows);
      }
      const orders = [...ordersByOrder.values()].flat();
      const order = orders[0]!;
      if (orders.some((o) => o.orderStatus === 'REFUNDED' || o.orderStatus === 'CANCELED' || o.orderStatus === 'CANCELLED')) {
        throw new ApprovalRefundProblem('approval-refund-conflict', 409, '이미 환급·취소된 주문입니다');
      }
      if (new Set(orders.map((o) => o.payerAccountId)).size !== 1) throw new ApprovalRefundProblem('approval-refund-conflict', 409, '한 승인에 결제자가 다른 주문이 섞였습니다');

      const prior = (await Promise.all(orderIds.map((orderId) => this.d.orders.cancellationsOf?.(orderId) ?? []))).flat();
      const tickets = new Set(orders.map((o) => o.ticketId).filter((t) => t.length > 0));
      const activePrior = prior.filter((c) => c.state !== 'VOIDED' && tickets.has(c.ticketId));
      if (activePrior.length > 0) {
        const resumed = await this.#resumeExisting(approvalId, input, activePrior);
        if (resumed) return resumed;
        throw new ApprovalRefundProblem('approval-refund-conflict', 409, '이미 취소·환급 기록이 있는 티켓입니다');
      }
      if (prior.some((c) => tickets.has(c.ticketId) && c.state !== 'VOIDED')) throw new ApprovalRefundProblem('approval-refund-conflict', 409, '이미 취소·환급 기록이 있는 티켓입니다');

      const refundable = orders.reduce((sum, o) => sum + moneyOf(o), 0);
      this.#kinds.set(approvalId, input.kind);
      if (input.kind === 'DISCRETIONARY_WAIVER') {
        if (input.amount <= 0 || input.amount > refundable) throw new ApprovalRefundProblem('approval-refund-amount-mismatch', 422, '면제 금액이 남은 환급 금액을 넘습니다');
      } else if (input.amount !== refundable) {
        throw new ApprovalRefundProblem('approval-refund-amount-mismatch', 422, '승인 금액이 남은 환급 금액과 다릅니다');
      }

      const nowMs = this.d.clock.now();
      const entryStarted = orders.some((o) => o.entryOpensAtMs !== undefined && nowMs >= o.entryOpensAtMs);
      if (input.kind === 'MINOR_CONTRACT_CANCEL') {
        const recorded = this.d.entryRecords ? (await Promise.all(orders.map((o) => this.d.entryRecords!.hasEntry(o.ticketId).catch(() => false)))).some(Boolean) : false;
        if (entryStarted || recorded) throw new ApprovalRefundProblem('minor-contract-entry-started', 409, '입장이 시작되어 미성년 계약 취소를 할 수 없습니다');
      }

      const ids = this.#cancellationIds(orderIds, approvalId);
      const reason: CancellationReason = input.kind === 'MINOR_CONTRACT_CANCEL' ? 'MINOR_CONTRACT_CANCEL' : 'EXCEPTION';

      if (input.kind === 'DISCRETIONARY_WAIVER') {
        const shares = this.#waiverShares(input.amount, orderIds, ordersByOrder);
        let status: ApprovalRefundStatus = 'REFUNDED';
        for (const orderId of orderIds) {
          const amount = shares.get(orderId) ?? 0;
          if (amount <= 0) continue;
          const outcome = await this.d.payments.cancel({ cancellationId: ids.get(orderId)!, orderId, amount, reason, deadlineMs: nowMs + DEADLINE_MS });
          if (outcome !== 'CANCELLED') status = 'REFUND_PENDING';
        }
        await this.#createWaiverRows(ordersByOrder, { approvalId, kind: input.kind, reason, status, nowMs, ids, shares });
        return { status, cancellationId: ids.get(orderIds[0]!)!, refundAmount: input.amount };
      }

      // 시스템 잘못 환불이 입장 시작 뒤면 지금 환급하지 않고 마감 뒤 실행기가 맡는다(REQUESTED).
      if (input.kind === 'SYSTEM_FAULT_REFUND' && entryStarted) {
        await this.#createAll(ordersByOrder, { approvalId, kind: input.kind, reason, status: 'REQUESTED', nowMs, ids });
        return { status: 'REQUESTED', cancellationId: ids.get(orderIds[0]!)!, refundAmount: input.amount };
      }

      for (const orderId of orderIds) {
        const rows = ordersByOrder.get(orderId)!;
        const ticketIds = rows.map((o) => o.ticketId).filter((id) => id.length > 0);
        if (ticketIds.length === 0) continue;
        const ticket = await this.d.tickets.cancel({ orderId, ticketIds, requestedByAccountId: rows[0]!.payerAccountId, cancellationId: ids.get(orderId)!, deadlineMs: nowMs + DEADLINE_MS, reason });
        if (ticket === 'REFUND_AFTER_CLOSE') {
          await this.#createAll(ordersByOrder, { approvalId, kind: input.kind, reason, status: 'REQUESTED', nowMs, ids });
          return { status: 'REQUESTED', cancellationId: ids.get(orderIds[0]!)!, refundAmount: input.amount };
        }
        if (ticket !== 'REFUND_NOW') throw new ApprovalRefundProblem('approval-refund-conflict', 409, '티켓을 취소할 수 없는 상태입니다');
      }

      let status: ApprovalRefundStatus = 'REFUNDED';
      for (const orderId of orderIds) {
        const rows = ordersByOrder.get(orderId)!;
        const amount = rows.reduce((sum, o) => sum + moneyOf(o), 0);
        const outcome = await this.d.payments.cancel({ cancellationId: ids.get(orderId)!, orderId, amount, reason, deadlineMs: nowMs + DEADLINE_MS });
        if (outcome !== 'CANCELLED') status = 'REFUND_PENDING';
      }
      await this.#createAll(ordersByOrder, { approvalId, kind: input.kind, reason, status, nowMs, ids });
      return { status, cancellationId: ids.get(orderIds[0]!)!, refundAmount: input.amount };
    });
  }

  /** 같은 승인 ID로 남은 모든 행. approvalRefundOf가 없는 대역은 첫 행(findCancellation)만 본다 */
  async #approvalRows(approvalId: string): Promise<CancellationRecord[]> {
    if (this.d.orders.approvalRefundOf) {
      const rows = await this.d.orders.approvalRefundOf(approvalId);
      return rows ?? [];
    }
    const one = await this.d.orders.findCancellation(approvalId);
    return one ? [one] : [];
  }

  /** 다시 온 요청의 주문 집합·합계·종류가 처음과 같은지 본다. 다르면 409 */
  #assertReplay(approvalId: string, rows: CancellationRecord[], input: ApprovalRefundInput, orderIds: readonly string[]): void {
    const known = rows.find((r) => r.kind !== undefined)?.kind ?? this.#kinds.get(approvalId);
    const existingOrders = new Set(rows.map((r) => r.orderId));
    const sameOrders = existingOrders.size === orderIds.length && orderIds.every((id) => existingOrders.has(id));
    const total = rows.reduce((sum, r) => sum + r.refundAmount, 0);
    if (!sameOrders || total !== input.amount || (known !== undefined && known !== input.kind)) {
      throw new ApprovalRefundProblem('approval-refund-conflict', 409, '같은 승인 ID에 다른 환불 요청이 왔습니다');
    }
  }

  #resultOf(rows: CancellationRecord[]): ApprovalRefundResult {
    const status: ApprovalRefundStatus = rows.every((r) => r.state === 'REFUNDED') ? 'REFUNDED' : rows.some((r) => r.state === 'REQUESTED') ? 'REQUESTED' : 'REFUND_PENDING';
    return { status, cancellationId: rows[0]!.cancellationId, refundAmount: rows.reduce((sum, r) => sum + r.refundAmount, 0) };
  }

  /** FLAGGED REFUND(IR-11): 이미 있는 REQUESTED 취소 행을 그대로 환급으로 끝낸다. 합계·종류가 다르면 undefined(409) */
  async #resumeExisting(approvalId: string, input: ApprovalRefundInput, active: readonly CancellationRecord[]): Promise<ApprovalRefundResult | undefined> {
    if (input.kind !== 'SYSTEM_FAULT_REFUND') return undefined;
    if (!active.every((c) => c.state === 'REQUESTED')) return undefined;
    const total = active.reduce((sum, c) => sum + c.refundAmount, 0);
    if (total !== input.amount) return undefined;
    const nowMs = this.d.clock.now();
    let status: ApprovalRefundStatus = 'REFUNDED';
    this.#kinds.set(approvalId, input.kind);
    for (const c of active) {
      const outcome = await this.d.payments.cancel({ cancellationId: c.cancellationId, orderId: c.orderId, amount: c.refundAmount, reason: 'EXCEPTION', deadlineMs: nowMs + DEADLINE_MS });
      const next: CancellationStatus = outcome === 'CANCELLED' ? 'REFUNDED' : 'REFUND_PENDING';
      await this.d.writes.updateStatus({ cancellationId: c.cancellationId, status: next, nowMs });
      await this.d.writes.markApproval?.({ cancellationId: c.cancellationId, approvalId });
      if (next !== 'REFUNDED') status = 'REFUND_PENDING';
    }
    return { status, cancellationId: active[0]!.cancellationId, refundAmount: total };
  }

  /** 주문마다 첫 티켓은 그 주문의 취소 ID, 나머지 티켓은 실제 UUID를 쓴다(IR-21) */
  #cancellationIds(orderIds: readonly string[], approvalId: string): Map<string, string> {
    const ids = new Map<string, string>();
    orderIds.forEach((orderId, index) => ids.set(orderId, index === 0 ? approvalId : randomUUID()));
    return ids;
  }

  #waiverShares(total: number, orderIds: readonly string[], ordersByOrder: ReadonlyMap<string, CancellationOrderView[]>): Map<string, number> {
    const shares = new Map<string, number>();
    let remaining = total;
    orderIds.forEach((orderId, index) => {
      const cap = ordersByOrder.get(orderId)!.reduce((sum, o) => sum + moneyOf(o), 0);
      const amount = index === orderIds.length - 1 ? remaining : Math.min(cap, remaining);
      shares.set(orderId, amount);
      remaining -= amount;
    });
    return shares;
  }

  async #createWaiverRows(
    ordersByOrder: ReadonlyMap<string, CancellationOrderView[]>,
    i: { approvalId: string; kind: ApprovalRefundKind; reason: CancellationReason; status: ApprovalRefundStatus; nowMs: number; ids: ReadonlyMap<string, string>; shares: ReadonlyMap<string, number> },
  ): Promise<void> {
    for (const [orderId, rows] of ordersByOrder) {
      const amount = i.shares.get(orderId) ?? 0;
      if (amount <= 0) continue;
      const first = rows[0]!;
      await this.#create({
        approvalId: i.approvalId,
        cancellationId: i.ids.get(orderId)!,
        orderId,
        ticketId: first.ticketId || randomUUID(),
        kind: i.kind,
        reason: i.reason,
        amount,
        status: i.status,
        nowMs: i.nowMs,
      });
    }
  }

  async #createAll(
    ordersByOrder: ReadonlyMap<string, CancellationOrderView[]>,
    i: { approvalId: string; kind: ApprovalRefundKind; reason: CancellationReason; status: ApprovalRefundStatus; nowMs: number; ids: ReadonlyMap<string, string> },
  ): Promise<void> {
    for (const [orderId, rows] of ordersByOrder) {
      let first = true;
      for (const row of rows) {
        const cancellationId = first ? i.ids.get(orderId)! : randomUUID();
        first = false;
        await this.#create({
          approvalId: i.approvalId,
          cancellationId,
          orderId,
          ticketId: row.ticketId || randomUUID(),
          kind: i.kind,
          reason: i.reason,
          amount: moneyOf(row),
          status: i.status,
          nowMs: i.nowMs,
        });
      }
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
      approvalId: i.approvalId,
    });
    if ((out as { status?: string }).status === 'CONFLICT') throw new ApprovalRefundProblem('approval-refund-conflict', 409, '같은 주문·티켓의 취소가 이미 진행 중입니다');
  }
}

export type Input = ApprovalRefundInput;
