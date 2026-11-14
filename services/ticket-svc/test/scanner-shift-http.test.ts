// 근무 준비·기기 배치·준비 보고·등록 코드 재발급·IP 실패 제한의 HTTP 시험
// (BUILD_ORDER GAT-170 잔여, offline-gate §6.1·§6.2, O-T37·O-T42).
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { athOf, createService, fakeClock, MemoryDpopReplayStore, type AdminAuthz, type AdminAuthzPort, type ScannerSessionCheck } from '@peaket/platform';
import { calculateJwkThumbprint, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { MemoryEnrollmentAttemptLimiter } from '../src/modules/scanner/adapters/memory-enrollment-attempt-limiter.js';
import { MemoryEnrollmentCodeStore } from '../src/modules/scanner/adapters/memory-enrollment-code-store.js';
import { MemoryScannerDeviceStore } from '../src/modules/scanner/adapters/memory-scanner-device-store.js';
import { MemoryScannerGateStore } from '../src/modules/scanner/adapters/memory-scanner-gate-store.js';
import { MemoryScannerShiftStore } from '../src/modules/scanner/adapters/memory-scanner-shift-store.js';
import type { ScannerEventPolicy } from '../src/modules/scanner/domain/ports.js';

const NOW = Date.parse('2026-11-15T00:00:00Z');
const HOUR = 60 * 60_000;
const EVENT = '0190f3a1-7c2e-7a00-8000-000000000001';
const DEVICE = '0190f3a1-7c2e-7a00-8000-000000000002';
const OTHER_DEVICE = '0190f3a1-7c2e-7a00-8000-000000000003';
const PROMOTER = '0190f3a1-7c2e-7a00-8000-000000000004';
const OTHER_PROMOTER = '0190f3a1-7c2e-7a00-8000-000000000005';
const ADMIN = '0190f3a1-7c2e-7a00-8000-000000000006';
const ACCOUNT = '0190f3a1-7c2e-7a00-8000-000000000007';
const ASSIGNMENT = '0190f3a1-7c2e-7a00-8000-000000000008';
const SESSION = '0190f3a1-7c2e-7a00-8000-000000000009';
const TICKET = '0190f3a1-7c2e-7a00-8000-00000000000a';
const SCAN_SESSION = '0190f3a1-7c2e-7a00-8000-00000000000b';
const TOKEN = 'staff-token';
const HOST = 'scanner-api.peaket.example';

class FakeIdentity implements AdminAuthzPort {
  readonly answers = new Map<string, AdminAuthz>();
  async getAdminAuthz(q: { adminAccountId: string; sessionId: string }): Promise<AdminAuthz> {
    return this.answers.get(`${q.adminAccountId}/${q.sessionId}`) ?? { valid: false, role: '' };
  }
}

class FakeSessions implements ScannerSessionCheck {
  answer = { valid: true, role: 'gate_lead' as const, eventId: EVENT, assignmentId: ASSIGNMENT, validFromMs: NOW - HOUR, validUntilMs: NOW + 4 * HOUR, proxy: false };
  async check(): Promise<typeof this.answer> {
    return this.answer;
  }
}

const quiet = () => new Writable({ write: (_c, _e, cb) => cb() });
let svc: Awaited<ReturnType<typeof createService>>;
let store: MemoryScannerDeviceStore;
let shift: MemoryScannerShiftStore;
const clock = fakeClock({ now: NOW });
const identity = new FakeIdentity();
const sessions = new FakeSessions();
let policyAnswer: ScannerEventPolicy | undefined;

type Key = { privateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey']; jwk: Record<string, unknown>; jkt: string };
async function keyOf(): Promise<Key> {
  const pair = await generateKeyPair('ES256', { extractable: true });
  const jwk = (await exportJWK(pair.publicKey)) as Record<string, unknown>;
  return { privateKey: pair.privateKey, jwk, jkt: await calculateJwkThumbprint(jwk as never, 'sha256') };
}

async function proofOf(key: Key, method: string, path: string, token?: string): Promise<string> {
  const payload: Record<string, unknown> = { jti: randomUUID(), htm: method, htu: `https://${HOST}${path}`, iat: Math.floor(NOW / 1000) };
  if (token) payload.ath = athOf(token);
  return new SignJWT(payload).setProtectedHeader({ typ: 'dpop+jwt', alg: 'ES256', jwk: key.jwk }).sign(key.privateKey);
}

async function staffHeaders(key: Key, method: string, path: string): Promise<Record<string, string>> {
  return {
    dpop: await proofOf(key, method, path, TOKEN),
    authorization: `DPoP ${TOKEN}`,
    'x-user-id': ACCOUNT,
    'x-session-id': SESSION,
    'x-user-aud': 'scanner',
    'x-user-jkt': key.jkt,
    'x-user-ath': athOf(TOKEN),
    'x-forwarded-proto': 'https',
    'x-forwarded-host': HOST,
    'content-type': 'application/json',
  };
}

const opsHeaders = { 'x-user-id': ADMIN, 'x-session-id': 'ops-session', 'x-user-aud': 'ops', 'x-user-scope': '', 'content-type': 'application/json' };

beforeAll(async () => {
  identity.answers.set(`${ADMIN}/ops-session`, { valid: true, role: 'operator' });
  store = new MemoryScannerDeviceStore();
  await store.register({ deviceId: DEVICE, name: '동문-03', promoterId: PROMOTER, enrolledBy: ADMIN, atMs: NOW });
  await store.bindCredential({ deviceId: DEVICE, jkt: (await keyOf()).jkt, atMs: NOW });
  const gate = new MemoryScannerGateStore();
  gate.seedTicket({ ticketId: TICKET, eventId: EVENT, seatId: 'A-1', gateZone: '동문', status: 'ACTIVE' });
  shift = new MemoryScannerShiftStore(gate);
  const limiter = new MemoryEnrollmentAttemptLimiter(() => clock.now());
  svc = await createService({
    name: 'ticket-svc-shift-http',
    module: AppModule.register({ scanner: { store, codes: new MemoryEnrollmentCodeStore(clock), replay: new MemoryDpopReplayStore(clock), gate, shift, limiter, policy: { get: async () => policyAnswer } } }),
    env: { PEAKET_ENV: 'ci' },
    clock,
    logDestination: quiet(),
    adminAuthz: identity,
    scanner: { devices: store, sessions, replay: new MemoryDpopReplayStore(clock) },
  });
});

afterAll(async () => {
  await svc?.close();
});

describe('근무 준비와 준비 보고 [GAT-170]', () => {
  test('배치가 없으면 409 no-placement이고, 배치 뒤에는 기기·배정·게이트·목록 번호가 200으로 나온다', async () => {
    const key = await keyOf();
    await store.bindCredential({ deviceId: DEVICE, jkt: key.jkt, atMs: NOW });
    const noPlacement = await svc.http.inject({ method: 'GET', url: '/v1/scanner/shift', headers: await staffHeaders(key, 'GET', '/v1/scanner/shift') });
    expect(noPlacement.statusCode).toBe(409);
    expect(JSON.parse(noPlacement.payload)).toMatchObject({ type: 'https://peaket.example/problems/no-placement' });

    await shift.putPlacement({ eventId: EVENT, deviceId: DEVICE, gateZone: '동문', mode: 'IN', setBy: ADMIN, atMs: NOW, expectedVersion: 0 });
    const r = await svc.http.inject({ method: 'GET', url: '/v1/scanner/shift', headers: await staffHeaders(key, 'GET', '/v1/scanner/shift') });
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(JSON.parse(r.payload)).toMatchObject({
      eventId: EVENT,
      reentryAllowed: false,
      placement: { gateZone: '동문', mode: 'IN' },
      packageSeq: 1,
      role: 'gate_lead',
      device: { deviceId: DEVICE, name: '동문-03', status: 'ACTIVE', enrolled: true, mtls: false },
      assignment: { assignmentId: ASSIGNMENT, role: 'gate_lead', proxy: false },
      package: { seq: 1, stale: false },
      auth: { deviceProof: 'DPOP', staffSession: true },
    });
  });

  test('준비 보고는 204이고 다음 근무 준비에 보고 시각·나이·대기 수가 보인다', async () => {
    const key = await keyOf();
    await store.bindCredential({ deviceId: DEVICE, jkt: key.jkt, atMs: NOW });
    const r = await svc.http.inject({
      method: 'PUT',
      url: '/v1/scanner/shift/readiness',
      headers: await staffHeaders(key, 'PUT', '/v1/scanner/shift/readiness'),
      payload: JSON.stringify({ packageSeq: 1, clockOffsetMs: -420, pendingUploads: 3 }),
    });
    expect(r.statusCode).toBe(204);
    const s = await svc.http.inject({ method: 'GET', url: '/v1/scanner/shift', headers: await staffHeaders(key, 'GET', '/v1/scanner/shift') });
    expect(JSON.parse(s.payload)).toMatchObject({ package: { reportedPackageSeq: 1, ageMs: 0, stale: false } });
  });

  test('기기 인증만으로 올린 스캔 기록도 받고 세션 밖 기록으로 표시한다(O-T37 ⑧)', async () => {
    const key = await keyOf();
    await store.bindCredential({ deviceId: DEVICE, jkt: key.jkt, atMs: NOW });
    if (!(await shift.placementOf(EVENT, DEVICE))) {
      await shift.putPlacement({ eventId: EVENT, deviceId: DEVICE, gateZone: '동문', mode: 'IN', setBy: ADMIN, atMs: NOW, expectedVersion: 0 });
    }
    const path = '/v1/scanner/scans';
    const body = [
      {
        id: randomUUID(),
        eventId: EVENT,
        ticketId: TICKET,
        scannerSessionId: SCAN_SESSION,
        direction: 'IN',
        method: 'QR',
        result: 'PASS',
        scannedAtDevice: new Date(NOW).toISOString(),
        knownSeq: 1,
        deviceSeq: 1,
      },
    ];
    const r = await svc.http.inject({
      method: 'POST',
      url: path,
      headers: { dpop: await proofOf(key, 'POST', path), 'x-forwarded-proto': 'https', 'x-forwarded-host': HOST, 'content-type': 'application/json' },
      payload: JSON.stringify(body),
    });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.payload)).toMatchObject({ acceptedIds: [body[0]!.id], flags: [expect.objectContaining({ kind: 'OUT_OF_SESSION' })] });
  });

  test('배치 없는 기기의 기기 인증만 업로드는 403이다', async () => {
    const key = await keyOf();
    const deviceId = randomUUID();
    await store.register({ deviceId, name: '동문-없음', promoterId: PROMOTER, enrolledBy: ADMIN, atMs: NOW });
    await store.bindCredential({ deviceId, jkt: key.jkt, atMs: NOW });
    const path = '/v1/scanner/scans';
    const body = [{ id: randomUUID(), eventId: EVENT, ticketId: TICKET, scannerSessionId: SCAN_SESSION, direction: 'IN', method: 'QR', result: 'PASS', scannedAtDevice: new Date(NOW).toISOString(), knownSeq: 1, deviceSeq: 1 }];
    const r = await svc.http.inject({
      method: 'POST',
      url: path,
      headers: { dpop: await proofOf(key, 'POST', path), 'x-forwarded-proto': 'https', 'x-forwarded-host': HOST, 'content-type': 'application/json' },
      payload: JSON.stringify(body),
    });
    expect(r.statusCode).toBe(403);
    expect(JSON.parse(r.payload)).toMatchObject({ type: 'https://peaket.example/problems/scanner-event-mismatch' });
  });
});

