// 시험용 실시간 표 원천(RtQuerySource·SeatMapSource 짝 가짜). 행 모양은 rt 뷰 셋과 bronze.brz_ref_seat_map을 ClickHouseRtSource가 바꾼 모양과 같다
// (같은 RtBoard를 실제 ClickHouse에 돌리는 통합 시험 test-int/realtime-table.int.test.ts가 진짜 쪽을 본다).
// 조회 수를 세고, 원천마다 실패를 켤 수 있다(ClickHouse 장애 흉내).
import { RtSourceFailure, type BucketRow, type CumulativeRow, type FreshnessRow, type SeatMapRow } from '../domain/realtime-table.js';
import type { RtQuerySource, SeatMapSource } from '../domain/ports.js';

export type MemoryRtPart = 'cumulative' | 'buckets' | 'freshness' | 'seatMap';

export class MemoryRtSource implements RtQuerySource, SeatMapSource {
  readonly cumulativeRows = new Map<string, readonly CumulativeRow[]>();
  readonly bucketRows = new Map<string, readonly BucketRow[]>();
  readonly seatMapRows = new Map<string, readonly SeatMapRow[]>();
  freshnessRows: readonly FreshnessRow[] = [];
  /** 켜 둔 원천은 RtSourceFailure를 던진다 */
  readonly failing = new Set<MemoryRtPart>();
  readonly reads: Record<MemoryRtPart, number> = { cumulative: 0, buckets: 0, freshness: 0, seatMap: 0 };
  /** 마지막 1초 칸 조회의 fromMs */
  lastBucketFromMs: number | undefined;

  async cumulative(eventId: string): Promise<readonly CumulativeRow[]> {
    this.#hit('cumulative');
    return this.cumulativeRows.get(eventId) ?? [];
  }

  async buckets(eventId: string, fromMs: number): Promise<readonly BucketRow[]> {
    this.#hit('buckets');
    this.lastBucketFromMs = fromMs;
    return (this.bucketRows.get(eventId) ?? []).filter((r) => r.secondMs >= fromMs);
  }

  async freshness(): Promise<readonly FreshnessRow[]> {
    this.#hit('freshness');
    return this.freshnessRows;
  }

  async seatMap(eventId: string): Promise<readonly SeatMapRow[]> {
    this.#hit('seatMap');
    return this.seatMapRows.get(eventId) ?? [];
  }

  #hit(part: MemoryRtPart): void {
    this.reads[part] += 1;
    if (this.failing.has(part)) throw new RtSourceFailure(`memory ${part} failing`);
  }
}
