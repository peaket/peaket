// ticket-svc ScannerDeviceService gRPC 클라이언트(ADR-0148, BAT-450).
// 운영자 권한·감사는 ops-svc가 마치고, 기기 원장의 쓰기는 이 클라이언트로 ticket-svc에 맡긴다.
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { ticketV1Ticket } from '@peaket/contracts/proto';
import { createGrpcClient, type GrpcLbProfile } from '@peaket/platform';
import {
  ScannerDeviceDependencyUnavailable,
  ScannerDeviceInactive,
  ScannerDeviceInputRejected,
  ScannerDeviceKeyInUse,
  ScannerDeviceNotFound,
  type ScannerCredentialType,
  type ScannerDeviceEnrollmentCode,
  type ScannerDevicePage,
  type ScannerDeviceRegistration,
  type ScannerDeviceRevocation,
  type ScannerDeviceStatus,
  type ScannerDeviceView,
  type TicketScannerDevices,
} from '../domain/scanner-devices.js';

const PROTO_LOAD_OPTIONS: protoLoader.Options = { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true };
const DEADLINE_MS = 2_000;
type Unary = (req: object, md: grpc.Metadata, opts: grpc.CallOptions, cb: (e: grpc.ServiceError | null, v?: Record<string, unknown>) => void) => grpc.ClientUnaryCall;

const STATUS: Record<string, ScannerDeviceStatus> = {
  SCANNER_DEVICE_STATUS_ACTIVE: 'ACTIVE',
  SCANNER_DEVICE_STATUS_REVOKED: 'REVOKED',
  SCANNER_DEVICE_STATUS_RETIRED: 'RETIRED',
};
const CREDENTIAL: Record<string, ScannerCredentialType> = {
  SCANNER_CREDENTIAL_TYPE_DEVICE_KEY: 'DEVICE_KEY',
  SCANNER_CREDENTIAL_TYPE_MTLS_CERT: 'MTLS_CERT',
};

const isoOf = (v: unknown): string | undefined => {
  if (!v || typeof v !== 'object') return undefined;
  const t = v as Record<string, unknown>;
  const seconds = Number(t.seconds);
  const nanos = Number(t.nanos);
  if (!Number.isFinite(seconds)) return undefined;
  return new Date(seconds * 1000 + (Number.isFinite(nanos) ? Math.floor(nanos / 1_000_000) : 0)).toISOString();
};

function deviceOf(v: unknown): ScannerDeviceView {
  const r = (v ?? {}) as Record<string, unknown>;
  const status = STATUS[String(r.status)];
  const credentialType = CREDENTIAL[String(r.credential_type)];
  if (!status || !credentialType) throw new ScannerDeviceDependencyUnavailable(new Error(`모르는 기기 상태·자격: ${String(r.status)}/${String(r.credential_type)}`));
  return {
    deviceId: String(r.device_id ?? ''),
    name: String(r.name ?? ''),
    promoterId: String(r.promoter_id ?? ''),
    status,
    credentialType,
    ...(isoOf(r.cert_expires_at) !== undefined ? { certExpiresAt: isoOf(r.cert_expires_at)! } : {}),
    ...(isoOf(r.last_seen_at) !== undefined ? { lastSeenAt: isoOf(r.last_seen_at)! } : {}),
  };
}

function codeOf(v: unknown): { enrollmentCode?: string; enrollmentCodeExpiresAt?: string } {
  const c = (v ?? {}) as Record<string, unknown>;
  return {
    ...(typeof c.code === 'string' && c.code !== '' ? { enrollmentCode: c.code } : {}),
    ...(isoOf(c.expires_at) !== undefined ? { enrollmentCodeExpiresAt: isoOf(c.expires_at)! } : {}),
  };
}

/** gRPC 상태를 ops-svc 오류로 사상한다(단위 시험이 직접 부른다) */
export function mappedErrorOf(e: grpc.ServiceError): Error {
  if (e.code === grpc.status.NOT_FOUND) return new ScannerDeviceNotFound();
  if (e.code === grpc.status.FAILED_PRECONDITION) return new ScannerDeviceInactive();
  if (e.code === grpc.status.ALREADY_EXISTS) return new ScannerDeviceKeyInUse();
  if (e.code === grpc.status.INVALID_ARGUMENT) return new ScannerDeviceInputRejected(e.details || 'INVALID_ARGUMENT');
  return new ScannerDeviceDependencyUnavailable(e);
}

