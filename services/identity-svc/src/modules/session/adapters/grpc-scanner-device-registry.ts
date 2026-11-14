// ticket-svc ScannerDeviceLookupService 클라이언트(identity §6.1 '기기 승인 때의 기기 상태 확인', GAT-220).
// DPoP 증명의 키 지문(jkt)으로 등록 기기를 찾고 상태·이름·배정 파트너 ID를 받는다. 답이 없으면 ScannerRegistryUnavailable(503).
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { ticketV1Ticket } from '@peaket/contracts/proto';
import { createGrpcClient, type GrpcLbProfile } from '@peaket/platform';
import { type ScannerDeviceLookupAnswer, type ScannerDeviceRegistry, ScannerRegistryUnavailable } from '../domain/ports.js';

const PROTO_LOAD_OPTIONS: protoLoader.Options = { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true };
const DEADLINE_MS = 1_000;

type Unary = (req: object, md: grpc.Metadata, opts: grpc.CallOptions, cb: (e: grpc.ServiceError | null, v?: Record<string, unknown>) => void) => grpc.ClientUnaryCall;

export class GrpcScannerDeviceRegistry implements ScannerDeviceRegistry {
  readonly #client: grpc.Client & { GetScannerDeviceByCredential: Unary };

  constructor(address: string, profile: GrpcLbProfile = 'service') {
    const def = protoLoader.fromJSON(ticketV1Ticket as Parameters<typeof protoLoader.fromJSON>[0], PROTO_LOAD_OPTIONS);
    const node = (grpc.loadPackageDefinition(def) as unknown as { peaket: { ticket: { v1: { ScannerDeviceLookupService: grpc.ServiceClientConstructor } } } }).peaket.ticket.v1;
    const at = address.lastIndexOf(':');
    const port = Number(address.slice(at + 1));
    if (at <= 0 || !Number.isInteger(port) || port <= 0) throw new Error(`ScannerDeviceLookup 주소는 host:port여야 한다: ${address}`);
    this.#client = createGrpcClient(node.ScannerDeviceLookupService, {
      host: address.slice(0, at),
      port,
      profile,
      dependency: 'ticket-svc',
      timeoutCapMs: DEADLINE_MS,
    }) as unknown as grpc.Client & { GetScannerDeviceByCredential: Unary };
  }

  async byThumbprint(jkt: string): Promise<ScannerDeviceLookupAnswer> {
    const thumbprint = Buffer.from(jkt, 'base64url');
    return new Promise<ScannerDeviceLookupAnswer>((resolve, reject) => {
      this.#client.GetScannerDeviceByCredential(
        { credential_type: 'SCANNER_CREDENTIAL_TYPE_DEVICE_KEY', credential_thumbprint: thumbprint },
        new grpc.Metadata(),
        { deadline: Date.now() + DEADLINE_MS },
        (err, v) => {
          if (err) {
            reject(new ScannerRegistryUnavailable(err));
            return;
          }
          const r = v ?? {};
          if (r.found !== true) {
            resolve({ found: false });
            return;
          }
          const status = String(r.status ?? '').replace(/^SCANNER_DEVICE_STATUS_/, '');
          if (status !== 'ACTIVE' && status !== 'REVOKED' && status !== 'RETIRED') {
            reject(new ScannerRegistryUnavailable(new Error(`모르는 기기 상태 ${String(r.status)}`)));
            return;
          }
          resolve({
            found: true,
            deviceId: String(r.device_id ?? ''),
            status,
            name: String(r.name ?? ''),
            promoterId: String(r.promoter_id ?? ''),
          });
        },
      );
    });
  }

  close(): void {
    this.#client.close();
  }
}
