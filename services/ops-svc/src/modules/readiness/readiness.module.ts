// 회차 단계·T-30분 점검·Go/No-Go 판정 컨텍스트 조립(F-03-3 OPS-380, ADR-0371). AppModule이 아니라 LiveModule.register의 imports로 싣는다
// (app.module.ts를 고치지 않으려는 것, 계획 '감독에게' 3 (가)). 원천과 저장소는 부르는 쪽(live-wiring)이 고른다.
import { type DynamicModule, Module } from '@nestjs/common';
import { ReadinessService, type ReadinessServiceDeps } from './application/readiness-service.js';
import { ReadinessController } from './inbound/readiness.controller.js';

@Module({})
export class ReadinessModule {
  /** deps는 팩토리로 받는다(DATABASE·시계를 주입받아 고르는 쪽이 live 모듈이다) */
  static register(provider: { useFactory: (...args: never[]) => ReadinessServiceDeps | Promise<ReadinessServiceDeps>; inject: unknown[] }): DynamicModule {
    return {
      module: ReadinessModule,
      controllers: [ReadinessController],
      providers: [
        {
          provide: ReadinessService,
          useFactory: async (...args: never[]) => new ReadinessService(await provider.useFactory(...args)),
          inject: provider.inject as never[],
        },
      ],
      exports: [ReadinessService],
    };
  }
}
