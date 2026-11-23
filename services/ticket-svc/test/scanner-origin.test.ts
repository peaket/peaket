// F-05-5 ticket-svc 기기 인증 쓰기 경로의 출처·JSON 확인과 옛 관제 처리기 지움 HTTP 시험.
// 정본: docs/features/offline-gate.md §6.1 'GAT-170 마감 규칙'(출처 확인·관제 경로 ops-svc만)·O-T35, docs/security/asvs/offline-gate.md 3.5.1·3.5.2,
// openapi POST /v1/scanner/device-enrollments·/v1/scanner/scans(403·415), 계획 docs/review/plans/F-05-5.md §5·§6.
// 허용 출처는 정본 기본값 https://scanner.peaket.example(환경 변수 PEAKET_SCANNER_PWA_ORIGIN이 없을 때)이다.
// 거부 뒤에는 등록 코드가 소모되지 않고(같은 코드로 맞는 요청이 201) 스캔 기록이 저장되지 않음(저장소 행 수 그대로)을 본다.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { athOf, createService, fakeClock, MemoryDpopReplayStore, type AdminAuthzPort, type ScannerSessionAnswer, type ScannerSessionCheck } from '@peaket/platform';
import { calculateJwkThumbprint, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { loadTicketServiceConfig } from '../src/config.js';
import { MemoryEnrollmentAttemptLimiter } from '../src/modules/scanner/adapters/memory-enrollment-attempt-limiter.js';
import { MemoryEnrollmentCodeStore } from '../src/modules/scanner/adapters/memory-enrollment-code-store.js';
import { MemoryScannerDeviceStore } from '../src/modules/scanner/adapters/memory-scanner-device-store.js';
import { MemoryScannerGateStore } from '../src/modules/scanner/adapters/memory-scanner-gate-store.js';
import { MemoryScannerShiftStore } from '../src/modules/scanner/adapters/memory-scanner-shift-store.js';
import { ScannerDevices } from '../src/modules/scanner/application/scanner-devices.js';

const NOW = Date.parse('2026-11-23T03:00:00.000Z');
const IAT = Math.floor(NOW / 1000);
const PROMOTER = '0190f3a1-7c2e-7a00-8000-0000000005a1';
const ADMIN = '0190f3a1-7c2e-7a00-8000-0000000005a2';
const EVENT = '0190f3a1-7c2e-7a00-8000-0000000005a3';
const TICKET = '0190f3a1-7c2e-7a00-8000-0000000005a4';
const DEVICE = '0190f3a1-7c2e-7a00-8000-0000000005a5';
const SESSION = '0190f3a1-7c2e-7a00-8000-0000000005a6';
const HOST = 'scanner-api.peaket.example';
const PWA = 'https://scanner.peaket.example';
/** PWA 출처와 아주 조금만 다른 값까지 모두 거부한다(자주 놓친 결함: 목록 밖 값마다) */
const WRONG_ORIGINS: (string | undefined)[] = [
  'https://evil.example',
  undefined,
  'https://scanner.peaket.example/',
  'https://SCANNER.peaket.example',
  'https://scanner.peaket.example:8443',
  'http://scanner.peaket.example',
  'null',
];

const operator: AdminAuthzPort = { getAdminAuthz: async () => ({ valid: true, role: 'operator' }) };
const quiet = () => new Writable({ write: (_c, _e, cb) => cb() });

class Sessions implements ScannerSessionCheck {
  answer: ScannerSessionAnswer = { valid: true, role: 'gate_staff', eventId: EVENT };
  async check(): Promise<ScannerSessionAnswer> {
    return this.answer;
  }
}

type Key = { privateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey']; jwk: Record<string, unknown>; jkt: string };
async function keyOf(): Promise<Key> {
  const pair = await generateKeyPair('ES256', { extractable: true });
  const jwk = (await exportJWK(pair.publicKey)) as Record<string, unknown>;
  return { privateKey: pair.privateKey, jwk, jkt: await calculateJwkThumbprint(jwk as never, 'sha256') };
}

async function proofOf(key: Key, method: string, path: string): Promise<string> {
  return new SignJWT({ jti: randomUUID(), htm: method, htu: `https://${HOST}${path}`, iat: IAT })
    .setProtectedHeader({ typ: 'dpop+jwt', alg: 'ES256', jwk: key.jwk as never })
    .sign(key.privateKey);
}

let svc: Awaited<ReturnType<typeof createService>>;
let store: MemoryScannerDeviceStore;
let gate: MemoryScannerGateStore;
let devices: ScannerDevices;
let scannerKey: Key;
const clock = fakeClock({ now: NOW });

beforeAll(async () => {
  store = new MemoryScannerDeviceStore();
  gate = new MemoryScannerGateStore();
  gate.seedTicket({ ticketId: TICKET, eventId: EVENT, seatId: 'A-1', gateZone: '동문', status: 'ACTIVE' });
  const shift = new MemoryScannerShiftStore(gate);
  scannerKey = await keyOf();
  await store.register({ deviceId: DEVICE, name: '동문-01', promoterId: PROMOTER, enrolledBy: ADMIN, atMs: NOW });
  await store.bindCredential({ deviceId: DEVICE, jkt: scannerKey.jkt, atMs: NOW });
  await shift.putPlacement({ eventId: EVENT, deviceId: DEVICE, gateZone: '동문', mode: 'IN', setBy: ADMIN, atMs: NOW, expectedVersion: 0 });
  svc = await createService({
    name: 'ticket-svc-origin',
    module: AppModule.register({
      scanner: {
        store,
        codes: new MemoryEnrollmentCodeStore(clock),
        replay: new MemoryDpopReplayStore(clock),
        gate,
        shift,
        limiter: new MemoryEnrollmentAttemptLimiter(() => clock.now()),
      },
    }),
    env: { PEAKET_ENV: 'ci' },
    clock,
    logDestination: quiet(),
    // 관제 역할 대역은 operator로 답한다: 옛 처리기가 남아 있으면 404가 아니라 처리돼 드러난다
    adminAuthz: operator,
    scanner: { devices: store, sessions: new Sessions(), replay: new MemoryDpopReplayStore(clock) },
  });
  devices = svc.app.get(ScannerDevices);
});

afterAll(async () => {
  await svc?.close();
});

const ENROLL = '/v1/scanner/device-enrollments';
const SCANS = '/v1/scanner/scans';

async function enroll(key: Key, code: string, o: { origin?: string; contentType?: string; ip?: string } = {}) {
  return svc.http.inject({
    method: 'POST',
    url: ENROLL,
    headers: {
      dpop: await proofOf(key, 'POST', ENROLL),
      'x-forwarded-proto': 'https',
      'x-forwarded-host': HOST,
      'x-forwarded-for': o.ip ?? '10.55.0.1',
      'content-type': o.contentType ?? 'application/json',
      ...(o.origin !== undefined ? { origin: o.origin } : {}),
    },
    payload: o.contentType === 'application/x-www-form-urlencoded' ? `code=${encodeURIComponent(code)}` : JSON.stringify({ code }),
  });
}

const scanBody = () => [
  {
    id: randomUUID(),
    eventId: EVENT,
    ticketId: TICKET,
    scannerSessionId: SESSION,
    direction: 'IN',
    method: 'QR',
    result: 'PASS',
    gateZone: '동문',
    scannedAtDevice: new Date(NOW).toISOString(),
    knownSeq: 1,
    deviceSeq: 1,
  },
];

async function upload(o: { origin?: string; contentType?: string; withToken?: boolean } = {}) {
  const body = scanBody();
  const r = await svc.http.inject({
    method: 'POST',
    url: SCANS,
    headers: {
      dpop: o.withToken
        ? await new SignJWT({ jti: randomUUID(), htm: 'POST', htu: `https://${HOST}${SCANS}`, iat: IAT, ath: athOf('staff-token') })
            .setProtectedHeader({ typ: 'dpop+jwt', alg: 'ES256', jwk: scannerKey.jwk as never })
            .sign(scannerKey.privateKey)
        : await proofOf(scannerKey, 'POST', SCANS),
      'x-forwarded-proto': 'https',
      'x-forwarded-host': HOST,
      'content-type': o.contentType ?? 'application/json',
      ...(o.withToken
        ? {
            authorization: 'DPoP staff-token',
            'x-user-id': ADMIN,
            'x-session-id': SESSION,
            'x-user-aud': 'scanner',
            'x-user-jkt': scannerKey.jkt,
            'x-user-ath': athOf('staff-token'),
          }
        : {}),
      ...(o.origin !== undefined ? { origin: o.origin } : {}),
    },
    payload: JSON.stringify(body),
  });
  return { r, id: body[0]!.id };
}

const problemOf = (payload: string) => JSON.parse(payload) as { type?: string; status?: number };

describe('기기 등록 경로의 출처·JSON 확인(O-T35, offline-gate §6.1)', () => {
  test('O-T35 ① 다른 사이트 출처와 PWA 출처와 조금 다른 값은 403 scanner-origin-forbidden이고 코드를 소모하지 않으며 키를 묶지 않는다 [ASVS v5.0.0-3.5.1]', async () => {
    const created = await devices.register({ name: '출처-01', promoterId: PROMOTER, enrolledBy: ADMIN });
    const key = await keyOf();
    for (const origin of WRONG_ORIGINS.filter((o) => o !== undefined)) {
      const r = await enroll(key, created.enrollmentCode, { origin });
      expect(r.statusCode, origin).toBe(403);
      expect(problemOf(r.payload).type, origin).toBe('https://peaket.example/problems/scanner-origin-forbidden');
    }
    expect(await store.byThumbprint(key.jkt)).toBeNull();
    const ok = await enroll(key, created.enrollmentCode, { origin: PWA });
    expect(ok.statusCode).toBe(201);
    expect(JSON.parse(ok.payload)).toEqual({ deviceId: created.device.deviceId });
  });

  test('O-T35 ② Origin이 없으면 403이고 그 코드는 그대로 남아 맞는 요청이 201이다 [ASVS v5.0.0-3.5.1]', async () => {
    const created = await devices.register({ name: '출처-02', promoterId: PROMOTER, enrolledBy: ADMIN });
    const key = await keyOf();
    const r = await enroll(key, created.enrollmentCode);
    expect(r.statusCode).toBe(403);
    expect(problemOf(r.payload).type).toBe('https://peaket.example/problems/scanner-origin-forbidden');
    expect(await store.byThumbprint(key.jkt)).toBeNull();
    expect((await enroll(key, created.enrollmentCode, { origin: PWA })).statusCode).toBe(201);
  });

  test('O-T35 ①② 출처 거부는 등록 실패로 세지 않는다(같은 IP에서 11번 거부된 뒤에도 맞는 요청이 201)', async () => {
    const created = await devices.register({ name: '출처-03', promoterId: PROMOTER, enrolledBy: ADMIN });
    const key = await keyOf();
    for (let i = 0; i < 11; i++) expect((await enroll(key, created.enrollmentCode, { origin: 'https://evil.example', ip: '10.55.0.9' })).statusCode).toBe(403);
    expect((await enroll(key, created.enrollmentCode, { origin: PWA, ip: '10.55.0.9' })).statusCode).toBe(201);
  });

  test('O-T35 ③ 양식·text/plain 본문은 PWA 출처여도 415이고 코드를 소모하지 않는다 [ASVS v5.0.0-3.5.2]', async () => {
    const created = await devices.register({ name: '출처-04', promoterId: PROMOTER, enrolledBy: ADMIN });
    const key = await keyOf();
    for (const contentType of ['application/x-www-form-urlencoded', 'text/plain']) {
      const r = await enroll(key, created.enrollmentCode, { origin: PWA, contentType });
      expect(r.statusCode, contentType).toBe(415);
    }
    expect(await store.byThumbprint(key.jkt)).toBeNull();
    expect((await enroll(key, created.enrollmentCode, { origin: PWA })).statusCode).toBe(201);
  });

  test('O-T35 ⑤ PWA 출처와 정상 본문은 201이고 기기 키가 묶인다', async () => {
    const created = await devices.register({ name: '출처-05', promoterId: PROMOTER, enrolledBy: ADMIN });
    const key = await keyOf();
    const r = await enroll(key, created.enrollmentCode, { origin: PWA });
    expect(r.statusCode).toBe(201);
    expect(await store.byThumbprint(key.jkt)).toMatchObject({ deviceId: created.device.deviceId, status: 'ACTIVE' });
  });
});

describe('스캔 올리기 경로의 출처·JSON 확인(O-T35, offline-gate §6.1)', () => {
  test('O-T35 ① 다른 사이트 출처와 PWA 출처와 조금 다른 값의 업로드는 403이고 기록이 저장되지 않는다 [ASVS v5.0.0-3.5.1]', async () => {
    const before = gate.scans.size;
    for (const origin of WRONG_ORIGINS.filter((o) => o !== undefined)) {
      const { r, id } = await upload({ origin });
      expect(r.statusCode, origin).toBe(403);
      expect(problemOf(r.payload).type, origin).toBe('https://peaket.example/problems/scanner-origin-forbidden');
      expect(gate.scans.has(id), origin).toBe(false);
    }
    // 스태프 토큰을 붙인 업로드도 같다
    const { r, id } = await upload({ origin: 'https://evil.example', withToken: true });
    expect(r.statusCode).toBe(403);
    expect(gate.scans.has(id)).toBe(false);
    expect(gate.scans.size).toBe(before);
  });

  test('O-T35 ② Origin 없는 업로드는 403이고 기록이 저장되지 않는다 [ASVS v5.0.0-3.5.1]', async () => {
    const before = gate.scans.size;
    const { r, id } = await upload();
    expect(r.statusCode).toBe(403);
    expect(problemOf(r.payload).type).toBe('https://peaket.example/problems/scanner-origin-forbidden');
    expect(gate.scans.has(id)).toBe(false);
    expect(gate.scans.size).toBe(before);
  });

  test('O-T35 ③ 양식·text/plain 업로드는 415이고 기록이 저장되지 않는다 [ASVS v5.0.0-3.5.2]', async () => {
    const before = gate.scans.size;
    for (const contentType of ['application/x-www-form-urlencoded', 'text/plain']) {
      const { r, id } = await upload({ origin: PWA, contentType });
      expect(r.statusCode, contentType).toBe(415);
      expect(gate.scans.has(id), contentType).toBe(false);
    }
    expect(gate.scans.size).toBe(before);
  });

  test('O-T35 ⑤ PWA 출처와 정상 본문의 기기 인증 업로드는 200이고 기록이 하나 저장된다', async () => {
    const before = gate.scans.size;
    const { r, id } = await upload({ origin: PWA });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.payload)).toMatchObject({ acceptedIds: [id] });
    expect(gate.scans.has(id)).toBe(true);
    expect(gate.scans.size).toBe(before + 1);
  });
});

