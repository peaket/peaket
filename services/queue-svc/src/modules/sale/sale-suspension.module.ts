// 판매 중지·재개의 대기열 사본 모듈(BAT-465 R-584, ADR-0123). AppModule이 저장소에 맞는 사본을 골라 넘긴다.
import { type DynamicModule, Module, type Provider } from '@nestjs/common';
import { INTERNAL_TOKEN, InternalTokenGuard } from '@peaket/platform';
import { SetSaleSuspensionCopy } from './application/set-sale-suspension-copy.js';
import type { SaleSuspensionCopies } from './domain/sale-suspension.js';
import { SaleSuspensionCopyController } from './inbound/sale-suspension-copy.controller.js';

@Module({})
export class SaleSuspensionModule {
  static register(copies: SaleSuspensionCopies): DynamicModule {
    const providers: Provider[] = [
      { provide: SetSaleSuspensionCopy, useFactory: () => new SetSaleSuspensionCopy(copies) },
      { provide: INTERNAL_TOKEN, useValue: process.env.PEAKET_INTERNAL_TOKEN },
      InternalTokenGuard,
    ];
    return { module: SaleSuspensionModule, controllers: [SaleSuspensionCopyController], providers };
  }
}
