// 스캐너 기기 HTTP 경로 시험(BUILD_ORDER GAT-170): 관제 목록·등록·폐기와 공개 기기 등록(DPoP).
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { fakeClock, MemoryDpopReplayStore, type AdminAuthz, type AdminAuthzPort, createService } from '@peaket/platform';
import { calculateJwkThumbprint, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { MemoryEnrollmentCodeStore } from '../src/modules/scanner/adapters/memory-enrollment-code-store.js';
import { MemoryScannerDeviceStore } from '../src/modules/scanner/adapters/memory-scanner-device-store.js';

const NOW = Date.parse('2026-11-13T00:00:00Z');
const PROMOTER = '0190f3a1-7c2e-7a00-8000-000000000001';
const ADMIN = '0190f3a1-7c2e-7a00-8000-000000000002';
const SESSION = '0190f3a1-7c2e-7a00-8000-000000000003';

class FakeIdentity implements AdminAuthzPort {
  readonly answers = new Map<string, AdminAuthz>();
  async getAdminAuthz(q: { adminAccountId: string; sessionId: string }): Promise<AdminAuthz> {
    return this.answers.get(`${q.adminAccountId}/${q.sessionId}`) ?? { valid: false, role: '' };
  }
}

const quiet = () => new Writable({ write: (_c, _e, cb) => cb() });
let svc: Awaited<ReturnType<typeof createService>>;
let store: MemoryScannerDeviceStore;
const identity = new FakeIdentity();
const clock = fakeClock({ now: NOW });
const headers = { 'x-user-id': ADMIN, 'x-session-id': SESSION, 'x-user-aud': 'ops', 'x-user-scope': '' };

beforeAll(async () => {
  identity.answers.set(`${ADMIN}/${SESSION}`, { valid: true, role: 'operator' });
  store = new MemoryScannerDeviceStore();
  svc = await createService({
    name: 'ticket-svc',
    module: AppModule.register({
      scanner: { store, codes: new MemoryEnrollmentCodeStore(clock), replay: new MemoryDpopReplayStore(clock) },
    }),
    env: { PEAKET_ENV: 'ci' },
    clock,
    logDestination: quiet(),
    adminAuthz: identity,
  });
});

afterAll(async () => {
  await svc?.close();
});

const post = (url: string, body: unknown, h: Record<string, string> = headers) => svc.http.inject({ method: 'POST', url, headers: { ...h, 'content-type': 'application/json' }, payload: JSON.stringify(body) });

describe('관제 스캐너 기기 경로 [GAT-170]', () => {
  test('operator가 기기를 등록하면 ACTIVE 기기와 1회용 코드가 201로 나오고, 목록에서 보인다', async () => {
    const r = await post('/v1/ops/scanner-devices', { name: '동문-03', promoterId: PROMOTER });
    expect(r.statusCode).toBe(201);
    const body = JSON.parse(r.payload) as { deviceId: string; name: string; status: string; enrollmentCode: string; enrollmentCodeExpiresAt: string };
    expect(body).toMatchObject({ name: '동문-03', promoterId: PROMOTER, status: 'ACTIVE', credentialType: 'DEVICE_KEY' });
    expect(body.enrollmentCode).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
    expect(Date.parse(body.enrollmentCodeExpiresAt) - NOW).toBe(600_000);
    expect(r.headers['cache-control']).toBe('no-store');

    const list = await svc.http.inject({ method: 'GET', url: '/v1/ops/scanner-devices?limit=10', headers });
    expect(list.statusCode).toBe(200);
    expect(JSON.parse(list.payload)).toMatchObject({ items: [expect.objectContaining({ deviceId: body.deviceId, name: '동문-03' })] });
  });

  test('공개 기기 등록은 DPoP 증명과 등록 코드로 jkt를 묶고, 같은 코드는 다시 쓰지 못한다', async () => {
    const created = await post('/v1/ops/scanner-devices', { name: '동문-04', promoterId: PROMOTER });
    const { enrollmentCode, deviceId } = JSON.parse(created.payload) as { enrollmentCode: string; deviceId: string };

    const pair = await generateKeyPair('ES256', { extractable: true });
    const jwk = (await exportJWK(pair.publicKey)) as Record<string, unknown>;
    const jkt = await calculateJwkThumbprint(jwk as never, 'sha256');
    const htu = 'https://scanner.peaket.example/v1/scanner/device-enrollments';
    const proof = await new SignJWT({ jti: randomUUID(), htm: 'POST', htu, iat: Math.floor(NOW / 1000) })
      .setProtectedHeader({ typ: 'dpop+jwt', alg: 'ES256', jwk })
      .sign(pair.privateKey);
    const enrollHeaders = { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'scanner.peaket.example', dpop: proof, 'content-type': 'application/json' };
    const r = await svc.http.inject({ method: 'POST', url: '/v1/scanner/device-enrollments', headers: enrollHeaders, payload: JSON.stringify({ code: enrollmentCode.toLowerCase().replace(/-/g, ' ') }) });
    expect(r.statusCode).toBe(201);
    expect(JSON.parse(r.payload)).toEqual({ deviceId });
    expect(await store.byThumbprint(jkt)).toMatchObject({ deviceId, status: 'ACTIVE', credentialThumbprint: jkt });

    const created2 = await post('/v1/ops/scanner-devices', { name: '동문-04-2', promoterId: PROMOTER });
    const { enrollmentCode: code2 } = JSON.parse(created2.payload) as { enrollmentCode: string };
    const proof2 = await new SignJWT({ jti: randomUUID(), htm: 'POST', htu, iat: Math.floor(NOW / 1000) })
      .setProtectedHeader({ typ: 'dpop+jwt', alg: 'ES256', jwk })
      .sign(pair.privateKey);
    const conflict = await svc.http.inject({ method: 'POST', url: '/v1/scanner/device-enrollments', headers: { ...enrollHeaders, dpop: proof2 }, payload: JSON.stringify({ code: code2 }) });
    expect(conflict.statusCode).toBe(409);
    expect(JSON.parse(conflict.payload)).toMatchObject({ type: 'https://peaket.example/problems/scanner-device-key-in-use' });

    const again = await svc.http.inject({ method: 'POST', url: '/v1/scanner/device-enrollments', headers: enrollHeaders, payload: JSON.stringify({ code: enrollmentCode }) });
    expect(again.statusCode).toBe(400); // 같은 DPoP jti 재사용이 코드 재사용보다 먼저다
  });

  test('폐기는 200으로 REVOKED가 되고, 그 뒤 등록 코드는 기기에 묶이지 않는다', async () => {
    const created = await post('/v1/ops/scanner-devices', { name: '동문-05', promoterId: PROMOTER });
    const { deviceId, enrollmentCode } = JSON.parse(created.payload) as { deviceId: string; enrollmentCode: string };
    const revoked = await post(`/v1/ops/scanner-devices/${deviceId}/revocation`, { reason: '분실' });
    expect(revoked.statusCode).toBe(200);
    expect(JSON.parse(revoked.payload)).toMatchObject({ deviceId, status: 'REVOKED' });

    const pair = await generateKeyPair('ES256', { extractable: true });
    const jwk = (await exportJWK(pair.publicKey)) as Record<string, unknown>;
    const proof = await new SignJWT({ jti: randomUUID(), htm: 'POST', htu: 'https://scanner.peaket.example/v1/scanner/device-enrollments', iat: Math.floor(NOW / 1000) })
      .setProtectedHeader({ typ: 'dpop+jwt', alg: 'ES256', jwk })
      .sign(pair.privateKey);
    const r = await svc.http.inject({
      method: 'POST',
      url: '/v1/scanner/device-enrollments',
      headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'scanner.peaket.example', dpop: proof, 'content-type': 'application/json' },
      payload: JSON.stringify({ code: enrollmentCode }),
    });
    expect(r.statusCode).toBe(410);
  });

  test('DPoP 증명이 없으면 400이고, viewer 역할은 등록할 수 없다', async () => {
    const noProof = await svc.http.inject({ method: 'POST', url: '/v1/scanner/device-enrollments', headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ code: 'BCDF-GHJK-LMNP' }) });
    expect(noProof.statusCode).toBe(400);

    const viewer = randomUUID();
    const viewerSession = randomUUID();
    identity.answers.set(`${viewer}/${viewerSession}`, { valid: true, role: 'viewer' });
    const r = await post('/v1/ops/scanner-devices', { name: '동문-06', promoterId: PROMOTER }, { 'x-user-id': viewer, 'x-session-id': viewerSession, 'x-user-aud': 'ops', 'x-user-scope': '' });
    expect(r.statusCode).toBe(403);
  });
});
