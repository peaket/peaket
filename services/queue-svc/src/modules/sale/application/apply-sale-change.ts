// 회차 판매 상태 사건을 notice에 쓰고 엣지 매진 표시를 그 판으로 맞춘다(docs/features/queue-admission.md §4 '판매 상태와 Kafka 구독의 첫 구현'·
// '엣지 매진 표시와 좌석 수 칸의 첫 구현', ADR-0214 결정 2·3, ADR-0219).
// UPCOMING은 ON_SALE로 쓰고(오픈 전에는 오픈 시각이 진입과 전진을 이미 막는다), 수명은 회차 키와 같게(판매 종료 + 1일), 일정 사본이 없으면 지금 + 2일 [가정]이다.
// 엣지: 매진 판이면 notice보다 먼저 켜고(POL-015의 차례), notice를 쓴 뒤 Lua가 돌려준 지금 판으로 맞춘다(EdgeFlagSync). 엣지 쓰기가 실패해도 던지지 않는다.
import type { Clock, Registry } from '@peaket/platform';
import { type EventSchedule, keepUntilOf, saleEndOf } from '../../entry/index.js';
import type { EdgeFlagSignals, EdgeSaleFlags } from '../domain/edge.js';
import {
  AVG_TICKETS_MAX,
  AVG_TICKETS_MIN,
  type QueueSaleState,
  SALE_STATE_FALLBACK_TTL_MS,
  type SaleApplyResult,
  type SaleChangedEvent,
  type SaleStates,
  SEAT_COUNT_CLOCK_SKEW_MS,
  type SeatCounts,
} from '../domain/sale.js';
import { EdgeFlagSync, type EdgeFlagSyncOptions } from './edge-flag-sync.js';

export interface ApplySaleChangeOptions {
  /** 엣지 매진 표시 저장소(없으면 엣지를 맞추지 않는다. 실제 어댑터는 HOT-012) */
  edge?: EdgeSaleFlags;
  logger?: { warn(obj: object, msg?: string): void };
  signals?: EdgeFlagSignals;
  /** 엣지 쓰기 마감(기본 2초 [가정], 시험이 줄인다) */
  edgeDeadlineMs?: number;
  /** 엣지 맞추기 멈춤 스위치(참이면 엣지를 쓰지 않는다) */
  paused?: () => boolean;
  /** 엣지 차단기 지표를 낼 곳 */
  registry?: Registry;
  /** 엣지 차단기 값 바꾸기(시험용) */
  breaker?: EdgeFlagSyncOptions['breaker'];
}

export class ApplySaleChange {
  /** 엣지 맞추기(엣지 저장소가 있을 때만). 시작 조립이 start·stop으로 파드 안 다시 맞추기를 돌린다 */
  readonly edgeSync: EdgeFlagSync | undefined;

  constructor(
    private readonly states: SaleStates,
    private readonly schedules: { get(eventId: string): Promise<EventSchedule | null> },
    private readonly clock: Clock,
    o: ApplySaleChangeOptions = {},
  ) {
    this.edgeSync = o.edge
      ? new EdgeFlagSync(o.edge, states, clock, {
          ...(o.logger ? { logger: o.logger } : {}),
          ...(o.signals ? { signals: o.signals } : {}),
          ...(o.edgeDeadlineMs !== undefined ? { deadlineMs: o.edgeDeadlineMs } : {}),
          ...(o.paused ? { paused: o.paused } : {}),
          ...(o.registry ? { registry: o.registry } : {}),
          ...(o.breaker ? { breaker: o.breaker } : {}),
          untilOf: async (eventId: string) => {
            const s = await schedules.get(eventId);
            return s ? saleEndOf(s) : null;
          },
        })
      : undefined;
  }

  /** @throws QueueStoreUnavailable 대기열 Redis 일시 장애(일정 사본 읽기 포함). 엣지 저장소 장애는 던지지 않는다 */
  async run(e: SaleChangedEvent): Promise<SaleApplyResult> {
    const state: QueueSaleState = e.status === 'UPCOMING' ? 'ON_SALE' : e.status;
    const schedule = await this.schedules.get(e.eventId);
    const now = this.clock.now();
    const expireAtMs = schedule ? keepUntilOf(schedule) : now + SALE_STATE_FALLBACK_TTL_MS;
    // 엣지 값은 판매 종료 뒤 무시된다(그 뒤는 원본이 410 sale-ended를 낸다)
    const edgeUntilMs = schedule ? saleEndOf(schedule) : now + SALE_STATE_FALLBACK_TTL_MS;
    if (state === 'SOLD_OUT') await this.edgeSync?.pre(e.eventId, { soldOut: true, version: e.version, expireAtMs: edgeUntilMs });
    const counts = countsOf(e, now);
    const out = await this.states.apply({
      eventId: e.eventId,
      state,
      version: e.version,
      soldOutTiers: [...new Set(e.soldOutTiers)],
      expireAtMs,
      extendOnStale: schedule !== null,
      ...(counts ? { counts } : {}),
    });
    const { current, ...result } = out;
    if (current.state !== '' && Number.isFinite(current.version)) await this.edgeSync?.current(e.eventId, { soldOut: current.state === 'SOLD_OUT', version: current.version, expireAtMs: edgeUntilMs });
    return result;
  }
}

/** 사건의 셈: 셈 시각이 없거나 읽지 못하거나 지금보다 5초 [가정] 넘게 앞서면 없다. 평균은 1~10 밖이면 버린다 */
function countsOf(e: SaleChangedEvent, now: number): SeatCounts | undefined {
  if (e.countedAt === undefined) return undefined;
  const at = Date.parse(e.countedAt);
  if (!Number.isFinite(at) || at > now + SEAT_COUNT_CLOCK_SKEW_MS) return undefined;
  if (!Number.isSafeInteger(e.available) || e.available < 0) return undefined;
  const avg = e.avgTicketsPerOrder;
  const okAvg = typeof avg === 'number' && Number.isFinite(avg) && avg >= AVG_TICKETS_MIN && avg <= AVG_TICKETS_MAX;
  return { remaining: e.available, countedAtMs: at, ...(okAvg ? { avgTicketsPerOrder: avg } : {}) };
}
