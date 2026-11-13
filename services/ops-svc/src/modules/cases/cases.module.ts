// CS 처리함 모듈(BAT-425 GAT-130). 저장소는 AppModule이 DB/메모리로 골라 넘긴다.
import { type DynamicModule, Module } from '@nestjs/common';
import { INTERNAL_TOKEN, InternalTokenGuard } from '@peaket/platform';
import { ReceiveCaseRequested } from './application/receive-case-requested.js';
import type { CsCaseStore } from './domain/cs-case.js';
import { CasesController } from './inbound/cases.controller.js';

@Module({})
export class CasesModule {
  static register(store: CsCaseStore): DynamicModule {
    return {
      module: CasesModule,
      controllers: [CasesController],
      providers: [
        { provide: ReceiveCaseRequested, useFactory: () => new ReceiveCaseRequested(store) },
        { provide: INTERNAL_TOKEN, useValue: process.env.PEAKET_INTERNAL_TOKEN },
        InternalTokenGuard,
      ],
    };
  }
}
