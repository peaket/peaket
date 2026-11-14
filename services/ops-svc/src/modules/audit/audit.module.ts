// 감사 체크포인트 모듈(BAT-465 GAT-310). 서비스는 AppModule이 DB/메모리로 골라 넘긴다.
import { type DynamicModule, Module } from '@nestjs/common';
import { AuditCheckpointService } from './checkpoint.js';
import { AuditCheckpointsController } from './inbound/checkpoints.controller.js';

export const AUDIT_CHECKPOINTS = Symbol('ops.AUDIT_CHECKPOINTS');

@Module({})
export class AuditModule {
  static register(checkpoints: AuditCheckpointService): DynamicModule {
    return {
      module: AuditModule,
      controllers: [AuditCheckpointsController],
      providers: [
        { provide: AuditCheckpointService, useValue: checkpoints },
        { provide: AUDIT_CHECKPOINTS, useValue: checkpoints },
      ],
    };
  }
}
