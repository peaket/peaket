// shop 시작 조립 시험(RV-08, ADR-0315, P-T63 ②, 계획 §10 '시작 조립').
// 정본: PEAKET_IDENTITY_FAN_JWKS_URL이 없으면 local·ci는 닫힌 대역(늘 403)과 경고 한 줄, 그 밖 환경은 시작 실패다.
// 주소가 있으면 JwksShopReauthGate를 만들고, 릴레이 리더 반복에는 merch-user-refund-retry(MerchRefundRetry.tick)가 붙는다.
// full `dist/main.js`를 띄우는 시험은 bundle의 시작 파일 시험 몫이고, 여기서는 main·relay가 그 부품을 실제로 부르는지 소스 경계로 함께 본다.
import { readFileSync } from 'node:fs';
import { MemoryReauthJtiStore } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import { shopReauthGateFromEnv } from '../src/modules/shop/index.js';

const JTI = new MemoryReauthJtiStore();
const FAN_JWKS_URL = 'https://identity.peaket.test/internal/jwks/fan.json';
const ISSUER = 'https://identity.peaket.test';

describe('shop 시작 조립(RV-08, P-T63 ②)', () => {
  test('RV-08 주소가 없으면 local·ci는 닫힌 대역(undefined)과 경고 한 줄이고 그 밖 환경은 시작 실패다', () => {
    for (const env of ['local', 'ci']) {
      const warnings: string[] = [];
      const gate = shopReauthGateFromEnv({ env: { PEAKET_ENV: env }, jti: JTI, warn: (m) => warnings.push(m) });
      expect(gate, env).toBeUndefined();
      expect(warnings.join('\n'), env).toContain('PEAKET_IDENTITY_FAN_JWKS_URL이 없다');
    }
    for (const env of ['prod', 'staging', 'demo']) {
      expect(() => shopReauthGateFromEnv({ env: { PEAKET_ENV: env }, jti: JTI }), env).toThrow('운영에서는 시작하지 않는다');
    }
  });

  test('RV-08 주소가 있으면 JwksShopReauthGate를 만들고 발급자가 없으면 local·ci만 기본 발급자를 쓴다', async () => {
    const gate = shopReauthGateFromEnv({ env: { PEAKET_ENV: 'ci', PEAKET_IDENTITY_FAN_JWKS_URL: FAN_JWKS_URL }, jti: JTI });
    expect(gate).toBeDefined();
    // 토큰이 없으면 공개키를 읽기 전에 403 거절이다
    expect(await gate!.verify(undefined, { accountId: 'a', sessionId: 's', act: 'FAN_HIGH_RISK', op: 'SHOP_CANCEL_REFUND_ACCOUNT' })).toBe(false);
    expect(shopReauthGateFromEnv({ env: { PEAKET_ENV: 'prod', PEAKET_IDENTITY_FAN_JWKS_URL: FAN_JWKS_URL, PEAKET_IDENTITY_ISSUER: ISSUER }, jti: JTI })).toBeDefined();
    expect(() => shopReauthGateFromEnv({ env: { PEAKET_ENV: 'prod', PEAKET_IDENTITY_FAN_JWKS_URL: FAN_JWKS_URL }, jti: JTI })).toThrow('PEAKET_IDENTITY_ISSUER가 없다');
  });

  test('RV-08 main은 재인증 게이트를, relay는 merch-user-refund-retry 반복을 조립한다', () => {
    const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
    expect(main).toContain('shopReauthGateFromEnv');
    expect(main).toContain('closedShopReauthGate');
    const relay = readFileSync(new URL('../src/relay.ts', import.meta.url), 'utf8');
    expect(relay).toContain("name: 'merch-user-refund-retry'");
    expect(relay).toContain('new MerchRefundRetry');
    expect(relay).toContain('MERCH_REFUND_LOOP_INTERVAL_MS');
  });
});
