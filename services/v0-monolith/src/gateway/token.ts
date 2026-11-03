// v0 입구의 팬 액세스 토큰 검증(docs/infra.md §3 'v0 배포' 3, docs/features/identity.md §3).
// - ES256 서명을 공개키 목록(JWKS)으로 검증한 뒤에만 본문을 읽는다(ASVS v5.0.0-9.1.1·9.1.2)
// - 머리 alg ES256·typ at+jwt·kid가 목록에 있음, 본문 iss 설정값·aud fan·exp 뒤·nbf 앞(있을 때)·sub·sid 1~1024자(ASVS v5.0.0-9.2.1·9.2.3)
// - 공개키 목록에 개인키(d)가 있으면 시작하지 않는다(서명 개인키는 클러스터에 두지 않는다)
import { createPublicKey, verify, type KeyObject } from 'node:crypto';
import type { Clock } from '@peaket/platform';

/** 팬 액세스 토큰 쿠키 이름(docs/features/identity.md §3) */
export const ACCESS_COOKIE = '__Secure-peaket_at';
/** 받는 토큰 대상. v0 입구는 팬 대상만 받는다(검표도 팬 대상 신원, docs/features/offline-gate.md §13) */
export const FAN_AUDIENCE = 'fan';
/** 받는 토큰 유형(JWT 머리 typ) */
export const ACCESS_TOKEN_TYPE = 'at+jwt';
/** sub·sid·scope·pid 문자열의 최대 길이(플랫폼 인증 가드가 읽는 머리 상한과 같다) */
export const MAX_CLAIM_LENGTH = 1024;

/** EC P-256 공개키 하나(JWK). kid가 있어야 한다 */
export interface FanPublicJwk {
  kty: 'EC';
  crv: 'P-256';
  x: string;
  y: string;
  kid: string;
  alg?: 'ES256';
  use?: 'sig';
}

export interface FanJwks {
  keys: FanPublicJwk[];
}

/** 검증을 통과한 신원(입구가 내부 머리로 넘긴다) */
export interface FanIdentity {
  sub: string;
  sid: string;
  /** 공백으로 이은 스코프. 없으면 빈 문자열 */
  scope: string;
  pid?: string;
}

/** 토큰을 거절한 까닭(지표 v0_gateway_token_rejections_total{reason}의 값) */
export type TokenRejection =
  | 'malformed' // JWT 모양(세 조각, base64url, JSON)이 아니다
  | 'alg' // 머리 alg가 ES256이 아니다
  | 'typ' // 머리 typ이 at+jwt가 아니다
  | 'kid' // 머리 kid가 없거나 목록에 없다
  | 'signature' // 서명이 맞지 않는다
  | 'issuer' // iss가 설정값이 아니다
  | 'audience' // aud가 fan이 아니다(문자열 하나나 fan만 든 배열이 아니다)
  | 'expired' // exp가 없거나 숫자가 아니거나 지금이거나 그 앞이다
  | 'not_yet_valid' // nbf가 있는데 지금보다 뒤다
  | 'claims'; // sub·sid·pid가 1~1024자의 공백 없는 보이는 ASCII가 아니거나, scope가 1024자 이하의 보이는 ASCII·공백이 아니다(머리 주입 방지)

export const TOKEN_REJECTIONS: readonly TokenRejection[] = ['malformed', 'alg', 'typ', 'kid', 'signature', 'issuer', 'audience', 'expired', 'not_yet_valid', 'claims'];

export type TokenResult = { ok: true; identity: FanIdentity } | { ok: false; reason: TokenRejection };

export interface TokenVerifierOptions {
  jwks: FanJwks;
  /** 받는 발급자(iss) */
  issuer: string;
  /** 시각(벽시계 now()의 밀리초를 초로 내려 exp·nbf와 견준다) */
  clock: Clock;
}

export class JwksError extends Error {
  override name = 'JwksError';
}

const BASE64URL = /^[A-Za-z0-9_-]+$/;
/** 머리에 실을 신원 값: 공백 없는 보이는 ASCII(머리 주입을 막는다) */
const TOKEN_CHARS = /^[\x21-\x7e]+$/;
/** 스코프: 보이는 ASCII와 공백 */
const SCOPE_CHARS = /^[\x20-\x7e]*$/;
/** ES256 서명(IEEE P1363 r||s)의 길이 */
const ES256_SIGNATURE_BYTES = 64;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** base64url 조각을 해독한다. 글자 집합 밖의 글자(Node 해독기는 건너뛴다)가 있으면 undefined */
function decodeBase64Url(part: string): Buffer | undefined {
  return BASE64URL.test(part) ? Buffer.from(part, 'base64url') : undefined;
}

function decodeJsonPart(part: string): Record<string, unknown> | undefined {
  const bytes = decodeBase64Url(part);
  if (!bytes) return undefined;
  try {
    const v: unknown = JSON.parse(bytes.toString('utf8'));
    return isRecord(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

function publicKeyOf(jwk: { x: string; y: string }): KeyObject {
  return createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }, format: 'jwk' });
}

/**
 * 환경 값의 JWKS JSON을 읽는다. 키가 하나도 없거나, EC P-256이 아니거나, kid가 없거나 겹치거나, alg가 ES256이 아니거나,
 * 개인키 칸(d)이 있으면 JwksError를 던진다
 */
