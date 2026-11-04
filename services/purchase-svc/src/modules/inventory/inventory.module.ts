// 모듈 조립 파일: inventory 포트에 어댑터를 묶는다.
import { type DynamicModule, Module, type Provider } from '@nestjs/common';
import { CLOCK, type Clock, type HotRedis, PLATFORM_LOGGER, type PlatformLogger } from '@peaket/platform';
import type { PurchaseSessionAccess } from './adapters/memory-purchase-sessions.js';
import { OpenPurchaseSession } from './application/open-purchase-session.js';
import { ReadSeatSnapshot } from './application/read-seat-snapshot.js';
import type { AdmissionKeys } from './domain/admission-token.js';
import { MemorySeatMap } from './adapters/memory-seat-map.js';
import { MemorySeatStore } from './adapters/memory-seat-store.js';
import { RecordingHoldAttempts } from './adapters/recording-hold-attempts.js';
import { RedisSeatStore, SEAT_REDIS } from './adapters/redis-seat-store.js';
import { RedisSweepLeases } from './adapters/redis-sweep-leases.js';
import { ExpirySweeper } from './application/expiry-sweeper.js';
import { HoldSeats } from './application/hold-seats.js';
import { LogGate, OOM_WARN_GATE } from './application/log-gate.js';
import {
  HOLD_ATTEMPTS,
  type HoldAttempts,
  noSeatSignals,
  PURCHASE_SESSIONS,
  type PurchaseSessionStore,
  SEAT_MAP,
  SEAT_MAP_SECTIONS,
  SEAT_SNAPSHOTS,
  SESSION_HOLDS,
  type SeatMapSections,
  type SeatSnapshots,
  type SessionStartedLog,
  SEAT_SIGNALS,
  SEAT_STORE,
  type SeatMap,
  type SeatMapIndex,
  type SeatSignals,
  type SeatStore,
  SWEEP_LEASES,
  type SweepLeases,
} from './domain/ports.js';
import { HoldsController } from './inbound/holds.controller.js';
import { SnapshotController } from './inbound/snapshot.controller.js';

/**
 * 스냅샷 API와 구매 세션 홀드 기록의 조립 값(BUILD_ORDER PRF-137). 주면 SnapshotController를 켜고 HoldSeats가 새 홀드를 구매 세션에 기록한다.
 * 요청 인증 훅의 sessions(PurchaseSessionAccess)와 같은 저장소를 가리켜야 같은 세션을 본다
 */
export interface AdmissionOptions {
  /** 구매 세션 저장소(열기·홀드 기록) */
  store: PurchaseSessionStore;
  /** SESSION_STARTED를 회차 Stream에 더하는 길 */
  startedLog: SessionStartedLog;
  /** 입장 토큰 공개키 묶음(PEAKET_ADMISSION_JWKS) */
  keys: AdmissionKeys;
  /** 입장 토큰 발급자(PEAKET_ADMISSION_ISSUER) */
  issuer: string;
}

export type InventoryModuleOptions = (
  /**
   * 운영: 좌석 Redis. 좌석맵 판과 시도 기록은 꼭 넘긴다(운영 좌석맵 판·HoldAttempt 보내기가 아직 없어 main.ts가 빈 메모리 판·버리는 기록을 넘긴다).
   * 1초 만료 반복(ExpirySweeper)을 만들어 내보낸다(RedisSeatStore·RedisSweepLeases, 임대 값 podId). 켜고 끄는 것은 main.ts다(시작 때 start, SIGTERM 때 stop)
   */
  | { storage: 'redis'; redis: HotRedis; seatMap: SeatMap & SeatMapIndex & SeatMapSections; attempts: HoldAttempts; podId: string; signals?: SeatSignals }
  /**
   * 시험: 넘기지 않은 것은 새로 만든다(저장소 MemorySeatStore(주입 Clock), 좌석맵 MemorySeatMap, 시도 기록 RecordingHoldAttempts, 지표 버림).
   * 만료 반복은 만들지 않는다(시험은 ExpirySweeper를 직접 만들어 손으로 tick한다)
   */
  | { storage: 'memory'; store?: SeatStore; seatMap?: SeatMap & SeatMapSections; attempts?: HoldAttempts; signals?: SeatSignals }
) & {
  /** 스냅샷 API·홀드 기록. 없으면 스냅샷 경로를 열지 않는다(기존 시험·조립) */
  admission?: AdmissionOptions;
  /** 구매 세션. createService의 purchaseSessions에 넘긴 것과 같은 객체여야 한다(요청 서명 확인과 세션 읽기가 같은 세션을 본다) */
  sessions: PurchaseSessionAccess;
};