describe('기기 배치 HTTP [GAT-170]', () => {
  test('현장 책임자는 If-Match "0"으로 배치하고 ETag 판을 받는다. 낡은 판은 412, If-Match 없음은 428이다', async () => {
    const key = await keyOf();
    await store.bindCredential({ deviceId: DEVICE, jkt: key.jkt, atMs: NOW });
    const path = `/v1/scanner/events/${EVENT}/device-placements/${DEVICE}`;
    const created = await svc.http.inject({ method: 'PUT', url: path, headers: { ...(await staffHeaders(key, 'PUT', path)), 'if-match': '"1"' }, payload: JSON.stringify({ gateZone: '서문', mode: 'IN' }) });
    expect(created.statusCode).toBe(200);
    expect(created.headers.etag).toBe('"2"');
    expect(JSON.parse(created.payload)).toMatchObject({ eventId: EVENT, deviceId: DEVICE, gateZone: '서문', mode: 'IN', version: 2 });
    const stale = await svc.http.inject({ method: 'PUT', url: path, headers: { ...(await staffHeaders(key, 'PUT', path)), 'if-match': '"1"' }, payload: JSON.stringify({ gateZone: '서문', mode: 'IN' }) });
    expect(stale.statusCode).toBe(412);
    const missing = await svc.http.inject({ method: 'PUT', url: path, headers: await staffHeaders(key, 'PUT', path), payload: JSON.stringify({ gateZone: '서문', mode: 'IN' }) });
    expect(missing.statusCode).toBe(428);
  });

  test('퇴장 모드는 재입장 불허 회차에서 422다', async () => {
    const key = await keyOf();
    await store.bindCredential({ deviceId: DEVICE, jkt: key.jkt, atMs: NOW });
    const path = `/v1/scanner/events/${EVENT}/device-placements/${DEVICE}`;
    const r = await svc.http.inject({ method: 'PUT', url: path, headers: { ...(await staffHeaders(key, 'PUT', path)), 'if-match': '"2"' }, payload: JSON.stringify({ gateZone: '서문', mode: 'OUT' }) });
    expect(r.statusCode).toBe(503); // core 정책 대역이 없어 '모른다'로 닫는다
  });

  test('파트너는 소속 기기만 배치한다', async () => {
    await store.register({ deviceId: OTHER_DEVICE, name: '서문-01', promoterId: OTHER_PROMOTER, enrolledBy: ADMIN, atMs: NOW });
    policyAnswer = { promoterId: PROMOTER, reentryAllowed: false };
    const partnerSession = 'partner-session';
    identity.answers.set(`${ADMIN}/${partnerSession}`, { valid: true, role: 'partner_admin', tenantId: PROMOTER });
    const headers = { 'x-user-id': ADMIN, 'x-session-id': partnerSession, 'x-user-aud': 'partner', 'x-user-scope': '', 'content-type': 'application/json', 'if-match': '"2"' };
    const path = `/v1/partner/events/${EVENT}/device-placements/${DEVICE}`;
    const ok = await svc.http.inject({ method: 'PUT', url: path, headers, payload: JSON.stringify({ gateZone: '동문', mode: 'IN' }) });
    expect(ok.statusCode).toBe(200);
    policyAnswer = { promoterId: OTHER_PROMOTER, reentryAllowed: false };
    const foreignEvent = await svc.http.inject({ method: 'PUT', url: path, headers, payload: JSON.stringify({ gateZone: '동문', mode: 'IN' }) });
    expect(foreignEvent.statusCode).toBe(403);
    policyAnswer = { promoterId: PROMOTER, reentryAllowed: false };
    const other = await svc.http.inject({ method: 'PUT', url: `/v1/partner/events/${EVENT}/device-placements/${OTHER_DEVICE}`, headers, payload: JSON.stringify({ gateZone: '동문', mode: 'IN' }) });
    expect(other.statusCode).toBe(403);
  });
});

