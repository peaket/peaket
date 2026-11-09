// 팬 계정 요약(openapi GET /v1/identity/me, FanAccountSummary, ADR-0202 결정 1, ADR-0235 결정 3, BUILD_ORDER BOT-047, I-T77).
// 부른 세션이 끝났으면 SESSION_ENDED(받는 층이 401로 바꾼다). 읽기만 하므로 잠그지 않는다. 이메일·휴대폰 번호·회원 코드는 담지 않는다.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '@peaket/platform';
import { ACCOUNT_CLAIMS, type AccountClaims, SESSION_STORE, type SessionStore, STAFF_ASSIGNMENTS, type StaffAssignments } from '../domain/ports.js';
import { sessionAlive } from '../domain/session.js';
import { signupCompleted } from '../domain/signup.js';
import { AccountError } from './account-error.js';

/** openapi FanAccountSummary */
export interface FanAccountSummaryView {
  nickname: string | null;
  signupCompleted: boolean;
  verified: boolean;
  hasStaffAssignment: boolean;
}

/** 부른 세션이 그 계정의 살아 있는 세션인가(끝났으면 SESSION_ENDED). 계정 요약·가입 마무리·가입 취소가 함께 쓴다 */
export async function requireLiveSession(store: SessionStore, clock: Clock, i: { accountId: string; sessionId: string }): Promise<{ accountId: string; sessionId: string }> {
  const accountId = i.accountId.toLowerCase();
  const sessionId = i.sessionId.toLowerCase();
  const me = await store.sessionOf(sessionId);
  if (!me || me.accountId !== accountId || !sessionAlive(me, clock.now())) throw new AccountError('SESSION_ENDED', '부른 세션이 끝났다');
  return { accountId, sessionId };
}

@Injectable()
export class GetAccountSummary {
  constructor(
    @Inject(SESSION_STORE) private readonly store: SessionStore,
    @Inject(ACCOUNT_CLAIMS) private readonly claims: AccountClaims,
    @Inject(STAFF_ASSIGNMENTS) private readonly staff: StaffAssignments,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** @throws AccountError SESSION_ENDED */
  async run(i: { accountId: string; sessionId: string }): Promise<FanAccountSummaryView> {
    const { accountId } = await requireLiveSession(this.store, this.clock, i);
    return this.of(accountId);
  }

  /** 세션 확인을 이미 한 쪽(가입 마무리)이 새 요약을 만든다 */
  async of(accountId: string): Promise<FanAccountSummaryView> {
    const [state, claims, staff] = await Promise.all([this.store.signupStateOf(accountId), this.claims.of(accountId), this.staff.hasAssigned(accountId)]);
    return {
      nickname: state?.nickname ?? null,
      signupCompleted: state ? signupCompleted(state.ageVerified, state.consentKinds) : false,
      verified: claims.scopes.includes('ticket:buy'),
      hasStaffAssignment: staff,
    };
  }
}
