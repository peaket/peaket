// F-07-8 다시 계산 시험의 토스 지급대행 전송 짝 대역. F-07-6 구현의 `TossPayoutTransport`(첫 인자 pgStore, cancelPayout은 { pgPayoutId, status })를 `implements`한다.
// 이 대역은 F-07-8 시험이 보는 것만 한다: 예약지급 취소(cancelPayout) 호출 기록과 실패 주입(응답 없음 = 연결 끊김, 5xx = TossTransportError 모양의 Error).
// HTTP·JWE 짝 시험(대역 서버)은 F-07-6 시험이 맡는다. F-07-7 시험의 대역(settlement-payout-toss-double.ts)과 파일을 나눠 같은 이름을 쓰지 않는다.
import type { TossPayoutTransport, TossSendResult } from '../../src/modules/settlement/domain/ports.js';
import type { PayoutStatus, PgStore, TossSellerStatus } from '../../src/modules/settlement/domain/settlement.js';

type TossSellerRegistration = Parameters<TossPayoutTransport['registerSeller']>[1];

export type RecalcTossFailure = 'NO_RESPONSE' | 'HTTP_5XX';

export class RecalcTossPayout implements TossPayoutTransport {
  readonly cancels: { pgStore: PgStore; pgPayoutId: string }[] = [];
  /** 실패시킬 지급 ID와 남은 횟수·모양 */
  readonly #failures = new Map<string, { left: number; kind: RecalcTossFailure }>();

  failCancel(pgPayoutId: string, kind: RecalcTossFailure, times = 1): void {
    this.#failures.set(pgPayoutId, { left: times, kind });
  }

  async cancelPayout(pgStore: PgStore, pgPayoutId: string): Promise<{ pgPayoutId: string; status: PayoutStatus }> {
    this.cancels.push({ pgStore, pgPayoutId });
    const f = this.#failures.get(pgPayoutId);
    if (f && f.left > 0) {
      f.left -= 1;
      if (f.kind === 'NO_RESPONSE') throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
      throw Object.assign(new Error('toss 503'), { status: 503 });
    }
    return { pgPayoutId, status: 'CANCELED' };
  }

  async requestPayouts(): Promise<TossSendResult> {
    return { kind: 'NO_RESPONSE' };
  }

  async getPayout(_pgStore: PgStore, pgPayoutId: string): Promise<{ pgPayoutId: string; status: PayoutStatus }> {
    return { pgPayoutId, status: 'REQUESTED' };
  }

  async registerSeller(_pgStore: PgStore, _body: TossSellerRegistration): Promise<{ tossSellerId: string; status: TossSellerStatus }> {
    throw new Error('F-07-8 시험은 셀러 등록을 부르지 않는다');
  }

  async getSeller(_pgStore: PgStore, tossSellerId: string): Promise<{ tossSellerId: string; status: TossSellerStatus }> {
    return { tossSellerId, status: 'APPROVED' };
  }

  async balance(): Promise<{ availableAmount: number; pendingAmount: number }> {
    return { availableAmount: 900_000_000_000, pendingAmount: 0 };
  }

  async listSettlementFees(): Promise<number> {
    return 0;
  }
}
