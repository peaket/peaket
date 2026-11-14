// ops-svc → purchase-svc 회차 취소 일괄 환불 gRPC 클라이언트(BAT-425 GAT-130).
// refund.proto EventRefundService가 정본이고, 주소가 없으면 ops-svc는 내부 HTTP 호환 경로로 물러난다.
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { purchaseV1Refund } from '@peaket/contracts/proto';
import { createGrpcClient, type GrpcLbProfile } from '@peaket/platform';

const PROTO_LOAD_OPTIONS: protoLoader.Options = { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true };
type Unary = (req: object, md: grpc.Metadata, opts: grpc.CallOptions, cb: (e: grpc.ServiceError | null, v?: Record<string, unknown>) => void) => grpc.ClientUnaryCall;
type RefundPackage = { EventRefundService: grpc.ServiceClientConstructor };

let loaded: RefundPackage | undefined;
function refundPackage(): RefundPackage {
  if (!loaded) {
    const def = protoLoader.fromJSON(purchaseV1Refund as Parameters<typeof protoLoader.fromJSON>[0], PROTO_LOAD_OPTIONS);
    loaded = (grpc.loadPackageDefinition(def) as unknown as { peaket: { purchase: { v1: RefundPackage } } }).peaket.purchase.v1;
  }
  return loaded;
}

export type RefundFault = 'ORGANIZER' | 'FORCE_MAJEURE' | 'CONTENT_CHANGE';
export type RefundKind = 'CANCEL' | 'POSTPONE';
export type RefundPg = 'TOSS' | 'PORTONE' | 'SIMULATOR';

export interface StartEventRefundCommand {
  readonly eventId: string;
  /** 멱등 키(ops 명령 ID) */
  readonly requestId: string;
  readonly fault: RefundFault;
  readonly ruledBy: string;
  readonly confirmedBy: string;
  readonly kind?: RefundKind;
  readonly fanNoticeReason?: string;
  readonly postponedToMs?: number;
  readonly refundWindowClosesAtMs?: number;
}

export interface EventRefundJobView {
  readonly jobId: string;
  readonly state: string;
  readonly refundWindowClosesAtMs?: number;
}

export interface EventRefundStarter {
  start(q: StartEventRefundCommand): Promise<EventRefundJobView>;
  pause(q: { requestId: string; pg?: RefundPg; reason: string }): Promise<EventRefundJobView>;
  resume(q: { requestId: string; pg?: RefundPg; reason?: string }): Promise<EventRefundJobView>;
  get(q: { requestId: string }): Promise<EventRefundJobView>;
}

const FAULT: Record<RefundFault, string> = {
  ORGANIZER: 'CANCELLATION_RULING_ORGANIZER',
  FORCE_MAJEURE: 'CANCELLATION_RULING_FORCE_MAJEURE',
  CONTENT_CHANGE: 'CANCELLATION_RULING_CONTENT_CHANGE',
};
const KIND: Record<RefundKind, string> = { CANCEL: 'EVENT_REFUND_KIND_CANCEL', POSTPONE: 'EVENT_REFUND_KIND_POSTPONE' };
const PG: Record<RefundPg, string> = { TOSS: 'PG_PROVIDER_TOSS', PORTONE: 'PG_PROVIDER_PORTONE', SIMULATOR: 'PG_PROVIDER_SIMULATOR' };
const timestampOf = (ms: number): { seconds: number; nanos: number } => ({ seconds: Math.floor(ms / 1000), nanos: (ms % 1000) * 1_000_000 });
const msOf = (v: unknown): number | undefined => {
  const t = typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : undefined;
  return t ? Number(t.seconds) * 1000 + Math.floor(Number(t.nanos) / 1_000_000) : undefined;
};

export interface GrpcEventRefundsOptions {
  readonly address: string;
  readonly profile?: GrpcLbProfile;
}

export class GrpcEventRefunds implements EventRefundStarter {
  readonly #client: grpc.Client & { StartEventRefund: Unary; GetEventRefundJob: Unary; PauseEventRefundJob: Unary; ResumeEventRefundJob: Unary };

  constructor(o: GrpcEventRefundsOptions) {
    const at = o.address.lastIndexOf(':');
    const port = Number(o.address.slice(at + 1));
    if (at <= 0 || !Number.isInteger(port) || port <= 0 || port > 65_535) throw new Error('PEAKET_PURCHASE_GRPC_ADDR는 host:port여야 한다');
    this.#client = createGrpcClient(refundPackage().EventRefundService, {
      host: o.address.slice(0, at),
      port,
      profile: o.profile ?? 'service',
      dependency: 'purchase-svc',
      timeoutCapMs: 30_000,
    }) as unknown as grpc.Client & { StartEventRefund: Unary; GetEventRefundJob: Unary; PauseEventRefundJob: Unary; ResumeEventRefundJob: Unary };
  }

  async start(q: StartEventRefundCommand): Promise<EventRefundJobView> {
    const answer = await this.#call('StartEventRefund', {
      event_id: q.eventId,
      cancellation_request_id: q.requestId,
      ruling: FAULT[q.fault],
      ruled_by: q.ruledBy,
      confirmed_by: q.confirmedBy,
      confirmed_at: timestampOf(Date.now()),
      kind: KIND[q.kind ?? 'CANCEL'],
      ...(q.fanNoticeReason !== undefined ? { fan_notice_reason: q.fanNoticeReason } : {}),
      ...(q.postponedToMs !== undefined ? { postponed_to: timestampOf(q.postponedToMs) } : {}),
      ...(q.refundWindowClosesAtMs !== undefined ? { refund_window_closes_at: timestampOf(q.refundWindowClosesAtMs) } : {}),
    });
    return viewOf(answer);
  }

  async pause(q: { requestId: string; pg?: RefundPg; reason: string }): Promise<EventRefundJobView> {
    const answer = await this.#call('PauseEventRefundJob', {
      job_id: q.requestId,
      ...(q.pg ? { pg: PG[q.pg] } : {}),
      reason: q.reason,
    });
    return viewOf({ job_id: q.requestId, ...answer });
  }

  async resume(q: { requestId: string; pg?: RefundPg; reason?: string }): Promise<EventRefundJobView> {
    const answer = await this.#call('ResumeEventRefundJob', {
      job_id: q.requestId,
      ...(q.pg ? { pg: PG[q.pg] } : {}),
      ...(q.reason !== undefined ? { reason: q.reason } : {}),
    });
    return viewOf({ job_id: q.requestId, ...answer });
  }

  async get(q: { requestId: string }): Promise<EventRefundJobView> {
    const answer = await this.#call('GetEventRefundJob', { job_id: q.requestId });
    return viewOf({ job_id: q.requestId, ...answer });
  }

  async #call(method: 'StartEventRefund' | 'GetEventRefundJob' | 'PauseEventRefundJob' | 'ResumeEventRefundJob', req: object): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      this.#client[method](req, new grpc.Metadata(), {}, (e, v) => (e ? reject(e) : resolve(v ?? {})));
    });
  }

  close(): void {
    this.#client.close();
  }
}

function viewOf(v: Record<string, unknown>): EventRefundJobView {
  const closes = msOf(v.refund_window_closes_at);
  return {
    jobId: typeof v.job_id === 'string' ? v.job_id : '',
    state: typeof v.state === 'string' ? v.state.replace(/^REFUND_JOB_STATE_/, '') : 'UNKNOWN',
    ...(closes !== undefined ? { refundWindowClosesAtMs: closes } : {}),
  };
}
