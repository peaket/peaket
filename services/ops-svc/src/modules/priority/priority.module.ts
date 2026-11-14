// 우선 구매 권리 모듈(GAT-135). AppModule이 purchase·queue 내부 HTTP 어댑터를 골라 넘긴다.
import { type DynamicModule, Module } from '@nestjs/common';
import { GrantPriority } from './application/grant-priority.js';
import { WithdrawPriority } from './application/withdraw-priority.js';
import type { PurchasePriorityGrants, QueuePriorityGrantCopies } from './domain/priority.js';
import { PriorityGrantsController } from './inbound/priority-grants.controller.js';

export interface PriorityModuleDeps {
  readonly purchase: PurchasePriorityGrants;
  readonly copies: QueuePriorityGrantCopies;
}

@Module({})
export class PriorityModule {
  static register(deps: PriorityModuleDeps): DynamicModule {
    return {
      module: PriorityModule,
      controllers: [PriorityGrantsController],
      providers: [
        { provide: GrantPriority, useFactory: () => new GrantPriority(deps.purchase, deps.copies) },
        { provide: WithdrawPriority, useFactory: () => new WithdrawPriority(deps.purchase, deps.copies) },
      ],
    };
  }
}
