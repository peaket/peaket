// 입장용 기기 키 HTTP 시험(BUILD_ORDER GAT-140, openapi POST /v1/tickets/{ticketId}/device-keys).
// 팬 머리(x-user-aud: fan)로 201·404·422·403을 보고, 응답 keyId가 저장소의 유효 키와 같은지 본다.
import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { Writable } from 'node:stream';
import { CreateTicketDeviceKeyBody, CreateTicketDeviceKeyResponse } from '@peaket/contracts/openapi/tickets';
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

// 월렛·서버 keyId 맞물림과 같은 키 다시 등록(BAT-350, O-T45 ②③, offline-gate §2, ADR-0336 결정 4·6).
// 본문의 공개키는 구현과 따로 계산해 둔 시험 벡터의 '월렛이 내보낸 모양'(publicKeyJwkAsExported: ext·key_ops 포함)이고, 기대 keyId도 벡터 값이다.
interface QrVector {
  publicKeyJwkAsExported: PublicKeyJwk;
  keyIdB64u: string;
  compressedPublicKeyB64u: string;
}
const vector = JSON.parse(readFileSync(new URL('../../../docs/api/vectors/qr-v1-device-key.v1.json', import.meta.url), 'utf8')) as QrVector;
const problemName = (payload: string): string => String((JSON.parse(payload) as { type?: unknown }).type ?? '').split('/').pop() ?? '';

describe('기기 키 HTTP 벡터 [O-T45]', () => {
  test('O-T45 ② 월렛이 내보낸 JWK 모양으로 ISSUE 201이고 keyId가 벡터 값이다', async () => {
    const ticketId = '0190f3a1-7c2e-7a00-8b2a-6c1d5e70f201';
    deviceKeysStore.seedTicket({ ticketId, eventId: EVENT, accountId: ACCOUNT });
    const body = { publicKeyJwk: vector.publicKeyJwkAsExported, reason: 'ISSUE' };
    expect(CreateTicketDeviceKeyBody.parse(body)).toEqual(body);
    const r = await post(ticketId, body);
    expect(r.statusCode).toBe(201);
    const got: unknown = JSON.parse(r.payload);
    expect(got).toEqual({ keyId: vector.keyIdB64u });
    expect(CreateTicketDeviceKeyResponse.parse(got)).toEqual(got);
    expect((await deviceKeysStore.activeKeysByEvent(EVENT)).get(ticketId)).toEqual([{ keyId: vector.keyIdB64u, publicKey: vector.compressedPublicKeyB64u }]);
  });

  test('O-T45 ③ HTTP: 같은 키를 다시 보내면 201·같은 keyId이고 다른 계정은 404, 다른 키는 403이다', async () => {
    const ticketId = '0190f3a1-7c2e-7a00-8b2a-6c1d5e70f202';
    deviceKeysStore.seedTicket({ ticketId, eventId: EVENT, accountId: ACCOUNT });
    const body = { publicKeyJwk: vector.publicKeyJwkAsExported, reason: 'ISSUE' };
    const first = await post(ticketId, body);
    expect(first.statusCode).toBe(201);
    // 응답을 잃은 뒤 다시 보내기
    const again = await post(ticketId, body);
    expect(again.statusCode).toBe(201);
    expect(JSON.parse(again.payload)).toEqual({ keyId: vector.keyIdB64u });
    expect(deviceKeysStore.keys.get(ticketId)).toHaveLength(1);
    expect(await deviceKeysStore.revokedKeyIdsByEvent(EVENT)).not.toContain(vector.keyIdB64u);
    // 다른 계정이 같은 공개키로 보내면 404 not-found(보유자 확인이 먼저)
    const other = await post(ticketId, body, OTHER);
    expect(other.statusCode).toBe(404);
    expect(problemName(other.payload)).toBe('not-found');
    // 다른 키(입장 시작 전)는 재인증 뒤 다시 받기(403 reissue-required, ADR-0363 결정 2)
    const otherKey = await post(ticketId, { publicKeyJwk: await jwk(), reason: 'ISSUE' });
    expect(otherKey.statusCode).toBe(403);
    expect(problemName(otherKey.payload)).toBe('reissue-required');
    expect((await deviceKeysStore.activeKeysByEvent(EVENT)).get(ticketId)!.map((k) => k.keyId)).toEqual([vector.keyIdB64u]);
  });

  // RV350-1(정본 a0a652796): REISSUE·BOOTH는 재인증·부스 허용 확인(403)을 먼저 지나야 같은 키를 본다. 이 서비스 조립에는 재인증 확인이 없다
  test('O-T45 ③ HTTP: 같은 키 REISSUE·BOOTH는 재인증·부스 허용 확인을 못 지나면 403이고 보유자가 아니어도 404보다 403이다', async () => {
    const ticketId = '0190f3a1-7c2e-7a00-8b2a-6c1d5e70f203';
    deviceKeysStore.seedTicket({ ticketId, eventId: EVENT, accountId: ACCOUNT });
    expect((await post(ticketId, { publicKeyJwk: vector.publicKeyJwkAsExported, reason: 'ISSUE' })).statusCode).toBe(201);
    const reissue = { publicKeyJwk: vector.publicKeyJwkAsExported, reason: 'REISSUE' };
    const booth = { publicKeyJwk: vector.publicKeyJwkAsExported, reason: 'BOOTH', boothRequestId: '0190f3a1-7c2e-7a00-8000-0000000000b1' };
    for (const [label, target, account] of [
      ['보유자', ticketId, ACCOUNT],
      ['다른 계정', ticketId, OTHER],
      ['없는 티켓', '0190f3a1-7c2e-7a00-8b2a-6c1d5e70f299', ACCOUNT],
    ] as const) {
      // 재인증 없는 REISSUE는 reissue-required, 재인증 없는 BOOTH는 reauth-required(ADR-0363 결정 2, openapi createTicketDeviceKey 403 설명)
      for (const [body, name] of [
        [reissue, 'reissue-required'],
        [booth, 'reauth-required'],
      ] as const) {
        const r = await post(target, body, account);
        expect(r.statusCode, `${label} ${body.reason}`).toBe(403);
        expect(problemName(r.payload), `${label} ${body.reason}`).toBe(name);
      }
    }
    expect(deviceKeysStore.keys.get(ticketId)).toHaveLength(1);
    expect(deviceKeysStore.keys.get(ticketId)![0]!.revokedAtMs).toBeUndefined();
    expect(deviceKeysStore.keys.get(ticketId)![0]!.reason).toBe('ISSUE');
  });
});
