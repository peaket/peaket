// 세션 컨텍스트의 '토큰에 실을 계정 값' 포트를 본인확인 기록으로 채운다(docs/features/identity.md §3 액세스 토큰 scope·pid, §5).
// 본인확인을 마친 계정만 ticket:buy와 pid(pid 키 전환 기간이면 pid_prev도)를 싣는다.
import type { AccountClaims, AccountClosure, Reverifications } from '../../session/index.js';
import type { VerificationStore } from '../domain/ports.js';
import { TICKET_BUY_SCOPE } from '../domain/verification.js';

/** 재통과 기록(Reverifications)도 같은 저장소로 내준다(고위험 재인증, identity §5) */
export class VerificationClaims implements AccountClaims, Reverifications {
  readonly #store: VerificationStore;
  readonly #closure: Pick<AccountClosure, 'isClosing'> | undefined;

  /** closure: 정리·탈퇴 유예 중인 계정에는 ticket:buy·pid를 싣지 않는다(identity §8 '탈퇴의 첫 구현'). 없으면 보지 않는다(시험) */
  constructor(store: VerificationStore, closure?: Pick<AccountClosure, 'isClosing'>) {
    this.#store = store;
    this.#closure = closure;
  }

  async of(accountId: string) {
    if (this.#closure && (await this.#closure.isClosing(accountId))) return { scopes: [] };
    const v = await this.#store.claimsOf(accountId);
    if (!v) return { scopes: [] };
    return { scopes: [TICKET_BUY_SCOPE], pid: v.pid, ...(v.pidPrev ? { pidPrev: v.pidPrev } : {}) };
  }

  recentlyReverified(accountId: string, sessionId: string, since: number): Promise<boolean> {
    return this.#store.recentlyReverified(accountId, sessionId, since);
  }
}
