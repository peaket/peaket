// EndSession(docs/features/identity.md §2, I-T50 ④): 로그아웃. 이미 끝난 세션이면 그대로 성공(ended=false)이다.
// 세션 종료 사건(control.sessions-terminated)은 BUILD_ORDER PRF-030이 같은 트랜잭션의 Outbox로 낸다.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '@peaket/platform';
import { SESSION_SIGNALS, SESSION_STORE, type SessionSignals, type SessionStore } from '../domain/ports.js';
import { SessionError } from './session-error.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function checkIds(sessionId: string, accountId: string): void {
  if (!UUID.test(sessionId)) throw new SessionError('INVALID_ARGUMENT', 'session_id는 UUID다');
  if (!UUID.test(accountId)) throw new SessionError('INVALID_ARGUMENT', 'account_id는 UUID다');
}

@Injectable()
export class EndSession {
  constructor(
    @Inject(SESSION_STORE) private readonly store: SessionStore,
    @Inject(SESSION_SIGNALS) private readonly signals: SessionSignals,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async run(i: { sessionId: string; accountId: string }): Promise<{ ended: boolean }> {
    checkIds(i.sessionId, i.accountId);
    const now = this.clock.now();
    const ended = await this.store.transaction(async (tx) => {
      const s = await tx.getSessionForUpdate(i.sessionId);
      if (!s) throw new SessionError('NOT_FOUND', '세션이 없다');
      if (s.accountId !== i.accountId.toLowerCase()) throw new SessionError('FAILED_PRECONDITION', '그 계정의 세션이 아니다');
      if (s.terminatedAt !== null) return false;
      await tx.terminateSessions([s.id], 'LOGOUT', now);
      return true;
    });
    if (ended) this.signals.terminated('LOGOUT', 1);
    return { ended };
  }
}