describe('W7-WIR-02 옛 관제 처리기 지움(offline-gate §6.1 GAT-170 마감 규칙)', () => {
  test('W7-WIR-02 ticket-svc HTTP는 /v1/ops/scanner-devices* 네 경로를 받지 않는다(404)', async () => {
    const ops = { 'x-user-id': ADMIN, 'x-session-id': randomUUID(), 'x-user-aud': 'ops', 'x-user-scope': '', 'content-type': 'application/json' };
    const calls = [
      { method: 'GET' as const, url: '/v1/ops/scanner-devices?limit=10' },
      { method: 'POST' as const, url: '/v1/ops/scanner-devices', payload: JSON.stringify({ name: '옛-01', promoterId: PROMOTER }) },
      { method: 'POST' as const, url: `/v1/ops/scanner-devices/${DEVICE}/revocation`, payload: JSON.stringify({ reason: '분실' }) },
      { method: 'POST' as const, url: `/v1/ops/scanner-devices/${DEVICE}/enrollment-code`, payload: '{}' },
    ];
    for (const c of calls) {
      const r = await svc.http.inject({ ...c, headers: ops });
      expect(r.statusCode, `${c.method} ${c.url}`).toBe(404);
    }
    // 기기는 폐기되지 않았다
    expect(await store.byThumbprint(scannerKey.jkt)).toMatchObject({ deviceId: DEVICE, status: 'ACTIVE' });
  });
});

describe('허용 출처 설정(offline-gate §6.1 GAT-170 마감 규칙)', () => {
  const DB = 'postgres://peaket:peaket@127.0.0.1:5432/peaket';
  test('O-T35 ⑤ PEAKET_SCANNER_PWA_ORIGIN이 없거나 비면 https://scanner.peaket.example, 있으면 그 값이다', () => {
    expect(loadTicketServiceConfig({ PEAKET_DATABASE_URL: DB, PEAKET_ENV: 'ci' }).scannerPwaOrigin).toBe('https://scanner.peaket.example');
    expect(loadTicketServiceConfig({ PEAKET_DATABASE_URL: DB, PEAKET_ENV: 'ci', PEAKET_SCANNER_PWA_ORIGIN: '' }).scannerPwaOrigin).toBe('https://scanner.peaket.example');
    expect(loadTicketServiceConfig({ PEAKET_DATABASE_URL: DB, PEAKET_ENV: 'ci', PEAKET_SCANNER_PWA_ORIGIN: 'https://scanner.demo.localhost:8443' }).scannerPwaOrigin).toBe(
      'https://scanner.demo.localhost:8443',
    );
  });
});
