// 탈퇴 계정의 사람 키 만료 당기기의 메모리 대역(로컬·시험, BUILD_ORDER BOT-037). 메모리 저장소의 키에는 만료를 걸지 않고 받은 요청만 남긴다.
import type { WithdrawnKeys } from '../domain/ports.js';

export class MemoryWithdrawnKeys implements WithdrawnKeys {
  readonly requests: { pid: string; eventIds: string[]; at: number }[] = [];

  constructor(private readonly events: readonly string[] = []) {}

  async activeEvents(): Promise<string[]> {
    return [...this.events];
  }

  async expireBy(pid: string, eventIds: readonly string[], at: number): Promise<number> {
    this.requests.push({ pid, eventIds: [...eventIds], at });
    return 0;
  }
}