type DeviceMethod = 'ListScannerDevices' | 'RegisterScannerDevice' | 'RevokeScannerDevice' | 'ReissueEnrollmentCode';
type DeviceClient = grpc.Client & { ListScannerDevices: Unary; RegisterScannerDevice: Unary; RevokeScannerDevice: Unary; ReissueEnrollmentCode: Unary };

export interface GrpcTicketScannerDevicesOptions {
  readonly address: string;
  readonly profile?: GrpcLbProfile;
}

export class GrpcTicketScannerDevices implements TicketScannerDevices {
  readonly #client: DeviceClient;

  constructor(o: GrpcTicketScannerDevicesOptions) {
    const at = o.address.lastIndexOf(':');
    const port = Number(o.address.slice(at + 1));
    if (at <= 0 || !Number.isInteger(port) || port <= 0 || port > 65_535) throw new Error('PEAKET_TICKET_GRPC_URL은 host:port여야 한다');
    const def = protoLoader.fromJSON(ticketV1Ticket as Parameters<typeof protoLoader.fromJSON>[0], PROTO_LOAD_OPTIONS);
    const pkg = (grpc.loadPackageDefinition(def) as unknown as { peaket: { ticket: { v1: { ScannerDeviceService: grpc.ServiceClientConstructor } } } }).peaket.ticket.v1;
    this.#client = createGrpcClient(pkg.ScannerDeviceService, {
      host: o.address.slice(0, at),
      port,
      profile: o.profile ?? 'service',
      dependency: 'ticket-svc',
      timeoutCapMs: DEADLINE_MS,
    }) as unknown as DeviceClient;
  }

  #call<T>(method: DeviceMethod, req: object, answer: (v: Record<string, unknown>) => T): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      (this.#client[method] as Unary)(
        req,
        new grpc.Metadata(),
        { deadline: Date.now() + DEADLINE_MS },
        (e, v) => {
          if (e) {
            reject(mappedErrorOf(e));
            return;
          }
          resolve(answer(v ?? {}));
        },
      );
    });
  }

  list(q: { cursor?: string; limit: number }): Promise<ScannerDevicePage> {
    return this.#call('ListScannerDevices', { ...(q.cursor !== undefined ? { cursor: q.cursor } : {}), limit: q.limit }, (v) => ({
      items: Array.isArray(v.devices) ? (v.devices as unknown[]).map(deviceOf) : [],
      ...(typeof v.next_cursor === 'string' && v.next_cursor !== '' ? { nextCursor: v.next_cursor } : {}),
    }));
  }

  register(q: { requestId: string; name: string; promoterId: string; actedBy: string }): Promise<ScannerDeviceRegistration> {
    return this.#call('RegisterScannerDevice', { request_id: q.requestId, name: q.name, promoter_id: q.promoterId, acted_by: q.actedBy }, (v) => ({
      device: deviceOf(v.device),
      ...codeOf(v.enrollment_code),
      alreadyDone: v.already_done === true,
    }));
  }

  revoke(q: { requestId: string; deviceId: string; reason: string; actedBy: string }): Promise<ScannerDeviceRevocation> {
    return this.#call('RevokeScannerDevice', { request_id: q.requestId, device_id: q.deviceId, reason: q.reason, acted_by: q.actedBy }, (v) => ({
      device: deviceOf(v.device),
      alreadyDone: false,
    }));
  }

  reissue(q: { requestId: string; deviceId: string; actedBy: string }): Promise<ScannerDeviceEnrollmentCode> {
    return this.#call('ReissueEnrollmentCode', { request_id: q.requestId, device_id: q.deviceId, acted_by: q.actedBy }, (v) => ({
      ...codeOf(v.enrollment_code),
      alreadyDone: v.already_done === true,
    }));
  }

  close(): void {
    this.#client.close();
  }
}
