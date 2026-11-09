// 받는 층: gRPC AdminAuthzService.GetAdminAuthz(identity.proto, ADR-0172, BUILD_ORDER BOT-123). 관리 경로를 처리하는 서비스의 공통 가드가 요청마다 부른다.
// 부르는 쪽 신원은 메시 L7 허용 목록이 확인한다(docs/api/proto/README.md). 원본 DB에서 읽는다.
import * as grpc from '@grpc/grpc-js';
import type { GetAdminAuthz } from '../application/get-admin-authz.js';

type Req = { admin_account_id?: string; session_id?: string };

export function adminAuthzHandlers(uc: { authz: Pick<GetAdminAuthz, 'getAdminAuthz'> }, onError: (method: string, err: unknown) => void): grpc.UntypedServiceImplementation {
  const handler: grpc.handleUnaryCall<Req, object> = (call, cb) => {
    const r = call.request;
    const adminAccountId = String(r.admin_account_id ?? '');
    const sessionId = String(r.session_id ?? '');
    if (!adminAccountId || !sessionId) {
      cb({ code: grpc.status.INVALID_ARGUMENT, details: 'admin_account_id와 session_id가 있어야 한다' });
      return;
    }
    uc.authz.getAdminAuthz({ adminAccountId, sessionId }).then(
      (a) => cb(null, { valid: a.valid, role: a.role, tenant_id: a.tenantId ?? '' }),
      (err: unknown) => {
        onError('GetAdminAuthz', err instanceof Error ? err.name : 'Error');
        cb({ code: grpc.status.UNAVAILABLE, details: '판정하지 못했다' });
      },
    );
  };
  return { GetAdminAuthz: handler };
}
