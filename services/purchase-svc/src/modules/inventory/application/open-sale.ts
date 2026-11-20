// 유스케이스: 승인된 회차의 판매 열기(BAT-616 LCH-080, ADR-0327, seat-hold §6 '판매 열기와의 차례').
// 차례: ① event_sale UPCOMING 행 ② seat_rebuild 판 번호 1 표시 ③ 좌석 비트맵·세대 키·s:ctl:events(openSale).
// 같은 회차를 다시 열어도 행·판·비트맵을 새로 만들지 않는다(각 단계가 멱등이다). 좌석맵 판이 없거나 판매가 끝났으면 409 sale-not-publishable로 닫는다.
// 좌석 Redis 장애는 503 seat-store-unavailable이고, 그때도 UPCOMING 행·표시는 남을 수 있다(다음 호출이 이어서 연다).
import type { Clock } from '@peaket/platform';
import type { EventSaleStore, SeatMap, SeatRebuildMarks, SeatStore } from '../domain/ports.js';
import { SaleConfigUnavailable } from '../domain/sale-config.js';
import { KEEP_AFTER_SALE_END_MS, SeatStoreUnavailable } from '../domain/hold.js';

export const SALE_NOT_PUBLISHABLE = 'sale-not-publishable';
export const SEAT_STORE_UNAVAILABLE = 'seat-store-unavailable';

export class OpenSaleError extends Error {
  constructor(readonly code: typeof SALE_NOT_PUBLISHABLE | typeof SEAT_STORE_UNAVAILABLE) {
    super(code);
    this.name = 'OpenSaleError';
  }
}

export interface OpenSaleDeps {
  events: EventSaleStore;
  marks: SeatRebuildMarks;
  seats: Pick<SeatStore, 'openSale'>;
  seatMap: Pick<SeatMap, 'config'>;
  clock: Clock;
}

export interface OpenSaleResult {
  /** 이번 호출이 좌석 비트맵·세대 키를 새로 만들었는지 */
  opened: boolean;
  /** 이번 호출이 event_sale UPCOMING 행을 새로 만들었는지 */
  upcomingCreated: boolean;
  seatEpoch: number;
}

export class OpenSale {
  constructor(private readonly deps: OpenSaleDeps) {}

  async run(q: { eventId: string; openAtMs: number; startsAtMs: number }): Promise<OpenSaleResult> {
    let config: Awaited<ReturnType<SeatMap['config']>>;
    try {
      config = await this.deps.seatMap.config(q.eventId);
    } catch (err) {
      // core 판매 설정 사본을 읽지 못한 것도 열지 못한 것이다(닫힌 쪽). 정비 일이 다시 시도한다
      if (err instanceof SaleConfigUnavailable) throw new OpenSaleError(SEAT_STORE_UNAVAILABLE);
      throw err;
    }
    if (!config) throw new OpenSaleError(SALE_NOT_PUBLISHABLE);
    const now = this.deps.clock.now();
    // 판매 종료(공연 시작 24시간 전)가 지난 회차는 열지 않는다(ADR-0064)
    if (now >= config.saleEndsAtMs) throw new OpenSaleError(SALE_NOT_PUBLISHABLE);
    const createUpcoming = this.deps.events.createUpcoming?.bind(this.deps.events);
    if (!createUpcoming) throw new Error('EventSaleStore.createUpcoming이 없다(판매 열기 조립이 틀렸다)');
    const created = await createUpcoming({ eventId: q.eventId, openAtMs: q.openAtMs, sellableSeats: config.seatCount, nowMs: now });
    // 다시 만들기 반복이 이 회차를 알게 판 번호 1 표시를 남긴다(판매 열기 전에 부른다)
    await this.deps.marks.markOpened(q.eventId);
    try {
      const opened = await this.deps.seats.openSale({ eventId: q.eventId, seatCount: config.seatCount, keepUntilMs: Math.max(q.startsAtMs, config.saleEndsAtMs + KEEP_AFTER_SALE_END_MS) });
      return { opened: opened.created, upcomingCreated: created !== undefined, seatEpoch: opened.seatEpoch };
    } catch (err) {
      if (err instanceof SeatStoreUnavailable) throw new OpenSaleError(SEAT_STORE_UNAVAILABLE);
      throw err;
    }
  }
}
