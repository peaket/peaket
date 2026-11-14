// 받는 층: gRPC ScannerDeviceLookupService.GetScannerDeviceByCredential(ticket.proto, identity §6.1 '기기 승인 때의 기기 상태 확인', GAT-220).
// identity-svc가 DPoP 증명의 키 지문(jkt)이나 인증서 지문으로 등록 기기를 찾고 상태를 본다. 기기 원장의 주인은 ticket-svc다.
// 등록되지 않았거나 자격 종류가 다르면 found=false다(identity가 403 미등록 기기로 답한다).
import * as grpc from '@grpc/grpc-js';
import type { ScannerDeviceStore } from '../domain/ports.js';
import { ScannerDeviceInputError, type ScannerDeviceStatus } from '../domain/scanner-device.js';

type Req = Record<string, unknown>;

const STATUS: Record<ScannerDeviceStatus, string> = {
  ACTIVE: 'SCANNER_DEVICE_STATUS_ACTIVE',
  REVOKED: 'SCANNER_DEVICE_STATUS_REVOKED',
  RETIRED: 'SCANNER_DEVICE_STATUS_RETIRED',
};

/** proto-loader는 bytes를 Buffer로 준다. jkt는 SHA-256 base64url 43자다 */
function thumbprintOf(v: unknown): string | undefined {
  if (v instanceof Uint8Array) return Buffer.from(v).toString('base64url');
  return undefined;
}

export function scannerDeviceLookupHandlers(
  uc: { store: Pick<ScannerDeviceStore, 'byThumbprint'> },
  onError: (method: string, err: unknown) => void,
): grpc.UntypedServiceImplementation {
  return {
    GetScannerDeviceByCredential: (call: grpc.ServerUnaryCall<Req, object>, cb: grpc.sendUnaryData<object>) => {
      const r = call.request;
      const credentialType = typeof r.credential_type === 'string' ? r.credential_type : '';
      const jkt = thumbprintOf(r.credential_thumbprint);
      if (credentialType !== 'SCANNER_CREDENTIAL_TYPE_DEVICE_KEY' || jkt === undefined) {
        cb(null, { found: false });
        return;
      }
      uc.store
        .byThumbprint(jkt)
        .then((d) => {
          if (!d) {
            cb(null, { found: false });
            return;
          }
          cb(null, {
            found: true,
            device_id: d.deviceId,
            status: STATUS[d.status],
            name: d.name,
            promoter_id: d.promoterId,
          });
        })
        .catch((err: unknown) => {
          if (err instanceof ScannerDeviceInputError) {
            cb(null, { found: false });
            return;
          }
          onError('GetScannerDeviceByCredential', err);
          cb({ code: grpc.status.INTERNAL, details: '기기 원장을 읽지 못했다' });
        });
    },
  };
}
