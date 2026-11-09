// 본인확인 시험 어댑터(docs/features/identity.md §5 '본인확인 시험 어댑터와 첫 구현'·'모의 기관과 기관 창 흐름'). 실제 기관 없이 결과를 정한다. local·ci·demo 전용.
// - 기관 창 값: 모의 기관 주소(PEAKET_TEST_VERIFICATION_URL)에 건 ID만 실어 보낸다. 돌아올 주소는 모의 기관이 시작할 때 받는다(기관에 등록하는 것과 같다)
// - 결과 값은 모의 기관이 시험 기관 비밀로 서명한 것만 믿는다(test-agency.ts). 서명·건 ID·만든 시각(10분 [가정])이 틀리면 FAILED
// - 서명한 결과의 이름표로 연계정보를 만든다: 같은 이름표 = 같은 사람. 결과가 DOWN이면 기관 장애(503 PROVIDER_DOWN)
import { createHmac } from 'node:crypto';
import { type Clock, systemClock } from '@peaket/platform';
import type { VerificationProvider } from '../domain/ports.js';
import { ProviderUnavailable } from '../domain/verification.js';
import { openTestAgencyResult } from './test-agency.js';

export const VERIFICATION_PROVIDER_ENV = 'PEAKET_VERIFICATION_PROVIDER';
export const TEST_VERIFICATION_SECRET_ENV = 'PEAKET_TEST_VERIFICATION_SECRET';
export const TEST_VERIFICATION_URL_ENV = 'PEAKET_TEST_VERIFICATION_URL';
export const TEST_VERIFICATION_MODE_ENV = 'PEAKET_TEST_VERIFICATION_MODE';
/** 비밀을 주지 않았을 때 쓰는 개발용 값(모의 기관 scripts/mock-idv.mjs와 같다) */
export const DEV_TEST_VERIFICATION_SECRET = 'peaket-test-verification-secret-v1';

/**
 * 설정의 시험 기관 비밀(base64)을 푼다. base64가 아닌 글자가 있으면 던진다: Buffer.from(…, 'base64')는 틀린 글자를 건너뛰어 빈 키·잘린 키가 된다(BOT-010이 넘긴 것).
 * 채움(=)은 없어도 된다. 길이(16바이트 이상)는 생성자가 본다. 모의 기관(scripts/mock-idv.mjs secretFromEnv)과 같은 규칙이다
 */
export function decodeTestSecret(raw: string): Buffer {
  const key = Buffer.from(raw, 'base64');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw) || key.toString('base64').replace(/=+$/, '') !== raw.replace(/=+$/, '')) throw new Error(`${TEST_VERIFICATION_SECRET_ENV}는 base64여야 한다`);
  return key;
}
const ALLOWED_ENVS = ['local', 'ci', 'demo'];
const MODES = ['POPUP', 'REDIRECT'] as const;
type Mode = (typeof MODES)[number];

/** 결과 값을 만든 뒤 믿는 시간 10분 [가정](본인확인 건이 결과를 받는 시간과 같다), 앞선 시각은 1분 [가정]까지 받는다 */
export const TEST_RESULT_TTL_MS = 10 * 60_000;
const FUTURE_SKEW_MS = 60_000;
const MAX_PERSON = 64;

export interface TestVerificationOptions {
  /** 시험 기관 비밀(16바이트 이상, 모의 기관과 같은 값) */
  secret: Uint8Array;
  /** 모의 기관 주소(절대 주소, http·https) */
  agencyUrl: string;
  /** 기관 창 방식. REDIRECT는 페이지 이동 방식 기관(모바일·일부 브라우저)을 흉내 낸다 */
  mode?: Mode;
  clock?: Clock;
}

export class TestVerificationProvider implements VerificationProvider {
  readonly #secret: Buffer;
  readonly #agencyUrl: string;
  readonly #mode: Mode;
  readonly #clock: Clock;

