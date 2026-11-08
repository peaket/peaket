// 닉네임 확인(openapi POST /v1/identity/nickname-checks, ADR-0203 결정 3, ADR-0235 결정 5, BUILD_ORDER BOT-047, I-T80).
// 참고용이다. 확정은 가입 마무리의 잠금과 409다. 세션마다 요청 한도를 둔다.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '@peaket/platform';
import { NICKNAME_CHECK_LIMITS, type NicknameCheckLimits, SESSION_SIGNALS, SESSION_STORE, type SessionSignals, type SessionStore } from '../domain/ports.js';
import { nicknameKey, nicknameProblem } from '../domain/signup.js';
import { requireLiveSession } from './get-account-summary.js';

/** 요청 한도에 걸렸다(429 Retry-After) */
export class NicknameCheckLimited extends Error {
  constructor(readonly retryAfterMs: number) {
    super('닉네임 확인 요청 한도');
    this.name = 'NicknameCheckLimited';
  }
}

export type NicknameCheckView = { available: true } | { available: false; reason: 'taken' | 'invalid' };

@Injectable()
export class CheckNickname {
  constructor(
    @Inject(SESSION_STORE) private readonly store: SessionStore,
    @Inject(NICKNAME_CHECK_LIMITS) private readonly limits: NicknameCheckLimits,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(SESSION_SIGNALS) private readonly signals: SessionSignals,
  ) {}

  /** @throws NicknameCheckLimited @throws AccountError SESSION_ENDED(끝난 세션은 요청 수를 쓰지 않는다) */
  async run(i: { accountId: string; sessionId: string; nickname: string }): Promise<NicknameCheckView> {
    const { sessionId } = await requireLiveSession(this.store, this.clock, i);
    const limit = await this.limits.allow(sessionId);
    if (!limit.allowed) {
      this.signals.nicknameCheckLimited();
      throw new NicknameCheckLimited(limit.retryAfterMs);
    }
    if (nicknameProblem(i.nickname) !== null) return { available: false, reason: 'invalid' };
    return (await this.store.nicknameKeyTaken(nicknameKey(i.nickname))) ? { available: false, reason: 'taken' } : { available: true };
  }
}
