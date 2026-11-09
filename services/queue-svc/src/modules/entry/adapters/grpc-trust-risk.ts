// trust-svc ScoreRisk 호출(docs/api/proto/peaket/trust/v1/trust.proto, docs/features/bot-defense.md §4.6·§11.3, BUILD_ORDER BOT-050).
// 데드라인 800ms [가정], 호출 차단기(10초 창 20건·실패 50%·5초 열림, 공용 기본값). 판정을 받지 못하면(오류·데드라인 넘김·차단기 열림·알 수 없는 응답) 던지지 않고 UNAVAILABLE이다.
// 통과로 보지 않는다: 부르는 쪽이 토큰에 hd를 서명하고 파드 메모리 한도를 건다(§11.2).
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { trustV1Trust } from '@peaket/contracts/proto';
import { type CircuitBreaker, type CircuitBreakerOptions, createGrpcClient, type GrpcLbProfile, ProblemError } from '@peaket/platform';
import { Counter, type Registry } from '@peaket/platform';
import { noRiskSignals, type RiskFallbackReason, type RiskInput, type RiskPort, type RiskSignals, type RiskVerdict } from '../domain/ports.js';
import { REASONS, type ReasonCategory } from '../domain/queue.js';

export const TRUST_RISK_DEADLINE_MS = 800;
/** 호출 차단기의 설정 [가정]. 창·실패율·열린 시간은 공용 기본값이고, 파드마다 동시 호출 상한(벌크헤드)은 200건이다(§4.6의 초당 약 3,500건을 파드 수로 나눈 값의 몇 배, Q-T57에서 잰다) */
export const TRUST_BREAKER: Readonly<Pick<CircuitBreakerOptions, 'maxConcurrent'>> = Object.freeze({ maxConcurrent: 200 });

const PROTO_LOAD_OPTIONS: protoLoader.Options = { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true };
type Unary = (req: object, md: grpc.Metadata, opts: grpc.CallOptions, cb: (e: grpc.ServiceError | null, v?: Record<string, unknown>) => void) => grpc.ClientUnaryCall;

class InvalidVerdict extends Error {
  override readonly name = 'InvalidVerdict';
}

const SNAKE: Readonly<Record<string, string>> = {
  v: 'v',
  windowMs: 'window_ms',
  pointerMoves: 'pointer_moves',
  pointerEntropy: 'pointer_entropy',
  inputIntervalMeanMs: 'input_interval_mean_ms',
  inputIntervalStdMs: 'input_interval_std_ms',
  scrollEvents: 'scroll_events',
  scrollDistancePx: 'scroll_distance_px',
};

function behaviorOf(summary: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(summary)) {
    const name = SNAKE[k];
    if (name !== undefined && v !== undefined) out[name] = v;
  }
  return out;
}

function reasonOf(raw: unknown): ReasonCategory | undefined {
  const name = String(raw ?? '').replace(/^REASON_CATEGORY_/, '');
  return (REASONS as readonly string[]).includes(name) ? (name as ReasonCategory) : undefined;
}

export class GrpcTrustRisk implements RiskPort {
  readonly #client: grpc.Client & { ScoreRisk: Unary };

  constructor(
    address: string,
    profile: GrpcLbProfile = 'service',
    private readonly breaker: Pick<CircuitBreaker, 'run'> | undefined = undefined,
    private readonly signals: RiskSignals = noRiskSignals,
  ) {
    const def = protoLoader.fromJSON(trustV1Trust as Parameters<typeof protoLoader.fromJSON>[0], PROTO_LOAD_OPTIONS);
    const root = grpc.loadPackageDefinition(def) as unknown as { peaket: { trust: { v1: { TrustService: grpc.ServiceClientConstructor } } } };
    const at = address.lastIndexOf(':');
    const port = Number(address.slice(at + 1));
    if (at <= 0 || !Number.isInteger(port) || port <= 0) throw new Error(`trust-svc 주소는 host:port여야 한다: ${address}`);
    this.#client = createGrpcClient(root.peaket.trust.v1.TrustService, { host: address.slice(0, at), port, profile, dependency: 'trust-svc', timeoutCapMs: TRUST_RISK_DEADLINE_MS }) as unknown as grpc.Client & { ScoreRisk: Unary };
  }

