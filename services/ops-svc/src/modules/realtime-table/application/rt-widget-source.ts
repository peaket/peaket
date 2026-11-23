// 관제 위젯 원천 'rt-sales.summary'(F-04-1, ADR-0360 결정 9의 WidgetSource 포트). 관제 실시간 표 보드의 회차 스냅숏을
// 판매 중 탭 '구역별 잔여석'·판매 누적·머리 신선도 값으로 옮긴다(docs/streaming.md §4.1·§4.5, control-tower §2 '판매 진행 중').
// - 회차가 없으면 읽을 것이 없어 원천 실패다(위젯은 '받지 못함'). 보드가 한 번도 못 읽었으면 같다
// - 그래프 창(range)은 쓰지 않는다: 이 키는 지금 값만 싣는다(1초 칸 그래프는 원인 패널 몫)
// - 계산은 보드가 회차마다 0.5초에 한 번 한 값을 나눠 쓴다. 위젯 흐름은 (회차, 키)마다 1초에 한 번 부른다
import { WidgetSourceUnavailable, type WidgetKey, type WidgetReadQuery, type WidgetSource } from '../../live/index.js';
import type { RtBoard } from './rt-board.js';

export const RT_WIDGET_KEY = 'rt-sales.summary' as const;

export class RtWidgetSource implements WidgetSource {
  readonly keys: readonly WidgetKey[] = [RT_WIDGET_KEY];

  constructor(private readonly board: Pick<RtBoard, 'snapshot'>) {}

  async read(key: WidgetKey, q: WidgetReadQuery) {
    if (key !== RT_WIDGET_KEY) throw new WidgetSourceUnavailable(`모르는 키 ${key}`);
    if (!q.eventId) throw new WidgetSourceUnavailable('회차가 없다');
    let s;
    try {
      s = await this.board.snapshot(q.eventId, q.nowMs);
    } catch (err) {
      throw new WidgetSourceUnavailable(err instanceof Error ? err.name : 'rt');
    }
    const c = s.cumulative;
    const sectionIds = [...new Set([...Object.keys(c.soldSeatsBySection), ...Object.keys(s.remaining?.bySection ?? {})])].filter((id) => id !== '').sort();
    return {
      widgetKey: RT_WIDGET_KEY,
      source: 'clickhouse' as const,
      at: new Date(s.readAtMs).toISOString(),
      eventId: q.eventId,
      sold: c.soldSeats,
      remaining: s.remaining ? s.remaining.total : null,
      salesAmount: c.salesAmount,
      ordersConfirmed: c.ordersConfirmed,
      ticketsIssued: c.ticketsIssued,
      waiting: c.queue.waiting,
      queueEntries: c.queue.entries,
      sections: sectionIds.map((sectionId) => ({
        sectionId,
        sold: c.soldSeatsBySection[sectionId] ?? 0,
        remaining: s.remaining ? (s.remaining.bySection[sectionId] ?? null) : null,
      })),
      freshnessSeconds: s.freshness.headSeconds,
      degraded: s.degraded,
      tradeGap: s.tradeGap,
    };
  }
}
