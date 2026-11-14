// ticket-svc ScannerDeviceLookupService.GetScannerDeviceByCredential 시험(GAT-220, identity §6.1).
import { describe, expect, test } from 'vitest';
import { scannerDeviceLookupHandlers } from '../src/modules/scanner/inbound/scanner-device-lookup.grpc.js';
import type { ScannerDeviceRecord } from '../src/modules/scanner/domain/scanner-device.js';

const JKT = 'A'.repeat(43);

function handlersWith(device: ScannerDeviceRecord | null) {
  const errors: string[] = [];
  const handlers = scannerDeviceLookupHandlers(
    {
      store: {
        byThumbprint: async () => device,
      },
    },
    (method, err) => errors.push(`${method}:${String(err)}`),
  );
  const call = (request: Record<string, unknown>) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      (handlers.GetScannerDeviceByCredential as unknown as (c: unknown, cb: (e: unknown, v?: Record<string, unknown>) => void) => void)(
        { request },
        (e, v) => (e ? reject(e) : resolve(v ?? {})),
      );
    });
  return { call, errors };
}

const device: ScannerDeviceRecord = {
  deviceId: '0190f3a1-7c2e-7a00-8000-000000000006',
  name: '동문-03',
  promoterId: '0190f3a1-7c2e-7a00-8000-000000000007',
  status: 'ACTIVE',
  credentialType: 'DEVICE_KEY',
  credentialThumbprint: JKT,
  enrolledBy: '0190f3a1-7c2e-7a00-8000-000000000005',
  enrolledAtMs: Date.parse('2026-11-14T03:00:00.000Z'),
};

describe('ScannerDeviceLookupService [GAT-220]', () => {
  test('기기 키 지문으로 기기 ID·상태·이름·배정 파트너를 돌려준다', async () => {
    const h = handlersWith(device);
    const r = await h.call({ credential_type: 'SCANNER_CREDENTIAL_TYPE_DEVICE_KEY', credential_thumbprint: Buffer.from(JKT, 'base64url') });
    expect(r).toEqual({
      found: true,
      device_id: device.deviceId,
      status: 'SCANNER_DEVICE_STATUS_ACTIVE',
      name: '동문-03',
      promoter_id: device.promoterId,
    });
  });

  test('폐기 기기도 found=true와 상태로 답한다', async () => {
    const h = handlersWith({ ...device, status: 'REVOKED' });
    const r = await h.call({ credential_type: 'SCANNER_CREDENTIAL_TYPE_DEVICE_KEY', credential_thumbprint: Buffer.from(JKT, 'base64url') });
    expect(r).toMatchObject({ found: true, status: 'SCANNER_DEVICE_STATUS_REVOKED' });
  });

  test('없는 기기·다른 자격 종류·지문 누락은 found=false다', async () => {
    const none = handlersWith(null);
    expect(await none.call({ credential_type: 'SCANNER_CREDENTIAL_TYPE_DEVICE_KEY', credential_thumbprint: Buffer.from(JKT, 'base64url') })).toEqual({ found: false });
    expect(await none.call({ credential_type: 'SCANNER_CREDENTIAL_TYPE_MTLS_CERT', credential_thumbprint: Buffer.from(JKT, 'base64url') })).toEqual({ found: false });
    expect(await none.call({ credential_type: 'SCANNER_CREDENTIAL_TYPE_DEVICE_KEY' })).toEqual({ found: false });
  });
});
