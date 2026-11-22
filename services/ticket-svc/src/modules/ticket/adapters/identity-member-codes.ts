// identity MemberCodeService.ResolveMemberCodes 클라이언트(BUILD_ORDER GAT-050, ADR-0261 결정 6).
// 양도 받는 사람 찾기(회원 코드)에 쓴다. 한 코드씩 부르고 데드라인 2초 [가정]다. 실패는 삼키지 않고 UNAVAILABLE로 던진다(부르는 쪽이 503).
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { identityV1Identity } from '@peaket/contracts/proto';
import { createGrpcClient, type GrpcLbProfile } from '@peaket/platform';
import type { MemberCodeDirectory } from '../domain/transfer-ports.js';

const DEADLINE_CAP_MS = 2_000;
const PROTO_LOAD_OPTIONS: protoLoader.Options = { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true };
type Unary = (req: object, md: grpc.Metadata, opts: grpc.CallOptions, cb: (e: grpc.ServiceError | null, v?: Record<string, unknown>) => void) => grpc.ClientUnaryCall;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class GrpcMemberCodeDirectory implements MemberCodeDirectory {
  readonly #client: grpc.Client & { ResolveMemberCodes: Unary };

  constructor(address: string, profile: GrpcLbProfile = 'service') {
    const def = protoLoader.fromJSON(identityV1Identity as Parameters<typeof protoLoader.fromJSON>[0], PROTO_LOAD_OPTIONS);
    const pkg = (grpc.loadPackageDefinition(def) as unknown as { peaket: { identity: { v1: Record<string, unknown> } } }).peaket.identity.v1;
    const at = address.lastIndexOf(':');
    const port = Number(address.slice(at + 1));
    if (at <= 0 || !Number.isInteger(port) || port <= 0) throw new Error(`PEAKET_IDENTITY_GRPC_URL이 host:port여야 한다: ${address}`);
    this.#client = createGrpcClient(pkg.MemberCodeService as grpc.ServiceClientConstructor, {
      host: address.slice(0, at),
      port,
      profile,
      dependency: 'identity-svc',
      timeoutCapMs: DEADLINE_CAP_MS,
    }) as unknown as grpc.Client & { ResolveMemberCodes: Unary };
  }

  async resolveMemberCode(code: string): Promise<{ accountId: string; nickname: string } | undefined> {
    const resolved = await new Promise<unknown>((resolve, reject) => {
      this.#client.ResolveMemberCodes({ member_codes: [code] }, new grpc.Metadata(), { deadline: Date.now() + DEADLINE_CAP_MS }, (e, v) => (e ? reject(e) : resolve(v?.resolved)));
    });
    if (!Array.isArray(resolved)) throw new Error('회원 코드 답의 모양이 틀렸다');
    const row = resolved[0] as Record<string, unknown> | undefined;
    const accountId = typeof row?.account_id === 'string' ? row.account_id.toLowerCase() : undefined;
    if (accountId === undefined) return undefined;
    if (!UUID.test(accountId)) throw new Error('회원 코드 답의 계정 ID가 UUID가 아니다');
    // ResolveMemberCodes는 닉네임을 싣지 않는다. 화면에는 '회원'으로 가린다(닉네임 조회는 후속)
    return { accountId, nickname: '회원' };
  }

  close(): void {
    this.#client.close();
  }
}
