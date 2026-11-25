// 스캐너 목록·변경분·스캔·이상 표시 HTTP 시험(BUILD_ORDER GAT-180·GAT-190).
// platform ScannerGuard가 기기 ACTIVE와 CheckScannerSession을 본 뒤 ticket-svc 저장소로 처리하는지 확인한다.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { athOf, createService, fakeClock, MemoryDpopReplayStore, type AdminAuthzPort, type ScannerSessionAnswer, type ScannerSessionCheck } from '@peaket/platform';
import { calculateJwkThumbprint, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { MemoryEnrollmentCodeStore } from '../src/modules/scanner/adapters/memory-enrollment-code-store.js';
import { MemoryScannerDeviceStore } from '../src/modules/scanner/adapters/memory-scanner-device-store.js';
import { MemoryScannerGateStore } from '../src/modules/scanner/adapters/memory-scanner-gate-store.js';
import { MemoryScannerShiftStore } from '../src/modules/scanner/adapters/memory-scanner-shift-store.js';

const NOW = Date.parse('2026-11-13T03:00:00.000Z');
const IAT = Math.floor(NOW / 1000);
const PROMOTER = '0190f3a1-7c2e-7a00-8000-000000000001';
const ADMIN = '0190f3a1-7c2e-7a00-8000-000000000002';
const ACCOUNT = '0190f3a1-7c2e-7a00-8000-000000000003';
const EVENT = '0190f3a1-7c2e-7a00-8000-000000000004';
const OTHER = '0190f3a1-7c2e-7a00-8000-000000000005';
const TICKET = '0190f3a1-7c2e-7a00-8000-000000000006';
const TICKET_2 = '0190f3a1-7c2e-7a00-8000-000000000009';
const TICKET_3 = '0190f3a1-7c2e-7a00-8000-00000000000a';
const DEVICE = '0190f3a1-7c2e-7a00-8000-000000000007';
const SESSION = '0190f3a1-7c2e-7a00-8000-000000000008';
const TOKEN = 'staff-access-token';
const ATH = athOf(TOKEN);
const HOST = 'scanner-api.peaket.example';
const quiet = () => new Writable({ write: (_c, _e, cb) => cb() });

class FakeIdentity implements AdminAuthzPort {
  async getAdminAuthz(): Promise<{ valid: boolean; role: string }> {
    return { valid: true, role: 'operator' };
  }
}

class FakeSessions implements ScannerSessionCheck {
  readonly answers = new Map<string, ScannerSessionAnswer>();
  async check(q: { scannerSessionId: string; deviceId: string }): Promise<ScannerSessionAnswer> {
    return this.answers.get(`${q.scannerSessionId}/${q.deviceId}`) ?? { valid: false };
  }
}

interface Key {
  privateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
  jwk: Record<string, unknown>;
  jkt: string;
}

let svc: Awaited<ReturnType<typeof createService>>;
let store: MemoryScannerDeviceStore;
let gate: MemoryScannerGateStore;
let sessions: FakeSessions;
let key: Key;
let clock: ReturnType<typeof fakeClock>;
let seq = 0;
let freshnessRows: { deviceId: string; deviceName: string; gateZone: string; lastChangesAt: string; ageMs: number; thresholdMs: number }[] = [];
let freshnessThrows = false;
const freshness = {
  staleDevices: async () => {
    if (freshnessThrows) throw new Error('신선도 원천 장애');
    return freshnessRows;
  },
};

async function keyOf(): Promise<Key> {
  const pair = await generateKeyPair('ES256', { extractable: true });
  const jwk = (await exportJWK(pair.publicKey)) as Record<string, unknown>;
  return { privateKey: pair.privateKey, jwk, jkt: await calculateJwkThumbprint(jwk as never, 'sha256') };
}

async function proofOf(htm: string, path: string): Promise<string> {
  return new SignJWT({ jti: randomUUID(), htm, htu: `https://${HOST}${path}`, iat: IAT, ath: ATH })
    .setProtectedHeader({ typ: 'dpop+jwt', alg: 'ES256', jwk: key.jwk as never })
    .sign(key.privateKey);
}

async function headers(htm: string, path: string, session = SESSION): Promise<Record<string, string>> {
  return {
    'x-user-id': ACCOUNT,
    'x-session-id': session,
    'x-user-aud': 'scanner',
    'x-user-jkt': key.jkt,
    'x-user-ath': ATH,
    authorization: `DPoP ${TOKEN}`,
    dpop: await proofOf(htm, path),
    'x-forwarded-proto': 'https',
    'x-forwarded-host': HOST,
  };
}

const scan = (over: Record<string, unknown> = {}) => ({
  id: randomUUID(),
  eventId: EVENT,
  ticketId: TICKET,
  scannerSessionId: SESSION,
  direction: 'IN',
  method: 'QR',
  result: 'PASS',
  gateZone: '동문',
  scannedAtDevice: new Date(NOW).toISOString(),
  knownSeq: 0,
  deviceSeq: ++seq,
  ...over,
});

beforeAll(async () => {
  clock = fakeClock({ now: NOW });
  key = await keyOf();
  store = new MemoryScannerDeviceStore();
  await store.register({ deviceId: DEVICE, name: '동문-01', promoterId: PROMOTER, enrolledBy: ADMIN, atMs: NOW });
  await store.bindCredential({ deviceId: DEVICE, jkt: key.jkt, atMs: NOW });
  gate = new MemoryScannerGateStore();
  gate.seedTicket({ ticketId: TICKET, eventId: EVENT, seatId: 'A-1', gateZone: '동문', status: 'ACTIVE' });
  gate.seedTicket({ ticketId: TICKET_2, eventId: EVENT, seatId: 'A-2', gateZone: '동문', status: 'ACTIVE' });
  gate.seedTicket({ ticketId: TICKET_3, eventId: EVENT, seatId: 'A-3', gateZone: '동문', status: 'ACTIVE' });
  sessions = new FakeSessions();
  sessions.answers.set(`${SESSION}/${DEVICE}`, { valid: true, role: 'gate_lead', eventId: EVENT });
  const replay = new MemoryDpopReplayStore(clock);
  const shift = new MemoryScannerShiftStore(gate);
  await shift.putPlacement({ eventId: EVENT, deviceId: DEVICE, gateZone: '동문', mode: 'IN', setBy: ACCOUNT, atMs: NOW, expectedVersion: 0 });
  svc = await createService({
    name: 'ticket-svc-gate-int',
    module: AppModule.register({ scanner: { store, codes: new MemoryEnrollmentCodeStore(clock), replay, gate, shift, freshness } as never }),
    env: { PEAKET_ENV: 'ci' },
    clock,
    logDestination: quiet(),
    adminAuthz: new FakeIdentity(),
    scanner: { devices: store, sessions, replay },
  });
});

afterAll(async () => {
  await svc?.close().catch(() => {});
});

const get = (path: string, session = SESSION) => headers('GET', path, session).then((h) => svc.http.inject({ method: 'GET', url: path, headers: h }));
const post = async (path: string, body: unknown, session = SESSION) => {
  const h = await headers('POST', path, session);
  // 스캔 올리기는 스캐너 PWA 출처만 받는다(offline-gate §6.1 GAT-170 마감 규칙, O-T35)
  return svc.http.inject({ method: 'POST', url: path, headers: { ...h, origin: 'https://scanner.peaket.example', 'content-type': 'application/json' }, payload: JSON.stringify(body) });
};
const postDeviceOnly = async (path: string, body: unknown) => {
  const h = {
    dpop: await proofOf('POST', path),
    'x-forwarded-proto': 'https',
    'x-forwarded-host': HOST,
    origin: 'https://scanner.peaket.example',
    'content-type': 'application/json',
  };
  return svc.http.inject({ method: 'POST', url: path, headers: h, payload: JSON.stringify(body) });
};

describe('스캐너 목록·변경분 HTTP [GAT-180]', () => {
  test('패키지는 티켓·구역·lastSeq를 주고 Cache-Control no-store이며, 다른 회차는 403이다', async () => {
    const r = await get(`/v1/scanner/events/${EVENT}/package`);
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(JSON.parse(r.payload)).toMatchObject({ eventId: EVENT, gateZones: ['동문'], lastSeq: 1, tickets: expect.arrayContaining([expect.objectContaining({ ticketId: TICKET, seatLabel: 'A-1' })]) });
    expect((await get(`/v1/scanner/events/${OTHER}/package`)).statusCode).toBe(403);
  });

  test('변경분은 after 뒤를 주고, 스캔을 받으면 SCAN_STATE가 쌓인다', async () => {
    const r = await get(`/v1/scanner/events/${EVENT}/changes?after=0`);
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.payload)).toMatchObject({ lastSeq: 1, changes: [expect.objectContaining({ seq: 1, kind: 'PLACEMENT' })] });
    const s = scan({ ticketId: TICKET_3 });
    expect((await post('/v1/scanner/scans', [s])).statusCode).toBe(200);
    const after = JSON.parse((await get(`/v1/scanner/events/${EVENT}/changes?after=0`)).payload) as { changes: { kind: string }[] };
    expect(after.changes.map((c) => c.kind)).toContain('SCAN_STATE');
  });

  test('O-T20 변경분 HTTP 응답은 gate_lead에게만 staleDevices를 싣고 gate_staff에는 칸이 없다', async () => {
    const row = {
      deviceId: DEVICE,
      deviceName: '동문-03',
      gateZone: '동문',
      lastChangesAt: new Date(NOW - 180_000).toISOString(),
      ageMs: 180_000,
      thresholdMs: 120_000,
    };
    freshnessRows = [row];
    freshnessThrows = false;
    sessions.answers.set(`${SESSION}/${DEVICE}`, { valid: true, role: 'gate_lead', eventId: EVENT });
    clock.advance(6_000);
    const lead = JSON.parse((await get(`/v1/scanner/events/${EVENT}/changes?after=0`)).payload) as { staleDevices?: unknown };
    expect(lead.staleDevices).toEqual([row]);

    sessions.answers.set(`${SESSION}/${DEVICE}`, { valid: true, role: 'gate_staff', eventId: EVENT });
    clock.advance(6_000);
    const staff = JSON.parse((await get(`/v1/scanner/events/${EVENT}/changes?after=0`)).payload) as Record<string, unknown>;
    expect('staleDevices' in staff).toBe(false);

    sessions.answers.set(`${SESSION}/${DEVICE}`, { valid: true, role: 'gate_lead', eventId: EVENT });
    clock.advance(6_000);
    freshnessThrows = true;
    const failed = JSON.parse((await get(`/v1/scanner/events/${EVENT}/changes?after=0`)).payload) as { staleDevices?: unknown };
    expect(failed.staleDevices).toEqual([]);
    freshnessRows = [];
    freshnessThrows = false;
  });
});

