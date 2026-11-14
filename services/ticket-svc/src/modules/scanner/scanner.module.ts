// 스캐너 기기 모듈 조립(BUILD_ORDER GAT-170). 저장소·등록 코드·DPoP jti 포트를 고른다.
import { type DynamicModule, Module, type Provider } from '@nestjs/common';
import { CLOCK, type Clock } from '@peaket/platform';
import { ScannerDevices } from './application/scanner-devices.js';
import { ScannerGate } from './application/scanner-gate.js';
import { DPOP_REPLAY_STORE, ENROLLMENT_CODE_STORE, SCANNER_DEVICE_STORE, SCANNER_GATE_STORE, type DpopReplayStore, type EnrollmentCodeStore, type ScannerDeviceStore, type ScannerGateStore } from './domain/ports.js';
import { OpsScannerDevicesController } from './inbound/ops-scanner-devices.controller.js';
import { ScannerEnrollmentController } from './inbound/scanner-enrollment.controller.js';
import { ScannerGateController } from './inbound/scanner-gate.controller.js';

export interface ScannerWiring {
  store: ScannerDeviceStore;
  codes: EnrollmentCodeStore;
  replay: DpopReplayStore;
  gate: ScannerGateStore;
  /** 오프라인 스냅샷 허용 최대 시간(ms). 없으면 24시간 [가정] */
  maxOfflineMs?: number;
}

@Module({})
export class ScannerModule {
  static register(o: ScannerWiring): DynamicModule {
    const providers: Provider[] = [
      { provide: SCANNER_DEVICE_STORE, useValue: o.store },
      { provide: ENROLLMENT_CODE_STORE, useValue: o.codes },
      { provide: DPOP_REPLAY_STORE, useValue: o.replay },
      { provide: SCANNER_GATE_STORE, useValue: o.gate },
      {
        provide: ScannerDevices,
        useFactory: (store: ScannerDeviceStore, codes: EnrollmentCodeStore, clock: Clock) => new ScannerDevices({ store, codes, clock }),
        inject: [SCANNER_DEVICE_STORE, ENROLLMENT_CODE_STORE, CLOCK],
      },
      {
        provide: ScannerGate,
        useFactory: (store: ScannerGateStore, clock: Clock) => new ScannerGate({ store, clock, ...(o.maxOfflineMs !== undefined ? { maxOfflineMs: o.maxOfflineMs } : {}) }),
        inject: [SCANNER_GATE_STORE, CLOCK],
      },
    ];
    return { module: ScannerModule, controllers: [OpsScannerDevicesController, ScannerEnrollmentController, ScannerGateController], providers };
  }
}
