// 운영 명령 상세(GAT-110 첫 몫). 승인자가 요청자·사유·params를 그대로 본다(openapi GET /v1/ops/commands/{commandId}).
import { ProblemError } from '@peaket/platform';
import type { Command } from '../domain/command.js';
import type { CommandStore, ControlDeliveries } from '../domain/ports.js';

export class GetCommand {
  constructor(
    private readonly store: CommandStore,
    /** 파드마다의 ack 기록(F-02-1). 있으면 지금 판의 전파 상태(delivery)를 붙인다 */
    private readonly deliveries?: Pick<ControlDeliveries, 'summary'>,
  ) {}

  async execute(commandId: string): Promise<Command> {
    const command = await this.store.find(commandId);
    if (!command) throw new ProblemError({ type: 'not-found', status: 404, title: '찾을 수 없습니다' });
    if (!this.deliveries || command.controlVersion === undefined) return command;
    const delivery = await this.deliveries.summary(command.commandId, command.controlVersion);
    return delivery ? { ...command, delivery } : command;
  }
}
