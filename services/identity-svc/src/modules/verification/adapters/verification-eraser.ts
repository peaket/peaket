// 세션 컨텍스트의 '탈퇴한 계정의 본인확인 기록 파기' 포트를 본인확인 저장소로 채운다(docs/features/identity.md §8 '탈퇴의 첫 구현', BUILD_ORDER BOT-030).
import type { AccountEraser } from '../../session/index.js';
import type { VerificationStore } from '../domain/ports.js';

export class VerificationEraser implements AccountEraser {
  constructor(private readonly store: Pick<VerificationStore, 'eraseAccount'>) {}

  erase(accountId: string, now: number): Promise<boolean> {
    return this.store.eraseAccount(accountId, now);
  }
}
