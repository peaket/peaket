// F-05-12 O-T28 ②③ 부스 코드·책임자 허용·BOOTH 등록 한 번.
// 정본: docs/features/offline-gate.md §9.1 '부스 재발급', openapi createTicketBoothRequest·
//       createScannerBoothAuthorization·createTicketDeviceKey, d5 §5.13·§8.5, ADR-0050 결정 2, ADR-0051 결정 11.
// 시험 값은 정본 숫자(코드·허용 10분, 하루 3회)를 그대로 쓴다. 코드 상수를 가져오지 않는다.
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
import { MemoryDeviceKeyStore } from '../src/modules/ticket/adapters/memory-device-key-store.js';
import { DeviceKeys } from '../src/modules/ticket/application/device-keys.js';

const NOW = Date.parse('2026-11-26T03:00:00.000Z');
const IAT = Math.floor(NOW / 1000);
const PROMOTER = '0190f3a1-7c2e-7a00-8000-00000000a001';
const ADMIN = '0190f3a1-7c2e-7a00-8000-00000000a002';
const ACCOUNT = '0190f3a1-7c2e-7a00-8000-00000000a003';
const OTHER_ACCOUNT = '0190f3a1-7c2e-7a00-8000-00000000a004';
const EVENT = '0190f3a1-7c2e-7a00-8000-00000000a005';
const OTHER_EVENT = '0190f3a1-7c2e-7a00-8000-00000000a006';
const TICKET = '0190f3a1-7c2e-7a00-8000-00000000a007';
const TICKET_2 = '0190f3a1-7c2e-7a00-8000-00000000a008';
const DEVICE = '0190f3a1-7c2e-7a00-8000-00000000a009';
const SESSION = '0190f3a1-7c2e-7a00-8000-00000000a00a';
const TOKEN = 'staff-access-token';
const ATH = athOf(TOKEN);
const HOST = 'scanner-api.peaket.example';
const CODE_MS = 10 * 60_000;
const quiet = () => new Writable({ write: (_c, _e, cb) => cb() });

