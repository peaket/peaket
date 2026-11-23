// 실시간 표 원천 주소(PEAKET_RT_CLICKHOUSE_URL)가 없을 때의 닫힌 대역. 모든 조회가 RtSourceFailure라
// 파트너 판매 현황은 503 dependency-unavailable이고 신선도는 모름(나쁨)으로 보인다.
import { RtSourceFailure, type BucketRow, type CumulativeRow, type FreshnessRow, type SeatMapRow } from '../domain/realtime-table.js';
import type { RtQuerySource, SeatMapSource } from '../domain/ports.js';

export class UnavailableRtSource implements RtQuerySource, SeatMapSource {
  async cumulative(): Promise<readonly CumulativeRow[]> {
    throw new RtSourceFailure('rt source is not configured');
  }

  async buckets(): Promise<readonly BucketRow[]> {
    throw new RtSourceFailure('rt source is not configured');
  }

  async freshness(): Promise<readonly FreshnessRow[]> {
    throw new RtSourceFailure('rt source is not configured');
  }

  async seatMap(): Promise<readonly SeatMapRow[]> {
    throw new RtSourceFailure('rt source is not configured');
  }
}
