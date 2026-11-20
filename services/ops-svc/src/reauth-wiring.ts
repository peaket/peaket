// ops-svc 시작 조립: 재인증(JWKS·jti Redis) 값이 없을 때 환경별로 닫는 자리(계획 B21, ADR-0322 결정 8, OPSV-05).
// local·ci는 없으면 경고하고 닫힌 대역(재인증 503/403)으로 뜬다. demo·staging·prod는 둘 중 하나라도 없으면 시작하지 않는다.
export type ReauthWiring = { readonly ok: true; readonly warnings: readonly string[] };

const REQUIRED = ['PEAKET_IDENTITY_JWKS_URL', 'PEAKET_REAUTH_REDIS_URL'] as const;
const OPEN_ENVS = new Set(['local', 'ci']);

export function reauthWiring(env: NodeJS.ProcessEnv): ReauthWiring {
  const missing = REQUIRED.filter((k) => (env[k] ?? '').trim() === '');
  if (missing.length > 0 && !OPEN_ENVS.has(env.PEAKET_ENV ?? '')) {
    throw new Error(`${missing.join(', ')}가 없다(재인증 JWKS·jti Redis는 local·ci 밖에서 필수다)`);
  }
  return {
    ok: true,
    warnings: missing.map((k) => `${k}가 없어 재인증이 닫힌 대역(503/403)이다`),
  };
}
