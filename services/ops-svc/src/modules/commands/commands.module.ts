// 운영 명령 모듈(GAT-110 첫 몫, BAT-465 실행·재시도). 저장소는 AppModule이 DB/메모리로 골라 넘긴다.
import { type DynamicModule, Module, type Provider } from '@nestjs/common';
import { INTERNAL_TOKEN, InternalTokenGuard } from '@peaket/platform';
import type { AuditCheckpointService } from '../audit/index.js';
import { CreateCommand } from './application/create-command.js';
import { DecideCommand } from './application/decide-command.js';
import { ExecuteCommand } from './application/execute-command.js';
import { GetCommand } from './application/get-command.js';
import { HandleCommandEvent } from './application/handle-command-event.js';
import { ListCommands } from './application/list-commands.js';
import { RetryCommand } from './application/retry-command.js';
import type { CommandExecutor, CommandStore } from './domain/ports.js';
import { CommandsController } from './inbound/commands.controller.js';
import { InternalCommandEventsController } from './inbound/internal-command-events.controller.js';
import { COMMAND_EXECUTOR, COMMAND_STORE } from './tokens.js';

export { COMMAND_STORE, COMMAND_EXECUTOR } from './tokens.js';

@Module({})
export class CommandsModule {
  static register(store: CommandStore, executor?: CommandExecutor, checkpoints?: AuditCheckpointService, onCommandEvent?: (h: HandleCommandEvent) => void): DynamicModule {
    const execution = new ExecuteCommand(store, executor, checkpoints);
    const wired = executor ? execution : undefined;
    const createCommand = new CreateCommand(store, wired);
    // HTTP 수신기와 Kafka 소비자가 같은 처리기를 쓴다(두 길로 같은 사건이 와도 한 번만 만든다).
    onCommandEvent?.(new HandleCommandEvent({ createCommand, store }));
    const providers: Provider[] = [
      { provide: COMMAND_STORE, useValue: store },
      { provide: COMMAND_EXECUTOR, useValue: executor },
      { provide: ExecuteCommand, useValue: execution },
      { provide: CreateCommand, useValue: createCommand },
      { provide: ListCommands, useFactory: () => new ListCommands(store) },
      { provide: GetCommand, useFactory: () => new GetCommand(store) },
      { provide: DecideCommand, useFactory: () => new DecideCommand(store, wired) },
      { provide: RetryCommand, useFactory: () => new RetryCommand(store, execution) },
      { provide: INTERNAL_TOKEN, useValue: process.env.PEAKET_INTERNAL_TOKEN },
      InternalTokenGuard,
    ];
    return { module: CommandsModule, controllers: [CommandsController, InternalCommandEventsController], providers };
  }
}
