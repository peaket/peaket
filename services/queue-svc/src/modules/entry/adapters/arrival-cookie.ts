// 도착 시각 쿠키 읽기(docs/features/queue-admission.md §4 HOT-020 절, §10 '보안 토큰 및 키', ADR-0053 결정 2, ADR-0223 결정 2·3).
// 쿠키 값: v1.{kid}.{회차 ID}.{도착 시각 밀리초}.{요청 ID base64url}.{sid}.{MAC base64url}
// MAC = HMAC-SHA256(키 글자, "PEAKET-arrival-v1." ‖ 앞의 여섯 칸을 점으로 이은 글). 키는 base64url 글자를 그대로 HMAC 키로 쓴다(엣지 함수와 같다).
// 만료·회차·sid는 부르는 쪽(EnterQueue)이 본다. 형식 버전 v1이 알고리즘을 정하고, MAC을 상수 시간으로 견준 뒤에만 칸을 읽는다(ASVS v5.0.0-9.1.1).
import { createHmac, timingSafeEqual } from 'node:crypto';
import { PlatformConfigError } from '@peaket/platform';
import type { ArrivalClaims, ArrivalCookies } from '../domain/ports.js';

export const ARRIVAL_COOKIE_KEY_ENV = 'PEAKET_ARRIVAL_COOKIE_KEY';
export const ARRIVAL_COOKIE_KEY_PREVIOUS_ENV = 'PEAKET_ARRIVAL_COOKIE_KEY_PREVIOUS';
const VERSION = 'v1';
const KIND = 'PEAKET-arrival-v1';
const KID = /^[A-Za-z0-9_-]{1,32}$/;
const KEY_PART = /^[A-Za-z0-9_-]{1,64}$/;
const NUMBER = /^\d{1,15}$/;
const B64URL = /^[A-Za-z0-9_-]+$/;
const MIN_KEY_BYTES = 32;

export interface ArrivalKey {
  kid: string;
  /** 서명 키 글자(base64url, 엣지 저장소 arr:key:{kid}와 같은 값) */
  key: string;
}

function parseKey(name: string, value: string): ArrivalKey {
  const at = value.indexOf(':');
  const kid = at > 0 ? value.slice(0, at) : '';
  if (!KID.test(kid)) throw new Error(`${name}의 kid가 틀렸다(영문·숫자·_- 1~32자 뒤에 ':'와 키 글자)`);
  const key = value.slice(at + 1);
  // 값은 오류 문구에 싣지 않는다
  if (Buffer.from(key, 'base64url').length < MIN_KEY_BYTES) throw new Error(`${name}의 키는 ${MIN_KEY_BYTES}바이트 이상이어야 한다`);
  return { kid, key };
}

export class HmacArrivalCookies implements ArrivalCookies {
  readonly #keys = new Map<string, Buffer>();

  constructor(keys: readonly ArrivalKey[]) {
    for (const k of keys) this.#keys.set(k.kid, Buffer.from(k.key, 'utf8'));
  }

  /** 환경 값에서 키를 읽는다. 없으면 개발 환경은 null(쿠키를 읽지 않는다, 일반 진입뿐이다)이고 운영 환경(staging·prod)은 시작에 실패한다 */
  static fromEnv(env: Record<string, string | undefined>): HmacArrivalCookies | null {
    const cur = env[ARRIVAL_COOKIE_KEY_ENV];
    if (!cur) {
      if (env.PEAKET_ENV === 'staging' || env.PEAKET_ENV === 'prod') throw new PlatformConfigError(`${ARRIVAL_COOKIE_KEY_ENV}가 없다(도착 시각 쿠키 서명 키, 비밀 관리에서 넣는다)`);
      return null;
    }
    const keys = [parseKey(ARRIVAL_COOKIE_KEY_ENV, cur)];
    const prev = env[ARRIVAL_COOKIE_KEY_PREVIOUS_ENV];
    if (prev) keys.push(parseKey(ARRIVAL_COOKIE_KEY_PREVIOUS_ENV, prev));
    return new HmacArrivalCookies(keys);
  }

  read(value: string): ArrivalClaims | null {
    if (typeof value !== 'string' || value.length > 1024) return null;
    const parts = value.split('.');
    if (parts.length !== 7 || parts[0] !== VERSION) return null;
    const [, kid, e, t, rid64, sid, mac] = parts as [string, string, string, string, string, string, string];
    const key = this.#keys.get(kid);
    if (!key || !B64URL.test(mac)) return null;
    const want = createHmac('sha256', key).update(`${KIND}.${VERSION}.${kid}.${e}.${t}.${rid64}.${sid}`).digest();
    const got = Buffer.from(mac, 'base64url');
    if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
    // 같은 바이트로 읽히는 다른 글자(끝 글자의 쓰지 않는 비트)는 받지 않는다
    if (got.toString('base64url') !== mac) return null;
    if (!KEY_PART.test(e) || !KEY_PART.test(sid) || !NUMBER.test(t) || !B64URL.test(rid64)) return null;
    const rid = Buffer.from(rid64, 'base64url').toString('utf8');
    if (rid.length === 0 || rid.length > 128) return null;
    return { kid, e, t: Number(t), rid, sid };
  }
}
