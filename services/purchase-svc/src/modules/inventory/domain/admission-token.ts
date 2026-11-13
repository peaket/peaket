// 입장 토큰 확인(docs/features/seat-hold.md §2 '구매 세션 열기와 확인의 첫 구현', ADR-0183 결정 8, ADR-0050 결정 9, BUILD_ORDER PRF-136).
// ES256만, 공개키는 설정한 묶음(PEAKET_ADMISSION_JWKS)에서 머리의 kid로만 찾는다. Node 표준 암호 모듈로 한다(queue-svc의 서명과 같은 RFC 7515 형식, 서명은 r‖s 64바이트).
// 순서(ASVS 9.1.1: 서명을 확인한 뒤에만 내용을 받는다): 모양 → alg → kid → 서명 → typ → 본문 모양 → iss·aud → 클레임 모양 → exp → iat.
// 도메인 층이라 프레임워크·플랫폼 형을 가져오지 않는다(node:crypto만).
import { createPublicKey, type KeyObject, verify } from 'node:crypto';
import { KEY_PART } from './hold.js';
import { UUID_PATTERN } from './purchase-session.js';

/** 첫 사용 기한: 입장 토큰 iat + 5분(ADR-0183 결정 8, 클레임으로 싣지 않는다) */
export const FIRST_USE_MS = 5 * 60_000;
/** iat가 지금보다 이만큼(60초 [가정])까지 미래인 것은 시계 오차로 받는다 */
export const IAT_SKEW_MS = 60_000;
/** 토큰 글자 수 상한(헤더·본문·서명 합) */
export const ADMISSION_TOKEN_MAX_CHARS = 2048;

const KID = /^[A-Za-z0-9_.-]{1,64}$/;
const B64URL = /^[A-Za-z0-9_-]+$/;
/** 판매 자격 명단 키 모양(docs/data.md q:{event:E}:elig:{listKey}, ADR-0261 결정 3) */
export const LIST_KEY = /^[a-z0-9-]{3,32}$/;
/** 입장 토큰 lst의 최대 키 수(ADR-0265 결정 7) */
export const MAX_ADMISSION_LISTS = 10;

export type AdmissionRejectReason = 'format' | 'alg' | 'kid' | 'signature' | 'typ' | 'iss' | 'aud' | 'expired' | 'not_yet' | 'claims';

/** 입장 토큰 거절. reason은 로그·지표용이고 응답에는 싣지 않는다 */
export class AdmissionTokenRejected extends Error {
  constructor(readonly reason: AdmissionRejectReason) {
    super(`입장 토큰 거절: ${reason}`);
    this.name = 'AdmissionTokenRejected';
  }
}

export interface AdmissionClaims {
  jti: string;
  /** sub */
  accountId: string;
  /** sid */
  loginSessionId: string;
  /** event */
  eventId: string;
  /** jny */
  journeyId: string;
  issuedAtMs: number;
  expiresAtMs: number;
  /** prio (우선 구매 입장일 때만) */
  priorityGrantId?: string;
  /** lst: 구매자가 든 판매 자격 명단 키(없으면 칸을 뺀다). 판매 정책의 buyer.lists 사실이다 */
  lists?: string[];
}

/** kid → 공개키 */
export type AdmissionKeys = ReadonlyMap<string, KeyObject>;

/** 채움 없는 base64url을 바이트로. 허용 밖 글자·비정규 표기(같은 바이트의 다른 글)는 undefined */
function decodePart(s: string): Buffer | undefined {
  if (!B64URL.test(s)) return undefined;
  const b = Buffer.from(s, 'base64url');
  return b.toString('base64url') === s ? b : undefined;
}

