// ops-svc → payment-svc 명령 6 대체 결제사 전환의 갈 곳 묻기 gRPC 클라이언트(PaymentService.ResolvePgSwitch, F-02-2 OPS-310, ADR-0366 결정 5).
// payment.proto가 정본이고 부르는 쪽은 ops-svc뿐이다(deploy/platform/mesh/port-allow.yaml). 데드라인 2초 [가정]. 아무것도 쓰지 않는 읽기다.
// 실패(UNAVAILABLE·DEADLINE_EXCEEDED·INVALID_ARGUMENT 등)는 그대로 던진다(부르는 쪽이 503 pg-check-unavailable로 바꾼다).
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { paymentV1Payment } from '@peaket/contracts/proto';
import { createGrpcClient, type GrpcLbProfile } from '@peaket/platform';
import type { PgSwitchRoute, PgSwitchRoutes } from '../domain/pg-switch.js';
import type { PgName, PgSwitchResolver } from '../domain/ports.js';

const PROTO_LOAD_OPTIONS: protoLoader.Options = { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true };
type Unary = (req: object, md: grpc.Metadata, opts: grpc.CallOptions, cb: (e: grpc.ServiceError | null, v?: Record<string, unknown>) => void) => grpc.ClientUnaryCall;
type PaymentClient = grpc.Client & { ResolvePgSwitch: Unary };
type PaymentPackage = { PaymentService: grpc.ServiceClientConstructor };

let loaded: PaymentPackage | undefined;
function paymentPackage(): PaymentPackage {
  if (!loaded) {
    const def = protoLoader.fromJSON(paymentV1Payment as Parameters<typeof protoLoader.fromJSON>[0], PROTO_LOAD_OPTIONS);
    loaded = (grpc.loadPackageDefinition(def) as unknown as { peaket: { payment: { v1: PaymentPackage } } }).peaket.payment.v1;
  }
  return loaded;
}

/** 묻기 데드라인 2초 [가정](ADR-0366 결정 5) */
export const PG_SWITCH_RESOLVE_TIMEOUT_MS = 2_000;

const PG_TO_PROTO: Readonly<Record<PgName, string>> = { TOSS: 'PG_PROVIDER_TOSS', PORTONE: 'PG_PROVIDER_PORTONE', SIMULATOR: 'PG_PROVIDER_SIMULATOR' };
const PG_OF_PROTO: Readonly<Record<string, PgName>> = { PG_PROVIDER_TOSS: 'TOSS', PG_PROVIDER_PORTONE: 'PORTONE', PG_PROVIDER_SIMULATOR: 'SIMULATOR' };
const pgOf = (v: unknown): PgName | undefined => (typeof v === 'string' ? PG_OF_PROTO[v] : undefined);
const rowOf = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {});

/**
 * 응답을 갈 곳으로 읽는다. 물은 회차마다 한 줄이 있어야 하고 결제사가 맞아야 한다(모양이 틀린 답은 던진다). 상한이 수가 아니면 0으로 읽는다(부르는 쪽이 모름으로 막는다)
 * @throws Error 물은 회차의 줄이 없거나 결제사가 틀림
 */
export function pgSwitchRoutesOf(a: Record<string, unknown>, eventIds: readonly string[]): PgSwitchRoutes {
  const byEvent = new Map<string, PgSwitchRoute>();
  for (const raw of Array.isArray(a.routes) ? a.routes : []) {
    const r = rowOf(raw);
    const eventId = typeof r.event_id === 'string' ? r.event_id : '';
    const pg = pgOf(r.pg);
    const aps = Number(r.approvals_per_second);
    if (eventId !== '' && pg) byEvent.set(eventId, { eventId, pg, approvalsPerSecond: Number.isFinite(aps) && aps > 0 ? aps : 0 });
  }
  const routes = eventIds.map((id) => {
    const r = byEvent.get(id);
    if (!r) throw new Error('payment-svc ResolvePgSwitch 답에 물은 회차의 줄이 없다');
    return r;
  });
  const approvalLimits: Partial<Record<PgName, number>> = {};
  for (const raw of Array.isArray(a.approval_limits) ? a.approval_limits : []) {
    const l = rowOf(raw);
    const pg = pgOf(l.pg);
    const tps = Number(l.approvals_per_second);
    if (pg && Number.isFinite(tps) && tps > 0) approvalLimits[pg] = tps;
  }
  return { routes, approvalLimits };
}

export interface GrpcPgSwitchResolverOptions {
  /** payment-svc 업무 gRPC host:port(PEAKET_PAYMENT_GRPC_ADDR) */
  readonly address: string;
  readonly profile?: GrpcLbProfile;
}

export class GrpcPgSwitchResolver implements PgSwitchResolver {
  readonly #client: PaymentClient;

  constructor(o: GrpcPgSwitchResolverOptions) {
    const at = o.address.lastIndexOf(':');
    const port = Number(o.address.slice(at + 1));
    if (at <= 0 || !Number.isInteger(port) || port <= 0 || port > 65_535) throw new Error('PEAKET_PAYMENT_GRPC_ADDR는 host:port여야 한다');
    this.#client = createGrpcClient(paymentPackage().PaymentService, {
      host: o.address.slice(0, at),
      port,
      profile: o.profile ?? 'service',
      dependency: 'payment-svc',
      timeoutCapMs: PG_SWITCH_RESOLVE_TIMEOUT_MS,
      caller: 'ops-svc',
    }) as unknown as PaymentClient;
  }

  async resolve(q: { readonly eventIds: readonly string[]; readonly toPg?: PgName }): Promise<PgSwitchRoutes> {
    const answer = await new Promise<Record<string, unknown>>((resolve, reject) => {
      this.#client.ResolvePgSwitch({ event_ids: [...q.eventIds], to_pg: q.toPg ? PG_TO_PROTO[q.toPg] : 'PG_PROVIDER_UNSPECIFIED' }, new grpc.Metadata(), {}, (e, v) => (e ? reject(e) : resolve(v ?? {})));
    });
    return pgSwitchRoutesOf(answer, q.eventIds);
  }

  close(): void {
    this.#client.close();
  }
}
