// 감사 체크포인트 모듈(BAT-465 GAT-310·R-584). 서비스는 AppModule이 DB/메모리로 골라 넘긴다.
import { type DynamicModule, Module } from '@nestjs/common';
import type { AuditAnchorSigner } from './anchor.js';
import { AuditCheckpointService } from './checkpoint.js';
import { AuditAnchorsController, AuditCheckpointsController } from './inbound/checkpoints.controller.js';
import { AUDIT_ANCHOR_SIGNER, AUDIT_CHECKPOINTS } from './tokens.js';

export { AUDIT_ANCHOR_SIGNER, AUDIT_CHECKPOINTS } from './tokens.js';

@Module({})
export class AuditModule {
  static register(checkpoints: AuditCheckpointService, signer: AuditAnchorSigner): DynamicModule {
    return {
      module: AuditModule,
      controllers: [AuditCheckpointsController, AuditAnchorsController],
      providers: [
        { provide: AuditCheckpointService, useValue: checkpoints },
        { provide: AUDIT_CHECKPOINTS, useValue: checkpoints },
        { provide: AUDIT_ANCHOR_SIGNER, useValue: signer },
      ],
    };
  }
}
