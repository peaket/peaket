// F-06-1 POL-034: core-svc MergeNoticeService.SendAbsorbedNotice gRPC 클라이언트.
// 병합 확정 트랜잭션 안에서 한 번 부른다(기한 300ms [가정]). 실패는 sendAbsorbedNoticeOnce가 지표로만 남긴다.
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { coreV1Core } from '@peaket/contracts/proto';
import { createGrpcClient, type GrpcLbProfile } from '@peaket/platform';
import type { MergeNoticeSender } from '../domain/ports.js';

const PROTO_LOAD_OPTIONS: protoLoader.Options = { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true };
const DEADLINE_MS = 300;

type Unary = (req: object, md: grpc.Metadata, opts: grpc.CallOptions, cb: (e: grpc.ServiceError | null, v?: Record<string, unknown>) => void) => grpc.ClientUnaryCall;

function mergeNoticeCtor(): grpc.ServiceClientConstructor {
  const def = protoLoader.fromJSON(coreV1Core as Parameters<typeof protoLoader.fromJSON>[0], PROTO_LOAD_OPTIONS);
  let node = grpc.loadPackageDefinition(def) as unknown as Record<string, unknown>;
  for (const p of ['peaket', 'core', 'v1']) node = node[p] as Record<string, unknown>;
  return node.MergeNoticeService as grpc.ServiceClientConstructor;
}

export class GrpcMergeNotice implements MergeNoticeSender {
  readonly #client: grpc.Client & { SendAbsorbedNotice: Unary };

  constructor(address: string, profile: GrpcLbProfile = 'service') {
    const at = address.lastIndexOf(':');
    const port = Number(address.slice(at + 1));
    if (at <= 0 || !Number.isInteger(port) || port <= 0) throw new Error(`MergeNoticeService 주소는 host:port여야 한다: ${address}`);
    this.#client = createGrpcClient(mergeNoticeCtor(), { host: address.slice(0, at), port, profile, dependency: 'core-svc', timeoutCapMs: DEADLINE_MS }) as unknown as grpc.Client & { SendAbsorbedNotice: Unary };
  }

  send(i: { mergeId: string; absorbedAccountId: string; absorbedEmail: string }): Promise<boolean> {
    return new Promise((resolve, reject) => {
      this.#client.SendAbsorbedNotice(
        { merge_id: i.mergeId, absorbed_account_id: i.absorbedAccountId, absorbed_email: i.absorbedEmail },
        new grpc.Metadata(),
        { deadline: Date.now() + DEADLINE_MS },
        (e, v) => {
          if (e) reject(e);
          else resolve(v?.accepted === true);
        },
      );
    });
  }

  failed(_reason: string): void {
    // 지표는 main이 주는 콜백(MergeNoticeSignals)이 센다. 이 어댑터는 지표를 직접 갖지 않는다.
  }
}
