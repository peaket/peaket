// 받는 층: gRPC EventRefundService(docs/api/proto/peaket/purchase/v1/refund.proto, BAT-425 GAT-130).
// ops-svc가 EVENT_CANCEL·연기·진행률·일시정지·재개·신청·창 닫기를 부르는 정본 경로다.
// 같은 쓰임새를 내부 HTTP(EventRefundController)도 열어 두었다. 두 길은 같은 EventRefundService와 멱등 키(cancellation_request_id)를 쓴다.
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { purchaseV1Refund } from '@peaket/contracts/proto';
import { EventRefundError, type EventRefundService } from '../application/event-refund-service.js';
import type { EventCancellationRequest, EventRefundFault, EventRefundKind, EventRefundProgress, RefundJobState, RefundPauseReason, RefundPgProvider } from '../domain/event-refund.js';

export interface EventRefundPackage {
  EventRefundService: grpc.ServiceClientConstructor;
}

const PROTO_LOAD_OPTIONS: protoLoader.Options = { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true };
let pkg: EventRefundPackage | undefined;

/** peaket.purchase.v1 패키지(계약 설명자에서 한 번 만든다) */
export function eventRefundPackage(): EventRefundPackage {
  if (!pkg) {
    const def = protoLoader.fromJSON(purchaseV1Refund as Parameters<typeof protoLoader.fromJSON>[0], PROTO_LOAD_OPTIONS);
    pkg = (grpc.loadPackageDefinition(def) as unknown as { peaket: { purchase: { v1: EventRefundPackage } } }).peaket.purchase.v1;
  }
  return pkg;
}

type Req = Record<string, unknown>;
const text = (v: unknown): string => (typeof v === 'string' ? v : '');
const childOf = (v: unknown): Req | undefined => (typeof v === 'object' && v !== null ? (v as Req) : undefined);
const msOf = (v: unknown): number | undefined => {
  const t = childOf(v);
  return t ? Number(t.seconds) * 1000 + Math.floor(Number(t.nanos) / 1_000_000) : undefined;
};
const timestampOf = (ms: number): { seconds: number; nanos: number } => ({ seconds: Math.floor(ms / 1000), nanos: (ms % 1000) * 1_000_000 });

const FAULTS: Record<string, EventRefundFault> = {
  CANCELLATION_RULING_ORGANIZER: 'ORGANIZER',
  CANCELLATION_RULING_FORCE_MAJEURE: 'FORCE_MAJEURE',
  CANCELLATION_RULING_CONTENT_CHANGE: 'CONTENT_CHANGE',
};
const PGS: Record<string, RefundPgProvider> = { PG_PROVIDER_TOSS: 'TOSS', PG_PROVIDER_PORTONE: 'PORTONE', PG_PROVIDER_SIMULATOR: 'SIMULATOR' };
const KINDS: Record<string, EventRefundKind> = { EVENT_REFUND_KIND_CANCEL: 'CANCEL', EVENT_REFUND_KIND_POSTPONE: 'POSTPONE' };
const STATE_NAME: Record<RefundJobState, string> = {
  RUNNING: 'REFUND_JOB_STATE_RUNNING',
  PAUSED: 'REFUND_JOB_STATE_PAUSED',
  REFUND_WINDOW: 'REFUND_JOB_STATE_REFUND_WINDOW',
  COMPLETED: 'REFUND_JOB_STATE_COMPLETED',
};
const PAUSE_NAME: Record<RefundPauseReason, string> = {
  AUTO_FAILURE_RATE: 'REFUND_PAUSE_REASON_AUTO_FAILURE_RATE',
  AUTO_CONSECUTIVE_FAILURES: 'REFUND_PAUSE_REASON_AUTO_CONSECUTIVE_FAILURES',
  AUTO_CIRCUIT_OPEN: 'REFUND_PAUSE_REASON_AUTO_CIRCUIT_OPEN',
  AUTO_REJECT_RATE: 'REFUND_PAUSE_REASON_AUTO_REJECT_RATE',
  AUTO_FAILED_AMOUNT: 'REFUND_PAUSE_REASON_AUTO_FAILED_AMOUNT',
  MANUAL: 'REFUND_PAUSE_REASON_MANUAL',
};

const faultOf = (v: unknown): EventRefundFault => {
  const f = FAULTS[text(v)];
  if (!f) throw new EventRefundError('INVALID', '판정 값이 올바르지 않습니다');
  return f;
};
const pgOf = (v: unknown): RefundPgProvider | undefined => (text(v) === '' || text(v) === 'PG_PROVIDER_UNSPECIFIED' ? undefined : PGS[text(v)]);

const progressView = (p: EventRefundProgress): Record<string, unknown> => ({
  total_orders: p.total,
  done_orders: p.done,
  failed_orders: p.failed,
  not_applied_orders: p.notApplied,
  per_pg: p.perPg.map((x) => ({
    pg: `PG_PROVIDER_${x.pg}`,
    state: STATE_NAME[x.state],
    ...(x.pauseReason ? { pause_reason: PAUSE_NAME[x.pauseReason] } : {}),
    done_orders: x.done,
    failed_orders: x.failed,
    unknown_orders: x.unknown,
    not_applied_orders: x.notApplied,
  })),
});

