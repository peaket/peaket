// 파트너 관리 재인증 토큰 도구(I-T53 ②③, ADR-0206, docs/features/identity.md '위험 운영 명령 재인증').
// identity가 주는 관리 재인증 토큰과 같은 모양(ES256, r‖s 64바이트, typ reauth+jwt, aud partner, act, factors)으로 서명하고,
// 관리 공개키 묶음(JWKS)을 주는 가짜 fetch를 둔다(services/core-svc/test/shop-reauth-fixtures.ts와 같은 꼴).
// 발급자는 시작 조립의 기본값과 다르게 둔다.
import { generateKeyPairSync, type KeyObject, randomUUID, sign } from 'node:crypto';

export const ISS = 'https://identity.f077-test';
export const JWKS_URL = `${ISS}/internal/jwks/admin.json`;

export interface AdminKey {
  kid: string;
  priv: KeyObject;
  publicJwk: Record<string, string>;
}

export function adminKey(kid: string): AdminKey {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const j = publicKey.export({ format: 'jwk' }) as Record<string, string>;
  return { kid, priv: privateKey, publicJwk: { kty: 'EC', crv: 'P-256', x: j.x!, y: j.y!, kid, alg: 'ES256', use: 'sig' } };
}

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');

/** 정상 클레임(비밀번호·TOTP·패스키 세 요소, act PAYOUT_ACCOUNT). over로 칸을 바꾸거나(undefined면 뺀다) 더한다 */
export function reauthClaims(c: { nowMs: number; accountId: string; sessionId: string; jti?: string; lifeS?: number }, over: Record<string, unknown> = {}): Record<string, unknown> {
  const iat = Math.floor(c.nowMs / 1000);
  const base: Record<string, unknown> = {
    iss: ISS,
    sub: c.accountId,
    aud: 'partner',
    iat,
    exp: iat + (c.lifeS ?? 170),
    sid: c.sessionId,
    jti: c.jti ?? randomUUID(),
    act: 'PAYOUT_ACCOUNT',
    factors: ['password', 'totp', 'passkey'],
    ...over,
  };
  for (const [k, v] of Object.entries(base)) if (v === undefined) delete base[k];
  return base;
}

export function signReauth(key: AdminKey, claims: Record<string, unknown>): string {
  const head = b64({ alg: 'ES256', typ: 'reauth+jwt', kid: key.kid });
  const body = b64(claims);
  const sig = sign('sha256', Buffer.from(`${head}.${body}`), { key: key.priv, dsaEncoding: 'ieee-p1363' });
  return `${head}.${body}.${sig.toString('base64url')}`;
}

/** 관리 JWKS만 주는 fetch(다른 주소는 404) */
export function jwksFetch(keys: readonly AdminKey[]): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.endsWith('/internal/jwks/admin.json')) return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ keys: keys.map((k) => k.publicJwk) }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}
