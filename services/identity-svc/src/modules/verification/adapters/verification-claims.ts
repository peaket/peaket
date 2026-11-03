// 세션 컨텍스트의 '토큰에 실을 계정 값' 포트를 본인확인 기록으로 채운다(docs/features/identity.md §3 액세스 토큰 scope·pid, §5).
// 본인확인을 마친 계정만 ticket:buy와 pid(pid 키 전환 기간이면 pid_prev도)를 싣는다.
import type { AccountClaims } from '../../session/index.js';
import type { VerificationStore } from '../domain/ports.js';
import { TICKET_BUY_SCOPE } from '../domain/verification.js';

export class VerificationClaims implements AccountClaims {
  readonly #store: VerificationStore;

  constructor(store: VerificationStore) {
    this.#store = store;
  }

  async of(accountId: string) {
    const v = await this.#store.claimsOf(accountId);
    if (!v) return { scopes: [] };
    return { scopes: [TICKET_BUY_SCOPE], pid: v.pid, ...(v.pidPrev ? { pidPrev: v.pidPrev } : {}) };
  }
}
