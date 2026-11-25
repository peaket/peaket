// 받는 층: gRPC ReverificationCheckService.VerifyBoothReverification(identity.proto, F-05-12 O-T28 ①).
// ticket-svc가 부스 대조 토큰(5분)을 확인한다. 토큰 거절은 ok=false, 저장소 장애는 UNAVAILABLE이다.
// 오류 문구에는 토큰·계정·티켓 값을 싣지 않는다(proto README §2, docs/observability.md §8).
import * as grpc from '@grpc/grpc-js';
import { safeError, unreachable } from './grpc-errors.js';

type Req = Record<string, unknown>;
const text = (v: unknown): string => (typeof v === 'string' ? v : '');

export function boothReverificationHandlers(
  uc: { verify: { run(i: { token: string; accountId: string; ticketId: string }): Promise<boolean> } },
  onError: (method: string, err: unknown) => void,
): grpc.UntypedServiceImplementation {
  const handler: grpc.handleUnaryCall<Req, { ok: boolean }> = (call, cb) => {
    const r = call.request;
    uc.verify.run({ token: text(r.token), accountId: text(r.account_id), ticketId: text(r.ticket_id) }).then(
      (ok) => cb(null, { ok }),
      (err: unknown) => {
        onError('VerifyBoothReverification', safeError(err));
        if (unreachable(err)) cb({ code: grpc.status.UNAVAILABLE, details: '지금 확인할 수 없다' });
        else cb({ code: grpc.status.INTERNAL, details: '확인하지 못했다' });
      },
    );
  };
  return { VerifyBoothReverification: handler };
}
