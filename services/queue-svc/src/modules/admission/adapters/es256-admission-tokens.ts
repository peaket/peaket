// 입장 토큰 서명(ES256 JWT, docs/features/queue-admission.md §6 '입장 확정의 첫 구현', ADR-0050 결정 9, ADR-0183 결정 8).
// 머리 {alg ES256, typ admission+jwt, kid}, 클레임 iss·sub·aud purchase·jti·sid·event·jny·iat·exp(= iat + 최대 체류). 첫 사용 기한은 purchase-svc가 iat + 5분으로 본다.
// 서명은 Node 표준 암호 모듈로 한다(RFC 7515 그대로, 서명은 r‖s 64바이트). 키는 환경 값의 개인 JWK다(Secrets Manager → 시작 때 메모리, OPEN[10] 추천 적용).
// 키 교체(docs/features/queue-admission.md §6 '입장 토큰 공개키 묶음과 게이트웨이 확인', ADR-0288 결정 1·2): 키를 바꾸는 동안만 옛 키(공개 JWK, 검증만)와
// 그 끝 시각, 다음 키(공개 JWK)를 둔다. 공개키 묶음 jwks(지금 시각)는 지금 키·다음 키와, 지금 ≤ 끝 시각일 때만 옛 키(원소에 peaket_until, 초)를 준다.
import { createPrivateKey, createPublicKey, type KeyObject, sign } from 'node:crypto';
import type { AdmissionJwk, AdmissionTokens } from '../domain/ports.js';
import { MAX_STAY_MS } from '../domain/admission.js';

export const ADMISSION_TOKEN_KEY_ENV = 'PEAKET_ADMISSION_TOKEN_KEY';
/** 옛 키(공개 JWK, 검증만). 키를 바꾸는 동안만 둔다 */
export const ADMISSION_TOKEN_KEY_PREVIOUS_ENV = 'PEAKET_ADMISSION_TOKEN_KEY_PREVIOUS';
/** 옛 키의 끝 시각(ISO 8601, 초 단위: 밀리초가 0이어야 한다). 옛 키가 있으면 꼭 둔다 */
export const ADMISSION_TOKEN_KEY_PREVIOUS_UNTIL_ENV = 'PEAKET_ADMISSION_TOKEN_KEY_PREVIOUS_UNTIL';
/** 다음 키(공개 JWK). 서명하지 않고 묶음에만 싣는다(교체 차례 ①) */
export const ADMISSION_TOKEN_KEY_NEXT_ENV = 'PEAKET_ADMISSION_TOKEN_KEY_NEXT';
export const ADMISSION_TOKEN_ISSUER_ENV = 'PEAKET_ADMISSION_TOKEN_ISSUER';
/** 입장 확정 응답에 싣는 서버 ECDH 공개키(공개 JWK, 선택). 키를 만드는 것과 purchase-svc 쪽은 BOT-100 */
export const PURCHASE_ECDH_PUBLIC_JWK_ENV = 'PEAKET_PURCHASE_ECDH_PUBLIC_JWK';
/**
 * 옛 키 끝 시각의 상한(지금부터): 최대 체류 45분 + 1일 + 1시간 [가정](docs/features/queue-admission.md §6 '키 설정'.
 * 옛 키 검증 허용은 최대 체류 시각 + 1일까지이고, 1시간은 설정을 넣고 배포하는 데 드는 여유다)
 */
export const ADMISSION_PREVIOUS_UNTIL_MAX_MS = MAX_STAY_MS + 24 * 3_600_000 + 3_600_000;

const HTTPS = /^https:\/\/[^\s/]+/;
const KID = /^[A-Za-z0-9_.-]{1,64}$/;
/**
 * 끝 시각의 꼴: 날짜·시각(초까지)·선택 소수 초(적으면 0만)·시간대(Z나 ±hh:mm)가 다 있는 ISO 8601(BAT-057 리뷰 반영 R057-6·R057-9).
 * 칸마다 묶음으로 잡는다. 반복이 이웃하지 않아 되짚기가 없다
 */
const UNTIL_FORM = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.0{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))$/;

