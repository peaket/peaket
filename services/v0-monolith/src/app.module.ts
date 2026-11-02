// 뿌리 모듈: v0 모놀리스의 모듈을 모은다. 모듈 경계는 v1 서비스와 같다(docs/architecture.md §9.3).
// 대기열 v0(queue)와 좌석 v0(inventory)가 있다. 주문·결제·발권 v0는 wbs 1.1.3에서 더한다.
import { type DynamicModule, Module } from '@nestjs/common';
import { InventoryModule, type InventoryModuleOptions } from './modules/inventory/index.js';
import { QueueModule, type QueueModuleOptions } from './modules/queue/index.js';

export interface AppOptions {
  queue: QueueModuleOptions;
  /** 없으면 좌석 v0를 띄우지 않는다(대기열만 시험할 때) */
  inventory?: InventoryModuleOptions;
}

@Module({})
export class AppModule {
  static register(o: AppOptions): DynamicModule {
    const imports: DynamicModule[] = [QueueModule.register(o.queue)];
    if (o.inventory) imports.push(InventoryModule.register(o.inventory));
    return { module: AppModule, imports };
  }
}
