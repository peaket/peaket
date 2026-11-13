// 뿌리 모듈: 운영 명령·CS 처리함의 저장소를 DB/메모리로 골라 싣는다.
import { type DynamicModule, Module } from '@nestjs/common';
import { type Database, databaseModule } from '@peaket/platform';
import { CommandsModule, type CommandDispatcher } from './modules/commands/index.js';
import { DrizzleCommandStore, MemoryCommandStore } from './modules/commands/index.js';
import { CasesModule, DrizzleCsCaseStore, MemoryCsCaseStore } from './modules/cases/index.js';
import { MemoryAuditChain } from './modules/audit/index.js';

@Module({})
export class AppModule {
  static register(o: { database: Database; dispatcher?: CommandDispatcher } | { memory: true; dispatcher?: CommandDispatcher }): DynamicModule {
    if ('database' in o) {
      return {
        module: AppModule,
        imports: [databaseModule(o.database), CommandsModule.register(new DrizzleCommandStore(o.database), o.dispatcher), CasesModule.register(new DrizzleCsCaseStore(o.database))],
      };
    }
    return { module: AppModule, imports: [CommandsModule.register(new MemoryCommandStore(new MemoryAuditChain()), o.dispatcher), CasesModule.register(new MemoryCsCaseStore())] };
  }
}
