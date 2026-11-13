// 입장용 기기 공개키 등록·폐기 단위 시험(BUILD_ORDER GAT-140, FR-012, POL-018, ADR-0025·0050·0051, offline-gate §2·§3).
// JWK에서 keyId(SPKI SHA-256 앞 8바이트)·압축 공개키를 만들고, 티켓당 유효 키 하나·소유자·입장 시작·재발급 한도를 본다.
import { createHash, createPublicKey } from 'node:crypto';
import { fakeClock } from '@peaket/platform';
import { exportJWK, generateKeyPair } from 'jose';
import { beforeEach, describe, expect, test } from 'vitest';
import { MemoryDeviceKeyStore } from '../src/modules/ticket/adapters/memory-device-key-store.js';
import { DeviceKeys, type ReauthGate } from '../src/modules/ticket/application/device-keys.js';
import { deviceKeyMaterialOf, keyIdTextOf, type PublicKeyJwk } from '../src/modules/ticket/domain/device-key.js';

const NOW = Date.parse('2026-11-14T03:00:00.000Z');
const EVENT = '0190f3a1-7c2e-7a00-8000-000000000001';
const TICKET = '0190f3a1-7c2e-7a00-8000-000000000002';
const ACCOUNT = '0190f3a1-7c2e-7a00-8000-000000000003';
const OTHER = '0190f3a1-7c2e-7a00-8000-000000000004';

async function publicJwk(): Promise<PublicKeyJwk> {
  const pair = await generateKeyPair('ES256', { extractable: true });
  return (await exportJWK(pair.publicKey)) as PublicKeyJwk;
}

let store: MemoryDeviceKeyStore;
let clock: ReturnType<typeof fakeClock>;
let keys: DeviceKeys;

beforeEach(() => {
  clock = fakeClock({ now: NOW });
  store = new MemoryDeviceKeyStore();
  store.seedTicket({ ticketId: TICKET, eventId: EVENT, accountId: ACCOUNT });
  keys = new DeviceKeys({ store, clock });
});

const register = (over: Partial<Parameters<DeviceKeys['register']>[0]> = {}) => ({
  ticketId: TICKET,
  accountId: ACCOUNT,
  sessionId: '0190f3a1-7c2e-7a00-8000-000000000005',
  publicKeyJwk: undefined as unknown as PublicKeyJwk,
  reason: 'ISSUE' as const,
  ...over,
});

describe('기기 키 값 [GAT-140]', () => {
  test('P-256 JWK에서 keyId 8바이트와 압축 공개키 33바이트를 만들고 SPKI SHA-256과 맞춘다', async () => {
    const jwk = await publicJwk();
    const m = deviceKeyMaterialOf(jwk);
    expect(m.keyId).toHaveLength(8);
    expect(m.publicKey).toHaveLength(33);
    expect([0x02, 0x03]).toContain(m.publicKey[0]);
    expect(keyIdTextOf(m.keyId)).toMatch(/^[A-Za-z0-9_-]{11}$/);
    const spki = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }, format: 'jwk' }).export({ type: 'spki', format: 'der' });
    expect(Buffer.from(m.keyId)).toEqual(createHash('sha256').update(spki).digest().subarray(0, 8));
  });

  test('개인키 d 칸이나 곡선 밖의 점은 거절한다', async () => {
    const jwk = await publicJwk();
    expect(() => deviceKeyMaterialOf({ ...jwk, d: 'x' } as PublicKeyJwk)).toThrow();
    expect(() => deviceKeyMaterialOf({ ...jwk, x: 'A'.repeat(43) })).toThrow();
    expect(() => deviceKeyMaterialOf({ ...jwk, crv: 'P-384' } as unknown as PublicKeyJwk)).toThrow();
  });
});