const requestView = (r: EventCancellationRequest): Record<string, unknown> => ({
  job_id: r.requestId,
  state: STATE_NAME[statusStateOf(r)],
  ...(r.refundWindowClosesAtMs !== undefined ? { refund_window_closes_at: timestampOf(r.refundWindowClosesAtMs) } : {}),
});

const statusStateOf = (r: EventCancellationRequest): RefundJobState => {
  if (r.status === 'COMPLETED') return 'COMPLETED';
  if (r.status === 'PAUSED') return 'PAUSED';
  if (r.status === 'REFUND_WINDOW') return 'REFUND_WINDOW';
  return 'RUNNING';
};

export type EventRefundGrpcUseCases = Pick<EventRefundService, 'preview' | 'start' | 'get' | 'pause' | 'resume' | 'apply' | 'closeWindow'>;

const statusOf = (err: unknown): grpc.ServiceError => {
  if (err instanceof EventRefundError) {
    const code = err.code === 'INVALID' ? grpc.status.INVALID_ARGUMENT : err.code === 'NOT_FOUND' ? grpc.status.NOT_FOUND : grpc.status.FAILED_PRECONDITION;
    return { code, details: err.message } as grpc.ServiceError;
  }
  return { code: grpc.status.UNAVAILABLE, details: '지금 처리할 수 없다' } as grpc.ServiceError;
};

export function eventRefundServiceHandlers(useCases: EventRefundGrpcUseCases): grpc.UntypedServiceImplementation {
  const unary =
    (fn: (r: Req) => Promise<object>): grpc.handleUnaryCall<Req, object> =>
    (call, cb) => {
      fn(call.request).then(
        (v) => cb(null, v),
        (err: unknown) => cb(statusOf(err)),
      );
    };
  return {
    PreviewEventRefund: unary(async (r) => {
      const p = await useCases.preview({ eventId: text(r.event_id), fault: faultOf(r.ruling) });
      return {
        target_orders: p.targetOrders,
        refund_total: { krw: p.refundTotal },
        compensation_targets: p.compensationTargets,
        compensation_total: { krw: p.compensationTotal },
        per_pg: p.perPg.map((x) => ({ pg: `PG_PROVIDER_${x.pg}`, orders: x.orders, estimated_seconds: x.estimatedSeconds })),
      };
    }),
    StartEventRefund: unary(async (r) => {
      const kind = KINDS[text(r.kind)] ?? 'CANCEL';
      const postponedToMs = msOf(r.postponed_to);
      const closesAtMs = msOf(r.refund_window_closes_at);
      const result = await useCases.start({
        eventId: text(r.event_id),
        requestId: text(r.cancellation_request_id),
        fault: faultOf(r.ruling),
        ruledBy: text(r.ruled_by),
        confirmedBy: text(r.confirmed_by),
        kind,
        ...(text(r.fan_notice_reason) !== '' ? { fanNoticeReason: text(r.fan_notice_reason) } : {}),
        ...(postponedToMs !== undefined ? { postponedToMs } : {}),
        ...(closesAtMs !== undefined ? { refundWindowClosesAtMs: closesAtMs } : {}),
      });
      return requestView(result);
    }),
    GetEventRefundJob: unary(async (r) => {
      const job = await useCases.get(text(r.job_id));
      return {
        ...progressView(job.progress),
        state: STATE_NAME[statusStateOf(job)],
        kind: job.kind === 'POSTPONE' ? 'EVENT_REFUND_KIND_POSTPONE' : 'EVENT_REFUND_KIND_CANCEL',
        ...(job.refundWindowClosesAtMs !== undefined ? { refund_window_closes_at: timestampOf(job.refundWindowClosesAtMs) } : {}),
        applied_orders: job.progress.total - job.progress.notApplied,
      };
    }),
    PauseEventRefundJob: unary(async (r) => {
      const pg = pgOf(r.pg);
      const result = await useCases.pause({ requestId: text(r.job_id), ...(pg ? { pg } : {}), reason: text(r.reason) });
      return requestView(result);
    }),
    ResumeEventRefundJob: unary(async (r) => {
      const pg = pgOf(r.pg);
      const result = await useCases.resume({ requestId: text(r.job_id), ...(pg ? { pg } : {}), ...(text(r.reason) !== '' ? { reason: text(r.reason) } : {}) });
      return requestView(result);
    }),
    ApplyEventRefund: unary(async (r) => {
      const appliedAtMs = msOf(r.applied_at);
      const result = await useCases.apply({
        requestId: text(r.request_id),
        ticketId: text(r.ticket_id),
        ...(text(r.application_id) !== '' ? { applicationId: text(r.application_id) } : {}),
        ...(appliedAtMs !== undefined ? { appliedAtMs } : {}),
      });
      return { accepted: true, ...progressView(result.progress), state: STATE_NAME[statusStateOf(result)] };
    }),
    CloseEventRefundWindow: unary(async (r) => {
      const result = await useCases.closeWindow({ requestId: text(r.request_id), closedBy: text(r.closed_by), reason: text(r.reason) });
      return { ...requestView(result), not_applied_orders: result.progress.notApplied };
    }),
  };
}

/** Nest에 올리지 않고 start.ts가 직접 gRPC 서버에 붙이는 처리기 묶음. 시험도 같은 함수를 쓴다 */
export class EventRefundGrpcController {
  constructor(readonly useCases: EventRefundGrpcUseCases) {}

  handlers(): grpc.UntypedServiceImplementation {
    return eventRefundServiceHandlers(this.useCases);
  }
}
