// identity-svc ReverificationCheckService.VerifyBoothReverification 클라이언트(F-05-12 O-T28 ①).
// ticket-svc는 부스 코드를 만들기 전에 이 gRPC로 대조 토큰(5분, 계정·티켓 묶임)을 확인한다.
// 새 HTTP 주소·환경 값을 만들지 않고 기존 PEAKET_IDENTITY_GRPC_URL을 그대로 쓴다.
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { identityV1Identity } from '@peaket/contracts/proto';
import { createGrpcClient, type GrpcLbProfile } from '@peaket/platform';

/** 부스 대조 토큰 확인 포트(application/booth.ts의 BoothReverificationVerifier와 같은 모양) */
interface BoothReverificationVerifier {
  verify(i: { token: string; accountId: string; ticketId: string }): Promise<boolean>;
}

const DEADLINE_CAP_MS = 1_000;
const PROTO_LOAD_OPTIONS: protoLoader.Options = { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true };
type Unary = (req: object, md: grpc.Metadata, opts: grpc.CallOptions, cb: (e: grpc.ServiceError | null, v?: Record<string, unknown>) => void) => grpc.ClientUnaryCall;

export class GrpcBoothReverificationVerifier implements BoothReverificationVerifier {
  readonly #client: grpc.Client & { VerifyBoothReverification: Unary };

  constructor(address: string, profile: GrpcLbProfile = 'service') {
    const def = protoLoader.fromJSON(identityV1Identity as Parameters<typeof protoLoader.fromJSON>[0], PROTO_LOAD_OPTIONS);
    const pkg = (grpc.loadPackageDefinition(def) as unknown as { peaket: { identity: { v1: Record<string, unknown> } } }).peaket.identity.v1;
    const at = address.lastIndexOf(':');
    const port = Number(address.slice(at + 1));
    if (at <= 0 || !Number.isInteger(port) || port <= 0) throw new Error(`PEAKET_IDENTITY_GRPC_URL이 host:port여야 한다: ${address}`);
    this.#client = createGrpcClient(pkg.ReverificationCheckService as grpc.ServiceClientConstructor, {
      host: address.slice(0, at),
      port,
      profile,
      dependency: 'identity-svc',
      timeoutCapMs: DEADLINE_CAP_MS,
    }) as unknown as grpc.Client & { VerifyBoothReverification: Unary };
  }

  verify(i: { token: string; accountId: string; ticketId: string }): Promise<boolean> {
    return new Promise((res, rej) => {
      this.#client.VerifyBoothReverification(
        { token: i.token, account_id: i.accountId, ticket_id: i.ticketId },
        new grpc.Metadata(),
        { deadline: Date.now() + DEADLINE_CAP_MS },
        (e, v) => (e ? rej(e) : res(v?.ok === true)),
      );
    });
  }
}
