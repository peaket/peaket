// 내부 명령 사건 수신(BAT-465 GAT-300·R-584). Kafka 소비자(ops.command-events)와 같은 처리기를 부르는 HTTP 호환 경로다.
// eventKey로 명령 ID를 결정해 같은 사건이 다시 와도 한 번만 만든다. CS 사건은 기존 /internal/v1/cs-cases가 받는다.
import { Body, Controller, HttpCode, Inject, Post, UseGuards } from '@nestjs/common';
import { CLOCK, type Clock, ContractRouteSchema, InternalTokenGuard, Roles } from '@peaket/platform';
import { CommandEventBody, CommandEventResponse, HandleCommandEvent, commandIdOfEventKey } from '../application/handle-command-event.js';
import { CreateCommand } from '../application/create-command.js';
import type { CommandStore } from '../domain/ports.js';
import { COMMAND_STORE } from '../tokens.js';

export { commandIdOfEventKey } from '../application/handle-command-event.js';

@Controller('internal/v1/ops/command-events')
@UseGuards(InternalTokenGuard)
export class InternalCommandEventsController {
  readonly #handler: HandleCommandEvent;

  constructor(
    createCommand: CreateCommand,
    @Inject(COMMAND_STORE) store: CommandStore,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    this.#handler = new HandleCommandEvent({ createCommand, store });
  }

  @Post()
  @HttpCode(202)
  @Roles(['public'])
  @ContractRouteSchema({ responses: { 202: CommandEventResponse } })
  async handle(@Body() body: unknown): Promise<CommandEventResponse> {
    const parsed = CommandEventBody.safeParse(body);
    if (!parsed.success) return { accepted: false };
    return this.#handler.run(parsed.data, this.clock.now());
  }
}