  constructor(o: TestVerificationOptions) {
    if (o.secret.length < 16) throw new Error('시험 기관 비밀은 16바이트 이상이다');
    const url = new URL(o.agencyUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`모의 기관 주소는 http·https만 받는다: ${o.agencyUrl}`);
    this.#secret = Buffer.from(o.secret);
    this.#agencyUrl = url.toString();
    this.#mode = o.mode ?? 'POPUP';
    this.#clock = o.clock ?? systemClock;
  }

  /** 시험 어댑터는 local·ci·demo에서만 켠다(운영 쪽 환경에서 켜면 시작하지 않는다) */
  static fromEnv(env: Record<string, string | undefined>, clock: Clock = systemClock): TestVerificationProvider {
    const peaketEnv = env.PEAKET_ENV ?? 'prod';
    if (env[VERIFICATION_PROVIDER_ENV] !== 'test') throw new Error(`${VERIFICATION_PROVIDER_ENV}=test만 있다(실제 기관 연동은 계약 뒤, identity §13)`);
    if (!ALLOWED_ENVS.includes(peaketEnv)) throw new Error(`본인확인 시험 어댑터는 ${ALLOWED_ENVS.join('·')}에서만 켠다(지금 ${peaketEnv})`);
    const agencyUrl = env[TEST_VERIFICATION_URL_ENV];
    if (!agencyUrl) throw new Error(`${TEST_VERIFICATION_URL_ENV}가 없다(모의 기관 주소, services/identity-svc/scripts/mock-idv.mjs)`);
    const mode = env[TEST_VERIFICATION_MODE_ENV] ?? 'POPUP';
    if (!(MODES as readonly string[]).includes(mode)) throw new Error(`${TEST_VERIFICATION_MODE_ENV}는 ${MODES.join('·')}만 받는다: ${mode}`);
    const raw = env[TEST_VERIFICATION_SECRET_ENV];
    // 개발용 값은 공개 저장소에 있어 누구나 결과 값을 서명할 수 있다. 바깥에서 닿는 demo에서는 쓰지 않는다
    if (!raw && peaketEnv === 'demo') throw new Error(`demo에서는 ${TEST_VERIFICATION_SECRET_ENV}가 있어야 한다(개발용 값을 쓰지 않는다)`);
    return new TestVerificationProvider({ secret: raw ? decodeTestSecret(raw) : Buffer.from(DEV_TEST_VERIFICATION_SECRET), agencyUrl, mode: mode as Mode, clock });
  }

  window(attemptId: string) {
    return { url: this.#agencyUrl, method: 'POST' as const, fields: { verificationId: attemptId }, mode: this.#mode };
  }

  async confirm(attemptId: string, r: Record<string, string>): ReturnType<VerificationProvider['confirm']> {
    if (r.verificationId !== attemptId) return { outcome: 'FAILED' };
    const body = openTestAgencyResult(this.#secret, r);
    if (!body || body.tx !== attemptId) return { outcome: 'FAILED' };
    const age = this.#clock.now() - body.iat;
    if (age > TEST_RESULT_TTL_MS || age < -FUTURE_SKEW_MS) return { outcome: 'FAILED' };
    if (body.outcome === 'DOWN') throw new ProviderUnavailable();
    if (body.outcome === 'CANCELLED' || body.outcome === 'FAILED') return { outcome: body.outcome };
    const person = body.person;
    if (typeof person !== 'string' || person.length === 0 || person.length > MAX_PERSON) return { outcome: 'FAILED' };
    // 실제 연계정보처럼 88자 base64 값으로 만든다(64바이트)
    const ci = createHmac('sha512', this.#secret).update(`ci:${person}`).digest().toString('base64');
    // 생년월일은 유스케이스가 만 나이 계산에만 쓴다(BUILD_ORDER BOT-020). 없으면 싣지 않고, 유스케이스가 FAILED로 본다
    // 휴대폰 번호는 연락처 가명 계산에만 쓴다(BUILD_ORDER BOT-045)
    return { outcome: 'VERIFIED', ci, ...(body.birth === undefined ? {} : { birthDate: body.birth }), ...(body.phone === undefined ? {} : { phone: body.phone }) };
  }
}
