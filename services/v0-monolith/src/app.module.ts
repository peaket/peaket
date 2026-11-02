// 뿌리 모듈: v0 모놀리스의 모듈을 모은다. 모듈 경계는 v1 서비스와 같다(docs/architecture.md §9.3).
// 대기열 v0(queue), 좌석 v0(inventory), 주문·결제·발권 v0(booking·payment·ticket)가 있다.
import { type DynamicModule, Module } from '@nestjs/common';
import { BookingModule } from './modules/booking/index.js';
import { InventoryModule, type InventoryModuleOptions } from './modules/inventory/index.js';
import type { PaymentGatewayPort } from './modules/payment/index.js';
import { QueueModule, type QueueModuleOptions } from './modules/queue/index.js';
import { TicketModule } from './modules/ticket/index.js';

export interface SaleOptions {
  /** 결제사 연결(payment 모듈의 createV0PaymentGateway). 주문·결제·발권은 좌석 v0와 같은 DB를 쓴다 */
  gateway: PaymentGatewayPort;
}

export interface AppOptions {
  queue: QueueModuleOptions;
  /** 없으면 좌석 v0를 띄우지 않는다(대기열만 시험할 때) */
  inventory?: InventoryModuleOptions;
  /** 없으면 주문·결제·발권 v0를 띄우지 않는다. 있으면 inventory도 있어야 한다 */
  sale?: SaleOptions;
}

@Module({})
export class AppModule {
  static register(o: AppOptions): DynamicModule {
    const imports: DynamicModule[] = [QueueModule.register(o.queue)];
    if (o.inventory) imports.push(InventoryModule.register(o.inventory));
    if (o.sale) {
      if (!o.inventory) throw new Error('주문·결제·발권 v0는 좌석 v0(inventory)와 함께 띄운다');
      imports.push(BookingModule.register({ database: o.inventory.database, gateway: o.sale.gateway }));
      imports.push(TicketModule.register({ database: o.inventory.database }));
    }
    return { module: AppModule, imports };
  }
}
