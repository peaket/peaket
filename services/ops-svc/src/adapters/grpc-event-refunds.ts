// ops-svc → purchase-svc 회차 취소 일괄 환불 gRPC 클라이언트(BAT-425 GAT-130).
// refund.proto EventRefundService가 정본이고, 주소가 없으면 ops-svc는 내부 HTTP 호환 경로로 물러난다.
// 호출자 머리는 ops-svc다(purchase-svc SetEventRefundHold는 내부 토큰이 있으면 호출자 ops-svc만 받는다, BAT-420 몫 D).
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { purchaseV1Refund } from '@peaket/contracts/proto';
import { createGrpcClient, type GrpcLbProfile } from '@peaket/platform';
import type { EventCancellationDryRun, EventCancellationFault, EventCancellationPg } from '../modules/event-cancellations/domain/event-cancellation.js';
import { EventRefundHoldConflict, type EventRefundJobProgress, type EventRefundReader, type EventRefundHolds } from '../modules/event-cancellations/domain/ports.js';

const PROTO_LOAD_OPTIONS: protoLoader.Options = { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true };
type Unary = (req: object, md: grpc.Metadata, opts: grpc.CallOptions, cb: (e: grpc.ServiceError | null, v?: Record<string, unknown>) => void) => grpc.ClientUnaryCall;
type Method = 'StartEventRefund' | 'GetEventRefundJob' | 'PauseEventRefundJob' | 'ResumeEventRefundJob' | 'PreviewEventRefund' | 'SetEventRefundHold';
type RefundClient = grpc.Client & Record<Method, Unary>;
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
  /** 판정 미리보기의 주문별 배상 목록. 있으면 purchase-svc가 금액을 다시 계산하지 않는다(BAT-425 RV-02) */
  readonly compensationOrders?: EventCancellationDryRun['compensationOrders'];
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
const PG_OF: Readonly<Record<string, EventCancellationPg>> = { PG_PROVIDER_TOSS: 'TOSS', PG_PROVIDER_PORTONE: 'PORTONE', PG_PROVIDER_SIMULATOR: 'SIMULATOR' };
/** proto enum 이름에서 앞머리를 뗀다(UNSPECIFIED·모르는 값은 undefined) */
const enumOf = (v: unknown, prefix: string): string | undefined => (typeof v === 'string' && v.startsWith(prefix) && v !== `${prefix}UNSPECIFIED` ? v.slice(prefix.length) : undefined);
const intOf = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v ?? 0) || 0);
/** peaket.common.v1.Money(krw)를 원으로 */
const krwOf = (v: unknown): number => intOf(typeof v === 'object' && v !== null ? (v as { krw?: unknown }).krw : undefined);
const rows = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? (v.filter((x) => typeof x === 'object' && x !== null) as Record<string, unknown>[]) : []);
const timestampOf = (ms: number): { seconds: number; nanos: number } => ({ seconds: Math.floor(ms / 1000), nanos: (ms % 1000) * 1_000_000 });
const msOf = (v: unknown): number | undefined => {
  const t = typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : undefined;
  return t ? Number(t.seconds) * 1000 + Math.floor(Number(t.nanos) / 1_000_000) : undefined;
};

export interface GrpcEventRefundsOptions {
  readonly address: string;
  readonly profile?: GrpcLbProfile;
}

