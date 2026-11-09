// 세션 컨텍스트의 '탈퇴 전 대조값 보관 안내' 포트를 본인확인 저장소로 채운다(docs/features/identity.md §8 '대조값 보관의 첫 구현', BUILD_ORDER BOT-035).
// 행이 여럿이면 RESTRICTED가 CASE_OPEN보다 먼저이고, 같은 상태면 늦은 끝이다.
import type { FraudHolds } from '../../session/index.js';
import type { VerificationStore } from '../domain/ports.js';

export class VerificationHolds implements FraudHolds {
  constructor(private readonly store: Pick<VerificationStore, 'activeHoldsOf'>) {}

  async activeHold(accountId: string, now: number): Promise<{ state: 'CASE_OPEN' | 'RESTRICTED'; until: number } | null> {
    const rows = await this.store.activeHoldsOf(accountId, now);
    if (rows.length === 0) return null;
    return rows.reduce((best, h) => {
      if (h.state !== best.state) return h.state === 'RESTRICTED' ? h : best;
      return h.until > best.until ? h : best;
    });
  }
}