export function parseFanJwks(json: string): FanJwks {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new JwksError('공개키 목록이 JSON이 아니다');
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.keys) || parsed.keys.length === 0) throw new JwksError('공개키 목록에 키가 없다');
  const seen = new Set<string>();
  const keys: FanPublicJwk[] = [];
  for (const raw of parsed.keys as unknown[]) {
    if (!isRecord(raw)) throw new JwksError('공개키가 객체가 아니다');
    // 서명 개인키는 클러스터에 두지 않는다. 개인키 칸이 섞여 오면 시작하지 않는다
    if ('d' in raw) throw new JwksError('공개키 목록에 개인키(d)가 있다');
    if (raw.kty !== 'EC' || raw.crv !== 'P-256') throw new JwksError('공개키는 EC P-256만 받는다');
    if (typeof raw.kid !== 'string' || raw.kid.length === 0) throw new JwksError('공개키에 kid가 없다');
    if (seen.has(raw.kid)) throw new JwksError('공개키 kid가 겹친다');
    if (raw.alg !== undefined && raw.alg !== 'ES256') throw new JwksError('공개키 alg는 ES256만 받는다');
    if (raw.use !== undefined && raw.use !== 'sig') throw new JwksError('공개키 use는 sig만 받는다');
    if (typeof raw.x !== 'string' || typeof raw.y !== 'string') throw new JwksError('공개키 좌표(x·y)가 없다');
    const key: FanPublicJwk = { kty: 'EC', crv: 'P-256', x: raw.x, y: raw.y, kid: raw.kid };
    try {
      publicKeyOf(key);
    } catch {
      throw new JwksError('공개키를 읽지 못했다');
    }
    if (raw.alg === 'ES256') key.alg = 'ES256';
    if (raw.use === 'sig') key.use = 'sig';
    seen.add(key.kid);
    keys.push(key);
  }
  return { keys };
}

/** Cookie 머리에서 액세스 토큰 쿠키 값. 없거나 비었으면 undefined(같은 이름이 여럿이면 첫 값) */
export function accessTokenFromCookie(cookie: string | string[] | undefined): string | undefined {
  if (cookie === undefined) return undefined;
  const text = Array.isArray(cookie) ? cookie.join('; ') : cookie;
  for (const part of text.split(';')) {
    const at = part.indexOf('=');
    if (at < 0) continue;
    if (part.slice(0, at).trim() !== ACCESS_COOKIE) continue;
    const value = part.slice(at + 1).trim();
    return value.length > 0 ? value : undefined;
  }
  return undefined;
}

const claimText = (v: unknown, chars: RegExp, min: number): v is string => typeof v === 'string' && v.length >= min && v.length <= MAX_CLAIM_LENGTH && chars.test(v);

/** 토큰 검증 함수를 만든다. 공개키는 만들 때 한 번 읽어 둔다 */
export function createTokenVerifier(options: TokenVerifierOptions): (token: string) => TokenResult {
  const keys = new Map(options.jwks.keys.map((k) => [k.kid, publicKeyOf(k)]));
  const { issuer, clock } = options;
  const no = (reason: TokenRejection): TokenResult => ({ ok: false, reason });
  return (token) => {
    const parts = token.split('.');
    if (parts.length !== 3) return no('malformed');
    const [h = '', p = '', s = ''] = parts;
    const header = decodeJsonPart(h);
    const payload = decodeJsonPart(p);
    const signature = decodeBase64Url(s);
    if (!header || !payload || !signature) return no('malformed');
    if (header.alg !== 'ES256') return no('alg');
    if (header.typ !== ACCESS_TOKEN_TYPE) return no('typ');
    const key = typeof header.kid === 'string' ? keys.get(header.kid) : undefined;
    if (!key) return no('kid');
    // 서명을 먼저 본다. 본문은 서명이 맞은 뒤에만 믿는다(ASVS v5.0.0-9.1.1)
    if (signature.length !== ES256_SIGNATURE_BYTES) return no('signature');
    if (!verify('sha256', Buffer.from(`${h}.${p}`), { key, dsaEncoding: 'ieee-p1363' }, signature)) return no('signature');
    if (payload.iss !== issuer) return no('issuer');
    const aud = payload.aud;
    const audOk = aud === FAN_AUDIENCE || (Array.isArray(aud) && aud.length > 0 && aud.every((a) => a === FAN_AUDIENCE));
    if (!audOk) return no('audience');
    const now = clock.now();
    const exp = payload.exp;
    if (typeof exp !== 'number' || !Number.isFinite(exp) || exp * 1000 <= now) return no('expired');
    const nbf = payload.nbf;
    if (nbf !== undefined && (typeof nbf !== 'number' || !Number.isFinite(nbf) || nbf * 1000 > now)) return no('not_yet_valid');
    const { sub, sid, scope, pid } = payload;
    if (!claimText(sub, TOKEN_CHARS, 1) || !claimText(sid, TOKEN_CHARS, 1)) return no('claims');
    if (scope !== undefined && !claimText(scope, SCOPE_CHARS, 0)) return no('claims');
    if (pid !== undefined && !claimText(pid, TOKEN_CHARS, 1)) return no('claims');
    const identity: FanIdentity = { sub, sid, scope: typeof scope === 'string' ? scope : '' };
    if (typeof pid === 'string') identity.pid = pid;
    return { ok: true, identity };
  };
}
