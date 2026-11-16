// ticket-svc CancelTickets·OperatorCancelTickets gRPC 어댑터(GAT-080, docs/api/proto/peaket/ticket/v1/ticket.proto).
// ticket-svc가 티켓 행 잠금 안에서 결제자·보유자·진행 중 양도·공연 시작을 다시 보고 키를 폐기한다.
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { ticketV1Ticket } from '@peaket/contracts/proto';
import { type CircuitBreaker, createGrpcClient, type GrpcLbProfile } from '@peaket/platform';
import type { TicketCancelAnswer, TicketCancelOutcome } from '../domain/cancellation.js';
import type { OperatorTicketCancellations, OperatorTicketOutcome, OperatorTicketResult, TicketCancellations } from '../domain/ports.js';

const PROTO_LOAD_OPTIONS: protoLoader.Options = { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true };
type Unary = (req: object, md: grpc.Metadata, opts: grpc.CallOptions, cb: (e: grpc.ServiceError | null, v?: Record<string, unknown>) => void) => grpc.ClientUnaryCall;
type TicketPackage = { TicketService: grpc.ServiceClientConstructor };

let loaded: TicketPackage | undefined;
function ticketPackage(): TicketPackage {
  if (!loaded) {
    const def = protoLoader.fromJSON(ticketV1Ticket as Parameters<typeof protoLoader.fromJSON>[0], PROTO_LOAD_OPTIONS);
    loaded = (grpc.loadPackageDefinition(def) as unknown as { peaket: { ticket: { v1: TicketPackage } } }).peaket.ticket.v1;
  }
  return loaded;
}

const OUTCOMES: ReadonlySet<TicketCancelOutcome> = new Set(['REFUND_NOW', 'REFUND_AFTER_CLOSE', 'NOT_PAYER_HOLDER', 'TRANSFER_PENDING', 'EVENT_STARTED', 'ALREADY_CANCELLED']);
const OPERATOR_RESULTS: ReadonlySet<OperatorTicketResult> = new Set(['CANCELED', 'SKIPPED_ALREADY_ENDED', 'SKIPPED_ENTRY_RECORDED', 'SKIPPED_HOLDER_CHANGED']);
/** 운영자 취소 한 번의 데드라인 5초 [가정](대상 500장을 한 트랜잭션에서 잠그고 가른다, docs/api/guidelines.md §8.1) */
const OPERATOR_CANCEL_DEADLINE_MS = 5_000;
/** ticket-svc에 싣는 호출자 머리(내부 gRPC) */
const TICKET_CALLER = 'purchase-svc';

export interface GrpcTicketCancellationsOptions {
  address: string;
  profile?: GrpcLbProfile;
  breaker?: CircuitBreaker;
  /**
   * 내부 gRPC 토큰. 있으면 호출에 토큰을 싣는다. 호출자 머리(purchase-svc)는 늘 싣는다. ticket-svc OperatorCancelTickets는 토큰이 설정된 환경에서
   * 토큰·호출자 purchase-svc가 맞지 않으면 PERMISSION_DENIED다(리뷰 B6, docs/features/transfer-refund.md §7.4 '호출자')
   */
  internalToken?: string;
}

export class GrpcTicketCancellations implements TicketCancellations, OperatorTicketCancellations {
  readonly #client: grpc.Client & { CancelTickets: Unary; OperatorCancelTickets: Unary };

