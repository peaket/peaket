// ops-svc → payment-svc 하위 결제사 판정 gRPC 클라이언트(PaymentService.CheckEventPgAssignment, ADR-0349 결정 3, BAT-360).
// payment.proto가 정본이고, 부르는 쪽은 ops-svc뿐이다(docs/api/proto/README.md §3, deploy/platform/mesh/port-allow.yaml). 데드라인 2초 [가정].
// payment-svc가 PRF-203 규칙 함수로 판정하고 아무것도 쓰지 않는다. 실패(UNAVAILABLE·DEADLINE_EXCEEDED·INVALID_ARGUMENT 등)는 그대로 던진다(받는 쪽이 503 pg-check-unavailable로 바꾼다).
// 응답에서 읽는 값은 허용 여부, 걸린 하위 결제사 이름과 까닭, 지금 지정, 결제사별 승인 상한뿐이다(채널 키는 오지 않는다).
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { paymentV1Payment } from '@peaket/contracts/proto';
import { createGrpcClient, type GrpcLbProfile } from '@peaket/platform';
import type { PgAssignmentCheck, PgAssignmentVerdict, PgName } from '../domain/ports.js';

const PROTO_LOAD_OPTIONS: protoLoader.Options = { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true };
type Unary = (req: object, md: grpc.Metadata, opts: grpc.CallOptions, cb: (e: grpc.ServiceError | null, v?: Record<string, unknown>) => void) => grpc.ClientUnaryCall;
type PaymentClient = grpc.Client & { CheckEventPgAssignment: Unary };
type PaymentPackage = { PaymentService: grpc.ServiceClientConstructor };

let loaded: PaymentPackage | undefined;
function paymentPackage(): PaymentPackage {
  if (!loaded) {
    const def = protoLoader.fromJSON(paymentV1Payment as Parameters<typeof protoLoader.fromJSON>[0], PROTO_LOAD_OPTIONS);
    loaded = (grpc.loadPackageDefinition(def) as unknown as { peaket: { payment: { v1: PaymentPackage } } }).peaket.payment.v1;
  }
  return loaded;
}

/** 판정 데드라인 2초 [가정](ADR-0349 결정 3) */
export const PG_CHECK_GRPC_TIMEOUT_MS = 2_000;

const PG_TO_PROTO: Readonly<Record<PgName, string>> = { TOSS: 'PG_PROVIDER_TOSS', PORTONE: 'PG_PROVIDER_PORTONE', SIMULATOR: 'PG_PROVIDER_SIMULATOR' };
const PG_OF_PROTO: Readonly<Record<string, PgName>> = { PG_PROVIDER_TOSS: 'TOSS', PG_PROVIDER_PORTONE: 'PORTONE', PG_PROVIDER_SIMULATOR: 'SIMULATOR' };
const pgOf = (v: unknown): PgName | undefined => (typeof v === 'string' ? PG_OF_PROTO[v] : undefined);

/** 응답을 판정으로 읽는다. 걸렸는데 하위 결제사 이름이 없으면 모양이 틀린 답이라 던진다 */
export function pgAssignmentVerdictOf(a: Record<string, unknown>): PgAssignmentVerdict {
  const allowed = a.allowed === true;
  const sub = typeof a.conflict_sub_provider === 'string' ? a.conflict_sub_provider : '';
  const reason = typeof a.conflict_reason === 'string' ? a.conflict_reason : '';
  if (!allowed && sub === '') throw new Error('payment-svc CheckEventPgAssignment 답의 하위 결제사가 비었다');
  const primary = pgOf(a.current_primary_pg);
  const fallback = pgOf(a.current_fallback_pg);
  const approvalLimits: Partial<Record<PgName, number>> = {};
  for (const l of Array.isArray(a.approval_limits) ? a.approval_limits : []) {
    const row = typeof l === 'object' && l !== null ? (l as Record<string, unknown>) : {};
    const pg = pgOf(row.pg);
    const tps = Number(row.approvals_per_second);
    if (pg && Number.isFinite(tps) && tps > 0) approvalLimits[pg] = tps;
  }
  return {
    allowed,
    ...(allowed ? {} : { conflict: { subProvider: sub, reason: reason || 'UNKNOWN' } }),
    ...(primary ? { current: { primaryPg: primary, ...(fallback ? { fallbackPg: fallback } : {}) } } : {}),
    approvalLimits,
  };
}

export interface GrpcPgAssignmentCheckOptions {
  /** payment-svc gRPC host:port(PEAKET_PAYMENT_GRPC_ADDR) */
  readonly address: string;
  readonly profile?: GrpcLbProfile;
}

export class GrpcPgAssignmentCheck implements PgAssignmentCheck {
  readonly #client: PaymentClient;

  constructor(o: GrpcPgAssignmentCheckOptions) {
    const at = o.address.lastIndexOf(':');
    const port = Number(o.address.slice(at + 1));
    if (at <= 0 || !Number.isInteger(port) || port <= 0 || port > 65_535) throw new Error('PEAKET_PAYMENT_GRPC_ADDR는 host:port여야 한다');
    this.#client = createGrpcClient(paymentPackage().PaymentService, {
      host: o.address.slice(0, at),
      port,
      profile: o.profile ?? 'service',
      dependency: 'payment-svc',
      timeoutCapMs: PG_CHECK_GRPC_TIMEOUT_MS,
      caller: 'ops-svc',
    }) as unknown as PaymentClient;
  }

  async check(q: { eventId: string; primaryPg: PgName; fallbackPg?: PgName }): Promise<PgAssignmentVerdict> {
    const answer = await new Promise<Record<string, unknown>>((resolve, reject) => {
      this.#client.CheckEventPgAssignment(
        { event_id: q.eventId, primary_pg: PG_TO_PROTO[q.primaryPg], fallback_pg: q.fallbackPg ? PG_TO_PROTO[q.fallbackPg] : 'PG_PROVIDER_UNSPECIFIED' },
        new grpc.Metadata(),
        {},
        (e, v) => (e ? reject(e) : resolve(v ?? {})),
      );
    });
    return pgAssignmentVerdictOf(answer);
  }

  close(): void {
    this.#client.close();
  }
}