  async score(i: RiskInput): Promise<RiskVerdict> {
    try {
      const call = () => this.#call(i);
      return await (this.breaker ? this.breaker.run(call) : call());
    } catch (e) {
      this.signals.fallback(reasonFromError(e));
      return { kind: 'UNAVAILABLE' };
    }
  }

  async #call(i: RiskInput): Promise<RiskVerdict> {
    const v = await new Promise<Record<string, unknown> | undefined>((res, rej) => {
      this.#client.ScoreRisk(requestOf(i), new grpc.Metadata(), { deadline: Date.now() + TRUST_RISK_DEADLINE_MS }, (e, r) => (e ? rej(e) : res(r)));
    });
    return verdictOf(v ?? {});
  }

  close(): void {
    this.#client.close();
  }
}

function requestOf(i: RiskInput): object {
  return {
    context: i.context === 'LOBBY' ? 'SCORE_CONTEXT_LOBBY_ENTRY' : 'SCORE_CONTEXT_PREVERIFY',
    event_id: i.eventId,
    pid: i.pid,
    account_id: i.accountId,
    device_id: i.deviceId,
    journey_id: i.journeyId,
    lobby_shuffle: i.lobbyShuffle ? 'LOBBY_SHUFFLE_ON' : 'LOBBY_SHUFFLE_OFF',
    ...(i.humanCheckToken ? { human_check_token: i.humanCheckToken } : {}),
    ...(i.behaviorSummary ? { behavior: behaviorOf(i.behaviorSummary) } : {}),
    ...(i.client ? { client: { ip: i.client.ip, user_agent: i.client.userAgent ?? '', client_hints: i.client.clientHints, asn: i.client.asn } } : {}),
    ...(i.firstVisitAtMs !== undefined ? { first_visit_at: { seconds: Math.floor(i.firstVisitAtMs / 1000), nanos: (i.firstVisitAtMs % 1000) * 1_000_000 } } : {}),
  };
}

/** 응답을 판정으로. 모르는 값은 던져 받지 못함으로 처리한다(통과로 보지 않는다) */
function verdictOf(r: Record<string, unknown>): RiskVerdict {
  if (r.verdict === 'VERDICT_ALLOW') return r.degraded === true ? { kind: 'HELD' } : { kind: 'OK' };
  if (r.verdict === 'VERDICT_CHALLENGE') {
    const reason = reasonOf(r.reason);
    if (reason === undefined) throw new InvalidVerdict('사유 범주 없는 CHALLENGE');
    return { kind: 'VERIFY', reason };
  }
  throw new InvalidVerdict(`모르는 판정 ${String(r.verdict)}`);
}

function reasonFromError(e: unknown): RiskFallbackReason {
  if (e instanceof InvalidVerdict) return 'invalid';
  if (e instanceof ProblemError && e.slug === 'dependency-unavailable') return 'open';
  if (typeof e === 'object' && e !== null && (e as { code?: unknown }).code === grpc.status.DEADLINE_EXCEEDED) return 'deadline';
  return 'error';
}

/** 판정을 받지 못한 까닭의 지표(docs/features/bot-defense.md §15) */
export class PromRiskSignals implements RiskSignals {
  readonly #fallback = new Counter({ name: 'trust_score_fallback_total', help: 'trust-svc 판정을 받지 못해 축소 운영으로 간 수(reason: open 차단기 열림, deadline 데드라인 넘김, error 그 밖의 오류, invalid 알 수 없는 응답)', labelNames: ['reason'] as const, registers: [] });

  register(registry: Registry): void {
    registry.registerMetric(this.#fallback);
  }

  fallback(reason: RiskFallbackReason): void {
    this.#fallback.inc({ reason });
  }
}
