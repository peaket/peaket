// 받는 층: gRPC AdminSessionService.TerminateAdminSessions(identity.proto, BUILD_ORDER BOT-152, ADR-0322).
// 부르는 쪽은 ops-svc 하나다. 계정이 없거나 그 계정의 세션이 아니면 NOT_FOUND, 입력 꼴 오류는 INVALID_ARGUMENT다.
import * as grpc from '@grpc/grpc-js';
import { AdminAccountInputError, AdminAccountNotFound } from '../application/manage-admin-accounts.js';
import type { TerminateAdminSessions } from '../application/terminate-admin-sessions.js';

type Req = Record<string, unknown>;
const str = (v: unknown) => (typeof v === 'string' ? v : '');

export function adminSessionHandlers(uc: { terminate: Pick<TerminateAdminSessions, 'execute'> }, onError: (method: string, err: unknown) => void): grpc.UntypedServiceImplementation {
  return {
    TerminateAdminSessions: (call: grpc.ServerUnaryCall<Req, object>, cb: grpc.sendUnaryData<object>) => {
      const r = call.request;
      uc.terminate
        .execute({
          requestId: str(r.request_id),
          actedBy: str(r.acted_by),
          adminAccountId: str(r.admin_account_id),
          ...(str(r.session_id) ? { sessionId: str(r.session_id) } : {}),
        })
        .then(
          (out) => cb(null, { ended_count: out.endedCount, already_done: out.alreadyDone }),
          (err: unknown) => {
            if (err instanceof AdminAccountInputError) {
              cb({ code: grpc.status.INVALID_ARGUMENT, details: err.message });
              return;
            }
            if (err instanceof AdminAccountNotFound) {
              cb({ code: grpc.status.NOT_FOUND, details: '관리 계정이나 세션이 없다' });
              return;
            }
            onError('TerminateAdminSessions', err instanceof Error ? err.name : 'Error');
            cb({ code: grpc.status.UNAVAILABLE, details: '처리하지 못했다' });
          },
        );
    },
  };
}
