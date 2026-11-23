// 스캐너 기기 HTTP 경로 시험(BUILD_ORDER GAT-170): 공개 기기 등록(DPoP)과 기기 원장 쓰임새.
// 관제 목록·등록·폐기 HTTP 경로는 ops-svc만 받는다(offline-gate §6.1 'GAT-170 마감 규칙', W7-WIR-02, F-05-5).
// 그래서 기기 만들기·폐기는 ticket-svc 응용 층(ScannerDevices, ops-svc가 gRPC로 부르는 것과 같은 객체)으로 하고, 공개 등록만 HTTP로 본다.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { fakeClock, MemoryDpopReplayStore, type AdminAuthzPort, createService, type ScannerSessionCheck } from '@peaket/platform';
import { calculateJwkThumbprint, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { MemoryEnrollmentCodeStore } from '../src/modules/scanner/adapters/memory-enrollment-code-store.js';
import { MemoryScannerDeviceStore } from '../src/modules/scanner/adapters/memory-scanner-device-store.js';
import { MemoryScannerGateStore } from '../src/modules/scanner/adapters/memory-scanner-gate-store.js';
import { MemoryScannerShiftStore } from '../src/modules/scanner/adapters/memory-scanner-shift-store.js';
import { ScannerDevices } from '../src/modules/scanner/application/scanner-devices.js';

const NOW = Date.parse('2026-11-13T00:00:00Z');
const PROMOTER = '0190f3a1-7c2e-7a00-8000-000000000001';
const ADMIN = '0190f3a1-7c2e-7a00-8000-000000000002';
/** 스캐너 PWA 출처(offline-gate §6.1 GAT-170 마감 규칙의 기본값) */
const PWA = 'https://scanner.peaket.example';

class ClosedAdmin implements AdminAuthzPort {
  async getAdminAuthz(): Promise<{ valid: boolean; role: string }> {
    return { valid: false, role: '' };
  }
}

class FakeSessions implements ScannerSessionCheck {
  async check(): Promise<{ valid: boolean }> {
    return { valid: false };
  }
}

const quiet = () => new Writable({ write: (_c, _e, cb) => cb() });
let svc: Awaited<ReturnType<typeof createService>>;
let store: MemoryScannerDeviceStore;
let devices: ScannerDevices;
const clock = fakeClock({ now: NOW });

beforeAll(async () => {
  store = new MemoryScannerDeviceStore();
  const gate = new MemoryScannerGateStore();
  const shift = new MemoryScannerShiftStore(gate);
  svc = await createService({
    name: 'ticket-svc',
    module: AppModule.register({
      scanner: { store, codes: new MemoryEnrollmentCodeStore(clock), replay: new MemoryDpopReplayStore(clock), gate, shift },
    }),
    env: { PEAKET_ENV: 'ci' },
    clock,
    logDestination: quiet(),
    adminAuthz: new ClosedAdmin(),
    scanner: { devices: store, sessions: new FakeSessions(), replay: new MemoryDpopReplayStore(clock) },
  });
  devices = svc.app.get(ScannerDevices);
});

afterAll(async () => {
  await svc?.close();
});

const enrollHeaders = (proof: string) => ({ 'x-forwarded-proto': 'https', 'x-forwarded-host': 'scanner.peaket.example', origin: PWA, dpop: proof, 'content-type': 'application/json' });

describe('스캐너 기기 원장 쓰임새 [GAT-170]', () => {
  test('기기를 만들면 ACTIVE 기기와 1회용 코드(10분)가 나오고, 목록에서 보인다', async () => {
    const r = await devices.register({ name: '동문-03', promoterId: PROMOTER, enrolledBy: ADMIN });
    expect(r.device).toMatchObject({ name: '동문-03', promoterId: PROMOTER, status: 'ACTIVE', credentialType: 'DEVICE_KEY' });
    expect(r.enrollmentCode).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
    expect(Date.parse(r.enrollmentCodeExpiresAt) - NOW).toBe(600_000);
    const list = await devices.list({ limit: 10 });
    expect(list.items).toEqual(expect.arrayContaining([expect.objectContaining({ deviceId: r.device.deviceId, name: '동문-03' })]));
  });

  test('O-T37 ① 공개 기기 등록은 DPoP 증명과 등록 코드로 jkt를 묶고, 같은 코드는 다시 쓰지 못한다', async () => {
    const created = await devices.register({ name: '동문-04', promoterId: PROMOTER, enrolledBy: ADMIN });
    const { enrollmentCode } = created;
    const deviceId = created.device.deviceId;

    const pair = await generateKeyPair('ES256', { extractable: true });
    const jwk = (await exportJWK(pair.publicKey)) as Record<string, unknown>;
    const jkt = await calculateJwkThumbprint(jwk as never, 'sha256');
    const htu = 'https://scanner.peaket.example/v1/scanner/device-enrollments';
    const proof = await new SignJWT({ jti: randomUUID(), htm: 'POST', htu, iat: Math.floor(NOW / 1000) })
      .setProtectedHeader({ typ: 'dpop+jwt', alg: 'ES256', jwk })
      .sign(pair.privateKey);
    const r = await svc.http.inject({ method: 'POST', url: '/v1/scanner/device-enrollments', headers: enrollHeaders(proof), payload: JSON.stringify({ code: enrollmentCode.toLowerCase().replace(/-/g, ' ') }) });
    expect(r.statusCode).toBe(201);
    expect(JSON.parse(r.payload)).toEqual({ deviceId });
    expect(await store.byThumbprint(jkt)).toMatchObject({ deviceId, status: 'ACTIVE', credentialThumbprint: jkt });

    const created2 = await devices.register({ name: '동문-04-2', promoterId: PROMOTER, enrolledBy: ADMIN });
    const proof2 = await new SignJWT({ jti: randomUUID(), htm: 'POST', htu, iat: Math.floor(NOW / 1000) })
      .setProtectedHeader({ typ: 'dpop+jwt', alg: 'ES256', jwk })
      .sign(pair.privateKey);
    const conflict = await svc.http.inject({ method: 'POST', url: '/v1/scanner/device-enrollments', headers: enrollHeaders(proof2), payload: JSON.stringify({ code: created2.enrollmentCode }) });
    expect(conflict.statusCode).toBe(409);
    expect(JSON.parse(conflict.payload)).toMatchObject({ type: 'https://peaket.example/problems/scanner-device-key-in-use' });

    const again = await svc.http.inject({ method: 'POST', url: '/v1/scanner/device-enrollments', headers: enrollHeaders(proof), payload: JSON.stringify({ code: enrollmentCode }) });
    expect(again.statusCode).toBe(400); // 같은 DPoP jti 재사용이 코드 재사용보다 먼저다
  });

  test('폐기하면 REVOKED가 되고, 그 뒤 등록 코드는 기기에 묶이지 않는다(410)', async () => {
    const created = await devices.register({ name: '동문-05', promoterId: PROMOTER, enrolledBy: ADMIN });
    const revoked = await devices.revoke({ deviceId: created.device.deviceId, reason: '분실' });
    expect(revoked.device).toMatchObject({ deviceId: created.device.deviceId, status: 'REVOKED' });

    const pair = await generateKeyPair('ES256', { extractable: true });
    const jwk = (await exportJWK(pair.publicKey)) as Record<string, unknown>;
    const proof = await new SignJWT({ jti: randomUUID(), htm: 'POST', htu: 'https://scanner.peaket.example/v1/scanner/device-enrollments', iat: Math.floor(NOW / 1000) })
      .setProtectedHeader({ typ: 'dpop+jwt', alg: 'ES256', jwk })
      .sign(pair.privateKey);
    const r = await svc.http.inject({ method: 'POST', url: '/v1/scanner/device-enrollments', headers: enrollHeaders(proof), payload: JSON.stringify({ code: created.enrollmentCode }) });
    expect(r.statusCode).toBe(410);
  });

  test('PWA 출처에서 DPoP 증명 없이 등록하면 400 invalid-dpop-proof다', async () => {
    const noProof = await svc.http.inject({
      method: 'POST',
      url: '/v1/scanner/device-enrollments',
      headers: { origin: PWA, 'content-type': 'application/json' },
      payload: JSON.stringify({ code: 'BCDF-GHJK-LMNP' }),
    });
    expect(noProof.statusCode).toBe(400);
    expect(JSON.parse(noProof.payload)).toMatchObject({ type: 'https://peaket.example/problems/invalid-dpop-proof' });
  });
});
