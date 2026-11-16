// 판매 중지 확인의 PostgreSQL 어댑터(BAT-420 GAT-110 Q, 빈 뼈대). ops_command의 마지막 SUCCEEDED SALE_STOP·SALE_RESUME을 본다.
import type { Database } from '@peaket/platform';
import type { SaleSuspensionLookup } from '../../domain/ports.js';

export class DrizzleSaleSuspensionLookup implements SaleSuspensionLookup {
  constructor(private readonly database: Database) {}

  async isSuspended(_eventId: string): Promise<boolean> {
    void this.database;
    throw new Error('아직 없음');
  }
}
