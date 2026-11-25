// 부스 대조 토큰 확인(ticket-svc gRPC, docs/features/identity.md §6.1, docs/review/plans/F-05-12.md §3 결정 1).
// 토큰 원문은 받는 쪽에서만 잠깐 쓰고 해시로 찾는다. 만료(expires_at > now)와 계정·티켓 묶임을 모두 본다.
import type { Clock } from '@peaket/platform';
import { hashBoothToken, isBoothToken } from '../domain/booth-reverification.js';
import type { BoothReverificationStore } from '../domain/ports.js';

export interface VerifyBoothReverificationDeps {
  booth: BoothReverificationStore;
  clock: Clock;
}

export class VerifyBoothReverification {
  readonly #d: VerifyBoothReverificationDeps;
  constructor(d: VerifyBoothReverificationDeps) {
    this.#d = d;
  }

  /** true는 계정·티켓이 맞고 아직 5분이 지나지 않은 대조가 있다는 뜻이다. 저장소 장애는 던진다(gRPC UNAVAILABLE) */
  async run(i: { token: string; accountId: string; ticketId: string }): Promise<boolean> {
    if (!isBoothToken(i.token)) return false;
    const found = await this.#d.booth.byTokenHash(hashBoothToken(i.token));
    if (!found || !found.ciMatched) return false;
    if (found.accountId !== i.accountId || found.ticketId !== i.ticketId) return false;
    return found.expiresAtMs > this.#d.clock.now();
  }
}
