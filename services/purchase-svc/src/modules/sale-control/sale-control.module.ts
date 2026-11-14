// 판매 중지·재개 모듈(BAT-465 R-584, ADR-0123). 저장소와 사본은 AppModule/start가 골라 넘긴다.
import { type DynamicModule, Module, type Provider } from '@nestjs/common';
import { INTERNAL_TOKEN, InternalTokenGuard } from '@peaket/platform';
import { SetSaleSuspension } from './application/set-sale-suspension.js';
import type { SaleControlCopies, SaleControlStore } from './domain/ports.js';
import { SaleSuspensionController } from './inbound/sale-suspension.controller.js';

export interface SaleControlModuleDeps {
  readonly store: SaleControlStore;
  readonly copies?: SaleControlCopies;
}

@Module({})
export class SaleControlModule {
  static register(deps: SaleControlModuleDeps): DynamicModule {
    const providers: Provider[] = [
      { provide: SetSaleSuspension, useFactory: () => new SetSaleSuspension(deps.store, deps.copies) },
      { provide: INTERNAL_TOKEN, useValue: process.env.PEAKET_INTERNAL_TOKEN },
      InternalTokenGuard,
    ];
    return { module: SaleControlModule, controllers: [SaleSuspensionController], providers };
  }
}
