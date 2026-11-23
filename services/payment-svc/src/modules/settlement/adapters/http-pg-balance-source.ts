// 결제사 지급 가능 잔액 원천(settlement §5.1). 토스페이먼츠만 API(GET /v2/balances)가 있고, 토스 지급대행 전송(HttpTossPayoutTransport)으로 부른다.
// 전송이 없으면(설정 없음) 확인을 생략한다(undefined). 포트원은 운영자 입력값을 쓴다.
import type { PgBalanceSource, TossPayoutTransport } from '../domain/ports.js';
import type { Pg, PgStore } from '../domain/settlement.js';

export class HttpPgBalanceSource implements PgBalanceSource {
  constructor(private readonly toss: Pick<TossPayoutTransport, 'balance'> | undefined) {}

  async available(input: { pg: Pg; pgStore: PgStore }): Promise<{ availableAmount: number; pendingAmount: number } | undefined> {
    if (input.pg !== 'TOSS' || !this.toss) return undefined;
    return this.toss.balance(input.pgStore);
  }
}

export class UnavailablePgBalanceSource implements PgBalanceSource {
  async available(): Promise<undefined> {
    return undefined;
  }
}
