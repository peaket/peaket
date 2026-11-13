// 받는 층: gRPC ScannerSessionCheckService.CheckScannerSession(identity.proto, identity §6.1, offline-gate §6.1, GAT-170).
// ticket-svc만 부른다(메시 L7 허용 목록). 읽기라 멱등 키가 없고, 판정하지 못하면 INTERNAL·닿지 못하면 UNAVAILABLE이다.
import * as grpc from '@grpc/grpc-js';
import type { CheckScannerSession } from '../application/check-scanner-session.js';
import type { StaffRole } from '../domain/staff.js';

const ROLE: Record<StaffRole, string> = { gate_staff: 'STAFF_ROLE_GATE_STAFF', gate_lead: 'STAFF_ROLE_GATE_LEAD' };

type Req = Record<string, unknown>;
const text = (v: unknown): string => (typeof v === 'string' ? v : '');

export function scannerSessionCheckHandlers(
  uc: { check: Pick<CheckScannerSession, 'run'> },
  onError: (method: string, err: unknown) => void,
): grpc.UntypedServiceImplementation {
  return {
    CheckScannerSession: (call: grpc.ServerUnaryCall<Req, object>, cb: grpc.sendUnaryData<object>) => {
      const r = call.request;
      uc.check
        .run({ scannerSessionId: text(r.scanner_session_id), deviceId: text(r.device_id) })
        .then(
          (v) => cb(null, { valid: v.valid, role: v.role ? ROLE[v.role] : 'STAFF_ROLE_UNSPECIFIED', event_id: v.eventId ?? '' }),
          (err: unknown) => {
            onError('CheckScannerSession', err);
            cb({ code: grpc.status.INTERNAL, details: '처리하지 못했다' });
          },
        );
    },
  };
}
