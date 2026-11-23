// 토스 지급대행 전송 포트의 짝 대역(F-07-7 시험). F-07-6 계획 §5.1(나)의 `TossPayoutTransport`(첫 인자 pgStore)를 `implements`하고,
// F-07-7 계획 §5.1(나) 끝의 `updateSeller`를 더한 모양이다. HTTP·JWE 짝 시험(대역 서버 toss-payout-fake.ts)은 F-07-6 시험이 맡는다.
// 이 대역은 F-07-7 시험이 보는 것만 한다: 셀러 등록·수정 호출 기록, 상점별 실패 주입, 예약지급 취소 호출과 그 결과.
// 던지는 실패는 연결 실패와 같은 모양(Error, code ECONNRESET)이다. 결제사 응답의 상태 값은 정본(settlement §3·§5.2·§6)의 이름만 쓴다.
import type { TossPayoutTransport, TossSendResult } from '../../src/modules/settlement/domain/ports.js';
import type { PayoutStatus, PgStore, TossSellerStatus } from '../../src/modules/settlement/domain/settlement.js';

type TossSellerRegistration = Parameters<TossPayoutTransport['registerSeller']>[1];

export type TossCall =
  | { method: 'registerSeller'; pgStore: PgStore; body: TossSellerRegistration }
  | { method: 'updateSeller'; pgStore: PgStore; tossSellerId: string; body: TossSellerRegistration }
  | { method: 'getSeller'; pgStore: PgStore; tossSellerId: string }
  | { method: 'cancelPayout'; pgStore: PgStore; pgPayoutId: string }
  | { method: 'getPayout'; pgStore: PgStore; pgPayoutId: string }
  | { method: 'requestPayouts'; pgStore: PgStore }
  | { method: 'balance'; pgStore: PgStore }
  | { method: 'listSettlementFees'; pgStore: PgStore };

export type TossMethod = TossCall['method'];

const connectionReset = (): Error => Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });

export class RecordingTossPayout implements TossPayoutTransport {
  readonly calls: TossCall[] = [];
  /** 등록·조회·수정이 돌려줄 셀러 상태(상점별) */
  readonly sellerStatus: Record<PgStore, TossSellerStatus> = { STANDARD: 'PARTIALLY_APPROVED', ESCROW: 'PARTIALLY_APPROVED' };
  /** 실패시킬 `${method}:${pgStore}`와 남은 횟수 */
  readonly #failures = new Map<string, number>();
  /** 지급 ID별 지금 상태(getPayout) */
  readonly payoutStatus = new Map<string, PayoutStatus>();
  #seq = 0;
  /** 부를 때마다 부른다(포트원 대역과 한 줄로 차례를 볼 때) */
  onCall: ((c: TossCall) => void) | undefined;

  #push(c: TossCall): void {
    this.calls.push(c);
    this.onCall?.(c);
  }

  fail(method: TossMethod, pgStore: PgStore, times = Number.POSITIVE_INFINITY): void {
    this.#failures.set(`${method}:${pgStore}`, times);
  }

  clearFailures(): void {
    this.#failures.clear();
  }

  callsOf(method: TossMethod): TossCall[] {
    return this.calls.filter((c) => c.method === method);
  }

  #maybeFail(method: TossMethod, pgStore: PgStore): void {
    const left = this.#failures.get(`${method}:${pgStore}`) ?? 0;
    if (left <= 0) return;
    this.#failures.set(`${method}:${pgStore}`, left - 1);
    throw connectionReset();
  }

  async requestPayouts(pgStore: PgStore, _input?: Parameters<TossPayoutTransport['requestPayouts']>[1]): Promise<TossSendResult> {
    this.#push({ method: 'requestPayouts', pgStore });
    return { kind: 'NO_RESPONSE' };
  }

  async getPayout(pgStore: PgStore, pgPayoutId: string): Promise<{ pgPayoutId: string; status: PayoutStatus; errorCode?: string }> {
    this.#push({ method: 'getPayout', pgStore, pgPayoutId });
    this.#maybeFail('getPayout', pgStore);
    return { pgPayoutId, status: this.payoutStatus.get(pgPayoutId) ?? 'REQUESTED' };
  }

  async cancelPayout(pgStore: PgStore, pgPayoutId: string): Promise<void> {
    this.#push({ method: 'cancelPayout', pgStore, pgPayoutId });
    this.#maybeFail('cancelPayout', pgStore);
    this.payoutStatus.set(pgPayoutId, 'CANCELED');
  }

  async registerSeller(pgStore: PgStore, body: TossSellerRegistration): Promise<{ tossSellerId: string; status: TossSellerStatus }> {
    this.#push({ method: 'registerSeller', pgStore, body });
    this.#maybeFail('registerSeller', pgStore);
    this.#seq += 1;
    return { tossSellerId: `seller-${pgStore.toLowerCase()}-${this.#seq}`, status: this.sellerStatus[pgStore] };
  }

  async updateSeller(pgStore: PgStore, tossSellerId: string, body: TossSellerRegistration): Promise<{ tossSellerId: string; status: TossSellerStatus }> {
    this.#push({ method: 'updateSeller', pgStore, tossSellerId, body });
    this.#maybeFail('updateSeller', pgStore);
    return { tossSellerId, status: this.sellerStatus[pgStore] };
  }

  async getSeller(pgStore: PgStore, tossSellerId: string): Promise<{ tossSellerId: string; status: TossSellerStatus }> {
    this.#push({ method: 'getSeller', pgStore, tossSellerId });
    this.#maybeFail('getSeller', pgStore);
    return { tossSellerId, status: this.sellerStatus[pgStore] };
  }

  async balance(pgStore: PgStore): Promise<{ availableAmount: number; pendingAmount: number }> {
    this.#push({ method: 'balance', pgStore });
    return { availableAmount: 900_000_000_000, pendingAmount: 0 };
  }

  async listSettlementFees(pgStore: PgStore, _from?: Date, _to?: Date): Promise<number> {
    this.#push({ method: 'listSettlementFees', pgStore });
    return 0;
  }
}

/**
 * 셀러 수정이 없는 전송(F-07-7 계획 §5.1 (타) 결정 1: `updateSeller`는 선택 메서드). 고정된 F-07-6 시험의 FakeTransport처럼
 * 그 메서드가 없는 전송을 흉내 내고, 나머지 호출은 기록 대역에 그대로 넘긴다(호출 기록은 inner.calls로 본다)
 */
export function withoutUpdateSeller(inner: RecordingTossPayout): TossPayoutTransport {
  const t: TossPayoutTransport = {
    requestPayouts: (pgStore, input) => inner.requestPayouts(pgStore, input),
    getPayout: (pgStore, id) => inner.getPayout(pgStore, id),
    cancelPayout: (pgStore, id) => inner.cancelPayout(pgStore, id),
    registerSeller: (pgStore, body) => inner.registerSeller(pgStore, body),
    getSeller: (pgStore, id) => inner.getSeller(pgStore, id),
    balance: (pgStore) => inner.balance(pgStore),
    listSettlementFees: (pgStore, from, to) => inner.listSettlementFees(pgStore, from, to),
  };
  return t;
}