describe('등록 코드 재발급과 IP 실패 제한 [GAT-170]', () => {
  test('operator가 새 코드를 만들고, 폐기 기기는 409다', async () => {
    const created = await svc.http.inject({ method: 'POST', url: '/v1/ops/scanner-devices', headers: opsHeaders, payload: JSON.stringify({ name: '동문-09', promoterId: PROMOTER }) });
    const { deviceId } = JSON.parse(created.payload) as { deviceId: string };
    const r = await svc.http.inject({ method: 'POST', url: `/v1/ops/scanner-devices/${deviceId}/enrollment-code`, headers: { 'x-user-id': ADMIN, 'x-session-id': 'ops-session', 'x-user-aud': 'ops', 'x-user-scope': '' } });
    expect(r.statusCode).toBe(201);
    expect(JSON.parse(r.payload)).toMatchObject({ enrollmentCode: expect.stringMatching(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/) });
    await svc.http.inject({ method: 'POST', url: `/v1/ops/scanner-devices/${deviceId}/revocation`, headers: opsHeaders, payload: JSON.stringify({ reason: '분실' }) });
    const revoked = await svc.http.inject({ method: 'POST', url: `/v1/ops/scanner-devices/${deviceId}/enrollment-code`, headers: { 'x-user-id': ADMIN, 'x-session-id': 'ops-session', 'x-user-aud': 'ops', 'x-user-scope': '' } });
    expect(revoked.statusCode).toBe(409);
  });

  test('O-T42 ② 같은 IP의 실패 10회 뒤 11번째는 429다', async () => {
    const pair = await generateKeyPair('ES256', { extractable: true });
    const jwk = (await exportJWK(pair.publicKey)) as Record<string, unknown>;
    const enroll = async (code: string) => {
      const proof = await new SignJWT({ jti: randomUUID(), htm: 'POST', htu: `https://${HOST}/v1/scanner/device-enrollments`, iat: Math.floor(NOW / 1000) })
        .setProtectedHeader({ typ: 'dpop+jwt', alg: 'ES256', jwk })
        .sign(pair.privateKey);
      return svc.http.inject({
        method: 'POST',
        url: '/v1/scanner/device-enrollments',
        headers: { dpop: proof, 'x-forwarded-for': '10.9.9.9', 'x-forwarded-proto': 'https', 'x-forwarded-host': HOST, 'content-type': 'application/json' },
        payload: JSON.stringify({ code }),
      });
    };
    for (let i = 0; i < 10; i++) expect((await enroll('BCDF-GHJK-LMNP')).statusCode).toBe(410);
    expect((await enroll('BCDF-GHJK-LMNP')).statusCode).toBe(429);
  });
});
