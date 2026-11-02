// 뿌리 모듈: v0 모놀리스의 모듈을 모은다. 모듈 경계는 v1 서비스와 같다(docs/architecture.md §9.3).
// 지금은 대기열 v0(queue)만 있다. 좌석(inventory·booking)·결제·발권 v0는 wbs 1.1.2·1.1.3에서 더한다.
import { type DynamicModule, Module } from '@nestjs/common';
import { QueueModule, type QueueModuleOptions } from './modules/queue/index.js';

export interface AppOptions {
  queue: QueueModuleOptions;
}

@Module({})
export class AppModule {
  static register(o: AppOptions): DynamicModule {
    return { module: AppModule, imports: [QueueModule.register(o.queue)] };
  }
}