describe('기기 키 등록·폐기 [GAT-140]', () => {
  test('ISSUE는 첫 키를 등록하고, 키가 있으면 재인증 없이 바꾸지 못하며 재인증 뒤에도 24시간 1회만 바꾼다', async () => {
    const jwk1 = await publicJwk();
    const first = await keys.register(register({ publicKeyJwk: jwk1 }));
    expect(first.keyId).toMatch(/^[A-Za-z0-9_-]{11}$/);
    await expect(keys.register(register({ publicKeyJwk: await publicJwk() }))).rejects.toMatchObject({ code: 'REAUTH_REQUIRED' });

    const reauth: ReauthGate = { verify: async () => true };
    const withReauth = new DeviceKeys({ store, clock, reauth });
    const jwk2 = await publicJwk();
    const second = await withReauth.register(register({ publicKeyJwk: jwk2 }));
    expect(second.keyId).not.toBe(first.keyId);
    const active = await store.activeKeysByEvent(EVENT);
    expect(active.get(TICKET)).toHaveLength(1);
    expect(active.get(TICKET)![0]!.keyId).toBe(second.keyId);
    expect(await store.revokedKeyIdsByEvent(EVENT)).toEqual([first.keyId]);
    expect(await store.keyState(TICKET, Buffer.from(first.keyId, 'base64url'))).toBe('REVOKED');
    expect(await store.keyState(TICKET, Buffer.from(second.keyId, 'base64url'))).toBe('ACTIVE');
    await expect(withReauth.register(register({ publicKeyJwk: await publicJwk() }))).rejects.toMatchObject({ code: 'REISSUE_LIMIT' });
  });

  test('없는 티켓·다른 보유자는 not-found로 닫고, 입장 시작 뒤 ISSUE는 재인증 없이는 거절한다', async () => {
    const jwk = await publicJwk();
    await expect(keys.register(register({ ticketId: '0190f3a1-7c2e-7a00-8000-000000000099', publicKeyJwk: jwk }))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(keys.register(register({ accountId: OTHER, publicKeyJwk: jwk }))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    store.seedTicket({ ticketId: TICKET, eventId: EVENT, accountId: ACCOUNT, eventStartsAtMs: NOW - 1 });
    await expect(keys.register(register({ publicKeyJwk: jwk }))).rejects.toMatchObject({ code: 'ENTRY_STARTED' });
  });

  test('REISSUE는 재인증이 필요하고 24시간에 한 번만 되며, BOOTH는 부스 허용이 없어 거절한다', async () => {
    const jwk = await publicJwk();
    await keys.register(register({ publicKeyJwk: jwk }));
    await expect(keys.register(register({ publicKeyJwk: jwk, reason: 'REISSUE' }))).rejects.toMatchObject({ code: 'REAUTH_REQUIRED' });
    const reauth: ReauthGate = { verify: async () => true };
    const withReauth = new DeviceKeys({ store, clock, reauth });
    await expect(withReauth.register(register({ publicKeyJwk: jwk, reason: 'BOOTH' }))).rejects.toMatchObject({ code: 'BOOTH_NOT_ALLOWED' });
    const reissued = await withReauth.register(register({ publicKeyJwk: await publicJwk(), reason: 'REISSUE' }));
    expect(reissued.keyId).toMatch(/^[A-Za-z0-9_-]{11}$/);
    clock.advance(1_000);
    await expect(withReauth.register(register({ publicKeyJwk: await publicJwk(), reason: 'REISSUE' }))).rejects.toMatchObject({ code: 'REISSUE_LIMIT' });
  });

  test('입장 시작 뒤 REISSUE는 재인증이 있어도 ENTRY_STARTED다', async () => {
    const reauth: ReauthGate = { verify: async () => true };
    const withReauth = new DeviceKeys({ store, clock, reauth });
    await keys.register(register({ publicKeyJwk: await publicJwk() }));
    store.seedTicket({ ticketId: TICKET, eventId: EVENT, accountId: ACCOUNT, payerAccountId: ACCOUNT, eventStartsAtMs: NOW - 1 });
    await expect(withReauth.register(register({ publicKeyJwk: await publicJwk(), reason: 'REISSUE' }))).rejects.toMatchObject({ code: 'ENTRY_STARTED' });
  });

  test('TRANSFER는 보유자가 결제자와 다를 때만 허용한다', async () => {
    const holderTicket = '0190f3a1-7c2e-7a00-8000-000000000098';
    store.seedTicket({ ticketId: holderTicket, eventId: EVENT, accountId: OTHER, payerAccountId: ACCOUNT });
    const registered = await keys.register({
      ticketId: holderTicket,
      accountId: OTHER,
      sessionId: '0190f3a1-7c2e-7a00-8000-000000000005',
      publicKeyJwk: await publicJwk(),
      reason: 'TRANSFER',
    });
    expect(registered.keyId).toMatch(/^[A-Za-z0-9_-]{11}$/);

    store.seedTicket({ ticketId: TICKET, eventId: EVENT, accountId: ACCOUNT, payerAccountId: ACCOUNT });
    await expect(keys.register(register({ publicKeyJwk: await publicJwk(), reason: 'TRANSFER' }))).rejects.toMatchObject({ code: 'TRANSFER_NOT_ALLOWED' });
  });
});
