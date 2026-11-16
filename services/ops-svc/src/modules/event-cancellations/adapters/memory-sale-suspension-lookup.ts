// 판매 중지 확인의 메모리 어댑터(BAT-420 GAT-110 Q, 빈 뼈대). 메모리 명령 저장소의 SALE_STOP·SALE_RESUME 기록을 읽는다.
import type { CommandStore } from '../../commands/index.js';
import type { SaleSuspensionLookup } from '../domain/ports.js';

export class MemorySaleSuspensionLookup implements SaleSuspensionLookup {
  constructor(private readonly commands: CommandStore) {}

  async isSuspended(_eventId: string): Promise<boolean> {
    void this.commands;
    throw new Error('아직 없음');
  }
}