/**
 * 끝 시각(epoch ms)을 읽는다. 꼴이 아니거나, 읽은 시각에서 다시 만든 날짜·시각 칸(적은 시간대 차이를 되돌린 지역 칸)이 적은 값과 다르면
 * (달력에 없는 날 2월 30일·24시처럼 Date.parse가 다음 날로 넘긴 것) NaN이다(R057-9)
 */
function parseUntil(raw: string): number {
  const m = UNTIL_FORM.exec(raw);
  if (!m) return Number.NaN;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return Number.NaN;
  const offsetMin = m[7] ? (m[7] === '-' ? -1 : 1) * (Number(m[8]) * 60 + Number(m[9])) : 0;
  const local = new Date(ms + offsetMin * 60_000);
  const fields = [local.getUTCFullYear(), local.getUTCMonth() + 1, local.getUTCDate(), local.getUTCHours(), local.getUTCMinutes(), local.getUTCSeconds()];
  const written = [m[1], m[2], m[3], m[4], m[5], m[6]].map(Number);
  return fields.every((v, i) => v === written[i]) ? ms : Number.NaN;
}
const b64 = (v: object) => Buffer.from(JSON.stringify(v)).toString('base64url');
const seconds = (ms: number) => Math.floor(ms / 1000);

interface Jwk {
  kty?: string;
  crv?: string;
  x?: string;
  y?: string;
  d?: string;
  kid?: string;
}

function parseJwk(name: string, raw: string): Jwk {
  let j: Jwk;
  try {
    j = JSON.parse(raw) as Jwk;
  } catch {
    // 값은 오류 문구에 싣지 않는다
    throw new Error(`${name}는 JWK JSON이어야 한다`);
  }
  if (j === null || typeof j !== 'object' || j.kty !== 'EC' || j.crv !== 'P-256' || typeof j.x !== 'string' || typeof j.y !== 'string') throw new Error(`${name}는 P-256 JWK여야 한다(ES256)`);
  if (!j.kid || !KID.test(j.kid)) throw new Error(`${name}에 kid가 없거나 틀렸다(받는 쪽이 kid로 키를 고른다)`);
  return j;
}

/** 옛 키·다음 키는 공개 JWK만 받는다(개인 성분이 묶음·설정에 남지 않게) */
function parsePublicJwk(name: string, raw: string): Jwk {
  const j = parseJwk(name, raw);
  if ('d' in j) throw new Error(`${name}는 공개 JWK여야 한다(d를 빼고 넣는다)`);
  // 곡선 위의 점인지 읽어 본다(받는 쪽이 읽지 못하는 키를 묶음에 싣지 않게, BAT-057 리뷰 반영 R057-7). 값은 문구에 싣지 않는다
  try {
    createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: j.x!, y: j.y! }, format: 'jwk' });
  } catch {
    throw new Error(`${name}가 P-256 공개키로 읽히지 않는다(좌표가 곡선 위의 점이 아니다)`);
  }
  return j;
}

/** 묶음 원소(공개 부분만: kty·crv·x·y·kid·alg·use) */
const publicPart = (j: Jwk): AdmissionJwk => ({ kty: 'EC', crv: 'P-256', x: j.x!, y: j.y!, kid: j.kid!, alg: 'ES256', use: 'sig' });

export class Es256AdmissionTokens implements AdmissionTokens {
  readonly #key: KeyObject;
  readonly #kid: string;
  readonly #issuer: string;
  readonly #ecdh: Record<string, string> | undefined;
  readonly #current: AdmissionJwk;
  readonly #next: AdmissionJwk | undefined;
  readonly #previous: { jwk: AdmissionJwk; untilMs: number } | undefined;

