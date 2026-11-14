// 받는 층: gRPC ScannerDeviceService(ticket.proto, ADR-0148, BAT-450 GAT-220 잔여).
// ops-svc가 운영자 권한 확인·감사를 마친 뒤 기기 목록·등록·폐기·등록 코드 재발급을 이 서비스로 부른다.
// 기기 원장의 주인은 ticket-svc다. request_id가 같은 재시도는 기기를 또 만들지 않고 already_done=true로 답한다.
import * as grpc from '@grpc/grpc-js';
import { ScannerDeviceInactive, ScannerDeviceNotFound, ScannerDevices } from '../application/scanner-devices.js';
import { ScannerDeviceInputError, ScannerDeviceKeyConflict, type ScannerCredentialType, type ScannerDeviceStatus } from '../domain/scanner-device.js';

type Req = Record<string, unknown>;

const STATUS: Record<ScannerDeviceStatus, string> = {
  ACTIVE: 'SCANNER_DEVICE_STATUS_ACTIVE',
  REVOKED: 'SCANNER_DEVICE_STATUS_REVOKED',
  RETIRED: 'SCANNER_DEVICE_STATUS_RETIRED',
};
const CREDENTIAL: Record<ScannerCredentialType, string> = {
  DEVICE_KEY: 'SCANNER_CREDENTIAL_TYPE_DEVICE_KEY',
  MTLS_CERT: 'SCANNER_CREDENTIAL_TYPE_MTLS_CERT',
};

/** ISO 문자열을 google.protobuf.Timestamp로 */
function timestampOf(iso: string | undefined): { seconds: number; nanos: number } | undefined {
  if (iso === undefined) return undefined;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return undefined;
  return { seconds: Math.floor(ms / 1000), nanos: (ms % 1000) * 1_000_000 };
}

function deviceOf(d: {
  deviceId: string;
  name: string;
  promoterId: string;
  status: ScannerDeviceStatus;
  credentialType: ScannerCredentialType;
  certExpiresAt?: string;
  lastSeenAt?: string;
}): Record<string, unknown> {
  return {
    device_id: d.deviceId,
    name: d.name,
    promoter_id: d.promoterId,
    status: STATUS[d.status],
    credential_type: CREDENTIAL[d.credentialType],
    ...(d.certExpiresAt !== undefined ? { cert_expires_at: timestampOf(d.certExpiresAt) } : {}),
    ...(d.lastSeenAt !== undefined ? { last_seen_at: timestampOf(d.lastSeenAt) } : {}),
  };
}

function failure(e: unknown): grpc.ServiceError | undefined {
  if (e instanceof ScannerDeviceInputError) return { code: grpc.status.INVALID_ARGUMENT, details: `스캐너 기기 입력 오류: ${e.code}` } as grpc.ServiceError;
  if (e instanceof ScannerDeviceNotFound) return { code: grpc.status.NOT_FOUND, details: '스캐너 기기를 찾을 수 없다' } as grpc.ServiceError;
  if (e instanceof ScannerDeviceInactive) return { code: grpc.status.FAILED_PRECONDITION, details: '폐기·퇴역한 스캐너 기기다' } as grpc.ServiceError;
  if (e instanceof ScannerDeviceKeyConflict) return { code: grpc.status.ALREADY_EXISTS, details: '이미 다른 기기에 묶인 기기 키 지문이다' } as grpc.ServiceError;
  return undefined;
}

export function scannerDeviceHandlers(uc: Pick<ScannerDevices, 'list' | 'register' | 'revoke' | 'issueCode'>, onError: (method: string, err: unknown) => void): grpc.UntypedServiceImplementation {
  const run = <T>(method: string, cb: grpc.sendUnaryData<object>, body: () => Promise<T>, answer: (v: T) => object): void => {
    body()
      .then((v) => cb(null, answer(v)))
      .catch((err: unknown) => {
        const mapped = failure(err);
        if (mapped) {
          cb(mapped);
          return;
        }
        onError(method, err);
        cb({ code: grpc.status.INTERNAL, details: '스캐너 기기 원장을 읽거나 쓰지 못했다' });
      });
  };

  return {
    ListScannerDevices: (call: grpc.ServerUnaryCall<Req, object>, cb: grpc.sendUnaryData<object>) => {
      const r = call.request;
      run('ListScannerDevices', cb, () => uc.list({ cursor: r.cursor, limit: r.limit === 0 ? undefined : r.limit }), (page) => ({
        devices: page.items.map(deviceOf),
        ...(page.nextCursor !== undefined ? { next_cursor: page.nextCursor } : {}),
      }));
    },

    RegisterScannerDevice: (call: grpc.ServerUnaryCall<Req, object>, cb: grpc.sendUnaryData<object>) => {
      const r = call.request;
      run(
        'RegisterScannerDevice',
        cb,
        () => uc.register({ requestId: r.request_id, name: r.name, promoterId: r.promoter_id, enrolledBy: r.acted_by }),
        (v) => ({
          device: deviceOf(v.device),
          ...(!v.alreadyDone && v.enrollmentCode !== ''
            ? { enrollment_code: { code: v.enrollmentCode, expires_at: timestampOf(v.enrollmentCodeExpiresAt) } }
            : {}),
          already_done: v.alreadyDone,
        }),
      );
    },

    RevokeScannerDevice: (call: grpc.ServerUnaryCall<Req, object>, cb: grpc.sendUnaryData<object>) => {
      const r = call.request;
      run('RevokeScannerDevice', cb, () => uc.revoke({ requestId: r.request_id, deviceId: r.device_id, reason: r.reason }), (v) => ({
        device: deviceOf(v.device),
      }));
    },

    ReissueEnrollmentCode: (call: grpc.ServerUnaryCall<Req, object>, cb: grpc.sendUnaryData<object>) => {
      const r = call.request;
      run('ReissueEnrollmentCode', cb, () => uc.issueCode({ requestId: r.request_id, deviceId: r.device_id }), (v) => ({
        ...(!v.alreadyDone && v.enrollmentCode !== ''
          ? { enrollment_code: { code: v.enrollmentCode, expires_at: timestampOf(v.enrollmentCodeExpiresAt) } }
          : {}),
        already_done: v.alreadyDone,
      }));
    },
  };
}
