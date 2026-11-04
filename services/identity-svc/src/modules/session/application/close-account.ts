// 계정 정리 시작(docs/features/identity.md §5 '키 판·만 14세…'의 만 14세 재확인, ADR-0062). 본인확인 컨텍스트가 ACCOUNT_CLOSURE로 부른다.
// ACTIVE 계정을 WITHDRAWAL_PENDING과 정리 사유로 둔다. 탈퇴와 같은 정리(티켓·양도 요청·가상계좌 처리, 세션 강제 만료와 파기, §8 '탈퇴 뒤 데이터 파기 순서')는
// BUILD_ORDER BOT-030의 탈퇴 절차가 이 사유의 계정을 이어서 한다. 그래서 여기서는 세션을 끝내지 않는다(결과 대화상자를 보일 수 있게). 다시 불러도 같다(멱등)
import { Inject, Injectable } from '@nestjs/common';
import { type AccountClosure, SESSION_STORE, type SessionStore } from '../domain/ports.js';

@Injectable()
export class CloseAccount implements AccountClosure {
  constructor(@Inject(SESSION_STORE) private readonly store: SessionStore) {}

  async start(accountId: string, reason: 'UNDER_14'): Promise<void> {
    await this.store.transaction(async (tx) => {
      await tx.lockAccount(accountId);
      await tx.markClosure(accountId, reason);
    });
  }

  closureReasonOf(accountId: string): Promise<'UNDER_14' | null> {
    return this.store.transaction((tx) => tx.closureReasonOf(accountId));
  }
}
