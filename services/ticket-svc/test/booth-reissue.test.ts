// F-05-12 O-T28 ②③ 부스 코드·책임자 허용·BOOTH 등록 한 번.
// 정본: docs/features/offline-gate.md §9.1 '부스 재발급', openapi createTicketBoothRequest·
//       createScannerBoothAuthorization·createTicketDeviceKey, d5 §5.13·§8.5, ADR-0050 결정 2, ADR-0051 결정 11.
// 시험 값은 정본 숫자(코드·허용 10분, 하루 3회, 토큰 5분)를 그대로 쓴다. 코드 상수를 가져오지 않는다.
//
// 시험 리뷰 TR-06·TR-08·TR-10·TR-11·TR-14 반영:
// - X-Reauth-Token 없음·틀림·다른 계정을 재인증 단계에서 거부하고, 허용보다 먼저 본다.
// - KST 날짜·코드/허용 600,000−1ms·600,000ms·입장 시작 1ms 전/시작 시각 경계를 양쪽으로 본다.
// - 좌석 이름은 seatId와 다른 사람이 읽는 seatLabel로 두어 seatId를 돌려주는 구현이 통과하지 않게 한다.
// - 다른 출처·Origin 없음 403, text/plain 415, 성공 시 scanner_change KEY_REGISTERED 1, 403에는 키·변경 0.
// - boothRequestId가 그 허용에 묶였는지(같은 티켓의 다른 허용을 소비하지 않는지) 본다.
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
const DEVICE = '0190f3a1-7c2e-7a00-8000-00000000a009';
const SESSION = '0190f3a1-7c2e-7a00-8000-00000000a00a';
const TOKEN = 'staff-access-token';
const ATH = athOf(TOKEN);
const HOST = 'scanner-api.peaket.example';
const PWA = 'https://scanner.peaket.example';
const CODE_MS = 10 * 60_000;
const GOOD_REAUTH = `reauth-${ACCOUNT}`;
const quiet = () => new Writable({ write: (_c, _e, cb) => cb() });

