// 본인확인 시험 어댑터(docs/features/identity.md §5 '본인확인 시험 어댑터와 첫 구현'). 실제 기관 없이 결과를 정한다. local·ci·demo 전용.
// - 기관 창 값: 소비자 웹 복귀 주소(<웹 출처>/verify/return)에 건 ID만 실어 보낸다(모의 기관 화면은 BUILD_ORDER BOT-010)
// - 결과 값에 건 ID가 있으면 그 건의 결과인지 본다(다른 건의 결과 값을 넣으면 FAILED)
// - 결과 값의 testPerson(시험 사람 이름표)으로 연계정보를 만든다: 같은 이름표 = 같은 사람. outcome이 CANCELLED·FAILED면 그 결과
import { createHmac } from 'node:crypto';
import type { VerificationProvider } from '../domain/ports.js';

export const VERIFICATION_PROVIDER_ENV = 'PEAKET_VERIFICATION_PROVIDER';
export const TEST_VERIFICATION_SECRET_ENV = 'PEAKET_TEST_VERIFICATION_SECRET';
const ALLOWED_ENVS = ['local', 'ci', 'demo'];

export class TestVerificationProvider implements VerificationProvider {
  readonly #secret: Buffer;
  readonly #returnUrl: string;

  /** webOrigin: 소비자 웹 출처(복귀 주소의 앞). 기관 창 값의 url은 절대 주소다(openapi VerificationStart.window.url) */
  constructor(secret: Buffer, webOrigin: string) {
    if (secret.length < 16) throw new Error('시험 기관 비밀은 16바이트 이상이다');
    this.#secret = Buffer.from(secret);
    this.#returnUrl = new URL('/verify/return', webOrigin).toString();
  }

  /** 시험 어댑터는 local·ci·demo에서만 켠다(운영 쪽 환경에서 켜면 시작하지 않는다) */
  static fromEnv(env: Record<string, string | undefined>): TestVerificationProvider {
    const peaketEnv = env.PEAKET_ENV ?? 'prod';
    if (env[VERIFICATION_PROVIDER_ENV] !== 'test') throw new Error(`${VERIFICATION_PROVIDER_ENV}=test만 있다(실제 기관 연동은 계약 뒤, identity §13)`);
    if (!ALLOWED_ENVS.includes(peaketEnv)) throw new Error(`본인확인 시험 어댑터는 ${ALLOWED_ENVS.join('·')}에서만 켠다(지금 ${peaketEnv})`);
    const raw = env[TEST_VERIFICATION_SECRET_ENV];
    const origin = env.PEAKET_WEB_ORIGIN;
    if (!origin) throw new Error('PEAKET_WEB_ORIGIN이 없다(시험 기관의 복귀 주소 앞, 소비자 웹 출처)');
    return new TestVerificationProvider(raw ? Buffer.from(raw, 'base64') : Buffer.from('peaket-test-verification-secret-v1'), origin);
  }

  window(attemptId: string) {
    return { url: this.#returnUrl, method: 'POST' as const, fields: { verificationId: attemptId }, mode: 'POPUP' as const };
  }

  async confirm(attemptId: string, r: Record<string, string>): ReturnType<VerificationProvider['confirm']> {
    if (r.verificationId !== undefined && r.verificationId !== attemptId) return { outcome: 'FAILED' };
    if (r.outcome === 'CANCELLED' || r.outcome === 'FAILED') return { outcome: r.outcome };
    const person = r.testPerson;
    if (typeof person !== 'string' || person.length === 0 || person.length > 64) return { outcome: 'FAILED' as const };
    // 실제 연계정보처럼 88자 base64 값으로 만든다(64바이트)
    return { outcome: 'VERIFIED' as const, ci: createHmac('sha512', this.#secret).update(`ci:${person}`).digest().toString('base64') };
  }
}
