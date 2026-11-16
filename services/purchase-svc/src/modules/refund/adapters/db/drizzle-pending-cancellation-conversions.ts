// 보류 취소 전환(BAT-420 GAT-110 E, docs/data.md §5, 빈 뼈대). 주문 행 잠금 안에서 status = 'REQUESTED'인 그 행만 회차 취소 환급으로 이어 쓴다.
import type { Database } from '@peaket/platform';
import type { PendingCancellationConversions } from '../../domain/event-refund-ports.js';

export class DrizzlePendingCancellationConversions implements PendingCancellationConversions {
  constructor(private readonly database: Database) {}

  async convert(_q: Parameters<PendingCancellationConversions['convert']>[0]): Promise<'CONVERTED' | 'NOT_REQUESTED'> {
    void this.database;
    throw new Error('아직 없음');
  }
}
