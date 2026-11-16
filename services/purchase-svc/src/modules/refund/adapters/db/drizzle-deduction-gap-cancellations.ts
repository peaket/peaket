// 회차 취소 확정 전에 공제하고 보낸 입장 시작 뒤 취소(차액 CS 건 대상) 읽기(BAT-420 몫 D, OPEN[45] 결정, 빈 뼈대).
import type { Database } from '@peaket/platform';
import type { DeductionGapCancellations } from '../../domain/event-refund-ports.js';

export class DrizzleDeductionGapCancellations implements DeductionGapCancellations {
  constructor(private readonly database: Database) {}

  async list(_eventId: string, _entryOpensAtMs: number): ReturnType<DeductionGapCancellations['list']> {
    void this.database;
    throw new Error('아직 없음');
  }
}
