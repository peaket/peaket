// queue-svc 업무 gRPC 패키지(queue.proto)의 한 번 로더. 검증 이의·우선 구매 권리 두 서비스가 함께 쓴다.
// 설명자 선택지는 appeal.grpc.ts와 같다: 필드 이름은 snake_case, int64는 Number, enum은 이름 글자.
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { queueV1Queue } from '@peaket/contracts/proto';

const PROTO_LOAD_OPTIONS: protoLoader.Options = { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true };

export interface QueuePackage {
  VerificationAppealService: grpc.ServiceClientConstructor;
  PriorityGrantService: grpc.ServiceClientConstructor;
}

let pkg: QueuePackage | undefined;

export function queuePackage(): QueuePackage {
  if (!pkg) {
    const def = protoLoader.fromJSON(queueV1Queue as Parameters<typeof protoLoader.fromJSON>[0], PROTO_LOAD_OPTIONS);
    pkg = (grpc.loadPackageDefinition(def) as unknown as { peaket: { queue: { v1: QueuePackage } } }).peaket.queue.v1;
  }
  return pkg;
}
