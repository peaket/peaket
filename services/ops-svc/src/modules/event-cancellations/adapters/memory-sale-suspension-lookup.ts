// 판매 중지 확인의 메모리 어댑터(BAT-420 GAT-110 Q, transfer-refund §5 '요청 두 길'). 메모리 명령 저장소의 SALE_STOP·SALE_RESUME 기록을 읽는다.
// 그 회차의 SUCCEEDED 명령 가운데 마지막(끝난 시각, 같으면 명령 ID가 큰 것)이 SALE_STOP이면 판매 중지다(Drizzle 어댑터와 같은 차례).
import type { Command, CommandStore } from '../../commands/index.js';
import type { SaleSuspensionLookup } from '../domain/ports.js';

const PAGE = 100;

export class MemorySaleSuspensionLookup implements SaleSuspensionLookup {
  constructor(private readonly commands: CommandStore) {}

  async isSuspended(eventId: string): Promise<boolean> {
    let last: Command | undefined;
    let cursor: string | undefined;
    do {
      const page = await this.commands.list({ eventId, states: ['SUCCEEDED'], limit: PAGE, ...(cursor !== undefined ? { cursor } : {}) });
      for (const c of page.items) {
        if (c.type !== 'SALE_STOP' && c.type !== 'SALE_RESUME') continue;
        if (!last || c.updatedAtMs > last.updatedAtMs || (c.updatedAtMs === last.updatedAtMs && c.commandId > last.commandId)) last = c;
      }
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return last?.type === 'SALE_STOP';
  }
}
