// core-svc support gRPC 서비스 정의(F-06-4 화면용 사본 + F-06-5 문의). 시작 조립(main.ts)만 쓴다.
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { coreV1Core } from '@peaket/contracts/proto';

const LOAD: protoLoader.Options = { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true };

export interface SupportGrpcDefinitions {
  readonly bookingRestrictionView: grpc.ServiceDefinition;
  readonly fraudAppealView: grpc.ServiceDefinition;
  readonly inquiry: grpc.ServiceDefinition;
}

export function supportGrpcDefinitions(): SupportGrpcDefinitions {
  const pkg = (grpc.loadPackageDefinition(protoLoader.fromJSON(coreV1Core as never, LOAD)) as unknown as {
    peaket: { core: { v1: { BookingRestrictionViewService: grpc.ServiceClientConstructor; FraudAppealViewService: grpc.ServiceClientConstructor; SupportCaseService: grpc.ServiceClientConstructor } } };
  }).peaket.core.v1;
  return {
    bookingRestrictionView: pkg.BookingRestrictionViewService.service,
    fraudAppealView: pkg.FraudAppealViewService.service,
    inquiry: pkg.SupportCaseService.service,
  };
}
