// 관제 스캐너 기기 모듈(ADR-0148, BAT-450). AppModule이 ticket-svc gRPC 클라이언트와 감사 체인을 넘긴다.
import { type DynamicModule, Module } from '@nestjs/common';
import { CLOCK, type Clock } from '@peaket/platform';
import type { AuditChain } from '../audit/index.js';
import { OpsScannerDevices } from './application/scanner-devices.js';
import type { TicketScannerDevices } from './domain/scanner-devices.js';
import { OpsScannerDevicesController } from './inbound/scanner-devices.controller.js';

export interface ScannerDevicesModuleDeps {
  readonly devices: TicketScannerDevices;
  readonly audit?: AuditChain;
}

@Module({})
export class ScannerDevicesModule {
  static register(deps: ScannerDevicesModuleDeps): DynamicModule {
    return {
      module: ScannerDevicesModule,
      controllers: [OpsScannerDevicesController],
      providers: [
        {
          provide: OpsScannerDevices,
          useFactory: (clock: Clock) => new OpsScannerDevices({ devices: deps.devices, clock, ...(deps.audit ? { audit: deps.audit } : {}) }),
          inject: [CLOCK],
        },
      ],
    };
  }
}
