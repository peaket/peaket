// 만 14세 미만 가입 취소(openapi POST /v1/identity/signup-cancellations, ADR-0203 결정 4, ADR-0235 결정 6, BUILD_ORDER BOT-047, I-T81).
// 가입 전 계정만 받는다. 정리 사유 UNDER_14로 표시하고 그 계정의 세션을 모두 끝낸다(DELETE). 뒤의 정리는 정비 withdrawal-finish가 한다.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '@peaket/platform';
import { SESSION_SIGNALS, SESSION_STORE, type SessionSignals, type SessionStore } from '../domain/ports.js';
import { signupCompleted } from '../domain/signup.js';
import { AccountError } from './account-error.js';
import { requireLiveSession } from './get-account-summary.js';

@Injectable()
export class CancelSignup {
  constructor(
    @Inject(SESSION_STORE) private readonly store: SessionStore,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(SESSION_SIGNALS) private readonly signals: SessionSignals,
  ) {}

  /** @throws AccountError SESSION_ENDED·ALREADY_COMPLETED */
  async run(i: { accountId: string; sessionId: string }): Promise<void> {
    const { accountId } = await requireLiveSession(this.store, this.clock, i);
    const now = this.clock.now();
    const ended = await this.store.transaction(async (tx) => {
      await tx.lockAccount(accountId);
      const state = await tx.signupStateOf(accountId);
      if (!state || state.status === 'DELETED' || state.status === 'MERGED') throw new AccountError('SESSION_ENDED', '끝난 계정이다');
      if (signupCompleted(state.ageVerified, state.consentKinds)) throw new AccountError('ALREADY_COMPLETED', '가입을 이미 마쳤다');
      await tx.markClosure(accountId, 'UNDER_14', now);
      const open = await tx.unterminatedSessions(accountId);
      await tx.terminateSessions(open, 'DELETE', now);
      return open.length;
    });
    this.signals.terminated('DELETE', ended);
  }
}
