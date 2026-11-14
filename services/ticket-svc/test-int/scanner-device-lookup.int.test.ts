// ticket-svc ScannerDeviceLookupService·last_seen_at 실제 PostgreSQL 18 통합 시험(BUILD_ORDER GAT-220, R-566).
import { createDatabase, fakeClock, type Database } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migrateTicket } from '../scripts/migrate.mjs';
import { DrizzleScannerDeviceStore } from '../src/modules/scanner/adapters/db/drizzle-scanner-device-store.js';
import { scannerDeviceLookupHandlers } from '../src/modules/scanner/inbound/scanner-device-lookup.grpc.js';
import { startPostgres, type PostgresContainer } from './postgres.js';

const NOW = Date.parse('2026-11-14T03:00:00.000Z');
const PROMOTER = '0190f3a1-7c2e-7a00-8000-000000000001';
const ADMIN = '0190f3a1-7c2e-7a00-8000-000000000002';
const JKT = 'A'.repeat(43);

let pg: PostgresContainer;
let database: Database;
let store: DrizzleScannerDeviceStore;
let deviceId: string;

function lookup(request: Record<string, unknown>): Promise<Record<string, unknown>> {
  const handlers = scannerDeviceLookupHandlers({ store }, (method, err) => {
    throw new Error(`${method}: ${String(err)}`);
  });
  return new Promise((resolve, reject) => {
    (handlers.GetScannerDeviceByCredential as unknown as (c: unknown, cb: (e: unknown, v?: Record<string, unknown>) => void) => void)(
      { request },
      (e, v) => (e ? reject(e) : resolve(v ?? {})),
    );
  });
}

beforeAll(async () => {
  pg = await startPostgres();
  await migrateTicket(pg.url);
  database = createDatabase({ url: pg.url, applicationName: 'ticket-scanner-device-lookup-test', max: 4 });
  store = new DrizzleScannerDeviceStore(database);
  const clock = fakeClock({ now: NOW });
  const device = await store.register({ deviceId: randomUUID(), name: '동문-03', promoterId: PROMOTER, enrolledBy: ADMIN, atMs: clock.now() });
  deviceId = device.deviceId;
  await store.bindCredential({ deviceId, jkt: JKT, atMs: clock.now() });
});

afterAll(async () => {
  await database?.close().catch(() => {});
  pg?.stop();
});

describe('ScannerDeviceLookupService PostgreSQL [GAT-220]', () => {
  test('기기 키 지문으로 ACTIVE 기기·이름·배정 파트너를 주고 last_seen_at을 남긴다', async () => {
    const r = await lookup({ credential_type: 'SCANNER_CREDENTIAL_TYPE_DEVICE_KEY', credential_thumbprint: Buffer.from(JKT, 'base64url') });
    expect(r).toEqual({
      found: true,
      device_id: deviceId,
      status: 'SCANNER_DEVICE_STATUS_ACTIVE',
      name: '동문-03',
      promoter_id: PROMOTER,
    });

    await store.touch(deviceId, NOW + 5_000);
    const row = (await database.pool.query('select last_seen_at from scanner_device where id = $1', [deviceId])).rows[0];
    expect(new Date(row.last_seen_at).getTime()).toBe(NOW + 5_000);
    expect((await store.findById(deviceId))?.lastSeenAtMs).toBe(NOW + 5_000);
  });

  test('없는 지문·다른 자격 종류는 found=false이고, 폐기 기기는 상태로 답한다', async () => {
    expect(await lookup({ credential_type: 'SCANNER_CREDENTIAL_TYPE_DEVICE_KEY', credential_thumbprint: Buffer.from('B'.repeat(43), 'base64url') })).toEqual({ found: false });
    expect(await lookup({ credential_type: 'SCANNER_CREDENTIAL_TYPE_MTLS_CERT', credential_thumbprint: Buffer.from(JKT, 'base64url') })).toEqual({ found: false });
    expect(await lookup({ credential_type: 'SCANNER_CREDENTIAL_TYPE_DEVICE_KEY' })).toEqual({ found: false });

    await store.revoke({ deviceId, reason: '분실', atMs: NOW + 10_000 });
    const r = await lookup({ credential_type: 'SCANNER_CREDENTIAL_TYPE_DEVICE_KEY', credential_thumbprint: Buffer.from(JKT, 'base64url') });
    expect(r).toMatchObject({ found: true, status: 'SCANNER_DEVICE_STATUS_REVOKED' });
  });
});
