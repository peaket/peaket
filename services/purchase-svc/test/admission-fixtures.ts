// 입장 토큰 시험 도구: 키 만들기와 서명(queue-svc의 Es256AdmissionTokens와 같은 형식: ES256, r‖s 64바이트, typ admission+jwt).
import { generateKeyPairSync, type KeyObject, sign } from 'node:crypto';

export const ISS = 'https://queue.peaket.example';
export const JNY = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';

export interface TestKey {
  kid: string;
  priv: KeyObject;
  pub: KeyObject;
  publicJwk: Record<string, string>;
}

export function newKey(kid: string): TestKey {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const j = publicKey.export({ format: 'jwk' }) as Record<string, string>;
  return { kid, priv: privateKey, pub: publicKey, publicJwk: { kty: 'EC', crv: 'P-256', x: j.x!, y: j.y!, kid } };
}

export const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');

export interface ClaimsInput {
  nowMs: number;
  jti: string;
  accountId?: string;
  loginSessionId?: string;
  eventId?: string;
  maxStayMs?: number;
}

/** 정상 클레임. over로 칸을 바꾸거나(undefined면 뺀다) 더한다 */
export function claimsOf(c: ClaimsInput, over: Record<string, unknown> = {}): Record<string, unknown> {
  const iat = Math.floor(c.nowMs / 1000);
  return {
    iss: ISS,
    sub: c.accountId ?? 'acct-1',
    aud: 'purchase',
    jti: c.jti,
    sid: c.loginSessionId ?? 'login-1',
    event: c.eventId ?? 'ev-1',
    jny: JNY,
    iat,
    exp: iat + Math.floor((c.maxStayMs ?? 45 * 60_000) / 1000),
    ...over,
  };
}

/** 서명한 입장 토큰. header·claims로 칸을 바꾸거나 빼고, signWith로 서명 키를 바꾼다 */
export function signAdmission(key: TestKey, claims: Record<string, unknown>, o: { header?: Record<string, unknown>; signWith?: KeyObject } = {}): string {
  const head = b64({ alg: 'ES256', typ: 'admission+jwt', kid: key.kid, ...o.header });
  const body = b64(claims);
  const sig = sign('sha256', Buffer.from(`${head}.${body}`), { key: o.signWith ?? key.priv, dsaEncoding: 'ieee-p1363' });
  return `${head}.${body}.${sig.toString('base64url')}`;
}
