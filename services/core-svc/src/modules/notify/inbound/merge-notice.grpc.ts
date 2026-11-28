// F-06-1 POL-034: identity가 병합 트랜잭션 안에서 흡수 계정 완료 통지를 넘기는 내부 gRPC.
// 주소는 요청에만 있고 저장하지 않는다. notify는 강제 인테이크로 작업 하나를 적고 메모리 inbox에 주소를 둔다.
// 실패는 identity의 merge_notice_failed 지표로만 남기고 병합을 막지 않는다(계획 §3.1).
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { coreV1Core } from '@peaket/contracts/proto';
import type { NotificationIntake } from '../application/notification-intake.js';

const PROTO_LOAD_OPTIONS: protoLoader.Options = { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true };

/** core.proto의 MergeNoticeService 정의. 시험은 이 함수를 직접 쓰지 않고 main이 startGrpcServer에 넘긴다 */
export function mergeNoticeServiceDefinition(): grpc.ServiceDefinition {
  const def = protoLoader.fromJSON(coreV1Core as Parameters<typeof protoLoader.fromJSON>[0], PROTO_LOAD_OPTIONS);
  let node = grpc.loadPackageDefinition(def) as unknown as Record<string, unknown>;
  for (const p of ['peaket', 'core', 'v1']) node = node[p] as Record<string, unknown>;
  const service = node.MergeNoticeService as { service?: grpc.ServiceDefinition } | undefined;
  if (!service?.service) throw new Error('core.proto에 MergeNoticeService가 없습니다');
  return service.service;
}

type Req = Record<string, unknown>;
const text = (v: unknown): string => (typeof v === 'string' ? v : '');

export function mergeNoticeHandlers(
  intake: Pick<NotificationIntake, 'accountMergedAbsorbed'>,
  onError: (method: string, err: unknown) => void,
): grpc.UntypedServiceImplementation {
  return {
    SendAbsorbedNotice: (call: grpc.ServerUnaryCall<Req, object>, cb: grpc.sendUnaryData<object>) => {
      const mergeId = text(call.request.merge_id);
      const absorbedAccountId = text(call.request.absorbed_account_id);
      const absorbedEmail = text(call.request.absorbed_email);
      if (!mergeId || !absorbedAccountId || !absorbedEmail.includes('@')) {
        cb({ code: grpc.status.INVALID_ARGUMENT, details: '병합 통지 요청이 올바르지 않습니다' });
        return;
      }
      intake
        .accountMergedAbsorbed({ mergeId, absorbedAccountId, absorbedEmail })
        .then(
          (r) => cb(null, { accepted: r.created + r.duplicate > 0 }),
          (err: unknown) => {
            onError('SendAbsorbedNotice', err);
            cb({ code: grpc.status.INTERNAL, details: '병합 통지를 적지 못했다' });
          },
        );
    },
  };
}
