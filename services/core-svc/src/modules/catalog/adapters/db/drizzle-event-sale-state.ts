// F-07-12 RV-02: 회차 판매 상태 사건을 core DB에 쓰는 어댑터(core_app 연결).
// 쓰기는 0055의 SECURITY DEFINER 함수 search_apply_event_sale 하나가 맡는다: 판 번호 비교, event_sale_state 쓰기,
// search_document.sale_status·search_version 갱신을 한 트랜잭션에 한다. 앱은 표 권한 없이 EXECUTE만 갖는다.
import type { Database } from '@peaket/platform';
import { sql } from 'drizzle-orm';
import type { EventSaleApplyResult, EventSaleStateStore, EventSaleStatusEvent } from '../../domain/event-sale-state.js';

const rowsOf = <T>(result: unknown): T[] => ((result as { rows?: T[] }).rows ?? (result as T[])) as T[];

export class DrizzleEventSaleStateStore implements EventSaleStateStore {
  constructor(private readonly db: Database) {}

  async apply(e: EventSaleStatusEvent): Promise<EventSaleApplyResult> {
    const rows = rowsOf<{ result: string }>(
      await this.db.db.execute(
        sql`select search_apply_event_sale(${e.eventId}::uuid, ${e.status}, ${e.version}, ${e.changedAt}::timestamptz) as result`,
      ),
    );
    const result = rows[0]?.result;
    if (result === 'applied' || result === 'stale' || result === 'unknown') return result;
    throw new Error('search_apply_event_sale가 알 수 없는 값을 돌려줬다');
  }
}