@Module({})
export class InventoryModule {
  static register(o: InventoryModuleOptions): DynamicModule {
    const signals: Provider = { provide: SEAT_SIGNALS, useValue: o.signals ?? noSeatSignals };
    // 메모리 부족 경고 문: 받는 층과 만료 반복이 나눈다(파드마다 1초에 한 줄, L6)
    const oomGate: Provider = { provide: OOM_WARN_GATE, useFactory: (clock: Clock) => new LogGate(clock), inject: [CLOCK] };
    const optionalLogger = { token: PLATFORM_LOGGER, optional: true };
    const storage: Provider[] =
      o.storage === 'redis'
        ? [
            { provide: SEAT_REDIS, useValue: o.redis },
            // 저장소에 서비스 로거와 주입 Clock을 넘긴다(saleEvents가 거른 값의 수를 파드마다 60초에 한 줄까지 남긴다, L8·C3)
            {
              provide: SEAT_STORE,
              useFactory: (redis: HotRedis, clock: Clock, logger?: PlatformLogger) => new RedisSeatStore(redis, logger, clock),
              inject: [SEAT_REDIS, CLOCK, optionalLogger],
            },
            { provide: SWEEP_LEASES, useClass: RedisSweepLeases },
            { provide: SEAT_MAP, useValue: o.seatMap },
            { provide: HOLD_ATTEMPTS, useValue: o.attempts },
            {
              provide: ExpirySweeper,
              useFactory: (store: RedisSeatStore, seatMap: SeatMap & SeatMapIndex, leases: SweepLeases, clock: Clock, s: SeatSignals, gate: LogGate, logger?: PlatformLogger) =>
                new ExpirySweeper({ expiries: store, seatMap, leases, clock, podId: o.podId, signals: s, oomWarnGate: gate, ...(logger ? { logger } : {}) }),
              inject: [SEAT_STORE, SEAT_MAP, SWEEP_LEASES, CLOCK, SEAT_SIGNALS, OOM_WARN_GATE, optionalLogger],
            },
          ]
        : [
            o.store
              ? { provide: SEAT_STORE, useValue: o.store }
              : { provide: SEAT_STORE, useFactory: (clock: Clock, logger?: PlatformLogger) => new MemorySeatStore(clock, logger), inject: [CLOCK, optionalLogger] },
            { provide: SEAT_MAP, useValue: o.seatMap ?? new MemorySeatMap() },
            { provide: HOLD_ATTEMPTS, useValue: o.attempts ?? new RecordingHoldAttempts() },
          ];
    const optionalLoggerToken = { token: PLATFORM_LOGGER, optional: true };
    const snapshotProviders: Provider[] = o.admission
      ? [
          { provide: SESSION_HOLDS, useValue: o.admission.store },
          { provide: SEAT_SNAPSHOTS, useExisting: SEAT_STORE },
          { provide: SEAT_MAP_SECTIONS, useExisting: SEAT_MAP },
          {
            provide: OpenPurchaseSession,
            useFactory: (clock: Clock, logger?: PlatformLogger) =>
              new OpenPurchaseSession({ store: o.admission!.store, log: o.admission!.startedLog, keys: o.admission!.keys, issuer: o.admission!.issuer, clock, ...(logger ? { logger } : {}) }),
            inject: [CLOCK, optionalLoggerToken],
          },
          {
            provide: ReadSeatSnapshot,
            useFactory: (opener: OpenPurchaseSession, seatMap: SeatMap & SeatMapSections, snapshots: SeatSnapshots, clock: Clock) => {
              // 메모리 시험에서 넘긴 SeatStore가 스냅샷 읽기를 하지 않으면 시작 때 알린다
              if (typeof (snapshots as Partial<SeatSnapshots>).read !== 'function') throw new Error('스냅샷 API를 열려면 SeatSnapshots를 구현한 좌석 저장소가 필요하다');
              return new ReadSeatSnapshot({ opener, seatMap, snapshots, clock });
            },
            inject: [OpenPurchaseSession, SEAT_MAP_SECTIONS, SEAT_SNAPSHOTS, CLOCK],
          },
        ]
      : [];
    return {
      module: InventoryModule,
      controllers: o.admission ? [HoldsController, SnapshotController] : [HoldsController],
      providers: [HoldSeats, ...storage, ...snapshotProviders, signals, oomGate, { provide: PURCHASE_SESSIONS, useValue: o.sessions }],
      exports: o.storage === 'redis' ? [HoldSeats, ExpirySweeper] : [HoldSeats],
    };
  }
}
