// 받는 층: gRPC AccountMergeCheckService.CheckAccountMerge(proto core.proto, identity §2.1 '계정 병합의 첫 구현', IR-04).
// identity-svc가 계정 병합 제안을 만들 때와 확정 트랜잭션 바로 앞에 불러 흡수 계정의 찜 수(absorbed_wishes)를 받는다.
// 이번 몫은 찜 수만 채운다. 후기·한정 MD 차단 사유와 구독·배송지 수는 그 데이터의 첫 구현이 붙을 때 더한다(계획 §13 잔여).
// 오류: 빈 값·UUID가 아닌 계정 ID → INVALID_ARGUMENT, 원천 실패 → INTERNAL(계정 ID는 로그에 남기지 않는다).
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { coreV1Core } from '@peaket/contracts/proto';
import type { WishLifecycle } from '../application/wish-lifecycle.js';

export interface CorePackage {
  AccountMergeCheckService: grpc.ServiceClientConstructor;
}

/** 이름은 proto 그대로, enum은 이름, int64는 숫자로 읽는다(다른 서비스의 받는 층과 같은 값) */
const PROTO_LOAD_OPTIONS: protoLoader.Options = { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let pkg: CorePackage | undefined;
/** peaket.core.v1 패키지(계약 설명에서 만든다) */
export function corePackage(): CorePackage {
  if (!pkg) {
    const def = protoLoader.fromJSON(coreV1Core as Parameters<typeof protoLoader.fromJSON>[0], PROTO_LOAD_OPTIONS);
    pkg = (grpc.loadPackageDefinition(def) as unknown as { peaket: { core: { v1: CorePackage } } }).peaket.core.v1;
  }
  return pkg;
}

type Req = Record<string, unknown>;
const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

export interface AccountMergeCheckUseCases {
  readonly wishes: Pick<WishLifecycle, 'absorbedWishes'>;
}

export type AccountMergeCheckErrorLog = (method: string, err: unknown) => void;

/** gRPC 처리기 묶음. 시험은 startGrpcServer에 그대로 넘긴다 */
export function accountMergeCheckHandlers(useCases: AccountMergeCheckUseCases, onError: AccountMergeCheckErrorLog): grpc.UntypedServiceImplementation {
  return {
    CheckAccountMerge: (call: grpc.ServerUnaryCall<Req, Req>, cb: grpc.sendUnaryData<Req>) => {
      const primary = text(call.request.primary_account_id);
      const absorbed = text(call.request.absorbed_account_id);
      if (!UUID.test(primary) || !UUID.test(absorbed)) {
        cb({ code: grpc.status.INVALID_ARGUMENT, details: 'primary_account_id와 absorbed_account_id는 UUID여야 한다' });
        return;
      }
      useCases.wishes
        .absorbedWishes(absorbed)
        .then((wishes) => {
          cb(null, {
            // 후기·한정 MD 차단 사유와 구독·배송지 수는 아직 채우지 않는다(위 머리 주석)
            blocks: [],
            absorbed_wishes: wishes,
            absorbed_subscriptions: 0,
            absorbed_addresses: 0,
          });
        })
        .catch((err: unknown) => {
          onError('CheckAccountMerge', err);
          cb({ code: grpc.status.INTERNAL, details: '계정 병합 확인에 실패했다' });
        });
    },
  };
}
