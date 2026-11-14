// /v1/ops/scanner-devices* (BAT-450 GAT-220 잔여): ops-svc가 권한·감사를 맡고 ticket-svc gRPC 원장을 부른다.
import 'reflect-metadata';
import { createService } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { MemoryAuditChain } from '../src/modules/audit/index.js';
import {
  ScannerDeviceDependencyUnavailable,
  ScannerDeviceInactive,
  ScannerDeviceNotFound,
  type ScannerDevicePage,
  type ScannerDeviceRegistration,
  type ScannerDeviceRevocation,
  type TicketScannerDevices,
} from '../src/modules/scanner-devices/index.js';
import { FakeIdentity, quiet } from './support.js';

const NOW = Date.parse('2026-11-15T00:00:00Z');
const PROMOTER = '0190f3a1-7c2e-7a00-8000-000000000001';
const ADMIN = '0190f3a1-7c2e-7a00-8000-000000000002';
const DEVICE = '0190f3a1-7c2e-7a00-8000-000000000003';
const REQUEST = '0190f3a1-7c2e-7a00-8000-000000000004';
const identity = new FakeIdentity();
const chain = new MemoryAuditChain();
const calls: { method: string; input: Record<string, unknown> }[] = [];
let failure: 'not-found' | 'inactive' | 'down' | undefined;

const device = { deviceId: DEVICE, name: '동문-03', promoterId: PROMOTER, status: 'ACTIVE' as const, credentialType: 'DEVICE_KEY' as const };
const page: ScannerDevicePage = { items: [device] };
const ticket: TicketScannerDevices = {
  list: async (q) => {
    calls.push({ method: 'list', input: q });
    return page;
  },
  register: async (q): Promise<ScannerDeviceRegistration> => {
    calls.push({ method: 'register', input: q });
    return { device, enrollmentCode: 'BCDF-GHJK-LMNP', enrollmentCodeExpiresAt: new Date(NOW + 600_000).toISOString(), alreadyDone: false };
  },
  revoke: async (q): Promise<ScannerDeviceRevocation> => {
    calls.push({ method: 'revoke', input: q });
    return { device: { ...device, status: 'REVOKED' }, alreadyDone: false };
  },
  reissue: async (q) => {
    calls.push({ method: 'reissue', input: q });
    return { enrollmentCode: 'BCDF-GHJK-LMNP', enrollmentCodeExpiresAt: new Date(NOW + 600_000).toISOString(), alreadyDone: false };
  },
};

// 오류 사상 시험은 같은 포트를 잠시 바꿔 끼운다
const failing: TicketScannerDevices = {
  ...ticket,
  list: async () => {
    if (failure === 'not-found') throw new ScannerDeviceNotFound();
    if (failure === 'inactive') throw new ScannerDeviceInactive();
    if (failure === 'down') throw new ScannerDeviceDependencyUnavailable();
    return page;
  },
};

let svc: Awaited<ReturnType<typeof createService>>;

beforeAll(async () => {
  svc = await createService({
    name: 'ops-svc-scanner-devices',
    module: AppModule.register({ memory: true, scannerDevices: failing, auditChain: chain }),
    env: { PEAKET_ENV: 'ci' },
    logDestination: quiet(),
    adminAuthz: identity,
  });
});
afterAll(async () => {
  await svc?.close();
});

const post = (url: string, headers: Record<string, string>, body: unknown = {}) =>
  svc.http.inject({ method: 'POST', url, headers: { ...headers, 'content-type': 'application/json' }, payload: JSON.stringify(body) });

describe('/v1/ops/scanner-devices [BAT-450]', () => {
  test('viewer는 목록만, operator는 등록·재발급·폐기를 하고 감사 체인에 남긴다', async () => {
    failure = undefined;
    calls.length = 0;
    const viewer = identity.ops('viewer');
    expect((await svc.http.inject({ method: 'GET', url: '/v1/ops/scanner-devices', headers: viewer })).statusCode).toBe(200);

    const op = identity.ops('operator');
    const created = await post('/v1/ops/scanner-devices', op, { name: '동문-03', promoterId: PROMOTER });
    expect(created.statusCode).toBe(201);
    expect(JSON.parse(created.payload)).toMatchObject({ deviceId: DEVICE, status: 'ACTIVE', enrollmentCode: 'BCDF-GHJK-LMNP' });
    const issued = await post(`/v1/ops/scanner-devices/${DEVICE}/enrollment-code`, op);
    expect(issued.statusCode).toBe(201);
    expect(JSON.parse(issued.payload)).toMatchObject({ enrollmentCode: 'BCDF-GHJK-LMNP' });
    const revoked = await post(`/v1/ops/scanner-devices/${DEVICE}/revocation`, op, { reason: '분실' });
    expect(revoked.statusCode).toBe(200);
    expect(JSON.parse(revoked.payload)).toMatchObject({ status: 'REVOKED' });

    expect(calls.map((c) => c.method)).toEqual(['register', 'reissue', 'revoke']);
    expect(chain.entries.map((e) => e.recordType)).toEqual(['scanner_device_command', 'scanner_device_command', 'scanner_device_command']);
    expect(chain.entries[0]!.recordId).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('viewer는 등록·재발급·폐기를 못 한다', async () => {
    const viewer = identity.ops('viewer');
    expect((await post('/v1/ops/scanner-devices', viewer, { name: '동문-03', promoterId: PROMOTER })).statusCode).toBe(403);
    expect((await post(`/v1/ops/scanner-devices/${DEVICE}/enrollment-code`, viewer)).statusCode).toBe(403);
    expect((await post(`/v1/ops/scanner-devices/${DEVICE}/revocation`, viewer, { reason: '분실' })).statusCode).toBe(403);
  });

  test('ticket-svc 오류는 404·409·503 Problem으로 사상한다', async () => {
    const viewer = identity.ops('viewer');
    failure = 'not-found';
    const nf = await svc.http.inject({ method: 'GET', url: '/v1/ops/scanner-devices', headers: viewer });
    expect(nf.statusCode).toBe(404);
    expect(JSON.parse(nf.payload)).toMatchObject({ type: 'https://peaket.example/problems/scanner-device-not-found' });

    failure = 'inactive';
    const inactive = await svc.http.inject({ method: 'GET', url: '/v1/ops/scanner-devices', headers: viewer });
    expect(inactive.statusCode).toBe(409);
    expect(JSON.parse(inactive.payload)).toMatchObject({ type: 'https://peaket.example/problems/scanner-device-inactive' });

    failure = 'down';
    const down = await svc.http.inject({ method: 'GET', url: '/v1/ops/scanner-devices', headers: viewer });
    expect(down.statusCode).toBe(503);
    expect(JSON.parse(down.payload)).toMatchObject({ type: 'https://peaket.example/problems/scanner-auth-unavailable' });
    failure = undefined;
  });
});
