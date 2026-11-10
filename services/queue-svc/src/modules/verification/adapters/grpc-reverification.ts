// identity-svc ReverificationCheckService.CheckReverification 호출(docs/api/proto identity.proto, docs/features/bot-defense.md §5.2 3단계, I-T56 ④).
// 데드라인 800ms [가정](추가 검증 제출의 ScoreRisk와 같은 값, 요청 안이면 남은 시간과 짧은 쪽), 호출 차단기(공용 기본값).
// 답을 받지 못하면(오류·데드라인 넘김·차단기 열림·모르는 결과) ReverificationUnavailable을 던진다. 부르는 쪽은 통과로 보지 않고 503이다.
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { identityV1Identity } from '@peaket/contracts/proto';
import { type CircuitBreaker, createGrpcClient, type GrpcLbProfile } from '@peaket/platform';
import { type ReverificationPort, type ReverificationResult, ReverificationUnavailable } from '../domain/ports.js';

export const REVERIFICATION_DEADLINE_MS = 800;

const PROTO_LOAD_OPTIONS: protoLoader.Options = { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true };
type Unary = (req: object, md: grpc.Metadata, opts: grpc.CallOptions, cb: (e: grpc.ServiceError | null, v?: Record<string, unknown>) => void) => grpc.ClientUnaryCall;

const RESULT: Readonly<Record<string, ReverificationResult>> = {
  REVERIFICATION_RESULT_PASSED: 'PASSED',
  REVERIFICATION_RESULT_NOT_FOUND: 'NOT_FOUND',
  REVERIFICATION_RESULT_PERSON_MISMATCH: 'PERSON_MISMATCH',
};

export class GrpcReverification implements ReverificationPort {
  readonly #client: grpc.Client & { CheckReverification: Unary };

  constructor(
    address: string,
    profile: GrpcLbProfile = 'service',
    private readonly breaker: Pick<CircuitBreaker, 'run'> | undefined = undefined,
  ) {
    const def = protoLoader.fromJSON(identityV1Identity as Parameters<typeof protoLoader.fromJSON>[0], PROTO_LOAD_OPTIONS);
    const root = grpc.loadPackageDefinition(def) as unknown as { peaket: { identity: { v1: { ReverificationCheckService: grpc.ServiceClientConstructor } } } };
    const at = address.lastIndexOf(':');
    const port = Number(address.slice(at + 1));
    if (at <= 0 || !Number.isInteger(port) || port <= 0) throw new Error(`identity-svc 주소는 host:port여야 한다: ${address}`);
    this.#client = createGrpcClient(root.peaket.identity.v1.ReverificationCheckService, { host: address.slice(0, at), port, profile, dependency: 'identity-svc', timeoutCapMs: REVERIFICATION_DEADLINE_MS }) as unknown as grpc.Client & {
      CheckReverification: Unary;
    };
  }

  async check(i: { accountId: string; pid: string; notBeforeMs: number }): Promise<ReverificationResult> {
    let r: Record<string, unknown>;
    try {
      const call = () => this.#call(i);
      r = await (this.breaker ? this.breaker.run(call) : call());
    } catch (e) {
      throw new ReverificationUnavailable('identity-svc가 답하지 않았다', e);
    }
    const result = RESULT[String(r.result ?? '')];
    if (!result) throw new ReverificationUnavailable(`모르는 재통과 결과 ${String(r.result)}`);
    return result;
  }

  #call(i: { accountId: string; pid: string; notBeforeMs: number }): Promise<Record<string, unknown>> {
    return new Promise((res, rej) => {
      this.#client.CheckReverification({ account_id: i.accountId, pid: i.pid, not_before_ms: i.notBeforeMs }, new grpc.Metadata(), { deadline: Date.now() + REVERIFICATION_DEADLINE_MS }, (e, v) => (e ? rej(e) : res(v ?? {})));
    });
  }

  close(): void {
    this.#client.close();
  }
}
