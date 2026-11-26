// ops 승인 수명주기의 실제 서비스 어댑터(F-06-3 IR-01·IR-02·IR-08·IR-19).
// 주문 근거·환불은 purchase-svc 내부 HTTP, 양도 회수는 ticket-svc gRPC, 알림·경보는 서비스 로그/감사로 남긴다.
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { ticketV1Ticket } from '@peaket/contracts/proto';
import { createExternalHttpClient, createGrpcClient, ProblemError, type PlatformLogger } from '@peaket/platform';
import type { ApprovalLifecycleTargets, ApprovalLifecycleExecutors, ApprovalNotifier, ApprovalEscalationAlerts } from '../domain/lifecycle-ports.js';
import type { LifecycleKind } from '../domain/approval-lifecycle.js';

const OPTIONS: protoLoader.Options = { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true };
type Unary = (req: object, md: grpc.Metadata, opts: grpc.CallOptions, cb: (e: grpc.ServiceError | null, v?: Record<string, unknown>) => void) => grpc.ClientUnaryCall;
const atOf = (v: unknown): number | undefined => {
  const r = (v ?? {}) as Record<string, unknown>;
  const seconds = Number(r.seconds);
  return Number.isFinite(seconds) ? seconds * 1000 + Math.floor(Number(r.nanos) / 1_000_000) : undefined;
};
const stamp = (ms: number) => ({ seconds: Math.floor(ms / 1000), nanos: (ms % 1000) * 1_000_000 });

export class TicketReclaimClient {
  readonly #client: { GetReclaimBasis: Unary; ReclaimTransfer: Unary; VoidTickets: Unary };
  constructor(
    address: string,
    private readonly internalToken: string | undefined,
  ) {
    const at = address.lastIndexOf(':');
    const port = Number(address.slice(at + 1));
    if (at <= 0 || !Number.isInteger(port)) throw new Error('PEAKET_TICKET_GRPC_URL은 host:port여야 한다');
    this.#client = createGrpcClient(ticketPackageLocal(), { host: address.slice(0, at), port, dependency: 'ticket-svc', caller: 'ops-svc', ...(internalToken ? { internalToken } : {}), profile: 'service', timeoutCapMs: 10_000 }) as unknown as { GetReclaimBasis: Unary; ReclaimTransfer: Unary; VoidTickets: Unary };
  }

  async getBasis(ticketId: string): Promise<{ ticketId: string; payerAccountId: string; holderAccountId: string; entryStartsAtMs?: number; entryRecorded: boolean; status: string } | undefined> {
    const r = await this.#call(this.#client.GetReclaimBasis, { ticket_id: ticketId });
    return {
      ticketId: String(r.ticket_id ?? ticketId),
      payerAccountId: String(r.payer_account_id ?? ''),
      holderAccountId: String(r.holder_account_id ?? ''),
      ...(atOf(r.entry_starts_at) !== undefined ? { entryStartsAtMs: atOf(r.entry_starts_at)! } : {}),
      entryRecorded: r.entry_recorded === true,
      status: String(r.status ?? ''),
    };
  }

  async voidOrder(orderId: string, reason: string, o: { issueGeneration?: number; eventId?: string } = {}): Promise<{ voided: number; alreadyEntered: number }> {
    const r = await this.#call(this.#client.VoidTickets, {
      order_id: orderId,
      event_id: o.eventId ?? '',
      issue_generation: o.issueGeneration ?? 0,
      ...(reason ? { reason } : {}),
    });
    return { voided: Number(r.voided ?? 0), alreadyEntered: Number(r.already_entered ?? 0) };
  }

  async reclaim(i: { approvalId: string; ticketId: string; expectedPayerAccountId: string | null; expectedHolderAccountId: string | null; deadlineMs: number }) {
    const r = await this.#call(this.#client.ReclaimTransfer, {
      approval_id: i.approvalId,
      ticket_id: i.ticketId,
      expected_payer_account_id: i.expectedPayerAccountId ?? '',
      expected_holder_account_id: i.expectedHolderAccountId ?? '',
      deadline_ms: i.deadlineMs,
    });
    return { result: String(r.result ?? 'SKIPPED_HOLDER_CHANGED'), ticketId: i.ticketId, ...(typeof r.previous_holder_account_id === 'string' && r.previous_holder_account_id ? { previousHolderAccountId: r.previous_holder_account_id } : {}) };
  }

  #call(fn: Unary, req: object): Promise<Record<string, unknown>> {
    // 토큰·호출자 머리는 createGrpcClient의 인터셉터가 붙인다(내부 gRPC 머리 이름과 토큰을 섞지 않는다)
    return new Promise((resolve, reject) => fn(req, new grpc.Metadata(), { deadline: Date.now() + 10_000 }, (e, v) => (e ? reject(e) : resolve(v ?? {}))));
  }
}

