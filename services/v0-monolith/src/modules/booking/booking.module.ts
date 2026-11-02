// 모듈 조립 파일: 주문 v0 포트에 어댑터와 다른 모듈의 공개 함수를 묶는다(층 규칙의 밖).
import { type DynamicModule, Module } from '@nestjs/common';
import type { Database } from '@peaket/platform';
import { createSeatSales } from '../inventory/index.js';
import { createPayments, type PaymentGatewayPort } from '../payment/index.js';
import { createTicketIssuer } from '../ticket/index.js';
import { DrizzleOrderStore } from './adapters/db/drizzle-order-store.js';
import { BookingService } from './application/booking-service.js';
import { ORDER_STORE, PAYMENTS, SEAT_SALES, TICKETS } from './domain/ports.js';
import { OrderController } from './inbound/order.controller.js';

export interface BookingModuleOptions {
  /** 주문·결제·발권·좌석 v0 DB(같은 DB) */
  database: Database;
  /** 결제사 연결(payment 모듈의 createV0PaymentGateway, 시험은 시뮬레이터를 가리킨다) */
  gateway: PaymentGatewayPort;
}

@Module({})
export class BookingModule {
  static register(o: BookingModuleOptions): DynamicModule {
    return {
      module: BookingModule,
      controllers: [OrderController],
      providers: [
        BookingService,
        { provide: ORDER_STORE, useValue: new DrizzleOrderStore(o.database) },
        { provide: SEAT_SALES, useValue: createSeatSales(o.database) },
        { provide: PAYMENTS, useValue: createPayments(o.database, o.gateway) },
        { provide: TICKETS, useValue: createTicketIssuer(o.database) },
      ],
    };
  }
}
