// 받는 층: gRPC RestrictedCiHoldService(docs/api/proto identity.proto, docs/features/identity.md §8 '대조값 보관의 첫 구현', BUILD_ORDER BOT-035, I-T68).
// 부르는 쪽은 ops-svc만이고, 그 신원 확인은 메시 웨이포인트의 L7 허용 목록이 한다(identity §2, I-T68 ⑦, BUILD_ORDER HOT-400).
// 요청 모양이 틀리면 INVALID_ARGUMENT, 예상하지 못한 오류는 INTERNAL과 고정 문구이고 이유는 서버 쪽 기록에만 남긴다(docs/api/proto/README.md §2).
import * as grpc from '@grpc/grpc-js';
import { type HoldResult, type HoldState, RestrictedCiHoldError, type SetRestrictedCiHold } from '../application/set-restricted-ci-hold.js';
import { safeError } from './grpc-errors.js';

const STATE: Record<string, HoldState> = {
  RESTRICTED_CI_HOLD_STATE_CASE_OPEN: 'CASE_OPEN',
  RESTRICTED_CI_HOLD_STATE_RESTRICTED: 'RESTRICTED',
  RESTRICTED_CI_HOLD_STATE_RELEASED: 'RELEASED',
};
const RESULT: Record<HoldResult, string> = {
  OK: 'RESTRICTED_CI_HOLD_RESULT_OK',
  NO_VERIFICATION: 'RESTRICTED_CI_HOLD_RESULT_NO_VERIFICATION',
  STALE: 'RESTRICTED_CI_HOLD_RESULT_STALE',
};

type Req = Record<string, unknown>;

const text = (v: unknown): string => (typeof v === 'string' ? v : '');

/** google.protobuf.Timestamp(longs: Number) → 밀리초. 없으면 null */
function timestampMs(v: unknown): number | null {
  if (!v || typeof v !== 'object') return null;
  const t = v as { seconds?: unknown; nanos?: unknown };
  const s = Number(t.seconds ?? 0);
  const n = Number(t.nanos ?? 0);
  if (!Number.isFinite(s) || !Number.isFinite(n) || (s === 0 && n === 0)) return null;
  return s * 1000 + Math.floor(n / 1e6);
}

export function restrictedCiHoldHandlers(uc: { hold: Pick<SetRestrictedCiHold, 'run'> }, onError: (method: string, err: unknown) => void): grpc.UntypedServiceImplementation {
  const handler: grpc.handleUnaryCall<Req, object> = (call, cb) => {
    const r = call.request;
    const state = STATE[String(r.state)];
    if (!state) {
      cb({ code: grpc.status.INVALID_ARGUMENT, details: 'state가 없다' });
      return;
    }
    uc.hold.run({ accountId: text(r.account_id), fraudCaseId: text(r.fraud_case_id), state, until: timestampMs(r.until), version: Number(r.version ?? 0) }).then(
      (out) => cb(null, { result: RESULT[out] }),
      (err: unknown) => {
        if (err instanceof RestrictedCiHoldError) {
          cb({ code: grpc.status.INVALID_ARGUMENT, details: err.message });
          return;
        }
        onError('SetRestrictedCiHold', safeError(err));
        cb({ code: grpc.status.INTERNAL, details: '처리하지 못했다' });
      },
    );
  };
  return { SetRestrictedCiHold: handler };
}
