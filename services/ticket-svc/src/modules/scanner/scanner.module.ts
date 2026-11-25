// 스캐너 기기 모듈 조립(BUILD_ORDER GAT-170). 저장소·등록 코드·DPoP jti·배치·준비 보고 포트를 고른다.
import { type DynamicModule, Module, type Provider } from '@nestjs/common';
import { CLOCK, type Clock, type ScannerSessionCheck, scannerPwaOriginFromEnv } from '@peaket/platform';
import { ScannerDevices } from './application/scanner-devices.js';
import { ScannerGate } from './application/scanner-gate.js';
import { ScannerPlacements, ScannerShift } from './application/scanner-shift.js';
import {
  DPOP_REPLAY_STORE,
  ENROLLMENT_ATTEMPT_LIMITER,
  ENROLLMENT_CODE_STORE,
  ENTRY_CLOSE_STORE,
  SCANNER_DEVICE_COMMAND_STORE,
  SCANNER_DEVICE_STORE,
  SCANNER_EVENT_POLICY,
  SCANNER_GATE_STORE,
  SCANNER_MTLS_SECRET,
  SCANNER_PWA_ORIGIN,
  SCANNER_SESSION_TERMINATOR,
  SCANNER_SHIFT_STORE,
  type DpopReplayStore,
  type EnrollmentAttemptLimiter,
  type EnrollmentCodeStore,
  type EntryCloseStore,
  type ScannerDeviceCommandStore,
  type ScannerDeviceStore,
  type ScannerEventPolicyProvider,
  type ScannerGateStore,
  type ScannerOpsAlertSink,
  type ScannerSessionTerminator,
  type ScannerShiftStore,
} from './domain/ports.js';
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
  /** 기기 단독 업로드의 scannerSessionId로 계정·유효 창을 찾는 포트(C1-11). start는 sessions와 같은 객체를 넘긴다 */
  sessionLookup?: Pick<ScannerSessionCheck, 'check'>;
  /** ops-svc 기기 명령 request_id 멱등 기록. 없으면 매번 새로 처리한다 */
  commands?: ScannerDeviceCommandStore;
  /** SEV3 경보·세션 종료 실패를 남기는 곳 */
  alert?: (message: string, fields: Record<string, unknown>) => void;
  /** ops-svc ops_alert SEV3 경로(등록 전체 실패, C1-13). 없으면 alert 한 줄로만 남긴다 */
  opsAlert?: ScannerOpsAlertSink;
  /** 오프라인 스냅샷 허용 최대 시간(ms). 없으면 24시간 [가정] */
  maxOfflineMs?: number;
  /** 게이트웨이 mTLS 신뢰 머리 비밀 값. 없으면 인증서 지문 등록을 받지 않는다 */
  mtlsSecret?: string;
  /** 스캐너 PWA 출처(config.scannerPwaOrigin). 없으면 운영 기본 출처다(O-T35) */
  scannerPwaOrigin?: string;
  /** 스캔 기록 지표(scanner_scans_received_total). 없으면 세지 않는다 */
  onScanStored?: (result: 'PASS' | 'REJECT' | 'CHECK' | 'duplicate') => void;
  /** POLICY 변경 지표·로그(scanner_policy_changes_total, scanner.policy-changed) */
  onPolicyChanged?: (i: { eventId: string; reentryAllowed: boolean; seq: number }) => void;
  /** 입장 기록 마감 저장소(큐 비움 보고). 없으면 큐 보고 경로가 503이다 */
  entryClose?: EntryCloseStore;
  /** 큐 비움 보고 결과 지표(ticket_scanner_queue_reports_total{result}) */
  onQueueReport?: (result: 'empty' | 'pending' | 'no_placement') => void;
  /** 현장 책임자 변경분의 같은 구역 지연 기기(O-T20). 없으면 gate_lead에게 빈 목록 */
  freshness?: { staleDevices(i: { eventId: string; gateZone?: string; selfDeviceId?: string; nowMs: number }): Promise<import('./domain/scanner-gate.js').ScannerFreshnessDeviceView[]> };
  /** 스캐너 앱 최소 지원 판(C1-15). 기본 1.4.0 */
  minAppVersion?: string;
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
      { provide: SCANNER_PWA_ORIGIN, useValue: o.scannerPwaOrigin ?? scannerPwaOriginFromEnv({}) },
      ...(o.entryClose ? [{ provide: ENTRY_CLOSE_STORE, useValue: o.entryClose } satisfies Provider] : []),
      ...(o.mtlsSecret ? [{ provide: SCANNER_MTLS_SECRET, useValue: o.mtlsSecret } satisfies Provider] : []),
      ...(o.policy ? [{ provide: SCANNER_EVENT_POLICY, useValue: o.policy } satisfies Provider] : []),
      ...(o.limiter ? [{ provide: ENROLLMENT_ATTEMPT_LIMITER, useValue: o.limiter } satisfies Provider] : []),
      ...(o.sessions ? [{ provide: SCANNER_SESSION_TERMINATOR, useValue: o.sessions } satisfies Provider] : []),
      ...(o.commands ? [{ provide: SCANNER_DEVICE_COMMAND_STORE, useValue: o.commands } satisfies Provider] : []),
      {
        provide: ScannerDevices,
        useFactory: (store: ScannerDeviceStore, codes: EnrollmentCodeStore, clock: Clock, limiter?: EnrollmentAttemptLimiter, sessions?: ScannerSessionTerminator, commands?: ScannerDeviceCommandStore) =>
          new ScannerDevices({
            store,
            codes,
            clock,
            shifts: o.shift,
            ...(limiter ? { limiter } : {}),
            ...(sessions ? { sessions } : {}),
            ...(commands ? { commands } : {}),
            ...(o.alert ? { alert: o.alert } : {}),
            ...(o.opsAlert ? { opsAlert: o.opsAlert } : {}),
          }),
        inject: [
          SCANNER_DEVICE_STORE,
          ENROLLMENT_CODE_STORE,
          CLOCK,
          ...(o.limiter ? [ENROLLMENT_ATTEMPT_LIMITER] : []),
          ...(o.sessions ? [SCANNER_SESSION_TERMINATOR] : []),
          ...(o.commands ? [SCANNER_DEVICE_COMMAND_STORE] : []),
        ],
      },
      {
        provide: ScannerGate,
        useFactory: (store: ScannerGateStore, clock: Clock, devices: ScannerDeviceStore) =>
          new ScannerGate({
            store,
            clock,
            shifts: o.shift,
            devices,
            ...(o.policy ? { policy: o.policy } : {}),
            ...(o.sessionLookup ? { sessions: o.sessionLookup } : {}),
            ...(o.maxOfflineMs !== undefined ? { maxOfflineMs: o.maxOfflineMs } : {}),
            ...(o.onScanStored ? { onScanStored: o.onScanStored } : {}),
            ...(o.onPolicyChanged ? { onPolicyChanged: o.onPolicyChanged } : {}),
            ...(o.onQueueReport ? { onQueueReport: o.onQueueReport } : {}),
            ...(o.entryClose ? { entryClose: o.entryClose } : {}),
            ...(o.freshness ? { freshness: o.freshness } : {}),
            ...(o.minAppVersion !== undefined ? { minAppVersion: o.minAppVersion } : {}),
          }),
        inject: [SCANNER_GATE_STORE, CLOCK, SCANNER_DEVICE_STORE],
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
      // 관제 기기 경로(/v1/ops/scanner-devices*)는 ops-svc만 받는다. ticket-svc는 gRPC ScannerDeviceService로만 등록·폐기·재발급한다(W7-WIR-02)
      controllers: [
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
