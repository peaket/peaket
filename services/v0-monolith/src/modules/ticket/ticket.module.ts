// 모듈 조립 파일: 발권·검표 v0 포트에 어댑터를 묶는다(층 규칙의 밖).
import { type DynamicModule, Module } from '@nestjs/common';
import type { Database } from '@peaket/platform';
import { DrizzleTicketStore } from './adapters/db/drizzle-ticket-store.js';
import { TicketService } from './application/ticket-service.js';
import { TICKET_STORE } from './domain/ports.js';
import { ScanController } from './inbound/scan.controller.js';

export interface TicketModuleOptions {
  /** 발권·검표 v0 DB(v0_ticket·v0_gate_staff) */
  database: Database;
}

@Module({})
export class TicketModule {
  static register(o: TicketModuleOptions): DynamicModule {
    return {
      module: TicketModule,
      controllers: [ScanController],
      providers: [TicketService, { provide: TICKET_STORE, useValue: new DrizzleTicketStore(o.database) }],
    };
  }
}
