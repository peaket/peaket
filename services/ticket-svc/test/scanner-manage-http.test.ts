// F-05-12 SCR-052 서버 데이터: 기기 현황(GET …/devices)과 내 예외 통과(GET …/override-passes).
// 정본: docs/design/d5 §8.5, openapi getScannerEventDevices·GateStatus, docs/features/offline-gate.md §7.2·§9.1.
// 일반 스태프 403, 책임자 200, 내가 한 OVERRIDE만(다른 스태프 0), 사후 검토 상태 네 값, limit 기본 50·최대 200·400,
// 배치 없음 409 no-placement, GateStatus의 마지막 동기화·구역별 입장·사유별 거부·부스 수·마감 시각.
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
const LIMIT_LEAD = '0190f3a1-7c2e-7a00-8000-00000000d00e';
const EVENT = '0190f3a1-7c2e-7a00-8000-00000000d006';
const TICKET_A = '0190f3a1-7c2e-7a00-8000-00000000d007';
const TICKET_B = '0190f3a1-7c2e-7a00-8000-00000000d008';
const TICKET_C = '0190f3a1-7c2e-7a00-8000-00000000d009';
const TICKET_D = '0190f3a1-7c2e-7a00-8000-00000000d00a';
const SEAT_A = 'R구역 12열 7번';
const SEAT_B = 'R구역 12열 8번';
const SEAT_C = 'S구역 1열 1번';
const SEAT_D = 'S구역 1열 2번';
const DEVICE = '0190f3a1-7c2e-7a00-8000-00000000d00f';
const DEVICE_UNPLACED = '0190f3a1-7c2e-7a00-8000-00000000d010';
const LEAD_SESSION = '0190f3a1-7c2e-7a00-8000-00000000d00b';
const OTHER_LEAD_SESSION = '0190f3a1-7c2e-7a00-8000-00000000d00c';
const STAFF_SESSION = '0190f3a1-7c2e-7a00-8000-00000000d00d';
const UNPLACED_SESSION = '0190f3a1-7c2e-7a00-8000-00000000d011';
const LIMIT_SESSION = '0190f3a1-7c2e-7a00-8000-00000000d012';
const LAST_SYNC_MS = NOW - 5_000;
const CLOSED_AT_MS = NOW + 60 * 60_000;
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
let key2: Key;
let clock: ReturnType<typeof fakeClock>;
let seq = 0;
const bulkTickets: string[] = [];

