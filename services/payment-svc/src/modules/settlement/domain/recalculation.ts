// 회차 취소·연기 환급의 정산 보류에서 정산서 하나를 어떻게 다룰지 정하는 순수 함수(F-07-8 계획 §5.1 (가), ADR-0380 결정 4, settlement §4.1·§12 둘째 줄).
// 보류 열기와 다시 하기가 정산서마다 부른다. 결제사 호출·쓰기는 응용 층이 한다.
import type { PayoutStatus, Pg, StatementStatus } from './settlement.js';

/**
 * KEEP: 그대로(NOTIFIED·DISPUTED는 묶음 판정이 보류하고, HELD는 사유를 바꾸지 않으며, CARRIED_OVER는 완료 때 다시 계산한다)
 * HOLD: HELD(RECALCULATION)로(묶이지 않은 CONFIRMED, 남은 지급 건이 없는 토스 SCHEDULED)
 * UNBATCH_HOLD: 묶음에서 빼고 상계를 되돌린 뒤 HELD(접수 전 묶음에 묶인 CONFIRMED)
 * CANCEL_TOSS: 남은 지급 건(REQUESTED)의 토스 예약지급을 취소한 뒤 HELD
 * CANCEL_PORTONE: 포트원 수기 정산건을 취소한 뒤 HELD
 * SKIP: 지급이 나갔거나 진행 중이라 다시 계산하지 않는다(환급은 계산 뒤 환급 미수금)
 */
export type RecalculationAction = 'KEEP' | 'HOLD' | 'UNBATCH_HOLD' | 'CANCEL_TOSS' | 'CANCEL_PORTONE' | 'SKIP';

/** 돈이 나가지 않은 지급 건(셈에서 뺀다, U-R3) */
const SETTLED_WITHOUT_MONEY: ReadonlySet<PayoutStatus> = new Set(['FAILED', 'CANCELED']);

export function recalculationActionOf(s: { status: StatementStatus; payoutBatchId: string | null; pg: Pg; payouts: readonly { status: PayoutStatus }[] }): RecalculationAction {
  switch (s.status) {
    case 'SUPERSEDED':
      throw new Error('SUPERSEDED 정산서는 다시 계산 대상이 아니다');
    case 'CALCULATED':
    case 'NOTIFIED':
    case 'DISPUTED':
    case 'HELD':
    case 'CARRIED_OVER':
      return 'KEEP';
    case 'CONFIRMED':
      return s.payoutBatchId === null ? 'HOLD' : 'UNBATCH_HOLD';
    case 'PAID':
    case 'FAILED':
      return 'SKIP';
    case 'SCHEDULED': {
      const live = s.payouts.filter((p) => !SETTLED_WITHOUT_MONEY.has(p.status));
      if (live.some((p) => p.status !== 'REQUESTED')) return 'SKIP';
      if (s.pg === 'PORTONE') return 'CANCEL_PORTONE';
      return live.length === 0 ? 'HOLD' : 'CANCEL_TOSS';
    }
    default: {
      const never: never = s.status;
      throw new Error(`모르는 정산서 상태: ${String(never)}`);
    }
  }
}
