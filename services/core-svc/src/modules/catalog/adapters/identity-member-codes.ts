// identity MemberCodeService.ResolveMemberCodes 클라이언트(docs/api/proto/peaket/identity/v1/identity.proto, ADR-0261 결정 6, BUILD_ORDER HOT-250).
// - 회원 코드를 1만 개 [가정]씩 데드라인 2초 [가정]로 차례대로 부른다. 서버는 BUILD_ORDER GAT-050이 만든다(그 전에는 UNIMPLEMENTED라 올리기가 503이다).
// - gRPC 오류(UNAVAILABLE·DEADLINE_EXCEEDED·UNIMPLEMENTED·INTERNAL과 그 밖)는 모두 MemberCodeLookupFailed다(부분 결과를 돌려주지 않는다).
// - 답을 그대로 믿지 않는다: 보낸 코드가 아닌 것, 계정 ID가 UUID가 아닌 것, 한 코드에 다른 계정이 둘인 것은 정한 모양이 아닌 답으로 실패다.
// - 주소는 AdminAuthzService와 같은 PEAKET_IDENTITY_GRPC_URL이다. 회원 코드·계정 ID는 기록에 넣지 않는다(건수만).
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { identityV1Identity } from '@peaket/contracts/proto';
import { createGrpcClient, type GrpcLbProfile } from '@peaket/platform';
import { type MemberCodeDirectory, MemberCodeLookupFailed } from '../domain/eligibility-ports.js';
import { RESOLVE_BATCH, RESOLVE_DEADLINE_MS } from '../domain/sale-eligibility.js';
import { hostPort } from './seatmap-worker-client.js';

const PROTO_LOAD_OPTIONS: protoLoader.Options = { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Unary = (req: object, md: grpc.Metadata, opts: grpc.CallOptions, cb: (e: grpc.ServiceError | null, v?: Record<string, unknown>) => void) => grpc.ClientUnaryCall;

export class GrpcMemberCodeDirectory implements MemberCodeDirectory {
  readonly #client: grpc.Client & { ResolveMemberCodes: Unary };

  constructor(address: string, profile: GrpcLbProfile = 'service') {
    const def = protoLoader.fromJSON(identityV1Identity as Parameters<typeof protoLoader.fromJSON>[0], PROTO_LOAD_OPTIONS);
    const pkg = (grpc.loadPackageDefinition(def) as unknown as { peaket: { identity: { v1: Record<string, unknown> } } }).peaket.identity.v1;
    const { host, port } = hostPort(address, 'PEAKET_IDENTITY_GRPC_URL');
    this.#client = createGrpcClient(pkg.MemberCodeService as grpc.ServiceClientConstructor, { host, port, profile, dependency: 'identity-svc', timeoutCapMs: RESOLVE_DEADLINE_MS }) as unknown as grpc.Client & {
      ResolveMemberCodes: Unary;
    };
  }

  async resolve(codes: readonly string[], opts: { signal?: AbortSignal }): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (let i = 0; i < codes.length; i += RESOLVE_BATCH) {
      // 신호가 끊겼으면 남은 호출을 하지 않는다
      if (opts.signal?.aborted) throw new MemberCodeLookupFailed('CANCELLED');
      const batch = codes.slice(i, i + RESOLVE_BATCH);
      const asked = new Set(batch);
      const resolved = await this.#call(batch, opts.signal);
      if (!Array.isArray(resolved)) throw new MemberCodeLookupFailed('INVALID_RESPONSE');
      for (const r of resolved as Record<string, unknown>[]) {
        const code = r?.member_code;
        const account = r?.account_id;
        if (typeof code !== 'string' || !asked.has(code) || typeof account !== 'string' || !UUID.test(account)) throw new MemberCodeLookupFailed('INVALID_RESPONSE');
        const id = account.toLowerCase();
        const before = out.get(code);
        if (before !== undefined && before !== id) throw new MemberCodeLookupFailed('INVALID_RESPONSE');
        out.set(code, id);
      }
    }
    return out;
  }

  #call(batch: string[], signal: AbortSignal | undefined): Promise<unknown> {
    return new Promise((resolve, reject) => {
      // abort 듣기는 호출마다 달고 끝나면 뗀다(50번 부르는 동안 신호에 쌓이지 않게, 리뷰 C6)
      const onAbort = () => call.cancel();
      const call = this.#client.ResolveMemberCodes({ member_codes: batch }, new grpc.Metadata(), { deadline: Date.now() + RESOLVE_DEADLINE_MS }, (e, v) => {
        signal?.removeEventListener('abort', onAbort);
        if (e) reject(new MemberCodeLookupFailed(signal?.aborted ? 'CANCELLED' : (grpc.status[e.code] ?? String(e.code))));
        else resolve(v?.resolved);
      });
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  close(): void {
    this.#client.close();
  }
}