  constructor(o: GrpcTicketCancellationsOptions) {
    const at = o.address.lastIndexOf(':');
    const port = Number(o.address.slice(at + 1));
    if (at <= 0 || !Number.isInteger(port) || port <= 0 || port > 65_535) throw new Error('PEAKET_TICKET_GRPC_ADDR는 host:port여야 한다');
    this.#client = createGrpcClient(ticketPackage().TicketService, {
      host: o.address.slice(0, at),
      port,
      profile: o.profile ?? 'service',
      dependency: 'ticket-svc',
      timeoutCapMs: OPERATOR_CANCEL_DEADLINE_MS,
      caller: TICKET_CALLER,
      ...(o.internalToken ? { internalToken: o.internalToken } : {}),
    }) as unknown as grpc.Client & { CancelTickets: Unary; OperatorCancelTickets: Unary };
  }

  async cancel(q: Parameters<TicketCancellations['cancel']>[0]): Promise<TicketCancelAnswer> {
    const ms = Math.min(2_000, Math.max(1, Math.floor(Number.isFinite(q.deadlineMs) ? q.deadlineMs : 2_000)));
    const once = (): Promise<Record<string, unknown>> =>
      new Promise((resolve, reject) => {
        this.#client.CancelTickets(
          { order_id: q.orderId, ticket_ids: [...q.ticketIds], requested_by_account_id: q.requestedByAccountId, cancellation_id: q.cancellationId },
          new grpc.Metadata(),
          { deadline: new Date(Date.now() + ms) },
          (e, v) => (e ? reject(e) : resolve(v ?? {})),
        );
      });
    const v = await once();
    const out = Array.isArray(v.outcomes) ? (v.outcomes[0] as Record<string, unknown> | undefined) : undefined;
    const raw = typeof out?.result === 'string' ? out.result.replace(/^CANCEL_TICKET_RESULT_/, '') : '';
    if (!OUTCOMES.has(raw as TicketCancelOutcome)) throw new Error('ticket-svc CancelTickets 답의 결과를 알 수 없다');
    // ALREADY_CANCELLED에 먼저 키를 폐기한 팬 취소가 실려 오면 그 취소로 잇는다(리뷰 B2). 칸이 비었거나 모양이 틀리면 첫 칸 없는 답이다
    if (raw === 'ALREADY_CANCELLED') {
      const firstId = typeof out?.first_cancellation_id === 'string' ? out.first_cancellation_id : '';
      const firstResult = typeof out?.first_result === 'string' ? out.first_result.replace(/^CANCEL_TICKET_RESULT_/, '') : '';
      const at = out?.first_cancelled_at as { seconds?: unknown; nanos?: unknown } | null | undefined;
      const atMs = at ? Number(at.seconds) * 1000 + Math.floor(Number(at.nanos ?? 0) / 1_000_000) : Number.NaN;
      if (firstId !== '' && (firstResult === 'REFUND_NOW' || firstResult === 'REFUND_AFTER_CLOSE') && Number.isFinite(atMs)) {
        return { result: 'ALREADY_CANCELLED', firstCancellationId: firstId, firstResult, firstCancelledAtMs: atMs };
      }
    }
    return raw as TicketCancelOutcome;
  }

  /**
   * ticket-svc OperatorCancelTickets(BAT-415 몫 F, 데드라인 5초 [가정], docs/api/guidelines.md §8.1). 답은 요청 차례다.
   * 전송 실패·데드라인 초과·알 수 없는 결과·빠진 표는 던진다(부른 쪽이 그 표들을 TICKET_UNAVAILABLE로 남기고 다시 부르기에서 다시 한다)
   */
  async operatorCancel(q: Parameters<OperatorTicketCancellations['operatorCancel']>[0]): Promise<readonly OperatorTicketOutcome[]> {
    const ms = Math.min(OPERATOR_CANCEL_DEADLINE_MS, Math.max(1, Math.floor(Number.isFinite(q.deadlineMs) ? q.deadlineMs : OPERATOR_CANCEL_DEADLINE_MS)));
    const v = await new Promise<Record<string, unknown>>((resolve, reject) => {
      this.#client.OperatorCancelTickets(
        {
          approval_id: q.approvalId,
          fraud_case_id: q.fraudCaseId,
          event_id: q.eventId,
          targets: q.targets.map((t) => ({ ticket_id: t.ticketId, expected_holder_account_id: t.expectedHolderAccountId })),
        },
        new grpc.Metadata(),
        { deadline: new Date(Date.now() + ms) },
        (e, r) => (e ? reject(e) : resolve(r ?? {})),
      );
    });
    const raw = Array.isArray(v.outcomes) ? (v.outcomes as Record<string, unknown>[]) : [];
    const byTicket = new Map<string, OperatorTicketOutcome>();
    for (const o of raw) {
      const ticketId = typeof o.ticket_id === 'string' ? o.ticket_id : '';
      const result = typeof o.result === 'string' ? o.result.replace(/^OPERATOR_CANCEL_RESULT_/, '') : '';
      const orderId = typeof o.order_id === 'string' ? o.order_id : '';
      if (!OPERATOR_RESULTS.has(result as OperatorTicketResult) || ticketId === '' || orderId === '') throw new Error('ticket-svc OperatorCancelTickets 답의 결과를 알 수 없다');
      const withdrawn = typeof o.withdrawn_transfer_offer_id === 'string' && o.withdrawn_transfer_offer_id !== '' ? { withdrawnTransferOfferId: o.withdrawn_transfer_offer_id } : {};
      byTicket.set(ticketId, { ticketId, result: result as OperatorTicketResult, orderId, ...withdrawn });
    }
    return q.targets.map((t) => {
      const o = byTicket.get(t.ticketId);
      if (!o) throw new Error('ticket-svc OperatorCancelTickets 답에 빠진 표가 있다');
      return o;
    });
  }

  close(): void {
    this.#client.close();
  }
}
