// ticket 모듈의 HTTP 조립(입장용 기기 키 BUILD_ORDER GAT-140, 양도 GAT-050). gRPC는 start.ts가 따로 조립한다.
import { type DynamicModule, Module } from '@nestjs/common';
import { Transfers } from './application/transfers.js';
import { DeviceKeys } from './application/device-keys.js';
import { TicketDeviceKeysController } from './inbound/device-keys.controller.js';
import { TransfersController } from './inbound/transfers.controller.js';

export interface TicketWiring {
  deviceKeys: DeviceKeys;
  /** 양도·돌려주기(GAT-050). 없으면 그 처리기를 싣지 않는다(기기 키만 쓰는 단위 시험) */
  transfers?: Transfers;
}

@Module({})
export class TicketModule {
  static register(o: TicketWiring): DynamicModule {
    return {
      module: TicketModule,
      controllers: [TicketDeviceKeysController, ...(o.transfers ? [TransfersController] : [])],
      providers: [
        { provide: DeviceKeys, useValue: o.deviceKeys },
        ...(o.transfers ? [{ provide: Transfers, useValue: o.transfers }] : []),
      ],
    };
  }
}
