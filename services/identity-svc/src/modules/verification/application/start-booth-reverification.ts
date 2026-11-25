// 부스 재발급 본인확인 대조 시작(openapi createIdentityBoothReverification, docs/features/identity.md §6.1,
// docs/features/offline-gate.md §9.1 '부스 재발급', docs/review/plans/F-05-12.md §3 결정 1).
// 대조 목적 동의(정보통신망법 §23의5④ 단서)가 있어야 하고, 이미 본인확인한 계정만 비교할 수 있다.
// 일반 본인확인 시작(POST /v1/identity/verifications)은 purpose BOOTH를 받지 않는다(전용 경로만).
import type { Clock } from '@peaket/platform';
import { uuidv7 } from '@peaket/platform';
import type { AccountClosure } from '../../session/index.js';
import { BOOTH_TOKEN_TTL_MS, isBoothTicketId } from '../domain/booth-reverification.js';
import type { BoothReverificationSignals, VerificationProvider, VerificationStore } from '../domain/ports.js';
import { ProviderUnavailable } from '../domain/verification.js';
import { safeNextPath } from './start-verification.js';
import { VerificationError } from './verification-error.js';

export interface StartBoothReverificationDeps {
  store: VerificationStore;
  provider: VerificationProvider;
  closure: AccountClosure;
  clock: Clock;
  signals?: BoothReverificationSignals;
}

export class StartBoothReverification {
  readonly #d: StartBoothReverificationDeps;
  constructor(d: StartBoothReverificationDeps) {
    this.#d = d;
  }

  async run(i: { accountId: string; sessionId?: string | null; ticketId: string; consent: boolean; next: string }): Promise<{ verificationId: string; window: ReturnType<VerificationProvider['window']>; expiresAt: number }> {
    if (i.consent !== true) {
      this.#d.signals?.result('consent');
      throw new VerificationError('CONSENT', '부스 대조 목적 동의가 필요하다');
    }
    if (!isBoothTicketId(i.ticketId)) {
      this.#d.signals?.result('not_verified');
      throw new VerificationError('NOT_VERIFIED', '티켓 ID가 올바르지 않다');
    }
    if (!safeNextPath(i.next)) throw new VerificationError('NEXT_INVALID', 'next는 같은 출처 경로만 받는다');
    if ((await this.#d.closure.closureReasonOf(i.accountId)) === 'UNDER_14') throw new VerificationError('UNDER_14', '만 14세 미만으로 정리 중인 계정이다');
    // 부스 대조는 계정의 본인확인 기록(ci_hmac)과 비교한다. 기록이 없으면 비교할 수 없어 부스 코드를 줄 수 없다
    if (!(await this.#d.store.isVerified(i.accountId))) {
      this.#d.signals?.result('not_verified');
      throw new VerificationError('NOT_VERIFIED', '본인확인 기록이 없어 대조할 수 없다');
    }
    const now = this.#d.clock.now();
    const id = uuidv7(this.#d.clock);
    const expiresAt = now + BOOTH_TOKEN_TTL_MS;
    let window: ReturnType<VerificationProvider['window']>;
    try {
      window = this.#d.provider.window(id);
    } catch (e) {
      if (e instanceof ProviderUnavailable) throw new VerificationError('PROVIDER_DOWN', '본인확인기관을 쓸 수 없다');
      throw e;
    }
    await this.#d.store.transaction((tx) =>
      tx.insertAttempt({ id, accountId: i.accountId, sessionId: i.sessionId ?? null, purpose: 'BOOTH', ticketId: i.ticketId, next: i.next, status: 'PENDING', expiresAt, createdAt: now, completedAt: null }),
    );
    this.#d.signals?.result('started');
    return { verificationId: id, window, expiresAt };
  }
}
