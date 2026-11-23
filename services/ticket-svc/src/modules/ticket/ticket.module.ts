// ticket 모듈의 HTTP 조립(입장용 기기 키 BUILD_ORDER GAT-140, 양도 GAT-050, 월렛 목록 FIX-wallet-tickets). gRPC는 start.ts가 따로 조립한다.
import { type DynamicModule, type MiddlewareConsumer, Module, type NestModule, RequestMethod } from '@nestjs/common';
import { Transfers } from './application/transfers.js';
import { DeviceKeys } from './application/device-keys.js';
import { TicketService } from './application/ticket-service.js';
import { TicketDeviceKeysController } from './inbound/device-keys.controller.js';
import { TransfersController } from './inbound/transfers.controller.js';
import { WalletTicketsController } from './inbound/wallet-tickets.controller.js';

export interface TicketWiring {
  deviceKeys: DeviceKeys;
  /** 월렛 목록 GET /v1/tickets(FIX-wallet-tickets). 없으면 그 처리기를 싣지 않는다(기기 키만 쓰는 단위 시험) */
  tickets?: TicketService;
  /** 양도·돌려주기(GAT-050). 없으면 그 처리기를 싣지 않는다(기기 키만 쓰는 단위 시험) */
  transfers?: Transfers;
}

/**
 * 월렛 목록 응답은 계정 단위 정보라 캐시하지 않는다(docs/features/offline-gate.md §2 '캐시와 기록', 오류 응답도).
 * 처리기 앞의 인증 가드가 내는 401·400까지 덮으려고 요청이 가드에 닿기 전에 머리를 단다(purchase-svc AppModule의 no-store 미들웨어와 같은 꼴)
 */
const privateNoStore = (_req: unknown, res: { setHeader(name: string, value: string): unknown }, next: () => void): void => {
  res.setHeader('cache-control', 'private, no-store');
  next();
};

@Module({})
export class TicketModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(privateNoStore).forRoutes(
      { path: 'v1/tickets', method: RequestMethod.GET },
      { path: 'v1/tickets/:ticketId', method: RequestMethod.GET },
      { path: 'v1/transfers', method: RequestMethod.GET },
      { path: 'v1/transfers/:offerId', method: RequestMethod.GET },
    );
  }

  static register(o: TicketWiring): DynamicModule {
    return {
      module: TicketModule,
      controllers: [TicketDeviceKeysController, ...(o.tickets ? [WalletTicketsController] : []), ...(o.transfers ? [TransfersController] : [])],
      providers: [
        { provide: DeviceKeys, useValue: o.deviceKeys },
        ...(o.tickets ? [{ provide: TicketService, useValue: o.tickets }] : []),
        ...(o.transfers ? [{ provide: Transfers, useValue: o.transfers }] : []),
      ],
    };
  }
}