export class GrpcEventRefunds implements EventRefundStarter, EventRefundReader, EventRefundHolds {
  readonly #client: RefundClient;

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
      caller: 'ops-svc',
    }) as unknown as RefundClient;
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
      ...(q.compensationOrders !== undefined
        ? {
            compensation_orders: q.compensationOrders.map((o) => ({ order_id: o.orderId, base_amount: { krw: o.baseAmount }, amount: { krw: o.amount } })),
          }
        : {}),
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

  /** PreviewEventRefund(BAT-420 GAT-110 W): 판정 미리보기. 금액(Money)은 원으로, 결제사별 주문 수·예상 시간(초)을 읽는다 */
  async preview(q: { eventId: string; requestId: string; fault: EventCancellationFault }): Promise<EventCancellationDryRun> {
    const a = await this.#call('PreviewEventRefund', { event_id: q.eventId, cancellation_request_id: q.requestId, ruling: FAULT[q.fault] });
    const compensationOrders = rows(a.compensation_orders).map((o) => ({
      orderId: typeof o.order_id === 'string' ? o.order_id : '',
      baseAmount: krwOf(o.base_amount),
      amount: krwOf(o.amount),
    }));
    return {
      targetOrders: intOf(a.target_orders),
      refundTotal: krwOf(a.refund_total),
      compensationTargets: intOf(a.compensation_targets),
      compensationTotal: krwOf(a.compensation_total),
      ...(compensationOrders.length > 0 ? { compensationOrders } : {}),
      perPg: rows(a.per_pg).flatMap((p) => {
        const pg = typeof p.pg === 'string' ? PG_OF[p.pg] : undefined;
        return pg ? [{ pg, orders: intOf(p.orders), estimatedSeconds: intOf(p.estimated_seconds) }] : [];
      }),
    };
  }

  /**
   * SetEventRefundHold(BAT-420 몫 D): 걸기·늘리기는 held 참과 기한 Timestamp, 풀기는 held 거짓만 보낸다(기한 없음).
   * ALREADY_EXISTS(그 회차에 다른 요청의 열린 미룸)는 EventRefundHoldConflict로, 그 밖의 실패(UNAVAILABLE·시간 초과 등)는 그대로 던진다
   */
  async hold(q: { eventId: string; requestId: string; held: boolean; expiresAtMs?: number }): Promise<{ held: boolean }> {
    try {
      const answer = await this.#call('SetEventRefundHold', {
        event_id: q.eventId,
        cancellation_request_id: q.requestId,
        held: q.held,
        ...(q.held && q.expiresAtMs !== undefined ? { expires_at: timestampOf(q.expiresAtMs) } : {}),
      });
      return { held: answer.held === true };
    } catch (err) {
      if ((err as Partial<grpc.ServiceError> | undefined)?.code === grpc.status.ALREADY_EXISTS) throw new EventRefundHoldConflict();
      throw err;
    }
  }

  /**
   * GetEventRefundJob의 진행률 칸을 다 읽는다(BAT-420 GAT-110 W): 결제사 몫마다 상태·멈춘 이유·끝남·실패·결과 모름, 연기 신청 수·신청 창 닫힘.
   * purchase-svc에 그 일괄 환불이 없으면(NOT_FOUND) undefined다(웨이브 끝 리뷰 K4). 그 밖의 실패는 그대로 던진다
   */
  async job(q: { requestId: string }): Promise<EventRefundJobProgress | undefined> {
    let a: Record<string, unknown>;
    try {
      a = await this.#call('GetEventRefundJob', { job_id: q.requestId });
    } catch (err) {
      if ((err as Partial<grpc.ServiceError> | undefined)?.code === grpc.status.NOT_FOUND) return undefined;
      throw err;
    }
    const closesAtMs = msOf(a.refund_window_closes_at);
    return {
      state: enumOf(a.state, 'REFUND_JOB_STATE_') ?? 'UNKNOWN',
      total: intOf(a.total_orders),
      done: intOf(a.done_orders),
      failed: intOf(a.failed_orders),
      // 계좌 대기 수(BAT-420-rest 리뷰 반영 RV-05). 0(칸 없는 옛 답 포함)이면 싣지 않는다
      ...(intOf(a.account_pending_orders) > 0 ? { accountPending: intOf(a.account_pending_orders) } : {}),
      perPg: rows(a.per_pg).flatMap((p) => {
        const pg = typeof p.pg === 'string' ? PG_OF[p.pg] : undefined;
        if (!pg) return [];
        const pauseReason = enumOf(p.pause_reason, 'REFUND_PAUSE_REASON_');
        return [{ pg, state: enumOf(p.state, 'REFUND_JOB_STATE_') ?? 'UNKNOWN', ...(pauseReason !== undefined ? { pauseReason } : {}), done: intOf(p.done_orders), failed: intOf(p.failed_orders), unknown: intOf(p.unknown_orders), recentCalls: intOf(p.recent_calls), recentFailures: intOf(p.recent_failures) }];
      }),
      ...(a.kind === 'EVENT_REFUND_KIND_POSTPONE' ? { appliedOrders: intOf(a.applied_orders) } : {}),
      ...(closesAtMs !== undefined && closesAtMs > 0 ? { refundWindowClosesAt: new Date(closesAtMs).toISOString() } : {}),
    };
  }

  async #call(method: Method, req: object): Promise<Record<string, unknown>> {
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
