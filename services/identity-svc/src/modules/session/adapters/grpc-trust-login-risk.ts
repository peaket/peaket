// 로그인 판정(trust-svc ScoreRisk, 맥락 LOGIN. docs/features/identity.md §7, docs/features/bot-defense.md §3.1, BUILD_ORDER BOT-050).
// 데드라인 300ms [가정], 호출 차단기. 받지 못하면(오류·데드라인 넘김·차단기 열림·알 수 없는 응답) 던지지 않고 UNKNOWN이다. 로그인은 막지 않고 양도·계좌 입력에서 안전 쪽으로 다룬다.
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { trustV1Trust } from '@peaket/contracts/proto';
import { type CircuitBreaker, type CircuitBreakerOptions, createGrpcClient, type GrpcLbProfile } from '@peaket/platform';
import type { LoginRisk, LoginVerdictResult } from '../domain/ports.js';

export const TRUST_LOGIN_DEADLINE_MS = 300;
/** 호출 차단기의 설정 [가정]. 창·실패율·열린 시간은 공용 기본값이고 파드마다 동시 호출 상한은 100건이다(로그인은 몰리는 경로가 아니다) */
export const TRUST_LOGIN_BREAKER: Readonly<Pick<CircuitBreakerOptions, 'minCalls' | 'maxConcurrent'>> = Object.freeze({ minCalls: 20, maxConcurrent: 100 });

const PROTO_LOAD_OPTIONS: protoLoader.Options = { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true };
type Unary = (req: object, md: grpc.Metadata, opts: grpc.CallOptions, cb: (e: grpc.ServiceError | null, v?: Record<string, unknown>) => void) => grpc.ClientUnaryCall;

export class GrpcTrustLoginRisk implements LoginRisk {
  readonly #client: grpc.Client & { ScoreRisk: Unary };

  constructor(
    address: string,
    profile: GrpcLbProfile = 'service',
    private readonly breaker?: Pick<CircuitBreaker, 'run'>,
  ) {
    const def = protoLoader.fromJSON(trustV1Trust as Parameters<typeof protoLoader.fromJSON>[0], PROTO_LOAD_OPTIONS);
    const root = grpc.loadPackageDefinition(def) as unknown as { peaket: { trust: { v1: { TrustService: grpc.ServiceClientConstructor } } } };
    const at = address.lastIndexOf(':');
    const port = Number(address.slice(at + 1));
    if (at <= 0 || !Number.isInteger(port) || port <= 0) throw new Error(`trust-svc 주소는 host:port여야 한다: ${address}`);
    this.#client = createGrpcClient(root.peaket.trust.v1.TrustService, { host: address.slice(0, at), port, profile, dependency: 'trust-svc', timeoutCapMs: TRUST_LOGIN_DEADLINE_MS }) as unknown as grpc.Client & { ScoreRisk: Unary };
  }

  async score(i: Parameters<LoginRisk['score']>[0]): Promise<LoginVerdictResult> {
    try {
      const call = () => this.#call(i);
      return await (this.breaker ? this.breaker.run(call) : call());
    } catch {
      return { verdict: 'UNKNOWN' };
    }
  }

  async #call(i: Parameters<LoginRisk['score']>[0]): Promise<LoginVerdictResult> {
    const r = await new Promise<Record<string, unknown> | undefined>((res, rej) => {
      this.#client.ScoreRisk(
        {
          context: 'SCORE_CONTEXT_LOGIN',
          account_id: i.accountId,
          device_id: i.deviceId ?? '',
          client: { ip: i.clientIp ?? '', user_agent: i.userAgent ?? '', asn: i.asn ?? 0 },
        },
        new grpc.Metadata(),
        { deadline: Date.now() + TRUST_LOGIN_DEADLINE_MS },
        (e, v) => {
          if (e) rej(e);
          else res(v);
        },
      );
    });
    return verdictOf(r ?? {});
  }

  close(): void {
    this.#client.close();
  }
}

function verdictOf(r: Record<string, unknown>): LoginVerdictResult {
  // degraded인 ALLOW는 근거가 모자란 통과다(의존성 장애·근거 신호 없음). ALLOW로 적으면 양도·계좌 입력의 재확인을 건너뛰므로 UNKNOWN이다(identity §7)
  if (r.verdict === 'VERDICT_ALLOW') return r.degraded === true ? { verdict: 'UNKNOWN' } : { verdict: 'ALLOW' };
  if (r.verdict === 'VERDICT_CHALLENGE') {
    const reason = String(r.reason ?? '').replace(/^REASON_CATEGORY_/, '');
    if (reason !== '' && reason !== 'UNSPECIFIED') return { verdict: 'CHALLENGE', reason };
  }
  // 모르는 판정·사유 없는 CHALLENGE는 ALLOW로 보지 않는다
  throw new Error('trust-svc 응답을 읽지 못했다');
}
