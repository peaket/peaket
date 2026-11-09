// 계정 정리 시작(docs/features/identity.md §5 '키 판·만 14세…'의 만 14세 재확인, ADR-0062). 본인확인 컨텍스트가 ACCOUNT_CLOSURE로 부른다.
// ACTIVE 계정을 WITHDRAWAL_PENDING과 정리 사유·시작 시각으로 둔다. 여기서는 세션을 끝내지 않는다(결과 대화상자를 보일 수 있게). 끝내기는
// 정비 withdrawal-finish가 시작하고 10분 [가정] 뒤 재인증 없이 탈퇴와 같게 한다(§8 '탈퇴의 첫 구현', BUILD_ORDER BOT-030). 다시 불러도 같다(멱등)
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '@peaket/platform';
import { type AccountClosure, SESSION_STORE, type SessionStore } from '../domain/ports.js';

@Injectable()
export class CloseAccount implements AccountClosure {
  constructor(
    @Inject(SESSION_STORE) private readonly store: SessionStore,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async start(accountId: string, reason: 'UNDER_14'): Promise<void> {
    const now = this.clock.now();
    await this.store.transaction(async (tx) => {
      await tx.lockAccount(accountId);
      await tx.markClosure(accountId, reason, now);
    });
  }

  closureReasonOf(accountId: string): Promise<'UNDER_14' | null> {
    return this.store.transaction((tx) => tx.closureReasonOf(accountId));
  }

  async isClosing(accountId: string): Promise<boolean> {
    const status = await this.store.transaction((tx) => tx.accountStatusOf(accountId));
    return status !== null && status !== 'ACTIVE';
  }
}
