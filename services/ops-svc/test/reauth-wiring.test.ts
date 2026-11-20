// RV-08: ops-svc 시작 조립이 재인증 JWKS·jti Redis를 배포 환경에서 요구한다(계획 B21, ADR-0322 결정 8, OPSV-05).
// local·ci는 없으면 경고하고 닫힌 대역(503/403)으로 뜨지만, demo·staging·prod는 둘 중 하나라도 없으면 시작하지 않는다.
// 배포 값에는 PEAKET_IDENTITY_JWKS_URL과 재인증 Redis(Secret 키 PEAKET_REAUTH_REDIS_URL) 자리가 있다.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { reauthWiring } from '../src/reauth-wiring.js';

const values = readFileSync(fileURLToPath(new URL('../../../deploy/workloads/ops-svc/values.yaml', import.meta.url)), 'utf8');

describe('RV-08 재인증 시작 조립·배포 값', () => {
  test('RV-08 local·ci는 JWKS·Redis가 없어도 경고만 하고 시작한다', () => {
    for (const env of ['local', 'ci'] as const) {
      const out = reauthWiring({ PEAKET_ENV: env });
      expect(out, env).toMatchObject({ ok: true });
      expect(out.warnings.join(' '), env).toMatch(/PEAKET_IDENTITY_JWKS_URL/);
      expect(out.warnings.join(' '), env).toMatch(/PEAKET_REAUTH_REDIS_URL/);
    }
  });

  test('RV-08 demo·staging·prod는 JWKS·Redis가 하나라도 없으면 시작하지 않는다', () => {
    for (const env of ['demo', 'staging', 'prod'] as const) {
      expect(() => reauthWiring({ PEAKET_ENV: env }), `${env} 둘 다 없음`).toThrow(/PEAKET_IDENTITY_JWKS_URL/);
      expect(() => reauthWiring({ PEAKET_ENV: env, PEAKET_IDENTITY_JWKS_URL: 'http://identity-svc-grpc:50051' }), `${env} Redis 없음`).toThrow(/PEAKET_REAUTH_REDIS_URL/);
      expect(() => reauthWiring({ PEAKET_ENV: env, PEAKET_REAUTH_REDIS_URL: 'rediss://reauth' }), `${env} JWKS 없음`).toThrow(/PEAKET_IDENTITY_JWKS_URL/);
      expect(reauthWiring({ PEAKET_ENV: env, PEAKET_IDENTITY_JWKS_URL: 'http://identity-svc-grpc:50051', PEAKET_REAUTH_REDIS_URL: 'rediss://reauth' })).toMatchObject({ ok: true });
    }
  });

  test('RV-08 배포 값에 JWKS 주소와 재인증 Redis Secret 키 자리가 있다', () => {
    expect(values).toContain('PEAKET_IDENTITY_JWKS_URL');
    expect(values).toMatch(/PEAKET_REAUTH_REDIS_URL/);
    expect(values).toContain('secretEnvFrom: ops-svc-secrets');
  });
});
