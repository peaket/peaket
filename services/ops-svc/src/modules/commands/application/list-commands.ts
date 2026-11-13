// 운영 명령 목록(GAT-110 첫 몫). 최신순, 커서는 (만든 시각, 명령 ID)다.
import type { CommandPage, CommandStore } from '../domain/ports.js';
import type { CommandListQuery } from '../domain/ports.js';

export class ListCommands {
  constructor(private readonly store: CommandStore) {}

  execute(query: CommandListQuery): Promise<CommandPage> {
    return this.store.list(query);
  }
}
