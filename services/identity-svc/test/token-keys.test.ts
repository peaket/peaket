// 서명 키 셋 셋과 무중단 교체(docs/features/identity.md §3 '서명 키 분리와 무중단 로테이션'·'토큰 수명주기 구현', I-T20, ADR-0050 결정 9).
import { createLocalJWKSet, jwtVerify } from 'jose';
import { describe, expect, test } from 'vitest';
import { JoseTokenSigner } from '../src/modules/session/adapters/jose-token-signer.js';
import { TokenKeyRing } from '../src/modules/session/adapters/token-keys.js';
import { fanKey, ISSUER } from './support.js';

const NOW = Date.parse('2026-11-03T03:00:00Z');
const env = async (over: Record<string, string> = {}) => {
  const fan = await fanKey();
  return { PEAKET_ENV: 'ci', PEAKET_FAN_TOKEN_KEY: JSON.stringify(fan.privateJwk), ...over };
};

describe('토큰 서명 키 셋', () => {
  test('I-T20_공개키묶음에_지금키와옛키를싣고_옛키는정한시각까지만이다', async () => {
    const old = await fanKey();
    const ring = await TokenKeyRing.fromEnv(
      await env({ PEAKET_FAN_TOKEN_KEY_PREVIOUS: JSON.stringify(old.publicJwk), PEAKET_FAN_TOKEN_KEY_PREVIOUS_UNTIL: new Date(NOW + 60_000).toISOString() }),
    );
    expect(ring.jwks('fan', NOW).keys.map((k) => k.kid)).toEqual([ring.signingKey('fan').kid, old.publicJwk.kid]);
    expect(ring.jwks('fan', NOW + 60_001).keys.map((k) => k.kid)).toEqual([ring.signingKey('fan').kid]);
  });

  test('I-T20_교체전키로서명한토큰은_교체뒤에도옛키기한까지검증된다', async () => {
    const before = await TokenKeyRing.fromEnv(await env());
    const token = (await new JoseTokenSigner(before, ISSUER).access({ accountId: 'a', sessionId: 's' }, NOW)).token;
    const after = await TokenKeyRing.fromEnv(
      await env({
        PEAKET_FAN_TOKEN_KEY_PREVIOUS: JSON.stringify(before.publicJwk('fan')),
        PEAKET_FAN_TOKEN_KEY_PREVIOUS_UNTIL: new Date(NOW + 15 * 60_000 + 86_400_000).toISOString(),
      }),
    );
    const verifyAt = (t: number) => jwtVerify(token, createLocalJWKSet(after.jwks('fan', t)), { issuer: ISSUER, audience: 'fan', typ: 'at+jwt', currentDate: new Date(NOW + 60_000) });
    await expect(verifyAt(NOW + 60_000)).resolves.toBeTruthy();
    // 새 키로 서명한 토큰은 새 kid다
    const fresh = (await new JoseTokenSigner(after, ISSUER).access({ accountId: 'a', sessionId: 's' }, NOW)).token;
    expect(JSON.parse(Buffer.from(fresh.split('.')[0]!, 'base64url').toString()).kid).toBe(after.signingKey('fan').kid);
    // 옛 키 기한이 지나면 묶음에서 빠져 더는 검증되지 않는다
    await expect(verifyAt(NOW + 15 * 60_000 + 86_400_001)).rejects.toThrow();
  });

  test('secrets-and-keys_공개키묶음에는_개인키값이없고_ES256서명용만싣는다', async () => {
    const old = await fanKey();
    const ring = await TokenKeyRing.fromEnv(await env({ PEAKET_FAN_TOKEN_KEY_PREVIOUS: JSON.stringify(old.publicJwk), PEAKET_FAN_TOKEN_KEY_PREVIOUS_UNTIL: new Date(NOW + 1).toISOString() }));
    for (const k of ring.jwks('fan', NOW).keys) {
      expect(k).not.toHaveProperty('d');
      expect(k).toMatchObject({ kty: 'EC', crv: 'P-256', alg: 'ES256', use: 'sig' });
    }
  });

  test('ADR0050_운영쪽환경은_세키셋이모두있어야시작하고_로컬·CI는팬키셋만있어도된다', async () => {
    await expect(TokenKeyRing.fromEnv({ ...(await env()), PEAKET_ENV: 'prod' })).rejects.toThrow(/PEAKET_ADMIN_TOKEN_KEY/);
    const admin = await fanKey();
    const staff = await fanKey();
    const ring = await TokenKeyRing.fromEnv({ ...(await env()), PEAKET_ENV: 'staging', PEAKET_ADMIN_TOKEN_KEY: JSON.stringify(admin.privateJwk), PEAKET_STAFF_TOKEN_KEY: JSON.stringify(staff.privateJwk) });
    expect(ring.has('admin') && ring.has('staff')).toBe(true);
    const local = await TokenKeyRing.fromEnv(await env());
    expect(local.has('admin')).toBe(false);
    expect(local.jwks('admin', NOW).keys).toEqual([]);
  });

  test('ADR0050_키셋끼리같은kid를쓰거나_옛키기한없이옛키를두면_시작하지않는다', async () => {
    const e = await env();
    await expect(TokenKeyRing.fromEnv({ ...e, PEAKET_ADMIN_TOKEN_KEY: e.PEAKET_FAN_TOKEN_KEY })).rejects.toThrow(/kid/);
    const old = await fanKey();
    await expect(TokenKeyRing.fromEnv({ ...e, PEAKET_FAN_TOKEN_KEY_PREVIOUS: JSON.stringify(old.publicJwk) })).rejects.toThrow(/PREVIOUS_UNTIL/);
  });

  test('secrets-and-keys_옛키설정에개인키(d)가있으면_시작하지않는다(옛키는공개JWK만)', async () => {
    const old = await fanKey();
    await expect(TokenKeyRing.fromEnv(await env({ PEAKET_FAN_TOKEN_KEY_PREVIOUS: JSON.stringify(old.privateJwk), PEAKET_FAN_TOKEN_KEY_PREVIOUS_UNTIL: new Date(NOW + 1).toISOString() }))).rejects.toThrow(/공개 JWK/);
  });

  test('I-T20_다음키를먼저알린다_받는쪽캐시가새kid를알게된뒤서명키로올린다(2단계교체)', async () => {
    const next = await fanKey();
    const ring = await TokenKeyRing.fromEnv(await env({ PEAKET_FAN_TOKEN_KEY_NEXT: JSON.stringify(next.publicJwk) }));
    expect(ring.jwks('fan', NOW).keys.map((k) => k.kid)).toEqual([ring.signingKey('fan').kid, next.publicJwk.kid]);
    expect(ring.signingKey('fan').kid).not.toBe(next.publicJwk.kid);
    await expect(TokenKeyRing.fromEnv(await env({ PEAKET_FAN_TOKEN_KEY_NEXT: JSON.stringify(next.privateJwk) }))).rejects.toThrow(/공개 JWK/);
  });
});

