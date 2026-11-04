// 팬 탈퇴(openapi DELETE /v1/identity/account, docs/features/identity.md §8 '탈퇴의 첫 구현', BUILD_ORDER BOT-030, FR-017, POL-033, I-T16·I-T27).
// 재인증 토큰(세션·FAN_SENSITIVE에 묶임)을 확인하고 jti를 한 번 쓴 뒤, 계정 트랜잭션 하나에서 계정을 파기하고 살아 있는 세션을 모두 끝낸다(DELETE).
// 본인확인 기록(연계정보 HMAC·pid) 파기는 다음 트랜잭션이고, 실패해도 탈퇴는 끝난 것으로 답한다(정비 withdrawal-finish가 다시 지운다).
// 다른 서비스의 정리(티켓·양도 요청·가상계좌·결제 대기 주문, docs/planning/03 §1.5)는 탈퇴 참여자가 생길 때 BUILD_ORDER BOT-035가 붙인다.
import { Inject, Injectable, Optional } from '@nestjs/common';
import { CLOCK, type Clock, PLATFORM_LOGGER, type PlatformLogger } from '@peaket/platform';
import { ACCOUNT_ERASER, type AccountEraser, REAUTH_VERIFIER, ReauthRejected, type ReauthVerifier, SESSION_STORE, type SessionStore, type SessionTx } from '../domain/ports.js';
import { WITHDRAWAL_REAUTH_ACT } from '../domain/session.js';
import { AccountError } from './account-error.js';
import { checkIds } from './end-session.js';

export interface WithdrawInput {
  accountId: string;
  sessionId: string;
  /** X-Reauth-Token */
  reauthToken: string;
  /** confirmCancelUnusedTickets·acknowledgeFraudHold·refundAccount는 탈퇴 참여자와 대조값 보관이 생기면 쓴다(BOT-035). 계좌는 받아도 저장하지 않는다 */
  body: { confirmCancelUnusedTickets?: boolean; acknowledgeFraudHold?: boolean };
}

/** 계정 트랜잭션 안의 탈퇴 끝내기(재인증 탈퇴와 만 14세 미만 정리 마무리가 함께 쓴다) */
export async function completeWithdrawal(tx: SessionTx, accountId: string, now: number): Promise<void> {
  await tx.lockAccount(accountId);
  // 만료와 상관없이 끝나지 않은 세션을 모두 잠그고 끝낸다: 만료 경계에서 갱신이 더 이른 시각으로 출발해 겹쳐도 세션이 남지 않는다(다시 보기 낮음)
  const open = await tx.unterminatedSessions(accountId);
  await tx.eraseAccount(accountId, now);
  await tx.terminateSessions(open, 'DELETE', now);
}

@Injectable()
export class WithdrawAccount {
  constructor(
    @Inject(SESSION_STORE) private readonly store: SessionStore,
    @Inject(REAUTH_VERIFIER) private readonly reauth: ReauthVerifier,
    @Inject(ACCOUNT_ERASER) private readonly eraser: AccountEraser,
    @Inject(CLOCK) private readonly clock: Clock,
    @Optional() @Inject(PLATFORM_LOGGER) private readonly logger?: PlatformLogger,
  ) {}

  async run(i: WithdrawInput): Promise<void> {
    checkIds(i.sessionId, i.accountId);
    const accountId = i.accountId.toLowerCase();
    const sessionId = i.sessionId.toLowerCase();
    let token: { jti: string; accountId: string; expiresAt: number };
    try {
      token = await this.reauth.verify(i.reauthToken, { sessionId, act: WITHDRAWAL_REAUTH_ACT });
    } catch (e) {
      if (e instanceof ReauthRejected) throw new AccountError('REAUTH_REQUIRED', e.message);
      throw e;
    }
    if (token.accountId.toLowerCase() !== accountId) throw new AccountError('REAUTH_REQUIRED', '재인증 토큰의 계정이 다르다');
    const now = this.clock.now();
    await this.store.transaction(async (tx) => {
      // jti를 쓰는 것과 파기를 한 트랜잭션에: 둘 가운데 하나만 남지 않는다
      if (!(await tx.useReauth({ jti: token.jti, accountId, usedAt: now, expiresAt: token.expiresAt }))) {
        throw new AccountError('REAUTH_REQUIRED', '이미 쓴 재인증 토큰이다');
      }
      // 상태는 계정을 잠근 뒤에 본다(동시 탈퇴·정비와 겹쳐도 한 번만 끝낸다, 새 맥락 리뷰 L4)
      await tx.lockAccount(accountId);
      const status = await tx.accountStatusOf(accountId);
      if (status !== 'ACTIVE' && status !== 'WITHDRAWAL_PENDING') throw new AccountError('REAUTH_REQUIRED', '탈퇴할 수 있는 계정이 아니다');
      await completeWithdrawal(tx, accountId, now);
    });
    try {
      await this.eraser.erase(accountId, now);
    } catch (err) {
      // 계정은 이미 파기됐다. 남은 본인확인 기록은 정비가 지난 7일 [가정] 안에 탈퇴한 계정에서 다시 지운다(늦어도 5일 안, identity §8)
      this.logger?.warn({ err, accountId }, '탈퇴 뒤 본인확인 기록 파기 실패(정비가 다시 지운다)');
    }
  }
}
