// 받는 층: gRPC VerificationAppealService(docs/api/proto queue.proto, docs/features/bot-defense.md §12, B-T10 ③~⑤). queue-svc의 첫 업무 gRPC다.
// 부르는 쪽은 ops-svc만이고, 그 신원 확인은 메시 웨이포인트의 L7 허용 목록이 한다(BUILD_ORDER HOT-400).
// 요청 모양이 틀리면 INVALID_ARGUMENT(저장소를 읽지 않는다), 이의가 없으면 NOT_FOUND, 같은 건 ID에 다른 이의면 ALREADY_EXISTS,
// 대기열 Redis에 닿지 못하면 UNAVAILABLE(ops-svc 작업 워커가 같은 건·판으로 다시 보낸다), 예상하지 못한 오류는 INTERNAL이다.
// 오류 문구는 고정 글이고 받은 값을 싣지 않는다(docs/api/proto/README.md §2).
import * as grpc from '@grpc/grpc-js';
import { queuePackage } from '../../../grpc-package.js';
import { QueueStoreUnavailable } from '../../entry/index.js';
import type { AppealEntryState, GetVerificationAppeal, ResolveVerificationAppeal } from '../application/appeals.js';
import { VerificationError } from '../application/verification-error.js';
import type { AppealOutcome, ResolveResult } from '../domain/verification.js';

export { queuePackage };

type Req = Record<string, unknown>;
const text = (v: unknown): string => (typeof v === 'string' ? v : '');
/** int64(설명자 선택지 longs: Number). 숫자가 아니면 NaN이라 유스케이스가 거절한다 */
const int = (v: unknown): number => (typeof v === 'number' ? v : Number.NaN);

const OUTCOME: Readonly<Record<string, AppealOutcome>> = { APPEAL_OUTCOME_ACCEPTED: 'ACCEPTED', APPEAL_OUTCOME_REJECTED: 'REJECTED' };
const ENTRY_STATE: Record<AppealEntryState, string> = {
  VERIFYING: 'APPEAL_ENTRY_STATE_VERIFYING',
  PASSED: 'APPEAL_ENTRY_STATE_PASSED',
  ENDED: 'APPEAL_ENTRY_STATE_ENDED',
};
const RESOLVE: Record<ResolveResult, string> = {
  APPLIED: 'RESOLVE_APPEAL_RESULT_APPLIED',
  UNCHANGED: 'RESOLVE_APPEAL_RESULT_UNCHANGED',
  NOT_ISOLATED: 'RESOLVE_APPEAL_RESULT_NOT_ISOLATED',
};

const timestamp = (ms: number) => ({ seconds: Math.floor(ms / 1000), nanos: (ms % 1000) * 1_000_000 });

function failure(method: string, err: unknown, onError: (method: string, err: unknown) => void): Partial<grpc.StatusObject> {
  if (err instanceof VerificationError) {
    if (err.code === 'INVALID') return { code: grpc.status.INVALID_ARGUMENT, details: '요청 모양이 틀렸다' };
    if (err.code === 'APPEAL_NOT_FOUND') return { code: grpc.status.NOT_FOUND, details: '이의가 없다' };
    if (err.code === 'CASE_CONFLICT') return { code: grpc.status.ALREADY_EXISTS, details: '이 건 ID에 다른 이의가 있다' };
  }
  if (err instanceof QueueStoreUnavailable) return { code: grpc.status.UNAVAILABLE, details: '지금 처리할 수 없다' };
  onError(method, err);
  return { code: grpc.status.INTERNAL, details: '처리하지 못했다' };
}

export function verificationAppealHandlers(uc: { get: Pick<GetVerificationAppeal, 'run'>; resolve: Pick<ResolveVerificationAppeal, 'run'> }, onError: (method: string, err: unknown) => void): grpc.UntypedServiceImplementation {
  const GetVerificationAppeal: grpc.handleUnaryCall<Req, object> = (call, cb) => {
    uc.get.run(text(call.request.appeal_id)).then(
      (a) =>
        cb(null, {
          appeal_id: a.appealId,
          event_id: a.eventId,
          account_id: a.accountId,
          pid: a.pid,
          text: a.text,
          reason_category: a.reasonCategory,
          received_at: timestamp(a.receivedAtMs),
          entry_state: ENTRY_STATE[a.entryState],
        }),
      (err: unknown) => cb(failure('GetVerificationAppeal', err, onError)),
    );
  };
  const ResolveVerificationAppeal: grpc.handleUnaryCall<Req, object> = (call, cb) => {
    const r = call.request;
    const outcome = OUTCOME[text(r.outcome)];
    if (!outcome) {
      cb({ code: grpc.status.INVALID_ARGUMENT, details: '결과가 없다' });
      return;
    }
    uc.resolve.run({ appealId: text(r.appeal_id), caseId: text(r.case_id), caseVersion: int(r.case_version), outcome }).then(
      (result) => cb(null, { result: RESOLVE[result] }),
      (err: unknown) => cb(failure('ResolveVerificationAppeal', err, onError)),
    );
  };
  return { GetVerificationAppeal, ResolveVerificationAppeal };
}
