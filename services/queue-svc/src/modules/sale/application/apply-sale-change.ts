// 회차 판매 상태 사건을 notice에 쓴다(docs/features/queue-admission.md §4 '판매 상태와 Kafka 구독의 첫 구현', ADR-0214 결정 2·3).
// UPCOMING은 ON_SALE로 쓰고(오픈 전에는 오픈 시각이 진입과 전진을 이미 막는다), 수명은 회차 키와 같게(판매 종료 + 1일), 일정 사본이 없으면 지금 + 2일 [가정]이다.
import type { Clock } from '@peaket/platform';
import { type EventSchedule, keepUntilOf } from '../../entry/index.js';
import { type QueueSaleState, SALE_STATE_FALLBACK_TTL_MS, type SaleApplyResult, type SaleChangedEvent, type SaleStates } from '../domain/sale.js';

export class ApplySaleChange {
  constructor(
    private readonly states: SaleStates,
    private readonly schedules: { get(eventId: string): Promise<EventSchedule | null> },
    private readonly clock: Clock,
  ) {}

  /** @throws QueueStoreUnavailable 대기열 Redis 일시 장애(일정 사본 읽기 포함) */
  async run(e: SaleChangedEvent): Promise<SaleApplyResult> {
    const state: QueueSaleState = e.status === 'UPCOMING' ? 'ON_SALE' : e.status;
    const schedule = await this.schedules.get(e.eventId);
    const expireAtMs = schedule ? keepUntilOf(schedule) : this.clock.now() + SALE_STATE_FALLBACK_TTL_MS;
    return this.states.apply({ eventId: e.eventId, state, version: e.version, soldOutTiers: [...new Set(e.soldOutTiers)], expireAtMs, extendOnStale: schedule !== null });
  }
}
