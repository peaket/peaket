// 뿌리 모듈: 운영 명령·CS 처리함의 저장소를 DB/메모리로 골라 싣는다.
import { type DynamicModule, Module } from '@nestjs/common';
import { type Database, databaseModule } from '@peaket/platform';
import { AuditCheckpointService, AuditModule, DrizzleAuditChain, DrizzleAuditCheckpointStore, MemoryAuditChain, MemoryAuditCheckpointStore, ephemeralAuditAnchorSigner, type AuditAnchorSigner } from './modules/audit/index.js';
import { CommandsModule, type CommandExecutor, type HandleCommandEvent } from './modules/commands/index.js';
import { DrizzleCommandStore, MemoryCommandStore } from './modules/commands/index.js';
import { CasesModule, DrizzleCsCaseStore, MemoryCsCaseStore } from './modules/cases/index.js';
import { AlertsModule, DrizzleOpsAlertStore, MemoryOpsAlertStore } from './modules/alerts/index.js';
import { LiveModule, OpsLiveFeed } from './modules/live/index.js';
import { PriorityModule, type PriorityModuleDeps } from './modules/priority/index.js';

interface CommonWiring {
  readonly executor?: CommandExecutor;
  /** 우선 구매 권리 발급·회수(GAT-135). 없으면 그 경로를 열지 않는다 */
  readonly priority?: PriorityModuleDeps;
  /** 시험에서 체크포인트 시각을 고정한다. 없으면 Date.now */
  readonly nowMs?: number;
  /** Kafka 소비자(ops.command-events)가 쓸 처리기(BAT-465 R-584). HTTP 수신기와 같은 객체다 */
  readonly onCommandEvent?: (h: HandleCommandEvent) => void;
  /** 감사 체크포인트 공개 앵커 서명기(BAT-465 R-584). 없으면 임시 Ed25519 키를 쓴다(시험) */
  readonly signer?: AuditAnchorSigner;
}

@Module({})
export class AppModule {
  static register(o: ({ database: Database } & CommonWiring) | ({ memory: true } & CommonWiring)): DynamicModule {
    const signer = o.signer ?? ephemeralAuditAnchorSigner();
    if ('database' in o) {
      const chain = new DrizzleAuditChain(o.database);
      const checkpoints = new AuditCheckpointService(new DrizzleAuditCheckpointStore(o.database), chain, () => o.nowMs ?? Date.now(), signer);
      const store = new DrizzleCommandStore(o.database);
      return {
        module: AppModule,
        imports: [
          databaseModule(o.database),
          CommandsModule.register(store, o.executor, checkpoints, o.onCommandEvent),
          AuditModule.register(checkpoints, signer),
          LiveModule.register(new OpsLiveFeed({ commands: store, checkpoints })),
          CasesModule.register(new DrizzleCsCaseStore(o.database)),
          AlertsModule.register(new DrizzleOpsAlertStore(o.database)),
          ...(o.priority ? [PriorityModule.register(o.priority)] : []),
        ],
      };
    }
    const chain = new MemoryAuditChain();
    const checkpoints = new AuditCheckpointService(new MemoryAuditCheckpointStore(), chain, () => o.nowMs ?? Date.now(), signer);
    const store = new MemoryCommandStore(chain);
    return {
      module: AppModule,
      imports: [
        CommandsModule.register(store, o.executor, checkpoints, o.onCommandEvent),
        AuditModule.register(checkpoints, signer),
        LiveModule.register(new OpsLiveFeed({ commands: store, checkpoints })),
        CasesModule.register(new MemoryCsCaseStore()),
        AlertsModule.register(new MemoryOpsAlertStore()),
        ...(o.priority ? [PriorityModule.register(o.priority)] : []),
      ],
    };
  }
}
