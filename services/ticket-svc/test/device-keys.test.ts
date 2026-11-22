// 입장용 기기 공개키 등록·폐기 단위 시험(BUILD_ORDER GAT-140, FR-012, POL-018, ADR-0025·0050·0051, offline-gate §2·§3).
// JWK에서 keyId(SPKI SHA-256 앞 8바이트)·압축 공개키를 만들고, 티켓당 유효 키 하나·소유자·입장 시작·재발급 한도를 본다.
import { createHash, createPublicKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
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
    // 입장 시작 전, 다른 키가 유효한데 재인증 없음: reissue-required(ADR-0363 결정 2)
    await expect(keys.register(register({ publicKeyJwk: await publicJwk() }))).rejects.toMatchObject({ code: 'REISSUE_REQUIRED' });

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
    // 입장 시작 전 재인증 없는 REISSUE: reissue-required(ADR-0363 결정 2, openapi createTicketDeviceKey 403 설명)
    await expect(keys.register(register({ publicKeyJwk: jwk, reason: 'REISSUE' }))).rejects.toMatchObject({ code: 'REISSUE_REQUIRED' });
    const reauth: ReauthGate = { verify: async () => true };
    const withReauth = new DeviceKeys({ store, clock, reauth });
    await expect(withReauth.register(register({ publicKeyJwk: jwk, reason: 'BOOTH' }))).rejects.toMatchObject({ code: 'BOOTH_NOT_ALLOWED' });
    const reissued = await withReauth.register(register({ publicKeyJwk: await publicJwk(), reason: 'REISSUE' }));
    expect(reissued.keyId).toMatch(/^[A-Za-z0-9_-]{11}$/);
    clock.advance(1_000);
    await expect(withReauth.register(register({ publicKeyJwk: await publicJwk(), reason: 'REISSUE' }))).rejects.toMatchObject({ code: 'REISSUE_LIMIT' });
  });

  test('입장 시작 뒤 다른 키가 유효한 티켓의 REISSUE는 재인증이 있어도 REISSUE_AT_BOOTH다(ADR-0363 결정 2)', async () => {
    const reauth: ReauthGate = { verify: async () => true };
    const withReauth = new DeviceKeys({ store, clock, reauth });
    await keys.register(register({ publicKeyJwk: await publicJwk() }));
    store.seedTicket({ ticketId: TICKET, eventId: EVENT, accountId: ACCOUNT, payerAccountId: ACCOUNT, eventStartsAtMs: NOW - 1 });
    await expect(withReauth.register(register({ publicKeyJwk: await publicJwk(), reason: 'REISSUE' }))).rejects.toMatchObject({ code: 'REISSUE_AT_BOOTH' });
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

// 같은 키 다시 등록(BAT-350, O-T45 ③, offline-gate §2 '같은 키 다시 등록', ADR-0336 결정 4).
// 공개키·keyId는 구현과 따로 계산해 둔 시험 벡터(docs/api/vectors/qr-v1-device-key.v1.json)에서 읽는다. 월렛이 내보낸 JWK 모양(ext·key_ops)이다.
// 같은 규칙을 Drizzle 저장소가 겹쳐 지키므로 실제 DB 쪽은 test-int/device-key.int.test.ts의 O-T45 ③이 본다.
interface QrVector {
  publicKeyJwkAsExported: PublicKeyJwk;
  keyIdB64u: string;
  compressedPublicKeyB64u: string;
}
const vector = JSON.parse(readFileSync(new URL('../../../docs/api/vectors/qr-v1-device-key.v1.json', import.meta.url), 'utf8')) as QrVector;

describe('같은 키 다시 등록 [O-T45]', () => {
  const reauth: ReauthGate = { verify: async () => true };

  test('O-T45 ③ 같은 키 다시 등록은 바꾸지 않고 201, 다른 계정은 404', async () => {
    const first = await keys.register(register({ publicKeyJwk: vector.publicKeyJwkAsExported }));
    expect(first).toEqual({ keyId: vector.keyIdB64u });
    // 응답을 잃은 월렛이 같은 공개키로 다시 보낸다: 재인증(403)에 막히지 않고 같은 keyId
    clock.advance(1_000);
    const again = await keys.register(register({ publicKeyJwk: vector.publicKeyJwkAsExported }));
    expect(again).toEqual({ keyId: vector.keyIdB64u });
    // 바뀐 것이 없다: 유효 키 하나, 행 하나(처음 등록 시각 그대로), 폐기 0
    const rows = store.keys.get(TICKET)!;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.revokedAtMs).toBeUndefined();
    expect(rows[0]!.registeredAtMs).toBe(NOW);
    expect((await store.activeKeysByEvent(EVENT)).get(TICKET)).toEqual([{ keyId: vector.keyIdB64u, publicKey: vector.compressedPublicKeyB64u }]);
    expect(await store.revokedKeyIdsByEvent(EVENT)).toEqual([]);
    expect(await store.keyState(TICKET, Buffer.from(vector.keyIdB64u, 'base64url'))).toBe('ACTIVE');

    // 보유자 확인이 먼저다: 다른 계정·없는 티켓은 같은 공개키라도 not-found(404)
    await expect(keys.register(register({ accountId: OTHER, publicKeyJwk: vector.publicKeyJwkAsExported }))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(keys.register(register({ ticketId: '0190f3a1-7c2e-7a00-8000-000000000099', publicKeyJwk: vector.publicKeyJwkAsExported }))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(store.keys.get(TICKET)).toHaveLength(1);

    // 24시간 재발급 한도에도 세지 않는다: 재인증 뒤 첫 키 교체는 된다(다시 보낸 것이 교체로 세졌다면 REISSUE_LIMIT)
    clock.advance(60_000);
    const rotated = await new DeviceKeys({ store, clock, reauth }).register(register({ publicKeyJwk: await publicJwk() }));
    expect(rotated.keyId).not.toBe(vector.keyIdB64u);
    expect(await store.revokedKeyIdsByEvent(EVENT)).toEqual([vector.keyIdB64u]);
  });

  test('O-T45 ③ 입장 시작 뒤에도 같은 키는 201이고, 다른 키는 지금 규칙대로 거절한다', async () => {
    await keys.register(register({ publicKeyJwk: vector.publicKeyJwkAsExported }));
    store.seedTicket({ ticketId: TICKET, eventId: EVENT, accountId: ACCOUNT, eventStartsAtMs: NOW - 1 });
    expect(await keys.register(register({ publicKeyJwk: vector.publicKeyJwkAsExported }))).toEqual({ keyId: vector.keyIdB64u });
    expect(store.keys.get(TICKET)).toHaveLength(1);
    expect(store.keys.get(TICKET)![0]!.revokedAtMs).toBeUndefined();
    // 다른 키: 입장 시작 뒤 다른 키가 유효하면 부스로(HTTP 403 reissue-at-booth, ADR-0363 결정 2)
    await expect(keys.register(register({ publicKeyJwk: await publicJwk() }))).rejects.toMatchObject({ code: 'REISSUE_AT_BOOTH' });
    expect((await store.activeKeysByEvent(EVENT)).get(TICKET)).toEqual([{ keyId: vector.keyIdB64u, publicKey: vector.compressedPublicKeyB64u }]);
  });

  test('O-T45 ③ 유효 키와 다른 키는 재인증 없이 거절하고, TRANSFER도 같은 키는 바꾸지 않고 받는다', async () => {
    await keys.register(register({ publicKeyJwk: vector.publicKeyJwkAsExported }));
    // 다른 키 ISSUE(입장 시작 전): 재인증 뒤 다시 받기(HTTP 403 reissue-required, ADR-0363 결정 2)
    await expect(keys.register(register({ publicKeyJwk: await publicJwk() }))).rejects.toMatchObject({ code: 'REISSUE_REQUIRED' });
    expect((await store.activeKeysByEvent(EVENT)).get(TICKET)!.map((k) => k.keyId)).toEqual([vector.keyIdB64u]);
    expect(await store.revokedKeyIdsByEvent(EVENT)).toEqual([]);

    // 양도로 보유자가 바뀐 티켓의 새 보유자 TRANSFER 등록을 다시 보내도 바꾸지 않는다
    const transferred = '0190f3a1-7c2e-7a00-8000-000000000097';
    store.seedTicket({ ticketId: transferred, eventId: EVENT, accountId: OTHER, payerAccountId: ACCOUNT });
    const transfer = register({ ticketId: transferred, accountId: OTHER, publicKeyJwk: vector.publicKeyJwkAsExported, reason: 'TRANSFER' });
    expect(await keys.register(transfer)).toEqual({ keyId: vector.keyIdB64u });
    expect(await keys.register(transfer)).toEqual({ keyId: vector.keyIdB64u });
    expect(store.keys.get(transferred)).toHaveLength(1);
    expect(store.keys.get(transferred)![0]!.revokedAtMs).toBeUndefined();
  });

  // RV350-1(정본 a0a652796): 판정 차례는 이유마다 다르다. ISSUE·TRANSFER는 보유자 확인(404) 바로 뒤에 같은 키를 보고,
  // REISSUE·BOOTH는 재인증·부스 허용 확인(403)을 먼저 지난 뒤 보유자 확인 다음에 본다. 그 확인을 못 지나면 같은 키여도 403이다
  test('O-T45 ③ REISSUE·BOOTH는 재인증·부스 허용 확인(403)이 먼저다: 같은 키여도 못 지나면 403이고 보유자가 아니어도 404보다 403이다', async () => {
    await keys.register(register({ publicKeyJwk: vector.publicKeyJwkAsExported }));
    const before = store.keys.get(TICKET)!.map((k) => ({ ...k }));
    const withReauth = new DeviceKeys({ store, clock, reauth });
    const same = { publicKeyJwk: vector.publicKeyJwkAsExported };
    const booth = { ...same, reason: 'BOOTH' as const, boothRequestId: '0190f3a1-7c2e-7a00-8000-0000000000b1' };

    // 보유자 본인, 같은 키: 재인증 없는 REISSUE는 403 reissue-required, BOOTH는 403 reauth-required(ADR-0363 결정 2), 재인증이 있어도 부스 허용이 없는 BOOTH는 403(부스 허용 없음)
    await expect(keys.register(register({ ...same, reason: 'REISSUE' }))).rejects.toMatchObject({ code: 'REISSUE_REQUIRED' });
    await expect(keys.register(register(booth))).rejects.toMatchObject({ code: 'REAUTH_REQUIRED' });
    await expect(withReauth.register(register(booth))).rejects.toMatchObject({ code: 'BOOTH_NOT_ALLOWED' });

    // 보유자가 아니거나(다른 계정) 없는 티켓이어도 그 확인을 못 지나면 404보다 403이 먼저다
    for (const who of [{ accountId: OTHER }, { ticketId: '0190f3a1-7c2e-7a00-8000-000000000099' }]) {
      await expect(keys.register(register({ ...same, ...who, reason: 'REISSUE' }))).rejects.toMatchObject({ code: 'REISSUE_REQUIRED' });
      await expect(keys.register(register({ ...booth, ...who }))).rejects.toMatchObject({ code: 'REAUTH_REQUIRED' });
      await expect(withReauth.register(register({ ...booth, ...who }))).rejects.toMatchObject({ code: 'BOOTH_NOT_ALLOWED' });
      // 재인증을 지난 REISSUE는 그다음 보유자 확인에서 404다
      await expect(withReauth.register(register({ ...same, ...who, reason: 'REISSUE' }))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    }

    // 어느 요청도 바꾼 것이 없다
    expect(store.keys.get(TICKET)).toEqual(before);
    expect(await store.revokedKeyIdsByEvent(EVENT)).toEqual([]);
  });

  test('O-T45 ③ 재인증을 지난 REISSUE의 같은 키는 바꾸지 않고 201이고 24시간 한도에 세지 않는다', async () => {
    await keys.register(register({ publicKeyJwk: vector.publicKeyJwkAsExported }));
    const withReauth = new DeviceKeys({ store, clock, reauth });
    clock.advance(1_000);
    expect(await withReauth.register(register({ publicKeyJwk: vector.publicKeyJwkAsExported, reason: 'REISSUE' }))).toEqual({ keyId: vector.keyIdB64u });
    const rows = store.keys.get(TICKET)!;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.revokedAtMs).toBeUndefined();
    expect(rows[0]!.registeredAtMs).toBe(NOW);
    expect(rows[0]!.reason).toBe('ISSUE');
    expect(await store.revokedKeyIdsByEvent(EVENT)).toEqual([]);
    // 한도에 세지 않았으므로 새 키 REISSUE(첫 교체)는 되고, 그다음 교체는 24시간 한도로 막힌다
    clock.advance(1_000);
    const rotated = await withReauth.register(register({ publicKeyJwk: await publicJwk(), reason: 'REISSUE' }));
    expect(rotated.keyId).not.toBe(vector.keyIdB64u);
    expect(await store.revokedKeyIdsByEvent(EVENT)).toEqual([vector.keyIdB64u]);
    await expect(withReauth.register(register({ publicKeyJwk: await publicJwk(), reason: 'REISSUE' }))).rejects.toMatchObject({ code: 'REISSUE_LIMIT' });
  });

  test('O-T45 ③ 같은 키 요청 둘이 겹쳐도 둘 다 201이고 유효 키는 하나다', async () => {
    const both = await Promise.all([
      keys.register(register({ publicKeyJwk: vector.publicKeyJwkAsExported })),
      keys.register(register({ publicKeyJwk: vector.publicKeyJwkAsExported })),
    ]);
    expect(both).toEqual([{ keyId: vector.keyIdB64u }, { keyId: vector.keyIdB64u }]);
    expect(store.keys.get(TICKET)).toHaveLength(1);
    expect(await store.revokedKeyIdsByEvent(EVENT)).toEqual([]);
  });
});
