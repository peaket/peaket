// 좌석 화면 행동 요약 내보내기(docs/features/seat-hold.md §3 '좌석 화면 행동 요약', docs/features/bot-defense.md §4.1, ADR-0171 결정 4, ADR-0249 결정 6).
// 홀드 판정·한도·위험 점수에 쓰지 않는다. 구매 세션마다 처음 받은 요약 하나만 내고, 응답을 기다리지 않으며 실패해도 홀드를 막지 않는다.
import { type Clock, uuidv7 } from '@peaket/platform';
import type { BehaviorSignals, PurchaseSessionStore } from '../domain/ports.js';

export const SEAT_BEHAVIOR = Symbol('purchase.SeatBehaviorReporter');

export interface SeatBehaviorDeps {
  claims: Pick<PurchaseSessionStore, 'claimSeatBehavior'>;
  signals: BehaviorSignals;
  clock: Clock;
  /** 응답 뒤로 미룰 일을 맡긴다 */
  after: (work: () => Promise<void>) => void;
  /** 표시 쓰기 실패를 알린다(요약은 잃는다) */
  onFailed?: (err: unknown) => void;
}

export interface SeatBehaviorReport {
  purchaseSessionId: string;
  pid: string;
  eventId: string;
  journeyId: string;
  /** 경로 스키마가 칸을 닫아 둔 요약(BehaviorSummary) */
  behavior: Record<string, unknown>;
}

export class SeatBehaviorReporter {
  constructor(private readonly d: SeatBehaviorDeps) {}

  /** 기다리지 않는다. 표시를 처음 잡은 쪽만 낸다 */
  report(i: SeatBehaviorReport): void {
    if (i.journeyId === '' || i.pid === '') return;
    this.d.after(async () => {
      try {
        const first = await this.d.claims.claimSeatBehavior(i.purchaseSessionId);
        if (first !== true) return;
        this.d.signals.record({ eventKey: uuidv7(this.d.clock), screen: 'SEAT', pid: i.pid, eventId: i.eventId, journeyId: i.journeyId, features: i.behavior, tsMs: this.d.clock.now() });
      } catch (err) {
        this.d.onFailed?.(err);
      }
    });
  }
}
