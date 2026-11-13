// 받는 층: gRPC PriorityGrantService(queue.proto, docs/features/queue-admission.md §6 '우선 구매 입장', ADR-0171).
// 부르는 쪽은 ops-svc만이고, 그 신원 확인은 메시 웨이포인트의 L7 허용 목록이 한다.
// 요청 모양이 틀리면 INVALID_ARGUMENT(저장소를 읽지 않는다), 대기열 Redis에 닿지 못하면 UNAVAILABLE,
// 예상하지 못한 오류는 INTERNAL이다. 오류 문구는 고정 글이고 받은 값을 싣지 않는다(docs/api/proto/README.md §2).
import * as grpc from '@grpc/grpc-js';
import { QueueStoreUnavailable } from '../../entry/index.js';
import { PriorityGrantError, type SetPriorityGrant } from '../application/set-priority-grant.js';
import type { PriorityGrantState } from '../domain/priority-grant.js';

type Req = Record<string, unknown>;
const text = (v: unknown): string => (typeof v === 'string' ? v : '');
/** int64(설명자 선택지 longs: Number). 숫자가 아니면 NaN이라 유스케이스가 거절한다 */
const int = (v: unknown): number => (typeof v === 'number' ? v : Number.NaN);

/** google.protobuf.Timestamp → epoch ms. 모양이 틀리면 NaN(유스케이스가 거절한다) */
function timestampMs(v: unknown): number {
  if (typeof v !== 'object' || v === null) return Number.NaN;
  const o = v as { seconds?: unknown; nanos?: unknown };
  const seconds = typeof o.seconds === 'number' ? o.seconds : Number(o.seconds);
  const nanos = o.nanos === undefined ? 0 : typeof o.nanos === 'number' ? o.nanos : Number(o.nanos);
  if (!Number.isSafeInteger(seconds) || seconds <= 0) return Number.NaN;
  if (!Number.isSafeInteger(nanos) || nanos < 0 || nanos >= 1_000_000_000) return Number.NaN;
  return seconds * 1000 + Math.floor(nanos / 1_000_000);
}

const STATE: Readonly<Record<string, PriorityGrantState>> = {
  PRIORITY_GRANT_STATE_OFFERED: 'OFFERED',
  PRIORITY_GRANT_STATE_WITHDRAWN: 'WITHDRAWN',
};

function failure(method: string, err: unknown, onError: (method: string, err: unknown) => void): Partial<grpc.StatusObject> {
  if (err instanceof PriorityGrantError) return { code: grpc.status.INVALID_ARGUMENT, details: '요청 모양이 틀렸다' };
  if (err instanceof QueueStoreUnavailable) return { code: grpc.status.UNAVAILABLE, details: '지금 처리할 수 없다' };
  onError(method, err);
  return { code: grpc.status.INTERNAL, details: '처리하지 못했다' };
}

export function priorityGrantHandlers(uc: Pick<SetPriorityGrant, 'run'>, onError: (method: string, err: unknown) => void): grpc.UntypedServiceImplementation {
  const SetPriorityGrant: grpc.handleUnaryCall<Req, object> = (call, cb) => {
    const r = call.request;
    const state = STATE[text(r.state)];
    if (!state) {
      cb({ code: grpc.status.INVALID_ARGUMENT, details: '권리 상태가 없다' });
      return;
    }
    uc.run({
      accountId: text(r.account_id),
      eventId: text(r.event_id),
      grantId: text(r.grant_id),
      state,
      expiresAtMs: timestampMs(r.expires_at),
      version: int(r.version),
    }).then(
      (x) => cb(null, { changed: x.changed }),
      (err: unknown) => cb(failure('SetPriorityGrant', err, onError)),
    );
  };
  return { SetPriorityGrant };
}
