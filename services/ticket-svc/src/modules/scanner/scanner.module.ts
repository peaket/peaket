// 스캐너 기기 모듈 조립(BUILD_ORDER GAT-170). 저장소·등록 코드·DPoP jti·배치·준비 보고 포트를 고른다.
import { type DynamicModule, Module, type Provider } from '@nestjs/common';
import { CLOCK, type Clock } from '@peaket/platform';
import { ScannerDevices } from './application/scanner-devices.js';
import { ScannerGate } from './application/scanner-gate.js';
import { ScannerPlacements, ScannerShift } from './application/scanner-shift.js';
import {
  DPOP_REPLAY_STORE,
  ENROLLMENT_ATTEMPT_LIMITER,
  ENROLLMENT_CODE_STORE,
  SCANNER_DEVICE_STORE,
  SCANNER_EVENT_POLICY,
  SCANNER_GATE_STORE,
  SCANNER_SESSION_TERMINATOR,
  SCANNER_SHIFT_STORE,
  type DpopReplayStore,
  type EnrollmentAttemptLimiter,
  type EnrollmentCodeStore,
  type ScannerDeviceStore,
  type ScannerEventPolicyProvider,
  type ScannerGateStore,
  type ScannerSessionTerminator,
  type ScannerShiftStore,
} from './domain/ports.js';
import { OpsScannerDevicesController } from './inbound/ops-scanner-devices.controller.js';
import { PartnerScannerPlacementController } from './inbound/partner-scanner-placement.controller.js';
import { ScannerEnrollmentController } from './inbound/scanner-enrollment.controller.js';
import { ScannerGateController } from './inbound/scanner-gate.controller.js';
import { ScannerPlacementController } from './inbound/scanner-placement.controller.js';
import { ScannerShiftController } from './inbound/scanner-shift.controller.js';

export interface ScannerWiring {
  store: ScannerDeviceStore;
  codes: EnrollmentCodeStore;
  replay: DpopReplayStore;
  gate: ScannerGateStore;
  shift: ScannerShiftStore;
  /** 회차 판매·입장 창(core-svc). 없으면 근무 준비가 창을 비우고 OUT 배치를 503으로 닫는다 */
  policy?: ScannerEventPolicyProvider;
  /** 등록 시도 IP 실패 제한. 없으면 세지 않는다 */
  limiter?: EnrollmentAttemptLimiter;
  /** 기기 폐기 때 identity 스캐너 세션 종료. 없으면 부르지 않는다 */
  sessions?: ScannerSessionTerminator;
  /** SEV3 경보·세션 종료 실패를 남기는 곳 */
  alert?: (message: string, fields: Record<string, unknown>) => void;
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
      { provide: SCANNER_SHIFT_STORE, useValue: o.shift },
      ...(o.policy ? [{ provide: SCANNER_EVENT_POLICY, useValue: o.policy } satisfies Provider] : []),
      ...(o.limiter ? [{ provide: ENROLLMENT_ATTEMPT_LIMITER, useValue: o.limiter } satisfies Provider] : []),
      ...(o.sessions ? [{ provide: SCANNER_SESSION_TERMINATOR, useValue: o.sessions } satisfies Provider] : []),
      {
        provide: ScannerDevices,
        useFactory: (store: ScannerDeviceStore, codes: EnrollmentCodeStore, clock: Clock, limiter?: EnrollmentAttemptLimiter, sessions?: ScannerSessionTerminator) =>
          new ScannerDevices({
            store,
            codes,
            clock,
            ...(limiter ? { limiter } : {}),
            ...(sessions ? { sessions } : {}),
            ...(o.alert ? { alert: o.alert } : {}),
          }),
        inject: [
          SCANNER_DEVICE_STORE,
          ENROLLMENT_CODE_STORE,
          CLOCK,
          ...(o.limiter ? [ENROLLMENT_ATTEMPT_LIMITER] : []),
          ...(o.sessions ? [SCANNER_SESSION_TERMINATOR] : []),
        ],
      },
      {
        provide: ScannerGate,
        useFactory: (store: ScannerGateStore, clock: Clock) => new ScannerGate({ store, clock, shifts: o.shift, ...(o.maxOfflineMs !== undefined ? { maxOfflineMs: o.maxOfflineMs } : {}) }),
        inject: [SCANNER_GATE_STORE, CLOCK],
      },
      {
        provide: ScannerShift,
        useFactory: (devices: ScannerDeviceStore, shifts: ScannerShiftStore, gate: ScannerGateStore, clock: Clock, policy?: ScannerEventPolicyProvider) =>
          new ScannerShift({ devices, shifts, gate, clock, maxOfflineMs: o.maxOfflineMs ?? 24 * 60 * 60_000, ...(policy ? { policy } : {}) }),
        inject: [SCANNER_DEVICE_STORE, SCANNER_SHIFT_STORE, SCANNER_GATE_STORE, CLOCK, ...(o.policy ? [SCANNER_EVENT_POLICY] : [])],
      },
      {
        provide: ScannerPlacements,
        useFactory: (devices: ScannerDeviceStore, shifts: ScannerShiftStore, clock: Clock, policy?: ScannerEventPolicyProvider) =>
          new ScannerPlacements({ devices, shifts, clock, ...(policy ? { policy } : {}) }),
        inject: [SCANNER_DEVICE_STORE, SCANNER_SHIFT_STORE, CLOCK, ...(o.policy ? [SCANNER_EVENT_POLICY] : [])],
      },
    ];
    return {
      module: ScannerModule,
      controllers: [
        OpsScannerDevicesController,
        ScannerEnrollmentController,
        ScannerGateController,
        ScannerShiftController,
        ScannerPlacementController,
        PartnerScannerPlacementController,
      ],
      providers,
    };
  }
}
