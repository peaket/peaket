// 입장용 기기 키 HTTP 시험(BUILD_ORDER GAT-140, openapi POST /v1/tickets/{ticketId}/device-keys).
// 팬 머리(x-user-aud: fan)로 201·404·422·403을 보고, 응답 keyId가 저장소의 유효 키와 같은지 본다.
import 'reflect-metadata';
import { Writable } from 'node:stream';
import { createService, fakeClock, MemoryDpopReplayStore, type AdminAuthzPort, type ScannerSessionCheck } from '@peaket/platform';
import { exportJWK, generateKeyPair } from 'jose';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { MemoryEnrollmentCodeStore } from '../src/modules/scanner/adapters/memory-enrollment-code-store.js';
import { MemoryScannerDeviceStore } from '../src/modules/scanner/adapters/memory-scanner-device-store.js';
import { MemoryScannerGateStore } from '../src/modules/scanner/adapters/memory-scanner-gate-store.js';
import { MemoryScannerShiftStore } from '../src/modules/scanner/adapters/memory-scanner-shift-store.js';
import { MemoryDeviceKeyStore } from '../src/modules/ticket/adapters/memory-device-key-store.js';
import { DeviceKeys } from '../src/modules/ticket/application/device-keys.js';
import type { PublicKeyJwk } from '../src/modules/ticket/domain/device-key.js';

const NOW = Date.parse('2026-11-14T03:00:00.000Z');
const EVENT = '0190f3a1-7c2e-7a00-8000-000000000001';
const TICKET = '0190f3a1-7c2e-7a00-8000-000000000002';
const ACCOUNT = '0190f3a1-7c2e-7a00-8000-000000000003';
const OTHER = '0190f3a1-7c2e-7a00-8000-000000000004';
const SESSION = '0190f3a1-7c2e-7a00-8000-000000000005';
const quiet = () => new Writable({ write: (_c, _e, cb) => cb() });

class FakeAdmin implements AdminAuthzPort {
  async getAdminAuthz(): Promise<{ valid: boolean; role: string }> {
    return { valid: false, role: '' };
  }
}

class FakeSessions implements ScannerSessionCheck {
  async check(): Promise<{ valid: boolean }> {
    return { valid: false };
  }
}

let svc: Awaited<ReturnType<typeof createService>>;
let deviceKeysStore: MemoryDeviceKeyStore;

async function jwk(): Promise<PublicKeyJwk> {
  return (await exportJWK((await generateKeyPair('ES256', { extractable: true })).publicKey)) as PublicKeyJwk;
}

const post = (ticketId: string, body: unknown, account = ACCOUNT) =>
  svc.http.inject({
    method: 'POST',
    url: `/v1/tickets/${ticketId}/device-keys`,
    headers: { 'x-user-id': account, 'x-session-id': SESSION, 'x-user-aud': 'fan', 'content-type': 'application/json' },
    payload: JSON.stringify(body),
  });

beforeAll(async () => {
  const clock = fakeClock({ now: NOW });
  const replay = new MemoryDpopReplayStore(clock);
  deviceKeysStore = new MemoryDeviceKeyStore();
  deviceKeysStore.seedTicket({ ticketId: TICKET, eventId: EVENT, accountId: ACCOUNT });
  const gate = new MemoryScannerGateStore(deviceKeysStore);
  const shift = new MemoryScannerShiftStore(gate);
  const devices = new MemoryScannerDeviceStore();
  svc = await createService({
    name: 'ticket-svc-device-keys-http',
    module: AppModule.register({
      scanner: { store: devices, codes: new MemoryEnrollmentCodeStore(clock), replay, gate, shift },
      ticket: { deviceKeys: new DeviceKeys({ store: deviceKeysStore, clock }) },
    }),
    env: { PEAKET_ENV: 'ci' },
    clock,
    logDestination: quiet(),
    adminAuthz: new FakeAdmin(),
    scanner: { devices, sessions: new FakeSessions(), replay },
  });
});

afterAll(async () => {
  await svc?.close().catch(() => {});
});

describe('기기 키 HTTP [GAT-140]', () => {
  test('ISSUE는 201과 keyId를 주고, 응답 keyId가 유효 키다', async () => {
    const r = await post(TICKET, { publicKeyJwk: await jwk(), reason: 'ISSUE' });
    expect(r.statusCode).toBe(201);
    const body = JSON.parse(r.payload) as { keyId: string };
    expect(body.keyId).toMatch(/^[A-Za-z0-9_-]{11}$/);
    const active = await deviceKeysStore.activeKeysByEvent(EVENT);
    expect(active.get(TICKET)![0]!.keyId).toBe(body.keyId);
  });

  test('다른 보유자·없는 티켓은 404, 곡선 밖의 공개키는 422, REISSUE는 재인증 없이 403이다', async () => {
    expect((await post(TICKET, { publicKeyJwk: await jwk(), reason: 'ISSUE' }, OTHER)).statusCode).toBe(404);
    expect((await post('0190f3a1-7c2e-7a00-8000-000000000099', { publicKeyJwk: await jwk(), reason: 'ISSUE' })).statusCode).toBe(404);
    const bad = { kty: 'EC', crv: 'P-256', x: 'A'.repeat(43), y: 'A'.repeat(43) };
    expect((await post(TICKET, { publicKeyJwk: bad, reason: 'ISSUE' })).statusCode).toBe(422);
    expect((await post(TICKET, { publicKeyJwk: await jwk(), reason: 'REISSUE' })).statusCode).toBe(403);
  });
});
