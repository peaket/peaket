// 스캐너 기기 모듈 조립(BUILD_ORDER GAT-170). 저장소·등록 코드·DPoP jti 포트를 고른다.
import { type DynamicModule, Module, type Provider } from '@nestjs/common';
import { CLOCK, type Clock } from '@peaket/platform';
import { ScannerDevices } from './application/scanner-devices.js';
import { DPOP_REPLAY_STORE, ENROLLMENT_CODE_STORE, SCANNER_DEVICE_STORE, type DpopReplayStore, type EnrollmentCodeStore, type ScannerDeviceStore } from './domain/ports.js';
import { OpsScannerDevicesController } from './inbound/ops-scanner-devices.controller.js';
import { ScannerEnrollmentController } from './inbound/scanner-enrollment.controller.js';

export interface ScannerWiring {
  store: ScannerDeviceStore;
  codes: EnrollmentCodeStore;
  replay: DpopReplayStore;
}

@Module({})
export class ScannerModule {
  static register(o: ScannerWiring): DynamicModule {
    const providers: Provider[] = [
      { provide: SCANNER_DEVICE_STORE, useValue: o.store },
      { provide: ENROLLMENT_CODE_STORE, useValue: o.codes },
      { provide: DPOP_REPLAY_STORE, useValue: o.replay },
      {
        provide: ScannerDevices,
        useFactory: (store: ScannerDeviceStore, codes: EnrollmentCodeStore, clock: Clock) => new ScannerDevices({ store, codes, clock }),
        inject: [SCANNER_DEVICE_STORE, ENROLLMENT_CODE_STORE, CLOCK],
      },
    ];
    return { module: ScannerModule, controllers: [OpsScannerDevicesController, ScannerEnrollmentController], providers };
  }
}
