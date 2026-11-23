// queue-svc PriorityGrantService.SetPriorityGrant gRPC 클라이언트(ADR-0385).
// purchase-svc의 상태 대조가 사본을 다시 보낼 때 쓴다. ops-svc의 발급·회수 경로와 같은 계약이다.
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { queueV1Queue } from '@peaket/contracts/proto';
import { InvalidPriorityGrantState, type QueuePriorityGrants } from '../domain/ports.js';

const OPTIONS: protoLoader.Options = { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true };
const DEADLINE_MS = 2_000;

interface SetResponse {
  readonly changed?: boolean;
}
type Unary = (r: object, md: grpc.Metadata, o: grpc.CallOptions, cb: (e: grpc.ServiceError | null, v?: SetResponse) => void) => void;
type Client = grpc.Client & { SetPriorityGrant: Unary };

let service: grpc.ServiceClientConstructor | undefined;
function serviceOf(): grpc.ServiceClientConstructor {
  if (!service) {
    const def = protoLoader.fromJSON(queueV1Queue as Parameters<typeof protoLoader.fromJSON>[0], OPTIONS);
    service = (grpc.loadPackageDefinition(def) as unknown as { peaket: { queue: { v1: { PriorityGrantService: grpc.ServiceClientConstructor } } } }).peaket.queue.v1
      .PriorityGrantService;
  }
  return service;
}

export class GrpcQueuePriorityGrants implements QueuePriorityGrants {
  readonly #client: Client;

  constructor(address: string) {
    this.#client = new (serviceOf())(address, grpc.credentials.createInsecure()) as unknown as Client;
  }

  set(i: Parameters<QueuePriorityGrants['set']>[0]): Promise<{ changed: boolean }> {
    return new Promise((resolve, reject) => {
      this.#client.SetPriorityGrant(
        {
          account_id: i.accountId,
          event_id: i.eventId,
          grant_id: i.grantId,
          state: `PRIORITY_GRANT_STATE_${i.state}`,
          expires_at: { seconds: Math.floor(i.expiresAtMs / 1000), nanos: (i.expiresAtMs % 1000) * 1_000_000 },
          version: i.version,
        },
        new grpc.Metadata(),
        { deadline: Date.now() + DEADLINE_MS },
        (e, v) => {
          if (e) {
            if (e.code === grpc.status.INVALID_ARGUMENT) reject(new InvalidPriorityGrantState(e.details ?? ''));
            else reject(e);
            return;
          }
          resolve({ changed: v?.changed === true });
        },
      );
    });
  }

  /** 종료 때 gRPC 연결을 닫는다 */
  close(): void {
    this.#client.close();
  }
}
