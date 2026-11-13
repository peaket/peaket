// identity-svc ScannerSessionCheckService.CheckScannerSession 클라이언트(BUILD_ORDER GAT-170, offline-gate §6.2).
// 스캐너 경로 가드가 스태프 세션·배정·회차 유효를 요청마다 묻고 5초 캐시한다(ScannerAuthState).
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { identityV1Identity } from '@peaket/contracts/proto';
import { createGrpcClient, type GrpcLbProfile } from '@peaket/platform';
import type { ScannerSessionAnswer, ScannerSessionCheck, ScannerStaffRole } from '@peaket/platform';

const DEADLINE_CAP_MS = 1_000;
const PROTO_LOAD_OPTIONS: protoLoader.Options = { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true };

type Unary = (req: object, md: grpc.Metadata, opts: grpc.CallOptions, cb: (e: grpc.ServiceError | null, v?: Record<string, unknown>) => void) => grpc.ClientUnaryCall;

const roleOf = (v: unknown): ScannerStaffRole | undefined => {
  if (v === 'STAFF_ROLE_GATE_STAFF') return 'gate_staff';
  if (v === 'STAFF_ROLE_GATE_LEAD') return 'gate_lead';
  return undefined;
};

export class GrpcScannerSessionCheck implements ScannerSessionCheck {
  readonly #client: grpc.Client & { CheckScannerSession: Unary };

  constructor(address: string, profile: GrpcLbProfile = 'service') {
    const def = protoLoader.fromJSON(identityV1Identity as Parameters<typeof protoLoader.fromJSON>[0], PROTO_LOAD_OPTIONS);
    const pkg = (grpc.loadPackageDefinition(def) as unknown as { peaket: { identity: { v1: Record<string, unknown> } } }).peaket.identity.v1;
    const at = address.lastIndexOf(':');
    const port = Number(address.slice(at + 1));
    if (at <= 0 || !Number.isInteger(port) || port <= 0) throw new Error(`PEAKET_IDENTITY_GRPC_URL이 host:port여야 한다: ${address}`);
    this.#client = createGrpcClient(pkg.ScannerSessionCheckService as grpc.ServiceClientConstructor, {
      host: address.slice(0, at),
      port,
      profile,
      dependency: 'identity-svc',
      timeoutCapMs: DEADLINE_CAP_MS,
    }) as unknown as grpc.Client & { CheckScannerSession: Unary };
  }

  check(q: { scannerSessionId: string; deviceId: string }): Promise<ScannerSessionAnswer> {
    return new Promise((res, rej) => {
      this.#client.CheckScannerSession(
        { scanner_session_id: q.scannerSessionId, device_id: q.deviceId },
        new grpc.Metadata(),
        { deadline: Date.now() + DEADLINE_CAP_MS },
        (e, v) => {
          if (e) return rej(e);
          const role = roleOf(v?.role);
          const eventId = typeof v?.event_id === 'string' && v.event_id !== '' ? v.event_id : undefined;
          res({ valid: v?.valid === true, ...(role ? { role } : {}), ...(eventId ? { eventId } : {}) });
        },
      );
    });
  }

  close(): void {
    this.#client.close();
  }
}
