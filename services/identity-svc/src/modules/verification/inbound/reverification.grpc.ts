// 받는 층: gRPC ReverificationCheckService(docs/api/proto identity.proto, docs/features/bot-defense.md §5.2 3단계, I-T56, BUILD_ORDER BOT-090).
// 부르는 쪽은 queue-svc만이고, 그 신원 확인은 메시 웨이포인트의 L7 허용 목록이 한다(I-T56 ⑤, BUILD_ORDER HOT-400).
// 요청 모양이 틀리면 INVALID_ARGUMENT(저장소를 읽지 않는다), 저장소에 닿지 못하면 UNAVAILABLE, 예상하지 못한 오류는 INTERNAL이다.
// 오류 문구는 고정 글이고 받은 값을 싣지 않는다. 이유는 서버 쪽 기록에만 남긴다(docs/api/proto/README.md §2). 어느 오류도 재통과로 답하지 않는다
import * as grpc from '@grpc/grpc-js';
import { type CheckReverification, ReverificationCheckError, type ReverificationResult } from '../application/check-reverification.js';
import { safeError, unreachable } from './grpc-errors.js';

const RESULT: Record<ReverificationResult['result'], string> = {
  PASSED: 'REVERIFICATION_RESULT_PASSED',
  NOT_FOUND: 'REVERIFICATION_RESULT_NOT_FOUND',
  PERSON_MISMATCH: 'REVERIFICATION_RESULT_PERSON_MISMATCH',
};

type Req = Record<string, unknown>;
const text = (v: unknown): string => (typeof v === 'string' ? v : '');
/** int64(설명자 선택지 longs: Number). 숫자가 아니면 NaN이라 유스케이스가 거절한다 */
const int = (v: unknown): number => (typeof v === 'number' ? v : Number.NaN);

export function reverificationCheckHandlers(uc: { check: Pick<CheckReverification, 'run'> }, onError: (method: string, err: unknown) => void): grpc.UntypedServiceImplementation {
  const handler: grpc.handleUnaryCall<Req, object> = (call, cb) => {
    const r = call.request;
    uc.check.run({ accountId: text(r.account_id), pid: text(r.pid), notBeforeMs: int(r.not_before_ms) }).then(
      // verified_at_ms는 PASSED일 때만 채운다
      (out) => cb(null, { result: RESULT[out.result], verified_at_ms: out.result === 'PASSED' ? out.verifiedAt : 0 }),
      (err: unknown) => {
        if (err instanceof ReverificationCheckError) {
          cb({ code: grpc.status.INVALID_ARGUMENT, details: err.message });
          return;
        }
        onError('CheckReverification', safeError(err));
        if (unreachable(err)) cb({ code: grpc.status.UNAVAILABLE, details: '지금 처리할 수 없다' });
        else cb({ code: grpc.status.INTERNAL, details: '처리하지 못했다' });
      },
    );
  };
  return { CheckReverification: handler };
}