let pkg: grpc.ServiceClientConstructor | undefined;
function ticketPackageLocal(): grpc.ServiceClientConstructor {
  if (!pkg) {
    const def = protoLoader.fromJSON(ticketV1Ticket as Parameters<typeof protoLoader.fromJSON>[0], OPTIONS);
    pkg = (grpc.loadPackageDefinition(def) as unknown as { peaket: { ticket: { v1: { TicketService: grpc.ServiceClientConstructor } } } }).peaket.ticket.v1.TicketService;
  }
  return pkg;
}

export class HttpApprovalLifecyclePorts implements ApprovalLifecycleTargets, ApprovalLifecycleExecutors {
  readonly #purchase;
  constructor(
    purchaseUrl: string | undefined,
    private readonly ticket: TicketReclaimClient | undefined,
    private readonly internalToken: string | undefined,
    private readonly now: () => number = Date.now,
  ) {
    this.#purchase = purchaseUrl ? createExternalHttpClient({ provider: 'purchase-svc', baseUrl: purchaseUrl, timeoutCapMs: 5_000 }) : undefined;
  }

  async basis(kind: LifecycleKind, targetRef: string) {
    if (kind === 'TRANSFER_RECLAIM') {
      const b = await this.ticket?.getBasis(targetRef);
      if (!b) return undefined;
      return { targetAccountId: b.payerAccountId, expectedHolderAccountId: b.holderAccountId, ...(b.entryStartsAtMs !== undefined ? { entryStartsAtMs: b.entryStartsAtMs } : {}), ...(b.entryRecorded ? { entryRecorded: true } : {}) };
    }
    const body = await this.#get(`/internal/v1/orders/${targetRef}/approval-basis`);
    if (!body) return undefined;
    return {
      targetAccountId: typeof body.payerAccountId === 'string' ? body.payerAccountId : null,
      orderId: typeof body.orderId === 'string' ? body.orderId : targetRef,
      ...(typeof body.entryOpensAt === 'string' ? { entryStartsAtMs: Date.parse(body.entryOpensAt) } : {}),
      ...(body.entryRecorded === true ? { entryRecorded: true } : {}),
      ...(typeof body.refundableAmount === 'number' ? { refundableAmount: body.refundableAmount } : {}),
      ...(typeof body.issueGeneration === 'number' ? { issueGeneration: body.issueGeneration } : {}),
      ...(typeof body.eventId === 'string' && body.eventId ? { eventId: body.eventId } : {}),
    };
  }

  async changed(kind: LifecycleKind, targetRef: string): Promise<'OK' | 'TARGET_CHANGED'> {
    if (kind === 'TRANSFER_RECLAIM') {
      const b = await this.ticket?.getBasis(targetRef);
      if (!b) return 'OK';
      return b.entryRecorded || (b.entryStartsAtMs !== undefined && this.now() >= b.entryStartsAtMs) ? 'TARGET_CHANGED' : 'OK';
    }
    const body = await this.#get(`/internal/v1/orders/${targetRef}/approval-basis`);
    const status = typeof body?.orderStatus === 'string' ? body.orderStatus : '';
    return ['REFUNDED', 'CANCELED', 'CANCELLED', 'EXPIRED'].includes(status) ? 'TARGET_CHANGED' : 'OK';
  }