async function keyOf(): Promise<Key> {
  const pair = await generateKeyPair('ES256', { extractable: true });
  const jwk = (await exportJWK(pair.publicKey)) as Record<string, unknown>;
  return { privateKey: pair.privateKey, jwk, jkt: await calculateJwkThumbprint(jwk as never, 'sha256') };
}
async function proofOf(htm: string, path: string, k: Key = key): Promise<string> {
  return new SignJWT({ jti: randomUUID(), htm, htu: `https://${HOST}${path}`, iat: IAT, ath: ATH })
    .setProtectedHeader({ typ: 'dpop+jwt', alg: 'ES256', jwk: k.jwk as never })
    .sign(k.privateKey);
}
async function headers(htm: string, path: string, session: string, account: string, k: Key = key): Promise<Record<string, string>> {
  return {
    'x-user-id': account,
    'x-session-id': session,
    'x-user-aud': 'scanner',
    'x-user-jkt': k.jkt,
    'x-user-ath': ATH,
    authorization: `DPoP ${TOKEN}`,
    dpop: await proofOf(htm, path, k),
    'x-forwarded-proto': 'https',
    'x-forwarded-host': HOST,
  };
}
const scannerGet = async (path: string, session: string, account: string, k: Key = key) => svc.http.inject({ method: 'GET', url: path, headers: await headers('GET', path, session, account, k) });
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
  key2 = await keyOf();
  const devices = new MemoryScannerDeviceStore();
  await devices.register({ deviceId: DEVICE, name: '동문-01', promoterId: PROMOTER, enrolledBy: ADMIN, atMs: NOW });
  await devices.bindCredential({ deviceId: DEVICE, jkt: key.jkt, atMs: NOW });
  await devices.register({ deviceId: DEVICE_UNPLACED, name: '예비-01', promoterId: PROMOTER, enrolledBy: ADMIN, atMs: NOW });
  await devices.bindCredential({ deviceId: DEVICE_UNPLACED, jkt: key2.jkt, atMs: NOW });
  gate = new MemoryScannerGateStore();
  const seeded = [
    [TICKET_A, SEAT_A],
    [TICKET_B, SEAT_B],
    [TICKET_C, SEAT_C],
    [TICKET_D, SEAT_D],
  ] as const;
  for (let i = 0; i < 51; i++) bulkTickets.push(`0190f3a1-7c2e-7a00-8000-0000000b${String(i).padStart(4, '0')}`);
  for (const [ticketId, seatLabel] of [...seeded, ...bulkTickets.map((t) => [t, `T구역 ${t.slice(-4)}번`] as const)]) {
    // seatId와 seatLabel을 다르게 둔다: seatId를 seatLabel 자리에 넣은 구현이 통과하지 않게(TR-10)
    gate.seedTicket({ ticketId, eventId: EVENT, seatId: `0190f3a1-7c2e-7a00-8000-0000000a${ticketId.slice(-4)}`, seatLabel, gateZone: '동문', status: 'ACTIVE' } as unknown as Parameters<typeof gate.seedTicket>[0]); // type-escape: seatLabel은 구현 뒤 생긴다
  }
  const sessions = new FakeSessions();
  sessions.answers.set(`${LEAD_SESSION}/${DEVICE}`, { valid: true, role: 'gate_lead', eventId: EVENT, accountId: LEAD });
  sessions.answers.set(`${OTHER_LEAD_SESSION}/${DEVICE}`, { valid: true, role: 'gate_lead', eventId: EVENT, accountId: OTHER_LEAD });
  sessions.answers.set(`${STAFF_SESSION}/${DEVICE}`, { valid: true, role: 'gate_staff', eventId: EVENT, accountId: STAFF });
  sessions.answers.set(`${LIMIT_SESSION}/${DEVICE}`, { valid: true, role: 'gate_lead', eventId: EVENT, accountId: LIMIT_LEAD });
  sessions.answers.set(`${UNPLACED_SESSION}/${DEVICE_UNPLACED}`, { valid: true, role: 'gate_lead', eventId: EVENT, accountId: LEAD });
  const replay = new MemoryDpopReplayStore(clock);
  const shift = new MemoryScannerShiftStore(gate);
  await shift.putPlacement({ eventId: EVENT, deviceId: DEVICE, gateZone: '동문', mode: 'IN', setBy: LEAD, atMs: NOW, expectedVersion: 0 });
  await shift.reportReadiness({ eventId: EVENT, deviceId: DEVICE, packageSeq: 7, clockOffsetMs: 0, pendingUploads: 2, reportedBy: LEAD, atMs: LAST_SYNC_MS });
  const keyStore = new MemoryDeviceKeyStore();
  let booth: unknown;
  let deviceKeys = new DeviceKeys({ store: keyStore, clock, reauth: { verify: async () => true } });
  try {
    const boothPath = new URL('../src/modules/ticket/adapters/memory-booth-store.ts', import.meta.url).href;
    const appPath = new URL('../src/modules/ticket/application/booth.ts', import.meta.url).href;
    const boothMod = (await import(/* @vite-ignore */ boothPath)) as unknown as { MemoryBoothStore: new (deps: unknown) => unknown };
    const appMod = (await import(/* @vite-ignore */ appPath)) as unknown as { TicketBooth: new (d: unknown) => unknown };
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

const openFlagsOf = () => [...gate.flags.values()].filter((f) => f.eventId === EVENT && f.status === 'OPEN').length;

describe('SCR-052 기기 현황·내 예외 통과', () => {
  test('SCR-052 일반 스태프는 기기 현황과 내 예외 통과를 볼 수 없다(403)', async () => {
    expect((await scannerGet(`/v1/scanner/events/${EVENT}/devices`, STAFF_SESSION, STAFF)).statusCode).toBe(403);
    expect((await scannerGet(`/v1/scanner/events/${EVENT}/override-passes`, STAFF_SESSION, STAFF)).statusCode).toBe(403);
  });

  test('SCR-052 배치가 없는 기기는 기기 현황·내 예외 통과 모두 409 no-placement다', async () => {
    const devices = await scannerGet(`/v1/scanner/events/${EVENT}/devices`, UNPLACED_SESSION, LEAD, key2);
    expect(devices.statusCode).toBe(409);
    expect(JSON.parse(devices.payload)).toMatchObject({ type: 'https://peaket.example/problems/no-placement', status: 409 });
    const passes = await scannerGet(`/v1/scanner/events/${EVENT}/override-passes`, UNPLACED_SESSION, LEAD, key2);
    expect(passes.statusCode).toBe(409);
    expect(JSON.parse(passes.payload)).toMatchObject({ type: 'https://peaket.example/problems/no-placement', status: 409 });
  });

  test('SCR-052 책임자는 기기 현황의 모든 칸과 내 OVERRIDE의 사후 검토 네 상태를 본다', async () => {
    const mine = await scanOverride(TICKET_A, LEAD_SESSION, LEAD, '액정 파손');
    expect(mine.statusCode).toBe(200);
    const other = await scanOverride(TICKET_B, OTHER_LEAD_SESSION, OTHER_LEAD, '방전');
    expect(other.statusCode).toBe(200);
    await scanOverride(TICKET_C, LEAD_SESSION, LEAD, '키 미반영');
    await scanOverride(TICKET_D, LEAD_SESSION, LEAD, '카메라');
    // 스캔을 모두 적은 뒤에 마감 행을 심는다(스캔이 '마감 뒤 도착' 표시를 만들지 않게)
    gate.seedEntryClose(EVENT, CLOSED_AT_MS);

    const status = await scannerGet(`/v1/scanner/events/${EVENT}/devices`, LEAD_SESSION, LEAD);
    expect(status.statusCode).toBe(200);
    const body = JSON.parse(status.payload) as {
      devices: { deviceId: string; name: string; placement?: { gateZone: string; mode: string }; ready: boolean; packageSeq?: number; lastSyncAt?: string; pendingUploads: number }[];
      entriesByZone: Record<string, number>;
      rejectsByReason: Record<string, number>;
      openFlags: number;
      boothCount: number;
      overrideCount: number;
      entryClosedAt?: string;
    };
    expect(body.devices.find((d) => d.deviceId === DEVICE)).toEqual(
      expect.objectContaining({ deviceId: DEVICE, name: '동문-01', placement: { gateZone: '동문', mode: 'IN' }, ready: true, packageSeq: 7, lastSyncAt: new Date(LAST_SYNC_MS).toISOString(), pendingUploads: 2 }),
    );
    expect(body.entriesByZone).toEqual({ 동문: 4 });
    expect(body.rejectsByReason).toEqual({});
    expect(body.openFlags).toBe(openFlagsOf());
    expect(body.openFlags).toBe(4);
    expect(body.boothCount).toBe(0);
    expect(body.overrideCount).toBe(4);
    expect(body.entryClosedAt).toBe(new Date(CLOSED_AT_MS).toISOString());

    const list = await scannerGet(`/v1/scanner/events/${EVENT}/override-passes`, LEAD_SESSION, LEAD);
    expect(list.statusCode).toBe(200);
    const passes = JSON.parse(list.payload) as { items: { scanId: string; at: string; ticketId: string; seatLabel: string; reason: string; note?: string; reviewStatus: string }[] };
    expect(passes.items).toHaveLength(4);
    expect(passes.items.map((p) => p.seatLabel).sort()).toEqual([SEAT_A, SEAT_B, SEAT_C, SEAT_D].sort());
    expect(passes.items.every((p) => p.reviewStatus === 'WAITING')).toBe(true);
    expect(passes.items.some((p) => p.ticketId === TICKET_B && p.seatLabel === SEAT_B)).toBe(false);
    expect(passes.items.find((p) => p.ticketId === TICKET_A)?.seatLabel).toBe(SEAT_A);

    const flags = await scannerGet(`/v1/scanner/events/${EVENT}/flags`, LEAD_SESSION, LEAD);
    expect((JSON.parse(flags.payload) as { items: { kind: string }[] }).items.filter((f) => f.kind === 'OVERRIDE_REVIEW')).toHaveLength(0);

    const flagOf = (ticketId: string) => [...gate.flags.values()].find((f) => f.ticketId === ticketId && f.kind === 'OVERRIDE_REVIEW')!;
    for (const [ticketId, statusName] of [
      [TICKET_A, 'OK'],
      [TICKET_B, 'SUSPECT'],
      [TICKET_C, 'UNDETERMINED'],
    ] as const) {
      expect((await scannerPost(`/v1/scanner/flags/${flagOf(ticketId).flagId}/resolution`, { status: statusName }, LEAD_SESSION, LEAD)).statusCode).toBe(200);
    }
    const after = await scannerGet(`/v1/scanner/events/${EVENT}/override-passes`, LEAD_SESSION, LEAD);
    const afterItems = (JSON.parse(after.payload) as { items: { ticketId: string; reviewStatus: string }[] }).items;
    expect(Object.fromEntries(afterItems.map((p) => [p.ticketId, p.reviewStatus]))).toEqual({
      [TICKET_A]: 'OK',
      [TICKET_B]: 'SUSPECT',
      [TICKET_C]: 'UNDETERMINED',
      [TICKET_D]: 'WAITING',
    });
    const statusAfter = await scannerGet(`/v1/scanner/events/${EVENT}/devices`, LEAD_SESSION, LEAD);
    expect((JSON.parse(statusAfter.payload) as { openFlags: number }).openFlags).toBe(openFlagsOf());
    expect((JSON.parse(statusAfter.payload) as { openFlags: number }).openFlags).toBe(1);
  });

  test('SCR-052 내 예외 통과 limit은 기본 50·최대 200이고 0·201·400·글자는 400이다', async () => {
    for (const ticketId of bulkTickets) {
      const r = await scanOverride(ticketId, LIMIT_SESSION, LIMIT_LEAD, '대량');
      expect(r.statusCode).toBe(200);
    }
    const base = `/v1/scanner/events/${EVENT}/override-passes`;
    const def = await scannerGet(base, LIMIT_SESSION, LIMIT_LEAD);
    expect(def.statusCode).toBe(200);
    expect((JSON.parse(def.payload) as { items: unknown[] }).items).toHaveLength(50);
    const max = await scannerGet(`${base}?limit=200`, LIMIT_SESSION, LIMIT_LEAD);
    expect((JSON.parse(max.payload) as { items: unknown[] }).items).toHaveLength(51);
    for (const limit of ['0', '201', '400', 'abc', '-1']) {
      const r = await scannerGet(`${base}?limit=${limit}`, LIMIT_SESSION, LIMIT_LEAD);
      expect(r.statusCode, `limit=${limit}`).toBe(400);
    }
  });
});
