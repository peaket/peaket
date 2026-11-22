// 결제사 지급 가능 잔액 원천(settlement §5.1). 토스페이먼츠만 API가 있고,
// 실제 JWE·키는 운영 전이므로 전송 포트(`TossBalanceTransport`) 뒤에 둔다. 어댑터가 없으면 확인을 생략한다.
import type { PgBalanceSource } from '../domain/ports.js';
import type { Pg, PgStore } from '../domain/settlement.js';

export interface TossBalanceTransport {
  /** GET /v2/balances. 상점(STANDARD·ESCROW)별 지급 가능액·정산 대기액을 준다. */
  available(store: PgStore): Promise<{ availableAmount: number; pendingAmount: number }>;
}

export class HttpPgBalanceSource implements PgBalanceSource {
  constructor(private readonly toss: TossBalanceTransport | undefined) {}

  async available(input: { pg: Pg; pgStore: PgStore }): Promise<{ availableAmount: number; pendingAmount: number } | undefined> {
    if (input.pg !== 'TOSS' || !this.toss) return undefined;
    return this.toss.available(input.pgStore);
  }
}

export class UnavailablePgBalanceSource implements PgBalanceSource {
  async available(): Promise<undefined> {
    return undefined;
  }
}
