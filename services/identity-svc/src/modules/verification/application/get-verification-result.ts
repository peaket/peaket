// 본인확인 결과 조회(openapi GET /v1/identity/verifications/{verificationId}/result). 처리 중이면 PENDING, 개인정보는 싣지 않는다.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '@peaket/platform';
import { VERIFICATION_STORE, type VerificationStore } from '../domain/ports.js';
import { isAttemptId, visible } from '../domain/verification.js';
import { restrictedUntilFor, type VerificationResultView, viewOf } from './confirm-verification.js';
import { VerificationError } from './verification-error.js';

@Injectable()
export class GetVerificationResult {
  constructor(
    @Inject(VERIFICATION_STORE) private readonly store: VerificationStore,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async run(i: { accountId: string; verificationId: string }): Promise<VerificationResultView> {
    const a = isAttemptId(i.verificationId) ? await this.store.attempt(i.verificationId) : null;
    const now = this.clock.now();
    if (!a || !visible(a, i.accountId, now)) throw new VerificationError('NOT_FOUND', '없는 건이거나 만료됐거나 다른 계정의 건이다');
    return viewOf(a, await restrictedUntilFor(this.store, a, now));
  }
}
