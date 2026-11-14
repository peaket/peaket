// 회차 취소 요청 모듈 조립. AppModule이 저장소와 purchase-svc 일괄 환불 시작기를 골라 넘긴다.
import { type DynamicModule, Module } from '@nestjs/common';
import { EventCancellations } from './application/event-cancellations.js';
import type { EventCancellationStore, EventRefundStarter } from './domain/ports.js';
import { EventCancellationsController } from './inbound/event-cancellations.controller.js';

export interface EventCancellationsModuleDeps {
  readonly store: EventCancellationStore;
  /** 없으면 확정·정지·재개가 503이다 */
  readonly refunds?: EventRefundStarter;
}

@Module({})
export class EventCancellationsModule {
  static register(deps: EventCancellationsModuleDeps): DynamicModule {
    return {
      module: EventCancellationsModule,
      controllers: [EventCancellationsController],
      providers: [{ provide: EventCancellations, useFactory: () => new EventCancellations(deps.store, deps.refunds) }],
    };
  }
}
