// 시험용 좌석맵 판. 운영 좌석맵 판(좌석맵 파일·event_seat_price에서 읽는 회차 캐시)은 PRF-130 ①에 없다.
import { SEAT_ID_PATTERN, type SeatRef } from '../domain/hold.js';
import type { SectionRange } from '../domain/seat-layout.js';
import type { EventSeatConfig, SeatMap, SeatMapIndex, SeatMapSections } from '../domain/ports.js';

/** 좌석맵 판의 좌석 하나. saleExcluded면 그 판에 있어도 고를 수 없다(resolve가 undefined) */
export interface MemorySeatDef extends SeatRef {
  saleExcluded?: boolean;
}

interface EventEntry {
  config: EventSeatConfig;
  /** 좌석 ID → 고를 수 있는 좌석(판매 제외석은 넣지 않는다) */
  seats: Map<string, SeatRef>;
  /** 색인 → 판의 좌석(판매 제외석 포함, 판매 제외 표시 없이) */
  byIndex: Map<number, SeatRef>;
  /** 구역 비트맵 범위(구역 색인 오름차순) */
  sections: SectionRange[];
}

const isNonNegativeInt = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

/** 판매 제외 표시를 뺀 좌석 사본 */
const refOf = (s: SeatRef): SeatRef => ({ seatId: s.seatId, index: s.index, sectionId: s.sectionId, sectionIndex: s.sectionIndex, seatOffset: s.seatOffset, tierId: s.tierId });

/** SeatMap·SeatMapIndex의 메모리 구현. 시험이 put으로 회차를 넣는다 */
export class MemorySeatMap implements SeatMap, SeatMapIndex, SeatMapSections {
  readonly #events = new Map<string, EventEntry>();

  /**
   * 회차 하나의 설정과 좌석을 넣는다(같은 회차를 다시 넣으면 통째로 바꾼다). 좌석 ID나 색인이 겹치거나, 색인이 0 ~ seatCount − 1 밖이거나,
   * 구역 색인·구역 안 거리가 0 이상의 정수가 아니거나, 좌석 ID가 SEAT_ID_PATTERN 모양이 아니면 RangeError(아무것도 바꾸지 않는다).
   */
  put(config: EventSeatConfig, seats: readonly MemorySeatDef[]): void {
    if (!Number.isSafeInteger(config.seatCount) || config.seatCount < 1) throw new RangeError(`회차 좌석 수는 1 이상의 정수다: ${config.seatCount}`);
    const ids = new Set<string>();
    const indexes = new Set<number>();
    const usable = new Map<string, SeatRef>();
    const all = new Map<number, SeatRef>();
    for (const s of seats) {
      const where = JSON.stringify(s);
      if (typeof s.seatId !== 'string' || !SEAT_ID_PATTERN.test(s.seatId)) throw new RangeError(`좌석 ID 모양이 틀렸다: ${where}`);
      if (!isNonNegativeInt(s.index) || s.index >= config.seatCount) throw new RangeError(`좌석 색인은 0 ~ ${config.seatCount - 1}의 정수다: ${where}`);
      if (!isNonNegativeInt(s.sectionIndex)) throw new RangeError(`구역 색인은 0 이상의 정수다: ${where}`);
      if (!isNonNegativeInt(s.seatOffset)) throw new RangeError(`구역 안 거리는 0 이상의 정수다: ${where}`);
      if (ids.has(s.seatId)) throw new RangeError(`좌석 ID가 겹친다: ${s.seatId}`);
      if (indexes.has(s.index)) throw new RangeError(`좌석 색인이 겹친다: ${s.index}`);
      ids.add(s.seatId);
      indexes.add(s.index);
      if (!s.saleExcluded) usable.set(s.seatId, refOf(s));
      all.set(s.index, refOf(s));
    }
    const ranges = new Map<number, SectionRange>();
    for (const s of seats) {
      const r = ranges.get(s.sectionIndex);
      if (!r) ranges.set(s.sectionIndex, { sectionIndex: s.sectionIndex, sectionId: s.sectionId, from: s.index, to: s.index });
      else {
        r.from = Math.min(r.from, s.index);
        r.to = Math.max(r.to, s.index);
      }
    }
    const sections = [...ranges.values()].sort((a, b) => a.sectionIndex - b.sectionIndex);
    this.#events.set(config.eventId, { config: { ...config }, seats: usable, byIndex: all, sections });
  }

  /** 넣은 회차 설정의 사본(없으면 undefined) */
  async config(eventId: string): Promise<EventSeatConfig | undefined> {
    const e = this.#events.get(eventId);
    return e ? { ...e.config } : undefined;
  }

  /** SeatMap.resolve와 같다: 같은 길이·차례, 없는 좌석·판매 제외석·넣지 않은 회차는 undefined. 판매 제외 표시는 돌려주는 SeatRef에 싣지 않는다 */
  async resolve(eventId: string, seatIds: readonly string[]): Promise<(SeatRef | undefined)[]> {
    const e = this.#events.get(eventId);
    return seatIds.map((id) => {
      const s = e?.seats.get(id);
      return s ? refOf(s) : undefined;
    });
  }

  /**
   * SeatMapIndex.byIndex와 같다(BUILD_ORDER PRF-135): 같은 길이·차례, put에 넣은 좌석이면 판매 제외석도 그 좌석(판매 제외 표시 없이 사본),
   * 넣지 않은 색인·넣지 않은 회차는 undefined. put으로 회차를 바꾸면 바꾼 판을 본다
   */
  async byIndex(eventId: string, indexes: readonly number[]): Promise<(SeatRef | undefined)[]> {
    const e = this.#events.get(eventId);
    return indexes.map((i) => {
      const s = e?.byIndex.get(i);
      return s ? refOf(s) : undefined;
    });
  }

  /**
   * SeatMapSections.sections와 같다(BUILD_ORDER PRF-137): put에 넣은 좌석을 구역 색인별로 묶어 가장 작은·큰 색인을 범위로 한다(판매 제외석 포함, 구역 색인 오름차순).
   * 구역 ID는 그 구역 첫 좌석의 것이다. 넣지 않은 회차는 undefined
   */
  async sections(eventId: string): Promise<readonly SectionRange[] | undefined> {
    return this.#events.get(eventId)?.sections.map((r) => ({ ...r }));
  }
}
