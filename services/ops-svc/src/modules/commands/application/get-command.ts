// 운영 명령 상세(GAT-110 첫 몫). 승인자가 요청자·사유·params를 그대로 본다(openapi GET /v1/ops/commands/{commandId}).
import { ProblemError } from '@peaket/platform';
import type { Command } from '../domain/command.js';
import type { CommandStore } from '../domain/ports.js';

export class GetCommand {
  constructor(private readonly store: CommandStore) {}

  async execute(commandId: string): Promise<Command> {
    const command = await this.store.find(commandId);
    if (!command) throw new ProblemError({ type: 'not-found', status: 404, title: '찾을 수 없습니다' });
    return command;
  }
}
