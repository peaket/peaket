// ticket-svc ScannerDeviceService request_id 멱등·SESSION_TERMINATED 실제 PostgreSQL 18 통합 시험(BAT-450, R-586).
import { createDatabase, fakeClock, type Database } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migrateTicket } from '../scripts/migrate.mjs';
import { DrizzleScannerDeviceCommandStore, DrizzleScannerDeviceStore } from '../src/modules/scanner/adapters/db/drizzle-scanner-device-store.js';
import { DrizzleScannerGateStore } from '../src/modules/scanner/adapters/db/drizzle-scanner-gate-store.js';
import { DrizzleScannerShiftStore } from '../src/modules/scanner/adapters/db/drizzle-scanner-shift-store.js';
import { MemoryEnrollmentCodeStore } from '../src/modules/scanner/adapters/memory-enrollment-code-store.js';
import { ScannerDevices } from '../src/modules/scanner/application/scanner-devices.js';
import { startPostgres, type PostgresContainer } from './postgres.js';

const NOW = Date.parse('2026-11-15T00:00:00.000Z');
const PROMOTER = '0190f3a1-7c2e-7a00-8000-000000000001';
const ADMIN = '0190f3a1-7c2e-7a00-8000-000000000002';
const EVENT = '0190f3a1-7c2e-7a00-8000-000000000004';

let pg: PostgresContainer;
let database: Database;
let devices: ScannerDevices;
let gate: DrizzleScannerGateStore;
let shift: DrizzleScannerShiftStore;

beforeAll(async () => {
  pg = await startPostgres();
  await migrateTicket(pg.url);
  database = createDatabase({ url: pg.url, applicationName: 'ticket-scanner-device-command-test', max: 4 });
  const clock = fakeClock({ now: NOW });
  const store = new DrizzleScannerDeviceStore(database);
  const commands = new DrizzleScannerDeviceCommandStore(database);
  gate = new DrizzleScannerGateStore(database);
  shift = new DrizzleScannerShiftStore(database);
  devices = new ScannerDevices({ store, codes: new MemoryEnrollmentCodeStore(clock), clock, commands, shifts: shift });
});

afterAll(async () => {
  await database?.close().catch(() => {});
  pg?.stop();
});

describe('ScannerDeviceService command idempotency PostgreSQL [BAT-450]', () => {
  test('같은 request_id 등록은 기기를 하나만 만들고 두 번째는 코드 없이 alreadyDone이다', async () => {
    const requestId = randomUUID();
    const first = await devices.register({ requestId, name: '동문-03', promoterId: PROMOTER, enrolledBy: ADMIN });
    expect(first.alreadyDone).toBe(false);
    expect(first.enrollmentCode).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-/);
    const second = await devices.register({ requestId, name: '다른 이름', promoterId: PROMOTER, enrolledBy: ADMIN });
    expect(second.alreadyDone).toBe(true);
    expect(second.enrollmentCode).toBe('');
    expect(second.device.deviceId).toBe(first.device.deviceId);
    const rows = (await database.pool.query('select count(*)::int as n from scanner_device where id = $1', [first.device.deviceId])).rows[0] as { n: number };
    expect(rows.n).toBe(1);
    const command = (await database.pool.query('select action, device_id from scanner_device_command where request_id = $1', [requestId])).rows[0];
    expect(command).toMatchObject({ action: 'REGISTER', device_id: first.device.deviceId });
  });

  test('기기 폐기는 배치된 회차에 SESSION_TERMINATED를 남기고, 마지막 변경분 수신 시각을 기록한다', async () => {
    const requestId = randomUUID();
    const r = await devices.register({ requestId, name: '서문-01', promoterId: PROMOTER, enrolledBy: ADMIN });
    const deviceId = r.device.deviceId;
    await shift.putPlacement({ eventId: EVENT, deviceId, gateZone: 'A', mode: 'IN', setBy: ADMIN, atMs: NOW, expectedVersion: 0 });
    await devices.revoke({ requestId: randomUUID(), deviceId, reason: '분실' });
    const changes = await gate.changes({ eventId: EVENT, after: 0, limit: 100, nowMs: NOW });
    expect(changes.changes.find((c) => c.kind === 'SESSION_TERMINATED')?.payload).toEqual({ v: 1, deviceId, reason: 'DEVICE_REVOKED' });
    await new DrizzleScannerDeviceStore(database).touchChanges(deviceId, NOW + 1_000);
    const row = (await database.pool.query('select last_changes_at from scanner_device where id = $1', [deviceId])).rows[0];
    expect(new Date(row.last_changes_at).getTime()).toBe(NOW + 1_000);
  });
});