/** 좌석 ID는 UUID 모양, 사람이 읽는 이름은 따로 둔다(TR-10: seatId를 seatLabel 자리에 넣지 않는다) */
const TICKET_A = '0190f3a1-7c2e-7a00-8000-00000000a0a1';
const TICKET_B = '0190f3a1-7c2e-7a00-8000-00000000a0b1';
const TICKET_C = '0190f3a1-7c2e-7a00-8000-00000000a0c1';
const TICKET_D = '0190f3a1-7c2e-7a00-8000-00000000a0d1';
const TICKET_D2 = '0190f3a1-7c2e-7a00-8000-00000000a0d2';
const TICKET_E = '0190f3a1-7c2e-7a00-8000-00000000a0e1';
const TICKET_F = '0190f3a1-7c2e-7a00-8000-00000000a0f1';
const TICKET_G = '0190f3a1-7c2e-7a00-8000-00000000a0a2';
const TICKET_H = '0190f3a1-7c2e-7a00-8000-00000000a0b2';
const TICKET_I = '0190f3a1-7c2e-7a00-8000-00000000a0c2';
const SEAT_LABEL_A = 'R구역 12열 7번';
const ALL_TICKETS = [TICKET_A, TICKET_B, TICKET_C, TICKET_D, TICKET_D2, TICKET_E, TICKET_F, TICKET_G, TICKET_H, TICKET_I];

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
/** 기기 키 저장소가 적은 scanner_change(성공 1회·403 0회) */
const changes: { eventId: string; kind: string; payload: Record<string, unknown> }[] = [];
/** 재인증 확인기에 실제로 넘어온 토큰·계정(TR-06: 늘 true인 대역을 두지 않는다) */
const reauthCalls: { token: string | undefined; accountId: string }[] = [];

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
const fanPost = (path: string, body: unknown, account = ACCOUNT, headers: Record<string, string> = {}) => svc.http.inject({ method: 'POST', url: path, headers: { ...fanHeaders(account), ...headers }, payload: JSON.stringify(body) });
type ScannerPostOptions = { origin?: string | null; contentType?: string; raw?: string };
const scannerPost = async (path: string, body: unknown, o: ScannerPostOptions = {}) => {
  const h = await scannerHeaders('POST', path);
  return svc.http.inject({
    method: 'POST',
    url: path,
    headers: {
      ...h,
      ...(o.origin === null ? {} : { origin: o.origin ?? PWA }),
      'content-type': o.contentType ?? 'application/json',
    },
    payload: o.raw ?? JSON.stringify(body),
  });
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
  keyStore = new MemoryDeviceKeyStore((eventId, kind, payload) => changes.push({ eventId, kind, payload }));
  for (const [i, ticketId] of ALL_TICKETS.entries()) {
    gate.seedTicket({ ticketId, eventId: EVENT, seatId: `0190f3a1-7c2e-7a00-8000-0000000c${String(i + 1).padStart(4, '0')}`, seatLabel: SEAT_LABEL_A, gateZone: '동문', status: 'ACTIVE' } as unknown as Parameters<typeof gate.seedTicket>[0]); // type-escape: seatLabel은 구현 뒤 생긴다
    keyStore.seedTicket({ ticketId, eventId: EVENT, accountId: ACCOUNT, eventStartsAtMs: NOW - 1 });
  }
  sessions = new FakeSessions();
  sessions.answers.set(`${SESSION}/${DEVICE}`, { valid: true, role: 'gate_lead', eventId: EVENT });
  const replay = new MemoryDpopReplayStore(clock);
  const shift = new MemoryScannerShiftStore(gate);
  await shift.putPlacement({ eventId: EVENT, deviceId: DEVICE, gateZone: '동문', mode: 'IN', setBy: ACCOUNT, atMs: NOW, expectedVersion: 0 });

  // 구현 뒤 생기는 부스 저장소·응용. 기준 트리에서는 이 동적 불러오기가 실패하므로 부스 없이 조립하고,
  // 각 시험은 경로 404·BOOTH_NOT_ALLOWED로 실패한다(준비 단계에서 멈추지 않는다).
  let booth: unknown;
  let deviceKeys = new DeviceKeys({ store: keyStore, clock, reauth: { verify: async () => false } });
  try {
    const boothPath = new URL('../src/modules/ticket/adapters/memory-booth-store.ts', import.meta.url).href;
    const appPath = new URL('../src/modules/ticket/application/booth.ts', import.meta.url).href;
    const boothMod = (await import(/* @vite-ignore */ boothPath)) as unknown as { MemoryBoothStore: new (deps: unknown) => unknown };
    const appMod = (await import(/* @vite-ignore */ appPath)) as unknown as { TicketBooth: new (d: unknown) => unknown };
    const boothStore = new boothMod.MemoryBoothStore({ deviceKeys: keyStore, devices: deviceStore, shift, gate });
    booth = new appMod.TicketBooth({
      store: boothStore,
      // 남의 표는 저장소가 먼저 404로 가른다. 토큰·계정·티켓이 모두 맞을 때만 통과한다
      verifications: { verify: async ({ token, accountId, ticketId }: { token: string; accountId: string; ticketId: string }) => token === 'good-token' && accountId === ACCOUNT && ALL_TICKETS.includes(ticketId) },
      clock,
    });
    deviceKeys = new DeviceKeys({
      store: keyStore,
      clock,
      // X-Reauth-Token 원문을 확인기에 넘기는지 시험이 본다. 계정마다 다른 토큰이라 다른 계정 토큰은 거부된다
      reauth: {
        verify: async (token: string | undefined, q: { accountId: string }) => {
          reauthCalls.push({ token, accountId: q.accountId });
          return token === `reauth-${q.accountId}`;
        },
      },
      booth: boothStore,
    } as unknown as ConstructorParameters<typeof DeviceKeys>[0]); // type-escape: booth 옵션은 구현 뒤 생긴다
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

const requestBooth = (ticketId = TICKET_A, token = 'good-token', account = ACCOUNT) => fanPost(`/v1/tickets/${ticketId}/booth-requests`, { reverificationToken: token }, account);
const authorizeBooth = (boothCode: string, o: ScannerPostOptions = {}) => scannerPost('/v1/scanner/booth-authorizations', { boothCode }, o);
const registerBooth = (ticketId: string, boothRequestId: string, publicKeyJwk: Record<string, unknown>, account = ACCOUNT, reauthToken: string | undefined = GOOD_REAUTH) =>
  fanPost(`/v1/tickets/${ticketId}/device-keys`, { publicKeyJwk, reason: 'BOOTH', boothRequestId }, account, reauthToken === undefined ? {} : { 'x-reauth-token': reauthToken });
const bodyOf = <T>(r: { payload: string }): T => JSON.parse(r.payload) as T;
const keysOf = (ticketId: string) => (keyStore.keys.get(ticketId) ?? []).filter((k) => k.revokedAtMs === undefined);
const registeredChanges = (ticketId: string) => changes.filter((c) => c.kind === 'KEY_REGISTERED' && c.payload.ticketId === ticketId);

describe('O-T28 ② 부스 코드·책임자 허용', () => {
  test('O-T28 ② 입장 시작 1ms 전이면 409, 시작 시각이면 201, 남의 표·없는 표는 404, 대조 토큰이 틀리면 409이고 코드는 8자·10분이다', async () => {
    keyStore.tickets.set(TICKET_B, { ticketId: TICKET_B, eventId: EVENT, accountId: ACCOUNT, eventStartsAtMs: clock.now() + 1 });
    expect((await requestBooth(TICKET_B)).statusCode).toBe(409);
    clock.advance(1);
    expect((await requestBooth(TICKET_B)).statusCode).toBe(201);

    expect((await requestBooth(TICKET_A, 'good-token', OTHER_ACCOUNT)).statusCode).toBe(404);
    expect((await requestBooth('0190f3a1-7c2e-7a00-8000-00000000a0ff')).statusCode).toBe(404);
    const bad = await requestBooth(TICKET_A, 'bad-token');
    expect(bad.statusCode).toBe(409);
    expect(bodyOf<{ type: string; status: number }>(bad)).toMatchObject({ type: 'https://peaket.example/problems/booth-mismatch', status: 409 });

    const at = clock.now();
    const ok = await requestBooth(TICKET_A);
    expect(ok.statusCode).toBe(201);
    const body = bodyOf<{ boothRequestId: string; boothCode: string; expiresAt: string }>(ok);
    expect(body.boothRequestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.boothCode).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/);
    expect(Date.parse(body.expiresAt) - at).toBe(CODE_MS);
  });

  test('O-T28 ② 하루 3회는 KST 날짜로 세고, 4번째는 429이며 KST 날이 바뀐 1ms 뒤에는 201이고 새 코드는 옛 코드를 무효로 한다', async () => {
    const KST_OFFSET = 9 * 60 * 60_000;
    const nextKstMidnight = Math.floor((clock.now() + KST_OFFSET) / 86_400_000) * 86_400_000 + 86_400_000 - KST_OFFSET;
    clock.advance(nextKstMidnight - 1 - clock.now());
    const a = bodyOf<{ boothCode: string }>(await requestBooth(TICKET_E));
    const b = bodyOf<{ boothCode: string }>(await requestBooth(TICKET_E));
    const c = bodyOf<{ boothCode: string }>(await requestBooth(TICKET_E));
    expect((await requestBooth(TICKET_E)).statusCode).toBe(429);
    expect((await authorizeBooth(a.boothCode)).statusCode).toBe(410);
    expect(b.boothCode).not.toBe(c.boothCode);
    clock.advance(1);
    expect((await requestBooth(TICKET_E)).statusCode).toBe(201);
  });

  test('O-T28 ② 일반 스태프는 403, 모르는 코드는 410, 만료 600,000−1ms는 200·600,000ms는 410이고, 같은 코드 재허용은 같은 allowUntil이다', async () => {
    const req = bodyOf<{ boothCode: string }>(await requestBooth(TICKET_C));
    sessions.answers.set(`${SESSION}/${DEVICE}`, { valid: true, role: 'gate_staff', eventId: EVENT });
    expect((await authorizeBooth(req.boothCode)).statusCode).toBe(403);
    sessions.answers.set(`${SESSION}/${DEVICE}`, { valid: true, role: 'gate_lead', eventId: OTHER_EVENT });
    expect((await authorizeBooth(req.boothCode)).statusCode).toBe(403);
    sessions.answers.set(`${SESSION}/${DEVICE}`, { valid: true, role: 'gate_lead', eventId: EVENT });
    expect((await authorizeBooth('ZZZZZZZZ')).statusCode).toBe(410);

    clock.advance(CODE_MS - 1);
    const at = clock.now();
    const ok = await authorizeBooth(req.boothCode);
    expect(ok.statusCode).toBe(200);
    const body = bodyOf<{ ticketId: string; seatLabel: string; allowUntil: string }>(ok);
    expect(body.ticketId).toBe(TICKET_C);
    expect(body.seatLabel).toBe(SEAT_LABEL_A);
    expect(Date.parse(body.allowUntil) - at).toBe(CODE_MS);
    const again = bodyOf<{ allowUntil: string }>(await authorizeBooth(req.boothCode));
    expect(again.allowUntil).toBe(body.allowUntil);

    const fresh = bodyOf<{ boothCode: string }>(await requestBooth(TICKET_C));
    clock.advance(CODE_MS);
    expect((await authorizeBooth(fresh.boothCode)).statusCode).toBe(410);
  });

  test('O-T28 ② 부스 허용 경로는 PWA 출처·JSON만 받는다(Origin 없음·다른 출처 403, text/plain 415)', async () => {
    const req = bodyOf<{ boothCode: string }>(await requestBooth(TICKET_I));
    for (const origin of [null, 'https://evil.example', 'https://scanner.peaket.example:443']) {
      const r = await authorizeBooth(req.boothCode, origin === null ? { origin: null } : { origin });
      expect(r.statusCode, String(origin)).toBe(403);
      expect(bodyOf<{ type: string }>(r).type).toBe('https://peaket.example/problems/scanner-origin-forbidden');
    }
    for (const contentType of ['text/plain', 'application/x-www-form-urlencoded']) {
      const r = await authorizeBooth(req.boothCode, { contentType, raw: JSON.stringify({ boothCode: req.boothCode }) });
      expect(r.statusCode, contentType).toBe(415);
    }
    expect((await authorizeBooth(req.boothCode)).statusCode).toBe(200);
  });
});

describe('O-T28 ③ BOOTH 등록 한 번', () => {
  test('O-T28 ③ 허용이 없거나 지났으면 403 booth-not-authorized이고 키·변경이 남지 않는다', async () => {
    const req = bodyOf<{ boothRequestId: string; boothCode: string }>(await requestBooth(TICKET_D));
    expect((await registerBooth(TICKET_D, req.boothRequestId, await publicJwk())).statusCode).toBe(403);
    expect(keysOf(TICKET_D)).toHaveLength(0);
    expect((await authorizeBooth(req.boothCode)).statusCode).toBe(200);
    clock.advance(CODE_MS);
    const late = await registerBooth(TICKET_D, req.boothRequestId, await publicJwk());
    expect(late.statusCode).toBe(403);
    expect(bodyOf<{ type: string; status: number }>(late)).toMatchObject({ type: 'https://peaket.example/problems/booth-not-authorized', status: 403 });
    expect(keysOf(TICKET_D)).toHaveLength(0);
    expect(registeredChanges(TICKET_D)).toHaveLength(0);
  });

  test('O-T28 ③ 허용 600,000−1ms에 첫 등록은 201·키 1·scanner_change KEY_REGISTERED 1이고, 두 번째는 403이며 사용한 코드 재허용은 410이다', async () => {
    const req = bodyOf<{ boothRequestId: string; boothCode: string }>(await requestBooth(TICKET_H));
    expect((await authorizeBooth(req.boothCode)).statusCode).toBe(200);
    clock.advance(CODE_MS - 1);
    const first = await registerBooth(TICKET_H, req.boothRequestId, await publicJwk());
    expect(first.statusCode).toBe(201);
    expect(keysOf(TICKET_H)).toHaveLength(1);
    expect(registeredChanges(TICKET_H)).toHaveLength(1);
    expect(changes.filter((c) => c.kind === 'KEY_REGISTERED' && c.payload.ticketId === TICKET_H)[0]!.eventId).toBe(EVENT);
    expect((await registerBooth(TICKET_H, req.boothRequestId, await publicJwk())).statusCode).toBe(403);
    expect(keysOf(TICKET_H)).toHaveLength(1);
    // 사용 표시가 남은 코드는 다시 허용하지 않는다(openapi createScannerBoothAuthorization 410 '코드 만료·사용됨')
    expect((await authorizeBooth(req.boothCode)).statusCode).toBe(410);
  });

  test('O-T28 ③ 허용 시각 600,000ms에는 아직 키가 없는 티켓도 403이다', async () => {
    const req = bodyOf<{ boothRequestId: string; boothCode: string }>(await requestBooth(TICKET_D2));
    expect((await authorizeBooth(req.boothCode)).statusCode).toBe(200);
    clock.advance(CODE_MS);
    expect((await registerBooth(TICKET_D2, req.boothRequestId, await publicJwk())).statusCode).toBe(403);
    expect(keysOf(TICKET_D2)).toHaveLength(0);
  });

  test('O-T28 ③ boothRequestId가 묶여서 같은 티켓의 다른 허용을 소비하지 않는다', async () => {
    const first = bodyOf<{ boothRequestId: string; boothCode: string }>(await requestBooth(TICKET_F));
    expect((await authorizeBooth(first.boothCode)).statusCode).toBe(200);
    const second = bodyOf<{ boothRequestId: string; boothCode: string }>(await requestBooth(TICKET_F));
    expect((await registerBooth(TICKET_F, second.boothRequestId, await publicJwk())).statusCode).toBe(403);
    expect(keysOf(TICKET_F)).toHaveLength(0);
    expect((await registerBooth(TICKET_F, first.boothRequestId, await publicJwk())).statusCode).toBe(201);
    expect(keysOf(TICKET_F)).toHaveLength(1);
    expect((await registerBooth(TICKET_F, second.boothRequestId, await publicJwk())).statusCode).toBe(403);
  });

  test('O-T28 ③ 재인증 없음·틀림은 허용보다 먼저 403 reauth-required이고, 다른 계정은 404로 거부하며 허용을 소모하지 않는다', async () => {
    const req = bodyOf<{ boothRequestId: string; boothCode: string }>(await requestBooth(TICKET_G));
    expect((await registerBooth(TICKET_G, req.boothRequestId, await publicJwk(), ACCOUNT, undefined)).statusCode).toBe(403);
    expect(bodyOf<{ type: string }>(await registerBooth(TICKET_G, req.boothRequestId, await publicJwk(), ACCOUNT, undefined)).type).toBe('https://peaket.example/problems/reauth-required');
    expect((await authorizeBooth(req.boothCode)).statusCode).toBe(200);
    const wrong = await registerBooth(TICKET_G, req.boothRequestId, await publicJwk(), ACCOUNT, 'reauth-wrong');
    expect(wrong.statusCode).toBe(403);
    expect(bodyOf<{ type: string }>(wrong).type).toBe('https://peaket.example/problems/reauth-required');
    expect((await registerBooth(TICKET_G, req.boothRequestId, await publicJwk(), OTHER_ACCOUNT, `reauth-${OTHER_ACCOUNT}`)).statusCode).toBe(404);
    expect(reauthCalls.some((c) => c.accountId === OTHER_ACCOUNT)).toBe(true);
    expect(registeredChanges(TICKET_G)).toHaveLength(0);
    expect((await registerBooth(TICKET_G, req.boothRequestId, await publicJwk())).statusCode).toBe(201);
    expect((await registerBooth(TICKET_G, req.boothRequestId, await publicJwk())).statusCode).toBe(403);
  });
});