  async refund(i: { approvalId: string; kind: string; targetRef: string; orderIds?: readonly string[]; amount: number; reasonText: string }) {
    const res = await this.#request('POST', `/internal/v1/approval-refunds/${i.approvalId}`, {
      kind: i.kind,
      orderId: i.targetRef,
      ...(i.orderIds !== undefined && i.orderIds.length > 0 ? { orderIds: i.orderIds } : {}),
      amount: i.amount,
      reasonText: i.reasonText,
    });
    if (!res.ok) throw new ProblemError({ type: 'approval-execution-failed', status: 502, title: '승인 환불을 실행하지 못했습니다' });
    const body = (await res.json()) as { status?: unknown; cancellationId?: unknown; refundAmount?: unknown };
    const status: 'REFUNDED' | 'REFUND_PENDING' | 'REQUESTED' = body.status === 'REFUNDED' ? 'REFUNDED' : body.status === 'REQUESTED' ? 'REQUESTED' : 'REFUND_PENDING';
    return { status, cancellationId: String(body.cancellationId ?? ''), refundAmount: Number(body.refundAmount ?? i.amount) };
  }

  async voidOrder(i: { orderId: string; reason: string; issueGeneration?: number; eventId?: string }): Promise<{ voided: number; alreadyEntered: number }> {
    if (!this.ticket) throw new ProblemError({ type: 'approval-execution-failed', status: 503, title: 'ticket-svc에 연결하지 못했습니다' });
    return this.ticket.voidOrder(i.orderId, i.reason, { ...(i.issueGeneration !== undefined ? { issueGeneration: i.issueGeneration } : {}), ...(i.eventId !== undefined ? { eventId: i.eventId } : {}) });
  }

  /** purchase의 기존 취소 행을 VOIDED로 끝낸다(IR-30). ticket 무효 뒤에만 부른다 */
  async voidCancellation(cancellationId: string): Promise<void> {
    const res = await this.#request('POST', `/internal/v1/cancellations/${cancellationId}/void`, {});
    if (!res.ok) throw new ProblemError({ type: 'approval-execution-failed', status: 502, title: '취소 행을 무효로 끝내지 못했습니다' });
  }

  async reclaim(i: { approvalId: string; targetRef: string; targetAccountId: string | null; expectedHolderAccountId: string | null; deadlineMs: number }) {
    if (!this.ticket) throw new ProblemError({ type: 'approval-execution-failed', status: 503, title: 'ticket-svc에 연결하지 못했습니다' });
    const out = await this.ticket.reclaim({ approvalId: i.approvalId, ticketId: i.targetRef, expectedPayerAccountId: i.targetAccountId, expectedHolderAccountId: i.expectedHolderAccountId, deadlineMs: i.deadlineMs });
    return { result: out.result as 'RECLAIMED' | 'SKIPPED_ENTRY_STARTED' | 'SKIPPED_ENTRY_RECORDED' | 'SKIPPED_NOT_TRANSFERRED' | 'SKIPPED_HOLDER_CHANGED', ...(out.previousHolderAccountId ? { previousHolderAccountId: out.previousHolderAccountId } : {}) };
  }

  async #get(path: string): Promise<Record<string, unknown> | undefined> {
    if (!this.#purchase) return undefined;
    const res = await this.#request('GET', path);
    if (!res.ok) return undefined;
    return (await res.json()) as Record<string, unknown>;
  }

  async #request(method: 'GET' | 'POST', path: string, body?: unknown) {
    if (!this.#purchase) throw new ProblemError({ type: 'dependency-unavailable', status: 503, title: 'purchase-svc에 연결하지 못했습니다' });
    return this.#purchase.request({
      method,
      path,
      headers: { ...(this.internalToken ? { 'x-peaket-internal-token': this.internalToken } : {}), ...(method === 'POST' ? { 'x-peaket-caller': 'ops-svc', 'content-type': 'application/json' } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      timeoutCapMs: 5_000,
    });
  }
}

export class LogApprovalNotifier implements ApprovalNotifier {
  constructor(private readonly logger: PlatformLogger) {}
  async send(i: Parameters<ApprovalNotifier['send']>[0]): Promise<void> {
    this.logger.info({ approvalId: i.approvalId, event: i.event, recipient: i.recipient, ...(i.payoutDate ? { payoutDate: i.payoutDate } : {}) }, '승인 업무 알림');
  }
}

export class LogApprovalAlerts implements ApprovalEscalationAlerts {
  constructor(private readonly logger: PlatformLogger) {}
  async open(i: Parameters<ApprovalEscalationAlerts['open']>[0]): Promise<void> {
    this.logger.warn({ alert: i.kind, approvalId: i.approvalId, recipient: i.recipient, pg: i.pg, payoutDate: i.payoutDate }, '승인 업무 경보');
  }
}
