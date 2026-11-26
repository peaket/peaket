// ops-svc 팬 조회 모듈(F-06-5). 원천 포트·접속기록·감사 체인·건 저장소를 묶는다.
import { type DynamicModule, Global, Module } from '@nestjs/common';
import { CLOCK, type Clock } from '@peaket/platform';
import type { AuditChain } from '../audit/index.js';
import type { CsCaseStore } from '../cases/index.js';
import { FanLookup, type FanLookupWiring } from './application/fan-lookup.js';
import { FanLookupController } from './inbound/fan-lookup.controller.js';

export interface FanLookupModuleOptions {
  readonly wiring?: FanLookupWiring;
  readonly caseStore?: CsCaseStore;
  readonly audit?: AuditChain;
}

@Global()
@Module({})
export class FanLookupModule {
  static register(o: FanLookupModuleOptions = {}): DynamicModule {
    return {
      module: FanLookupModule,
      controllers: [FanLookupController],
      providers: [
        {
          provide: FanLookup,
          inject: [CLOCK],
          useFactory: (clock: Clock) => new FanLookup({ wiring: o.wiring ?? {}, ...(o.caseStore ? { caseStore: o.caseStore } : {}), ...(o.audit ? { audit: o.audit } : {}), clock }),
        },
      ],
      exports: [FanLookup],
    };
  }
}
