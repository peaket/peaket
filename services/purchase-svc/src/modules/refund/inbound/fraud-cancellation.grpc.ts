// 받는 층: gRPC FraudCancellationService(docs/api/proto/peaket/purchase/v1/fraud_cancellation.proto, BUILD_ORDER GAT-080, ADR-0197).
// 부르는 쪽은 ops-svc뿐이다(내부 토큰 + 호출자 ops-svc + 처리자 approved_by 증명, docs/features/transfer-refund.md §7.4).
// BAT-415 시험 담당의 빈 뼈대다. 처리기는 '아직 없음'(UNIMPLEMENTED)으로 답하고, 동작은 구현 담당이 채운다.
import * as grpc from '@grpc/grpc-js';
import type { CancelFraudTickets } from '../application/cancel-fraud-tickets.js';
import type { GetFraudCancellation } from '../application/get-fraud-cancellation.js';

export interface FraudCancellationPackage {
  FraudCancellationService: grpc.ServiceClientConstructor;
}

/** peaket.purchase.v1 패키지(계약 설명자에서 만든다) */
export function fraudCancellationPackage(): FraudCancellationPackage {
  throw new Error('아직 없음');
}

export function fraudCancellationHandlers(
  _u: { cancel: Pick<CancelFraudTickets, 'execute'>; get: Pick<GetFraudCancellation, 'execute'>; nowMs?: () => number },
  _o?: { internalToken?: string; onError?: (method: string, err: unknown) => void },
): grpc.UntypedServiceImplementation {
  const notYet: grpc.handleUnaryCall<unknown, unknown> = (_call, cb) => cb({ code: grpc.status.UNIMPLEMENTED, details: '아직 없음' });
  return { CancelFraudTickets: notYet, GetFraudCancellation: notYet };
}