function jsonObject(b: Buffer): Record<string, unknown> | undefined {
  try {
    const v: unknown = JSON.parse(b.toString('utf8'));
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

const isKeyPart = (v: unknown): v is string => typeof v === 'string' && KEY_PART.test(v);

/**
 * lst 클레임의 모양을 본다(없으면 빈 배열, 있으면 1~10개의 중복 없는 명단 키). 틀리면 undefined.
 * queue-svc가 싣는 값과 purchase-svc가 읽는 값이 같은 규칙이다(ADR-0265 결정 7, seat-hold §2)
 */
export function admissionListsOfClaim(v: unknown): string[] | undefined {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length < 1 || v.length > MAX_ADMISSION_LISTS) return undefined;
  if (!v.every((k) => typeof k === 'string' && LIST_KEY.test(k))) return undefined;
  if (new Set(v).size !== v.length) return undefined;
  return [...v];
}

/**
 * 홀드 요청의 입장 토큰 머리에서 lst만 꺼낸다(서명은 게이트웨이가 확인해 넘겼다. stored-purchase-sessions의 admissionJtiOf와 같은 전제).
 * 토큰 모양이 깨졌거나 lst 모양이 틀리면 undefined(받는 층이 401 admission-token-invalid로 답한다). lst가 없으면 빈 배열이다
 */
export function admissionListsOf(token: unknown): string[] | undefined {
  if (typeof token !== 'string' || token.length > ADMISSION_TOKEN_MAX_CHARS) return undefined;
  const parts = token.split('.');
  if (parts.length !== 3 || !parts.every((p) => B64URL.test(p))) return undefined;
  try {
    const body: unknown = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'));
    if (body === null || typeof body !== 'object' || Array.isArray(body)) return undefined;
    return admissionListsOfClaim((body as { lst?: unknown }).lst);
  } catch {
    return undefined;
  }
}

/**
 * 입장 토큰을 확인하고 클레임을 돌려준다. 하나라도 어긋나면 AdmissionTokenRejected(reason)다. 머리의 jku·x5u·jwk·x5c 같은 키 출처는 읽지 않는다.
 * @param token 헤더 값(문자열이 아니거나 2048자를 넘으면 format)
 * @param o.nowMs 지금(epoch ms). exp는 정각부터 거절(지금 ≥ exp × 1000), iat는 지금 + 60초까지 받는다
 */
export function verifyAdmissionToken(token: unknown, o: { keys: AdmissionKeys; issuer: string; nowMs: number }): AdmissionClaims {
  if (typeof token !== 'string' || token.length > ADMISSION_TOKEN_MAX_CHARS) throw new AdmissionTokenRejected('format');
  const parts = token.split('.');
  if (parts.length !== 3) throw new AdmissionTokenRejected('format');
  const [h, p, s] = parts as [string, string, string];
  const hb = decodePart(h);
  const pb = decodePart(p);
  const sb = decodePart(s);
  if (!hb || !pb || !sb) throw new AdmissionTokenRejected('format');
  const header = jsonObject(hb);
  if (!header) throw new AdmissionTokenRejected('format');
  if (header.alg !== 'ES256') throw new AdmissionTokenRejected('alg');
  if (typeof header.kid !== 'string' || !KID.test(header.kid)) throw new AdmissionTokenRejected('kid');
  const key = o.keys.get(header.kid);
  if (!key) throw new AdmissionTokenRejected('kid');
  if (sb.length !== 64) throw new AdmissionTokenRejected('format');
  let ok = false;
  try {
    ok = verify('sha256', Buffer.from(`${h}.${p}`, 'utf8'), { key, dsaEncoding: 'ieee-p1363' }, sb);
  } catch {
    ok = false;
  }
  if (!ok) throw new AdmissionTokenRejected('signature');
  if (header.typ !== 'admission+jwt') throw new AdmissionTokenRejected('typ');
  const c = jsonObject(pb);
  if (!c) throw new AdmissionTokenRejected('format');
  if (c.iss !== o.issuer) throw new AdmissionTokenRejected('iss');
  if (c.aud !== 'purchase') throw new AdmissionTokenRejected('aud');
  const { iat, exp } = c;
  if (typeof iat !== 'number' || typeof exp !== 'number' || !Number.isInteger(iat) || !Number.isInteger(exp) || iat < 0 || exp <= iat || !Number.isSafeInteger(exp * 1000)) {
    throw new AdmissionTokenRejected('claims');
  }
  if (!isKeyPart(c.jti) || !isKeyPart(c.sub) || !isKeyPart(c.sid) || !isKeyPart(c.event)) throw new AdmissionTokenRejected('claims');
  if (typeof c.jny !== 'string' || !UUID_PATTERN.test(c.jny)) throw new AdmissionTokenRejected('claims');
  if (c.prio !== undefined && !isKeyPart(c.prio)) throw new AdmissionTokenRejected('claims');
  const lists = admissionListsOfClaim(c.lst);
  if (!lists) throw new AdmissionTokenRejected('claims');
  if (o.nowMs >= exp * 1000) throw new AdmissionTokenRejected('expired');
  if (iat * 1000 > o.nowMs + IAT_SKEW_MS) throw new AdmissionTokenRejected('not_yet');
  return {
    jti: c.jti,
    accountId: c.sub,
    loginSessionId: c.sid,
    eventId: c.event,
    journeyId: c.jny,
    issuedAtMs: iat * 1000,
    expiresAtMs: exp * 1000,
    ...(c.prio !== undefined ? { priorityGrantId: c.prio } : {}),
    ...(lists.length > 0 ? { lists } : {}),
  };
}

/**
 * 공개키 묶음(JWKS JSON)을 읽는다(환경 값 PEAKET_ADMISSION_JWKS). EC P-256 공개키만 받고 kid가 꼭 있어야 한다.
 * 개인 성분(d)이 섞이면 던진다(비밀이 설정 값에 잘못 들어간 것). 오류 문구에는 키 값을 싣지 않는다
 */
export function parseAdmissionJwks(raw: string): AdmissionKeys {
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    throw new Error('입장 토큰 공개키 묶음은 JWKS JSON이어야 한다');
  }
  const list = doc !== null && typeof doc === 'object' ? (doc as { keys?: unknown }).keys : undefined;
  if (!Array.isArray(list) || list.length === 0) throw new Error('입장 토큰 공개키 묶음에 keys가 없거나 비었다');
  const keys = new Map<string, KeyObject>();
  list.forEach((k: unknown, n: number) => {
    const at = `keys[${n}]`;
    if (k === null || typeof k !== 'object' || Array.isArray(k)) throw new Error(`입장 토큰 공개키 ${at}가 객체가 아니다`);
    const j = k as Record<string, unknown>;
    if ('d' in j) throw new Error(`입장 토큰 공개키 ${at}에 개인 성분(d)이 들어 있다. 공개 JWK만 넣는다`);
    if (j.kty !== 'EC' || j.crv !== 'P-256') throw new Error(`입장 토큰 공개키 ${at}는 EC P-256이어야 한다(ES256)`);
    if (typeof j.x !== 'string' || typeof j.y !== 'string') throw new Error(`입장 토큰 공개키 ${at}에 좌표(x·y)가 없다`);
    if (typeof j.kid !== 'string' || !KID.test(j.kid)) throw new Error(`입장 토큰 공개키 ${at}에 kid가 없거나 모양이 틀렸다`);
    if (j.use !== undefined && j.use !== 'sig') throw new Error(`입장 토큰 공개키 ${at}의 use는 sig여야 한다`);
    if (j.alg !== undefined && j.alg !== 'ES256') throw new Error(`입장 토큰 공개키 ${at}의 alg는 ES256이어야 한다`);
    if (keys.has(j.kid)) throw new Error(`입장 토큰 공개키 kid가 겹친다: ${at}`);
    try {
      keys.set(j.kid, createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: j.x, y: j.y }, format: 'jwk' }));
    } catch {
      throw new Error(`입장 토큰 공개키 ${at}의 좌표가 P-256 곡선 위의 점이 아니다`);
    }
  });
  return keys;
}
