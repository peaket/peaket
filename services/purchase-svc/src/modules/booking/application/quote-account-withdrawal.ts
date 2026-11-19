// 탈퇴 전 미사용 티켓 견적(docs/features/payment.md §4.1 '미사용 티켓 견적', docs/features/identity.md §8 '미사용 티켓 확인과 취소' 확인(견적),
// docs/api/proto/peaket/purchase/v1/account.proto QuoteAccountWithdrawal, ADR-0284 결정 7, BUILD_ORDER PRF-174, I-T26 ①, BAT-013).
// identity-svc가 미룸 표시 전에 부른다(읽기 전용, 데드라인 2초 [가정]). 아무것도 바꾸지 않고 재인증 토큰도 쓰지 않는다.
// DB에 닿지 못하거나 문장 시간 한도를 넘으면 WithdrawalOrdersUnavailable(gRPC UNAVAILABLE)이다.
import type { Clock } from '@peaket/platform';
import type { UnusedTicketsQuote, WithdrawalTickets } from '../domain/ports.js';
import { WithdrawalOrdersUnavailable } from '../domain/ports.js';
import { WITHDRAWAL_STATEMENT_TIMEOUT_MS } from './process-account-withdrawal.js';

export interface QuoteAccountWithdrawalDeps {
  readonly tickets: WithdrawalTickets;
  readonly clock: Clock;
}

export class QuoteAccountWithdrawal {
  constructor(private readonly d: QuoteAccountWithdrawalDeps) {}

  /**
   * deadlineAtMs: 이 호출의 마감 시각(ms, 받는 층이 gRPC 데드라인으로 준다. 없으면 Infinity).
   * @throws WithdrawalOrdersUnavailable purchase DB·판매 설정에 닿지 못했거나 문장 시간 한도를 넘었다(남은 시간이 1ms도 없을 때도)
   */
  async run(i: { accountId: string; deadlineAtMs: number }): Promise<UnusedTicketsQuote> {
    const left = i.deadlineAtMs - this.d.clock.now();
    if (!(left >= 1)) throw new WithdrawalOrdersUnavailable(new Error('남은 시간이 없다'));
    return this.d.tickets.quote({
      accountId: i.accountId,
      nowMs: this.d.clock.now(),
      statementTimeoutMs: Math.max(1, Math.floor(Math.min(WITHDRAWAL_STATEMENT_TIMEOUT_MS, left))),
    });
  }
}
