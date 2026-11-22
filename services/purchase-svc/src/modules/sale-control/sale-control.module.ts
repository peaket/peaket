// 판매 중지·재개 모듈(BAT-465 R-584, ADR-0123). 저장소와 사본은 AppModule/start가 골라 넘긴다.
import { type DynamicModule, Module, type Provider } from '@nestjs/common';
import { INTERNAL_TOKEN, InternalTokenGuard } from '@peaket/platform';
import type { SaleControlMemory } from './application/sale-control-memory.js';
import { SetSaleSuspension } from './application/set-sale-suspension.js';
import type { SaleControlCopies, SaleControlStore } from './domain/ports.js';
import { SaleSuspensionController } from './inbound/sale-suspension.controller.js';

export interface SaleControlModuleDeps {
  readonly store: SaleControlStore;
  readonly copies?: SaleControlCopies;
  /** 파드 메모리(ADR-0365 결정 7). 주면 내부 HTTP 경로의 판매 중지도 메모리에 바로 반영한다 */
  readonly memory?: SaleControlMemory;
}

@Module({})
export class SaleControlModule {
  static register(deps: SaleControlModuleDeps): DynamicModule {
    const providers: Provider[] = [
      { provide: SetSaleSuspension, useFactory: () => new SetSaleSuspension(deps.store, deps.copies, deps.memory) },
      { provide: INTERNAL_TOKEN, useValue: process.env.PEAKET_INTERNAL_TOKEN },
      InternalTokenGuard,
    ];
    return { module: SaleControlModule, controllers: [SaleSuspensionController], providers };
  }
}