class FakeAdmin implements AdminAuthzPort {
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
let deviceStore: MemoryScannerDeviceStore;
let gate: MemoryScannerGateStore;
let keyStore: MemoryDeviceKeyStore;
let sessions: FakeSessions;
let key: Key;
let clock: ReturnType<typeof fakeClock>;
let seq = 0;

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

async function scannerHeaders(htm: string, path: string, session = SESSION): Promise<Record<string, string>> {
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

const fanHeaders = (account = ACCOUNT) => ({ 'x-user-id': account, 'x-session-id': SESSION, 'x-user-aud': 'fan', 'x-user-scope': '', 'content-type': 'application/json' });
const fanPost = (path: string, body: unknown, account = ACCOUNT) => svc.http.inject({ method: 'POST', url: path, headers: fanHeaders(account), payload: JSON.stringify(body) });
const scannerPost = async (path: string, body: unknown) => {
  const h = await scannerHeaders('POST', path);
  return svc.http.inject({ method: 'POST', url: path, headers: { ...h, origin: 'https://scanner.peaket.example', 'content-type': 'application/json' }, payload: JSON.stringify(body) });
};
const scannerGet = async (path: string) => {
  const h = await scannerHeaders('GET', path);
  return svc.http.inject({ method: 'GET', url: path, headers: h });
};

async function publicJwk(): Promise<Record<string, unknown>> {
  return (await exportJWK((await generateKeyPair('ES256', { extractable: true })).publicKey)) as Record<string, unknown>;
}

beforeAll(async () => {
  clock = fakeClock({ now: NOW });
  key = await keyOf();
  deviceStore = new MemoryScannerDeviceStore();
  await deviceStore.register({ deviceId: DEVICE, name: '동문-01', promoterId: PROMOTER, enrolledBy: ADMIN, atMs: NOW });
  await deviceStore.bindCredential({ deviceId: DEVICE, jkt: key.jkt, atMs: NOW });
  gate = new MemoryScannerGateStore();
  gate.seedTicket({ ticketId: TICKET, eventId: EVENT, seatId: 'R구역 12열 7번', gateZone: '동문', status: 'ACTIVE' });
  gate.seedTicket({ ticketId: TICKET_2, eventId: EVENT, seatId: 'R구역 12열 8번', gateZone: '동문', status: 'ACTIVE' });
  keyStore = new MemoryDeviceKeyStore();
  keyStore.seedTicket({ ticketId: TICKET, eventId: EVENT, accountId: ACCOUNT, eventStartsAtMs: NOW - 1 });
  keyStore.seedTicket({ ticketId: TICKET_2, eventId: EVENT, accountId: ACCOUNT, eventStartsAtMs: NOW - 1 });
  sessions = new FakeSessions();
  sessions.answers.set(`${SESSION}/${DEVICE}`, { valid: true, role: 'gate_lead', eventId: EVENT });
  const replay = new MemoryDpopReplayStore(clock);
  const shift = new MemoryScannerShiftStore(gate);
  await shift.putPlacement({ eventId: EVENT, deviceId: DEVICE, gateZone: '동문', mode: 'IN', setBy: ACCOUNT, atMs: NOW, expectedVersion: 0 });

  // 구현 뒤 생기는 부스 저장소·응용. 기준 트리에서는 이 동적 불러오기가 실패하므로 부스 없이 조립하고,
  // 각 시험은 경로 404·BOOTH_NOT_ALLOWED로 실패한다(준비 단계에서 멈추지 않는다).
  let booth: unknown;
  let deviceKeys = new DeviceKeys({ store: keyStore, clock, reauth: { verify: async () => true } });
  try {
    const boothPath = '../src/modules/ticket/adapters/memory-booth-store.js';
    const appPath = '../src/modules/ticket/application/booth.js';
    const boothMod = (await import(boothPath)) as unknown as { MemoryBoothStore: new (deps: unknown) => unknown };
    const appMod = (await import(appPath)) as unknown as { TicketBooth: new (d: unknown) => unknown };
    const boothStore = new boothMod.MemoryBoothStore({ deviceKeys: keyStore, devices: deviceStore, shift, gate });
    booth = new appMod.TicketBooth({
      store: boothStore,
      verifications: { verify: async ({ token, accountId, ticketId }: { token: string; accountId: string; ticketId: string }) => token === 'good-token' && accountId === ACCOUNT && (ticketId === TICKET || ticketId === TICKET_2) },
      clock,
    });
    deviceKeys = new DeviceKeys({ store: keyStore, clock, reauth: { verify: async () => true }, booth: boothStore } as unknown as ConstructorParameters<typeof DeviceKeys>[0]); // type-escape: booth 옵션은 구현 뒤 생긴다
  } catch {
    // 구현 전: 부스 모듈이 없다
  }
  svc = await createService({
    name: 'ticket-svc-f0512-booth',
    module: AppModule.register({
      scanner: { store: deviceStore, codes: new MemoryEnrollmentCodeStore(clock), replay, gate, shift, ...(booth ? { booth } : {}) },
      ticket: { deviceKeys, ...(booth ? { booth } : {}) },
    } as unknown as Parameters<typeof AppModule.register>[0]), // type-escape: booth 옵션은 구현 뒤 생긴다
    env: { PEAKET_ENV: 'ci' },
    clock,
    logDestination: quiet(),
    adminAuthz: new FakeAdmin(),
    scanner: { devices: deviceStore, sessions, replay },
  });
});
afterAll(async () => {
  await svc?.close().catch(() => {});
});

const requestBooth = (ticketId = TICKET, token = 'good-token', account = ACCOUNT) => fanPost(`/v1/tickets/${ticketId}/booth-requests`, { reverificationToken: token }, account);
const authorizeBooth = (boothCode: string) => scannerPost('/v1/scanner/booth-authorizations', { boothCode });
const registerBooth = (ticketId: string, boothRequestId: string, publicKeyJwk: Record<string, unknown>, account = ACCOUNT) =>
  fanPost(`/v1/tickets/${ticketId}/device-keys`, { publicKeyJwk, reason: 'BOOTH', boothRequestId }, account);

describe('O-T28 ② 부스 코드·책임자 허용', () => {
  test('O-T28 ② 입장 시작 전이면 409, 남의 표·없는 표는 404, 대조 토큰이 틀리면 409이고 코드는 8자·10분이다', async () => {
    keyStore.tickets.set(TICKET_2, { ticketId: TICKET_2, eventId: EVENT, accountId: ACCOUNT, eventStartsAtMs: NOW + 60_000 });
    const before = await requestBooth(TICKET_2);
    expect(before.statusCode).toBe(409);
    expect(JSON.parse(before.payload)).toMatchObject({ type: 'https://peaket.example/problems/booth-before-entry', status: 409 });
    expect((await requestBooth(TICKET, 'good-token', OTHER_ACCOUNT)).statusCode).toBe(404);
    expect((await requestBooth('0190f3a1-7c2e-7a00-8000-00000000a0ff')).statusCode).toBe(404);
    const bad = await requestBooth(TICKET, 'bad-token');
    expect(bad.statusCode).toBe(409);
    expect(JSON.parse(bad.payload)).toMatchObject({ type: 'https://peaket.example/problems/booth-mismatch', status: 409 });
    keyStore.tickets.set(TICKET_2, { ticketId: TICKET_2, eventId: EVENT, accountId: ACCOUNT, eventStartsAtMs: NOW - 1 });

    const ok = await requestBooth(TICKET);
    expect(ok.statusCode).toBe(201);
    const body = JSON.parse(ok.payload) as { boothRequestId: string; boothCode: string; expiresAt: string };
    expect(body.boothRequestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.boothCode).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/);
    expect(Date.parse(body.expiresAt) - NOW).toBe(CODE_MS);
  });

  test('O-T28 ② 하루 3회를 넘으면 429이고, 새 코드는 옛 코드를 무효로 한다', async () => {
    const a = JSON.parse((await requestBooth(TICKET_2)).payload) as { boothCode: string };
    const b = JSON.parse((await requestBooth(TICKET_2)).payload) as { boothCode: string };
    const c = JSON.parse((await requestBooth(TICKET_2)).payload) as { boothCode: string };
    expect((await requestBooth(TICKET_2)).statusCode).toBe(429);
    // 옛 코드(가)는 새 요청 뒤 410이다
    expect((await authorizeBooth(a.boothCode)).statusCode).toBe(410);
    expect(b.boothCode).not.toBe(c.boothCode);
    // 다음 KST 날이면 다시 201
    clock.advance(24 * 60 * 60_000);
    expect((await requestBooth(TICKET_2)).statusCode).toBe(201);
  });

  test('O-T28 ② 일반 스태프는 403, 모르는 코드·만료 코드는 410, 다른 회차 기기는 403이고, gate_lead가 찍으면 200·10분 허용이다', async () => {
    const req = JSON.parse((await requestBooth(TICKET)).payload) as { boothCode: string };
    sessions.answers.set(`${SESSION}/${DEVICE}`, { valid: true, role: 'gate_staff', eventId: EVENT });
    expect((await authorizeBooth(req.boothCode)).statusCode).toBe(403);
    sessions.answers.set(`${SESSION}/${DEVICE}`, { valid: true, role: 'gate_lead', eventId: OTHER_EVENT });
    expect((await authorizeBooth(req.boothCode)).statusCode).toBe(403);
    sessions.answers.set(`${SESSION}/${DEVICE}`, { valid: true, role: 'gate_lead', eventId: EVENT });
    expect((await authorizeBooth('ZZZZZZZZ')).statusCode).toBe(410);
    clock.advance(CODE_MS);
    expect((await authorizeBooth(req.boothCode)).statusCode).toBe(410);
    // 새 코드를 찍으면 그때부터 10분 허용이다
    const fresh = JSON.parse((await requestBooth(TICKET)).payload) as { boothCode: string };
    const at = clock.now();
    const ok = await authorizeBooth(fresh.boothCode);
    expect(ok.statusCode).toBe(200);
    const body = JSON.parse(ok.payload) as { ticketId: string; seatLabel: string; allowUntil: string };
    expect(body.ticketId).toBe(TICKET);
    expect(body.seatLabel).toBe('R구역 12열 7번');
    expect(Date.parse(body.allowUntil) - at).toBe(CODE_MS);
    // 같은 코드를 다시 찍어도 같은 답이다(멱등)
    expect((await authorizeBooth(fresh.boothCode)).statusCode).toBe(200);
  });
});

describe('O-T28 ③ BOOTH 등록 한 번', () => {
  test('O-T28 ③ 허용이 없거나 지났으면 403 booth-not-authorized이고 키가 생기지 않는다', async () => {
    const req = JSON.parse((await requestBooth(TICKET)).payload) as { boothRequestId: string; boothCode: string };
    expect((await registerBooth(TICKET, req.boothRequestId, await publicJwk())).statusCode).toBe(403);
    expect((await authorizeBooth(req.boothCode)).statusCode).toBe(200);
    clock.advance(CODE_MS + 1);
    const late = await registerBooth(TICKET, req.boothRequestId, await publicJwk());
    expect(late.statusCode).toBe(403);
    expect(JSON.parse(late.payload)).toMatchObject({ type: 'https://peaket.example/problems/booth-not-authorized', status: 403 });
  });

  test('O-T28 ③ 첫 BOOTH 등록만 201이고 같은 부스 요청의 두 번째는 403이며, 동시 20회도 하나만 성공한다', async () => {
    const req = JSON.parse((await requestBooth(TICKET)).payload) as { boothRequestId: string; boothCode: string };
    expect((await authorizeBooth(req.boothCode)).statusCode).toBe(200);
    const keys = await Promise.all(Array.from({ length: 20 }, () => publicJwk()));
    const results = await Promise.all(keys.map((k) => registerBooth(TICKET, req.boothRequestId, k)));
    expect(results.filter((r) => r.statusCode === 201)).toHaveLength(1);
    expect(results.filter((r) => r.statusCode === 403)).toHaveLength(19);
  });
});
