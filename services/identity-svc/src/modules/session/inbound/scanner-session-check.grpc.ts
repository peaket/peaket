// 받는 층: gRPC ScannerSessionCheckService.CheckScannerSession(identity.proto, identity §6.1, offline-gate §6.1, GAT-170).
// ticket-svc만 부른다(메시 L7 허용 목록). 읽기라 멱등 키가 없고, 판정하지 못하면 INTERNAL·닿지 못하면 UNAVAILABLE이다.
import * as grpc from '@grpc/grpc-js';
import type { CheckScannerSession } from '../application/check-scanner-session.js';
import type { TerminateScannerSessions } from '../application/terminate-scanner-sessions.js';
import type { StaffRole } from '../domain/staff.js';

const ROLE: Record<StaffRole, string> = { gate_staff: 'STAFF_ROLE_GATE_STAFF', gate_lead: 'STAFF_ROLE_GATE_LEAD' };

type Req = Record<string, unknown>;
const text = (v: unknown): string => (typeof v === 'string' ? v : '');
const ms = (v: unknown): number | undefined => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : undefined);

export function scannerSessionCheckHandlers(
  uc: { check: Pick<CheckScannerSession, 'run'>; terminate: Pick<TerminateScannerSessions, 'run'> },
  onError: (method: string, err: unknown) => void,
): grpc.UntypedServiceImplementation {
  return {
    CheckScannerSession: (call: grpc.ServerUnaryCall<Req, object>, cb: grpc.sendUnaryData<object>) => {
      const r = call.request;
      uc.check
        .run({ scannerSessionId: text(r.scanner_session_id), deviceId: text(r.device_id) })
        .then(
          (v) =>
            cb(null, {
              valid: v.valid,
              role: v.role ? ROLE[v.role] : 'STAFF_ROLE_UNSPECIFIED',
              event_id: v.eventId ?? '',
              assignment_id: v.assignmentId ?? '',
              valid_from_ms: v.validFromMs ?? 0,
              valid_until_ms: v.validUntilMs ?? 0,
              proxy: v.proxy ?? false,
            }),
          (err: unknown) => {
            onError('CheckScannerSession', err);
            cb({ code: grpc.status.INTERNAL, details: '처리하지 못했다' });
          },
        );
    },
    TerminateScannerSessions: (call: grpc.ServerUnaryCall<Req, object>, cb: grpc.sendUnaryData<object>) => {
      const r = call.request;
      uc.terminate
        .run({ deviceId: text(r.device_id), reason: text(r.reason), ...(ms(r.terminated_at_ms) !== undefined ? { terminatedAtMs: ms(r.terminated_at_ms)! } : {}) })
        .then(
          (v) => cb(null, { terminated: v.terminated }),
          (err: unknown) => {
            onError('TerminateScannerSessions', err);
            cb({ code: grpc.status.INTERNAL, details: '처리하지 못했다' });
          },
        );
    },
  };
}