  /**
   * previous·next는 공개 JWK다. 옛 키·다음 키에 d가 있거나, 세 kid가 겹치거나, 끝 시각의 밀리초가 0이 아니거나,
   * 끝 시각이 nowMs(없으면 지금) + ADMISSION_PREVIOUS_UNTIL_MAX_MS보다 뒤면 던진다(docs/features/queue-admission.md §6 '키 설정')
   */
  constructor(o: { jwk: Jwk; issuer: string; ecdhPublicJwk?: Jwk; previous?: { jwk: Jwk; untilMs: number }; next?: Jwk; nowMs?: number }) {
    if (!HTTPS.test(o.issuer)) throw new Error('입장 토큰 발급자(iss)는 https 주소다');
    if (typeof o.jwk.d !== 'string') throw new Error(`${ADMISSION_TOKEN_KEY_ENV}는 개인 JWK여야 한다(서명에 쓴다)`);
    this.#key = createPrivateKey({ key: { kty: 'EC', crv: 'P-256', x: o.jwk.x, y: o.jwk.y, d: o.jwk.d }, format: 'jwk' });
    this.#kid = o.jwk.kid!;
    this.#issuer = o.issuer;
    const e = o.ecdhPublicJwk;
    this.#ecdh = e ? { kty: 'EC', crv: 'P-256', x: e.x!, y: e.y!, kid: e.kid! } : undefined;
    this.#current = publicPart(o.jwk);
    if (o.next && 'd' in o.next) throw new Error(`${ADMISSION_TOKEN_KEY_NEXT_ENV}는 공개 JWK여야 한다(d를 빼고 넣는다)`);
    if (o.previous && 'd' in o.previous.jwk) throw new Error(`${ADMISSION_TOKEN_KEY_PREVIOUS_ENV}는 공개 JWK여야 한다(d를 빼고 넣는다)`);
    const kids = [o.jwk.kid, o.previous?.jwk.kid, o.next?.kid].filter((k): k is string => k !== undefined);
    if (new Set(kids).size !== kids.length) throw new Error('입장 토큰 키의 kid가 겹친다(지금·옛·다음 키마다 달라야 한다)');
    if (o.previous) {
      const { untilMs } = o.previous;
      if (!Number.isSafeInteger(untilMs) || untilMs % 1000 !== 0) throw new Error(`${ADMISSION_TOKEN_KEY_PREVIOUS_UNTIL_ENV}는 초 단위 시각이어야 한다(밀리초가 0)`);
      if (untilMs > (o.nowMs ?? Date.now()) + ADMISSION_PREVIOUS_UNTIL_MAX_MS) throw new Error(`${ADMISSION_TOKEN_KEY_PREVIOUS_UNTIL_ENV}가 너무 뒤다(지금 + 최대 체류 + 1일 + 1시간까지)`);
      this.#previous = { jwk: publicPart(o.previous.jwk), untilMs };
    }
    this.#next = o.next ? publicPart(o.next) : undefined;
  }

