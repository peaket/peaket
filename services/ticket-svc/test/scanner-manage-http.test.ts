// F-05-12 SCR-052 서버 데이터: 기기 현황(GET …/devices)과 내 예외 통과(GET …/override-passes).
// 정본: docs/design/d5 §8.5, openapi getScannerEventDevices·GateStatus, docs/features/offline-gate.md §7.2·§9.1.
// 일반 스태프 403, 책임자 200, 내가 한 OVERRIDE만(다른 스태프 0), 사후 검토 상태 네 값.
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
const PROMOTER = '0190f3a1-7c2e-7a00-8000-00000000d001';
const ADMIN = '0190f3a1-7c2e-7a00-8000-00000000d002';
const LEAD = '0190f3a1-7c2e-7a00-8000-00000000d003';
const STAFF = '0190f3a1-7c2e-7a00-8000-00000000d004';
const OTHER_LEAD = '0190f3a1-7c2e-7a00-8000-00000000d005';
const EVENT = '0190f3a1-7c2e-7a00-8000-00000000d006';
const TICKET_A = '0190f3a1-7c2e-7a00-8000-00000000d007';
const TICKET_B = '0190f3a1-7c2e-7a00-8000-00000000d008';
const TICKET_C = '0190f3a1-7c2e-7a00-8000-00000000d009';
const DEVICE = '0190f3a1-7c2e-7a00-8000-00000000d00a';
const LEAD_SESSION = '0190f3a1-7c2e-7a00-8000-00000000d00b';
const OTHER_LEAD_SESSION = '0190f3a1-7c2e-7a00-8000-00000000d00c';
const STAFF_SESSION = '0190f3a1-7c2e-7a00-8000-00000000d00d';
const TOKEN = 'staff-access-token';
const ATH = athOf(TOKEN);
const HOST = 'scanner-api.peaket.example';
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
let gate: MemoryScannerGateStore;
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
async function headers(htm: string, path: string, session: string, account: string): Promise<Record<string, string>> {
  return {
    'x-user-id': account,
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
const scannerGet = async (path: string, session: string, account: string) => svc.http.inject({ method: 'GET', url: path, headers: await headers('GET', path, session, account) });
const scannerPost = async (path: string, body: unknown, session: string, account: string) => {
  const h = await headers('POST', path, session, account);
  return svc.http.inject({ method: 'POST', url: path, headers: { ...h, origin: 'https://scanner.peaket.example', 'content-type': 'application/json' }, payload: JSON.stringify(body) });
};
const scanOverride = (ticketId: string, session: string, account: string, note: string) =>
  scannerPost(
    '/v1/scanner/scans',
    [{ id: randomUUID(), eventId: EVENT, ticketId, scannerSessionId: session, direction: 'IN', method: 'OVERRIDE', result: 'PASS', gateZone: '동문', overrideNote: note, scannedAtDevice: new Date(clock.now()).toISOString(), knownSeq: 0, deviceSeq: ++seq }],
    session,
    account,
  );

beforeAll(async () => {
  clock = fakeClock({ now: NOW });
  key = await keyOf();
  const devices = new MemoryScannerDeviceStore();
  await devices.register({ deviceId: DEVICE, name: '동문-01', promoterId: PROMOTER, enrolledBy: ADMIN, atMs: NOW });
  await devices.bindCredential({ deviceId: DEVICE, jkt: key.jkt, atMs: NOW });
  gate = new MemoryScannerGateStore();
  gate.seedTicket({ ticketId: TICKET_A, eventId: EVENT, seatId: 'R구역 12열 7번', gateZone: '동문', status: 'ACTIVE' });
  gate.seedTicket({ ticketId: TICKET_B, eventId: EVENT, seatId: 'R구역 12열 8번', gateZone: '동문', status: 'ACTIVE' });
  gate.seedTicket({ ticketId: TICKET_C, eventId: EVENT, seatId: 'S구역 1열 1번', gateZone: '동문', status: 'ACTIVE' });
  const sessions = new FakeSessions();
  sessions.answers.set(`${LEAD_SESSION}/${DEVICE}`, { valid: true, role: 'gate_lead', eventId: EVENT, accountId: LEAD });
  sessions.answers.set(`${OTHER_LEAD_SESSION}/${DEVICE}`, { valid: true, role: 'gate_lead', eventId: EVENT, accountId: OTHER_LEAD });
  sessions.answers.set(`${STAFF_SESSION}/${DEVICE}`, { valid: true, role: 'gate_staff', eventId: EVENT, accountId: STAFF });
  const replay = new MemoryDpopReplayStore(clock);
  const shift = new MemoryScannerShiftStore(gate);
  await shift.putPlacement({ eventId: EVENT, deviceId: DEVICE, gateZone: '동문', mode: 'IN', setBy: LEAD, atMs: NOW, expectedVersion: 0 });
  const keyStore = new MemoryDeviceKeyStore();
  let booth: unknown;
  let deviceKeys = new DeviceKeys({ store: keyStore, clock, reauth: { verify: async () => true } });
  try {
    const boothPath = '../src/modules/ticket/adapters/memory-booth-store.js';
    const appPath = '../src/modules/ticket/application/booth.js';
    const boothMod = (await import(boothPath)) as unknown as { MemoryBoothStore: new (deps: unknown) => unknown };
    const appMod = (await import(appPath)) as unknown as { TicketBooth: new (d: unknown) => unknown };
    const boothStore = new boothMod.MemoryBoothStore({ deviceKeys: keyStore, devices, shift, gate });
    booth = new appMod.TicketBooth({ store: boothStore, verifications: { verify: async () => false }, clock });
    deviceKeys = new DeviceKeys({ store: keyStore, clock, reauth: { verify: async () => true }, booth: boothStore } as unknown as ConstructorParameters<typeof DeviceKeys>[0]); // type-escape: booth 옵션은 구현 뒤 생긴다
  } catch {
    // 구현 전: 부스 모듈이 없다
  }
  svc = await createService({
    name: 'ticket-svc-f0512-manage',
    module: AppModule.register({ scanner: { store: devices, codes: new MemoryEnrollmentCodeStore(clock), replay, gate, shift, ...(booth ? { booth } : {}) }, ticket: { deviceKeys, ...(booth ? { booth } : {}) } } as unknown as Parameters<typeof AppModule.register>[0]), // type-escape: booth 옵션은 구현 뒤 생긴다
    env: { PEAKET_ENV: 'ci' },
    clock,
    logDestination: quiet(),
    adminAuthz: new FakeAdmin(),
    scanner: { devices, sessions, replay },
  });
});
afterAll(async () => {
  await svc?.close().catch(() => {});
});

describe('SCR-052 기기 현황·내 예외 통과', () => {
  test('SCR-052 일반 스태프는 기기 현황과 내 예외 통과를 볼 수 없다(403)', async () => {
    expect((await scannerGet(`/v1/scanner/events/${EVENT}/devices`, '0190f3a1-7c2e-7a00-8000-00000000d00d', STAFF)).statusCode).toBe(403);
    expect((await scannerGet(`/v1/scanner/events/${EVENT}/override-passes`, '0190f3a1-7c2e-7a00-8000-00000000d00d', STAFF)).statusCode).toBe(403);
  });

  test('SCR-052 책임자는 기기 현황을 보고, 내 예외 통과에는 내 OVERRIDE만 사후 검토 상태와 함께 나온다', async () => {
    const mine = await scanOverride(TICKET_A, '0190f3a1-7c2e-7a00-8000-00000000d00b', LEAD, '액정 파손');
    expect(mine.statusCode).toBe(200);
    const other = await scanOverride(TICKET_B, '0190f3a1-7c2e-7a00-8000-00000000d00c', OTHER_LEAD, '방전');
    expect(other.statusCode).toBe(200);
    await scanOverride(TICKET_C, '0190f3a1-7c2e-7a00-8000-00000000d00b', LEAD, '키 미반영');

    const status = await scannerGet(`/v1/scanner/events/${EVENT}/devices`, '0190f3a1-7c2e-7a00-8000-00000000d00b', LEAD);
    expect(status.statusCode).toBe(200);
    const body = JSON.parse(status.payload) as {
      devices: { deviceId: string; name: string; placement?: { gateZone: string; mode: string }; ready: boolean; pendingUploads: number }[];
      openFlags: number;
      overrideCount: number;
    };
    expect(body.devices).toEqual([expect.objectContaining({ deviceId: DEVICE, name: '동문-01', placement: { gateZone: '동문', mode: 'IN' }, ready: true, pendingUploads: 0 })]);
    expect(body.overrideCount).toBe(2);
    expect(body.openFlags).toBeGreaterThanOrEqual(2);

    const list = await scannerGet(`/v1/scanner/events/${EVENT}/override-passes`, '0190f3a1-7c2e-7a00-8000-00000000d00b', LEAD);
    expect(list.statusCode).toBe(200);
    const passes = JSON.parse(list.payload) as { items: { seatLabel: string; reason: string; note?: string; reviewStatus: string }[] };
    expect(passes.items).toHaveLength(2);
    expect(passes.items.map((p) => p.seatLabel).sort()).toEqual(['R구역 12열 7번', 'S구역 1열 1번']);
    expect(passes.items.every((p) => p.reviewStatus === 'WAITING')).toBe(true);
    expect(passes.items.some((p) => p.seatLabel === 'R구역 12열 8번')).toBe(false);

    // 책임자 이상 표시 목록에는 OVERRIDE_REVIEW가 없다(O-T53 ②). 처리 결과는 내 예외 통과 목록에만 보인다.
    const flags = await scannerGet(`/v1/scanner/events/${EVENT}/flags`, '0190f3a1-7c2e-7a00-8000-00000000d00b', LEAD);
    const flagItems = (JSON.parse(flags.payload) as { items: { kind: string }[] }).items.filter((f) => f.kind === 'OVERRIDE_REVIEW');
    expect(flagItems.length).toBe(0);
    const all = [...gate.flags.values()].filter((f) => f.kind === 'OVERRIDE_REVIEW');
    expect(all.length).toBe(3);
    // 내가 한 예외 통과 하나를 정상 확인하면 그 줄의 사후 검토가 OK가 된다
    const mineFlag = all.find((f) => {
      const scan = [...gate.scans.values()].find((s) => s.ticketId === TICKET_A && s.method === 'OVERRIDE');
      return scan !== undefined && f.ticketId === scan.ticketId;
    });
    expect((await scannerPost(`/v1/scanner/flags/${mineFlag!.flagId}/resolution`, { status: 'OK' }, '0190f3a1-7c2e-7a00-8000-00000000d00b', LEAD)).statusCode).toBe(200);
    const after = await scannerGet(`/v1/scanner/events/${EVENT}/override-passes`, '0190f3a1-7c2e-7a00-8000-00000000d00b', LEAD);
    const afterItems = (JSON.parse(after.payload) as { items: { reviewStatus: string }[] }).items;
    expect(afterItems.some((p) => p.reviewStatus === 'OK')).toBe(true);
  });
});
