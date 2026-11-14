// 뿌리 모듈: 운영 명령·CS 처리함의 저장소를 DB/메모리로 골라 싣는다.
import { type DynamicModule, Module } from '@nestjs/common';
import { type Database, databaseModule } from '@peaket/platform';
import { AuditCheckpointService, AuditModule, DrizzleAuditChain, DrizzleAuditCheckpointStore, MemoryAuditChain, MemoryAuditCheckpointStore } from './modules/audit/index.js';
import { CommandsModule, type CommandExecutor } from './modules/commands/index.js';
import { DrizzleCommandStore, MemoryCommandStore } from './modules/commands/index.js';
import { CasesModule, DrizzleCsCaseStore, MemoryCsCaseStore } from './modules/cases/index.js';

interface CommonWiring {
  readonly executor?: CommandExecutor;
  /** 시험에서 체크포인트 시각을 고정한다. 없으면 Date.now */
  readonly nowMs?: number;
}

@Module({})
export class AppModule {
  static register(o: ({ database: Database } & CommonWiring) | ({ memory: true } & CommonWiring)): DynamicModule {
    if ('database' in o) {
      const chain = new DrizzleAuditChain(o.database);
      const checkpoints = new AuditCheckpointService(new DrizzleAuditCheckpointStore(o.database), chain, () => o.nowMs ?? Date.now());
      return {
        module: AppModule,
        imports: [
          databaseModule(o.database),
          CommandsModule.register(new DrizzleCommandStore(o.database), o.executor, checkpoints),
          AuditModule.register(checkpoints),
          CasesModule.register(new DrizzleCsCaseStore(o.database)),
        ],
      };
    }
    const chain = new MemoryAuditChain();
    const checkpoints = new AuditCheckpointService(new MemoryAuditCheckpointStore(), chain, () => o.nowMs ?? Date.now());
    return {
      module: AppModule,
      imports: [CommandsModule.register(new MemoryCommandStore(chain), o.executor, checkpoints), AuditModule.register(checkpoints), CasesModule.register(new MemoryCsCaseStore())],
    };
  }
}
