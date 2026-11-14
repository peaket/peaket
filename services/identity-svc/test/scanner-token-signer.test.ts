// 현장 스태프 토큰 서명 시험(GAT-220, identity §6.1): typ at+jwt, aud scanner, cnf.jkt, 만료 = 역할 유효 끝.
import { exportJWK, generateKeyPair, jwtVerify } from 'jose';
import { describe, expect, test } from 'vitest';
import { JoseTokenSigner } from '../src/modules/session/adapters/jose-token-signer.js';
import { TokenKeyRing } from '../src/modules/session/adapters/token-keys.js';

const ISSUER = 'https://identity.peaket.test';
const NOW = Date.parse('2026-11-14T03:00:00.000Z');

async function signer() {
  const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
  const privateJwk = { ...(await exportJWK(privateKey)), kid: 'staff-test', alg: 'ES256' };
  const publicJwk = { ...(await exportJWK(publicKey)), kid: 'staff-test', alg: 'ES256', use: 'sig' };
  const keys = await TokenKeyRing.fromEnv({ PEAKET_ENV: 'ci', PEAKET_FAN_TOKEN_KEY: JSON.stringify({ ...privateJwk, kid: 'fan-test' }), PEAKET_STAFF_TOKEN_KEY: JSON.stringify(privateJwk) });
  return { signer: new JoseTokenSigner(keys, ISSUER), publicKey };
}

describe('현장 스태프 토큰 [GAT-220]', () => {
  test('cnf.jkt·회차·세션을 묶고 만료는 역할 유효 끝이다', async () => {
    const { signer: s, publicKey } = await signer();
    const jkt = 'A'.repeat(43);
    const expiresAtMs = NOW + 2 * 3_600_000;
    const token = await s.staff({ accountId: 'acc-1', scannerSessionId: 'ss-1', eventId: 'ev-1', jkt, expiresAtMs }, NOW);
    const { payload, protectedHeader } = await jwtVerify(token.token, publicKey, { issuer: ISSUER, audience: 'scanner', currentDate: new Date(NOW) });
    expect(protectedHeader).toMatchObject({ alg: 'ES256', typ: 'at+jwt', kid: 'staff-test' });
    expect(payload).toMatchObject({ sub: 'acc-1', sid: 'ss-1', evt: 'ev-1', cnf: { jkt } });
    expect(payload.exp! * 1000).toBe(expiresAtMs);
    expect(token.expiresAt).toBe(expiresAtMs);
    expect(payload.role).toBeUndefined();
  });

  test('역할 유효 끝이 지났으면 토큰을 만들지 않는다', async () => {
    const { signer: s } = await signer();
    await expect(s.staff({ accountId: 'acc-1', scannerSessionId: 'ss-1', eventId: 'ev-1', jkt: 'A'.repeat(43), expiresAtMs: NOW }, NOW)).rejects.toThrow(/만료/);
  });
});
