// 최초 방문 쿠키 읽기(docs/features/queue-admission.md §10 '보안 토큰 및 키', docs/security/secrets-and-keys.md, ADR-0065 결정 9, ADR-0249 결정 2).
// 쿠키 값: v1.{kid}.{발급 시각 밀리초}.{요청 ID base64url}.{MAC base64url}
// MAC = HMAC-SHA256(키 글자, "PEAKET-firstvisit-v1." ‖ 앞의 네 칸을 점으로 이은 글). 키는 base64url 글자를 그대로 HMAC 키로 쓴다(엣지 함수와 같다).
// 형식 버전 v1이 알고리즘을 정하고, MAC을 상수 시간으로 견준 뒤에만 칸을 읽는다(ASVS v5.0.0-9.1.1).
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FirstVisitClaims, FirstVisitCookies } from '../domain/ports.js';

/** 쉼표로 이은 {kid}:{키 글자}. 키는 90일마다 바꾸지만 옛 쿠키의 수명은 1년 [가정]이라 옛 kid를 함께 넣는다 */
export const FIRST_VISIT_COOKIE_KEYS_ENV = 'PEAKET_FIRST_VISIT_COOKIE_KEYS';
const VERSION = 'v1';
const KIND = 'PEAKET-firstvisit-v1';
const KID = /^[A-Za-z0-9_-]{1,32}$/;
const NUMBER = /^\d{1,15}$/;
const B64URL = /^[A-Za-z0-9_-]+$/;
const MIN_KEY_BYTES = 32;
/** 옛 kid까지 받는 키 수의 상한 [가정](1년 ÷ 90일 = 약 4개에 여유) */
const MAX_KEYS = 6;
const MAX_VALUE_LENGTH = 1024;

export interface FirstVisitKey {
  kid: string;
  /** 서명 키 글자(base64url, 엣지 저장소 fv:key:{kid}와 같은 값) */
  key: string;
}

function parseKeys(value: string): FirstVisitKey[] {
  const pieces = value.split(',').map((p) => p.trim()).filter(Boolean);
  if (pieces.length > MAX_KEYS) throw new Error(`${FIRST_VISIT_COOKIE_KEYS_ENV}는 ${MAX_KEYS}개까지다`);
  return pieces.map((piece) => {
    const at = piece.indexOf(':');
    const kid = at > 0 ? piece.slice(0, at) : '';
    if (!KID.test(kid)) throw new Error(`${FIRST_VISIT_COOKIE_KEYS_ENV}의 kid가 틀렸다(영문·숫자·_- 1~32자 뒤에 ':'와 키 글자)`);
    const key = piece.slice(at + 1);
    // 값은 오류 문구에 싣지 않는다
    if (Buffer.from(key, 'base64url').length < MIN_KEY_BYTES) throw new Error(`${FIRST_VISIT_COOKIE_KEYS_ENV}의 키는 ${MIN_KEY_BYTES}바이트 이상이어야 한다`);
    return { kid, key };
  });
}

export class HmacFirstVisitCookies implements FirstVisitCookies {
  readonly #keys = new Map<string, Buffer>();

  constructor(keys: readonly FirstVisitKey[]) {
    for (const k of keys) this.#keys.set(k.kid, Buffer.from(k.key, 'utf8'));
  }

  /**
   * 환경 값에서 키를 읽는다. 없거나 틀리면 어느 환경이든 null이고 warn으로 알린다(그 기능만 끄고 시작은 막지 않는다. 값 있음은 배포 검사가 막는다, ADR-0249).
   * 경고 문구에 키 값을 싣지 않는다
   */
  static fromEnv(env: Record<string, string | undefined>, warn: (message: string) => void): HmacFirstVisitCookies | null {
    const raw = env[FIRST_VISIT_COOKIE_KEYS_ENV];
    if (!raw) {
      warn(`${FIRST_VISIT_COOKIE_KEYS_ENV}가 없어 쿠키 나이 신호를 쓰지 않는다`);
      return null;
    }
    try {
      return new HmacFirstVisitCookies(parseKeys(raw));
    } catch (err) {
      warn(`${err instanceof Error ? err.message : FIRST_VISIT_COOKIE_KEYS_ENV}: 쿠키 나이 신호를 쓰지 않는다`);
      return null;
    }
  }

  read(value: string): FirstVisitClaims | null {
    if (typeof value !== 'string' || value.length > MAX_VALUE_LENGTH) return null;
    const parts = value.split('.');
    if (parts.length !== 5 || parts[0] !== VERSION) return null;
    const [, kid, t, rid, mac] = parts as [string, string, string, string, string];
    const key = this.#keys.get(kid);
    if (!key || !B64URL.test(mac)) return null;
    const want = createHmac('sha256', key).update(`${KIND}.${VERSION}.${kid}.${t}.${rid}`).digest();
    const got = Buffer.from(mac, 'base64url');
    if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
    // 같은 바이트로 읽히는 다른 글자(끝 글자의 쓰지 않는 비트)는 받지 않는다
    if (got.toString('base64url') !== mac) return null;
    if (!NUMBER.test(t) || !B64URL.test(rid)) return null;
    return { kid, issuedAtMs: Number(t) };
  }
}
