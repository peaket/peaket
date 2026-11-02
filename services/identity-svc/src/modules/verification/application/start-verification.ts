// 본인확인 시작(openapi POST /v1/identity/verifications, docs/features/identity.md §5): 건을 만들고 기관 창 값을 준다.
// next는 safeNext() 규칙(docs/frontend.md §5.14, ASVS v5.0.0-3.7.2)으로 서버도 거절한다.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock, uuidv7 } from '@peaket/platform';
import { VERIFICATION_PROVIDER, VERIFICATION_STORE, type VerificationProvider, type VerificationStore } from '../domain/ports.js';
import { ATTEMPT_TTL_MS, ProviderUnavailable, type Purpose } from '../domain/verification.js';
import { VerificationError } from './verification-error.js';

/** safeNext(): 512자 이하, /로 시작, //·/\로 시작하지 않음, 제어 문자·백슬래시·%2f%2f·%5c 없음 */
export function safeNextPath(v: string): boolean {
  return v.length > 0 && v.length <= 512 && v.startsWith('/') && !v.startsWith('//') && !/[\u0000-\u001f\u007f\\]/.test(v) && !/%2f%2f|%5c/i.test(v);
}

@Injectable()
export class StartVerification {
  constructor(
    @Inject(VERIFICATION_STORE) private readonly store: VerificationStore,
    @Inject(VERIFICATION_PROVIDER) private readonly provider: VerificationProvider,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async run(i: { accountId: string; purpose: Purpose; next: string }) {
    if (!safeNextPath(i.next)) throw new VerificationError('NEXT_INVALID', 'next는 같은 출처 경로만 받는다');
    // 미성년자 계약 취소 확인(동의 → 대조 → 만 나이 → resultToken)은 그 단계가 붙인다. 그 전에는 받지 않는다(identity §5)
    if (i.purpose === 'MINOR_CONTRACT') throw new VerificationError('PURPOSE_UNSUPPORTED', '이 목적은 아직 받지 않는다');
    if (i.purpose === 'FIRST' && (await this.store.isVerified(i.accountId))) throw new VerificationError('ALREADY_VERIFIED', '이미 본인확인한 계정이다');
    const now = this.clock.now();
    const id = uuidv7(this.clock);
    const expiresAt = now + ATTEMPT_TTL_MS;
    // 기관 창 값을 먼저 만든다(기관이 없으면 건을 남기지 않고 503)
    let window: ReturnType<VerificationProvider['window']>;
    try {
      window = this.provider.window(id);
    } catch (e) {
      if (e instanceof ProviderUnavailable) throw new VerificationError('PROVIDER_DOWN', '본인확인기관을 쓸 수 없다');
      throw e;
    }
    await this.store.transaction((tx) => tx.insertAttempt({ id, accountId: i.accountId, purpose: i.purpose, next: i.next, status: 'PENDING', expiresAt, createdAt: now, completedAt: null }));
    return { verificationId: id, window, expiresAt };
  }
}
