// ticket 모듈의 HTTP 조립(입장용 기기 키, BUILD_ORDER GAT-140). gRPC는 start.ts가 따로 조립한다.
import { type DynamicModule, Module } from '@nestjs/common';
import { DeviceKeys } from './application/device-keys.js';
import { TicketDeviceKeysController } from './inbound/device-keys.controller.js';

export interface TicketWiring {
  deviceKeys: DeviceKeys;
}

@Module({})
export class TicketModule {
  static register(o: TicketWiring): DynamicModule {
    return {
      module: TicketModule,
      controllers: [TicketDeviceKeysController],
      providers: [{ provide: DeviceKeys, useValue: o.deviceKeys }],
    };
  }
}