  /** 환경 값에서 만든다. nowMs는 옛 키 끝 시각의 상한을 재는 지금(없으면 Date.now()). 시작 검사에 걸리면 던진다(값은 문구에 싣지 않는다) */
  static fromEnv(env: Record<string, string | undefined>, nowMs: number = Date.now()): Es256AdmissionTokens {
    const raw = env[ADMISSION_TOKEN_KEY_ENV];
    if (!raw) throw new Error(`${ADMISSION_TOKEN_KEY_ENV}가 없다(입장 토큰 서명 개인 JWK, 비밀 관리에서 넣는다)`);
    const issuer = env[ADMISSION_TOKEN_ISSUER_ENV];
    if (!issuer) throw new Error(`${ADMISSION_TOKEN_ISSUER_ENV}가 없다(입장 토큰 발급자 iss, https 주소)`);
    const ecdhRaw = env[PURCHASE_ECDH_PUBLIC_JWK_ENV];
    let ecdhPublicJwk: Jwk | undefined;
    if (ecdhRaw) {
      ecdhPublicJwk = parseJwk(PURCHASE_ECDH_PUBLIC_JWK_ENV, ecdhRaw);
      // 응답으로 내보내는 값이라 개인 성분이 섞이면 시작하지 않는다
      if ('d' in ecdhPublicJwk) throw new Error(`${PURCHASE_ECDH_PUBLIC_JWK_ENV}는 공개 JWK여야 한다(d를 빼고 넣는다)`);
    }
    const prevRaw = env[ADMISSION_TOKEN_KEY_PREVIOUS_ENV];
    const untilRaw = env[ADMISSION_TOKEN_KEY_PREVIOUS_UNTIL_ENV];
    let previous: { jwk: Jwk; untilMs: number } | undefined;
    if (prevRaw) {
      const jwk = parsePublicJwk(ADMISSION_TOKEN_KEY_PREVIOUS_ENV, prevRaw);
      const untilMs = untilRaw ? parseUntil(untilRaw) : Number.NaN;
      if (!Number.isFinite(untilMs)) throw new Error(`${ADMISSION_TOKEN_KEY_PREVIOUS_UNTIL_ENV}가 없거나 틀렸다(옛 키 검증 허용 끝 시각, 시간대가 있는 ISO 8601 초 단위, 예 2026-11-20T10:00:00Z·2026-11-20T19:00:00+09:00)`);
      previous = { jwk, untilMs };
    } else if (untilRaw) {
      throw new Error(`${ADMISSION_TOKEN_KEY_PREVIOUS_UNTIL_ENV}만 있고 ${ADMISSION_TOKEN_KEY_PREVIOUS_ENV}가 없다`);
    }
    const nextRaw = env[ADMISSION_TOKEN_KEY_NEXT_ENV];
    const next = nextRaw ? parsePublicJwk(ADMISSION_TOKEN_KEY_NEXT_ENV, nextRaw) : undefined;
    return new Es256AdmissionTokens({
      jwk: parseJwk(ADMISSION_TOKEN_KEY_ENV, raw),
      issuer,
      ...(ecdhPublicJwk ? { ecdhPublicJwk } : {}),
      ...(previous ? { previous } : {}),
      ...(next ? { next } : {}),
      nowMs,
    });
  }

  sign(c: {
    jti: string;
    accountId: string;
    sessionId: string;
    eventId: string;
    jny: string;
    nowMs: number;
    firstIssuedAtMs?: number;
    lists?: string[];
    priorityGrantId?: string;
  }): { token: string; expiresAtMs: number } {
    const iat = seconds(c.nowMs);
    // 같은 jti를 다시 줄 때도 만료는 첫 발급 + 최대 체류다(purchase-svc는 첫 토큰의 만료로 구매 세션을 연다, HOT-010 리뷰)
    const exp = seconds(Math.min(c.firstIssuedAtMs ?? c.nowMs, c.nowMs)) + seconds(MAX_STAY_MS);
    const head = b64({ alg: 'ES256', typ: 'admission+jwt', kid: this.#kid });
    // lst는 그 계정이 든 판매 자격 명단 키다(글자 차례, 1~10개). prio는 우선 구매 권리 ID다. 없으면 클레임을 넣지 않는다(ADR-0265 결정 7, ADR-0171)
    const body = b64({
      iss: this.#issuer,
      sub: c.accountId,
      aud: 'purchase',
      jti: c.jti,
      sid: c.sessionId,
      event: c.eventId,
      jny: c.jny,
      ...(c.lists && c.lists.length > 0 ? { lst: c.lists } : {}),
      ...(c.priorityGrantId !== undefined ? { prio: c.priorityGrantId } : {}),
      iat,
      exp,
    });
    const signed = `${head}.${body}`;
    const sig = sign('sha256', Buffer.from(signed), { key: this.#key, dsaEncoding: 'ieee-p1363' });
    return { token: `${signed}.${sig.toString('base64url')}`, expiresAtMs: exp * 1000 };
  }

  serverEcdhPublicKey(): Record<string, string> | undefined {
    return this.#ecdh ? { ...this.#ecdh } : undefined;
  }

  /** 공개키 묶음: 지금 키, 다음 키, 그리고 nowMs ≤ 끝 시각일 때만 옛 키(peaket_until = 끝 시각의 초). 끝 시각 + 1ms부터 옛 키를 뺀다 */
  jwks(nowMs: number): { keys: AdmissionJwk[] } {
    const p = this.#previous;
    return {
      keys: [{ ...this.#current }, ...(this.#next ? [{ ...this.#next }] : []), ...(p && nowMs <= p.untilMs ? [{ ...p.jwk, peaket_until: p.untilMs / 1000 }] : [])],
    };
  }
}