describe('스캔·이상 표시 HTTP [GAT-180·GAT-190]', () => {
  test('스캔은 멱등이고 두 번째 IN은 DUPLICATE 표시를 돌려준다', async () => {
    const s = scan({ ticketId: TICKET_2 });
    const first = await post('/v1/scanner/scans', [s]);
    expect(first.statusCode).toBe(200);
    expect(JSON.parse(first.payload)).toEqual({ acceptedIds: [s.id], flags: [], resyncRequired: false, staleIds: [] });
    const again = await post('/v1/scanner/scans', [s]);
    expect(JSON.parse(again.payload)).toEqual({ acceptedIds: [s.id], flags: [], resyncRequired: false, staleIds: [] });
    const dup = await post('/v1/scanner/scans', [scan({ ticketId: TICKET_2, knownSeq: 1 })]);
    expect(JSON.parse(dup.payload).flags).toEqual([expect.objectContaining({ kind: 'DUPLICATE', status: 'OPEN' })]);
  });

  test('예외 통과는 gate_lead 본인만 200이고, gate_staff·대리 승인·기기 단독은 403이다 [O-T34, ASVS 6.3.4]', async () => {
    const s = scan({ ticketId: TICKET, method: 'OVERRIDE', overrideNote: '액정 파손', knownSeq: 0 });
    sessions.answers.set(`${SESSION}/${DEVICE}`, { valid: true, role: 'gate_staff', eventId: EVENT });
    clock.advance(6_000);
    expect((await post('/v1/scanner/scans', [s])).statusCode).toBe(403);

    sessions.answers.set(`${SESSION}/${DEVICE}`, { valid: true, role: 'gate_lead', eventId: EVENT, proxy: true });
    clock.advance(6_000);
    expect((await post('/v1/scanner/scans', [s])).statusCode).toBe(403);

    expect((await postDeviceOnly('/v1/scanner/scans', [s])).statusCode).toBe(403);

    sessions.answers.set(`${SESSION}/${DEVICE}`, { valid: true, role: 'gate_lead', eventId: EVENT, proxy: false });
    clock.advance(6_000);
    const ok = await post('/v1/scanner/scans', [s]);
    expect(ok.statusCode).toBe(200);
    expect(JSON.parse(ok.payload).flags).toEqual([expect.objectContaining({ kind: 'OVERRIDE_REVIEW', ticketId: TICKET })]);
  });

  test('책임자는 이상 표시 목록을 보고 확인 결과를 남기며, gate_staff는 목록을 볼 수 없다', async () => {
    const page = await get(`/v1/scanner/events/${EVENT}/flags`);
    expect(page.statusCode).toBe(200);
    const item = (JSON.parse(page.payload) as { items: { flagId: string }[] }).items[0]!;
    const resolved = await post(`/v1/scanner/flags/${item.flagId}/resolution`, { status: 'OK', note: '정상 확인' });
    expect(resolved.statusCode).toBe(200);
    expect(JSON.parse(resolved.payload)).toMatchObject({ flagId: item.flagId, status: 'OK' });

    sessions.answers.set(`${SESSION}/${DEVICE}`, { valid: true, role: 'gate_staff', eventId: EVENT });
    clock.advance(6_000);
    expect((await get(`/v1/scanner/events/${EVENT}/flags`)).statusCode).toBe(403);
  });

  test('R-622 C1-01 gate_staff의 OVERRIDE 거절은 scanner-override-forbidden 문제 유형이다', async () => {
    sessions.answers.set(`${SESSION}/${DEVICE}`, { valid: true, role: 'gate_staff', eventId: EVENT });
    clock.advance(6_000);
    const r = await post('/v1/scanner/scans', [scan({ ticketId: TICKET, method: 'OVERRIDE', overrideNote: '액정 파손', knownSeq: 0 })]);
    expect(r.statusCode).toBe(403);
    expect(JSON.parse(r.payload)).toMatchObject({ type: 'https://peaket.example/problems/scanner-override-forbidden', status: 403 });
  });
});
