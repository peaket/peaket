// 운영 명령 모듈(GAT-110 첫 몫). 저장소는 AppModule이 DB/메모리로 골라 넘긴다.
import { type DynamicModule, Module, type Provider } from '@nestjs/common';
import { CreateCommand } from './application/create-command.js';
import { DecideCommand } from './application/decide-command.js';
import { GetCommand } from './application/get-command.js';
import { ListCommands } from './application/list-commands.js';
import type { CommandDispatcher, CommandStore } from './domain/ports.js';
import { CommandsController } from './inbound/commands.controller.js';

export const COMMAND_STORE = Symbol('ops.COMMAND_STORE');

@Module({})
export class CommandsModule {
  static register(store: CommandStore, dispatcher?: CommandDispatcher): DynamicModule {
    const providers: Provider[] = [
      { provide: COMMAND_STORE, useValue: store },
      { provide: CreateCommand, useFactory: () => new CreateCommand(store) },
      { provide: ListCommands, useFactory: () => new ListCommands(store) },
      { provide: GetCommand, useFactory: () => new GetCommand(store) },
      { provide: DecideCommand, useFactory: () => new DecideCommand(store, dispatcher) },
    ];
    return { module: CommandsModule, controllers: [CommandsController], providers };
  }
}
