// 모듈 조립 파일: 추가 검증 포트에 어댑터를 묶는다(BUILD_ORDER BOT-090, ADR-0259).
import { type DynamicModule, Module } from '@nestjs/common';
import { CLOCK, type Clock, type HotRedis } from '@peaket/platform';
import { type EventSchedules, MemoryEventSchedules, QUEUE_REDIS, RedisEventSchedules } from '../entry/index.js';
import { MemoryVerificationStore } from './adapters/memory-verification-store.js';
import { RedisVerificationStore } from './adapters/redis-verification-store.js';
import { GetVerificationAppeal, ResolveVerificationAppeal } from './application/appeals.js';
import { ReadVerification } from './application/read-verification.js';
import { SubmitAppeal } from './application/submit-appeal.js';
import { SubmitVerification } from './application/submit-verification.js';
import {
  CASE_REQUESTS,
  type CaseRequestPublisher,
  REVERIFICATION,
  type ReverificationPort,
  unavailableCaseRequests,
  unavailableReverification,
  unavailableVerificationRisk,
  VERIFICATION_OPTIONS,
  VERIFICATION_RISK,
  VERIFICATION_SCHEDULES,
  VERIFICATION_SIGNALS,
  VERIFICATION_STORE,
  type VerificationRiskPort,
  type VerificationSignals,
  type VerificationStore,
} from './domain/ports.js';
import { DEFAULT_VERIFICATION_OPTIONS, type VerificationOptions } from './domain/verification.js';
import { VerificationController } from './inbound/verification.controller.js';

export type VerificationModuleOptions = ({ storage: 'redis'; redis: HotRedis } | { storage: 'memory'; store?: VerificationStore; schedules?: EventSchedules }) & {
  /** identity-svc CheckReverification. 없으면 늘 503(주소가 없는 local·ci·demo) */
  reverification?: ReverificationPort;
  /** trust-svc ScoreRisk(VERIFICATION). 없으면 늘 503 */
  risk?: VerificationRiskPort;
  /** 건 요청 생산자. 없으면 이의만 503(Kafka 없는 local·ci) */
  cases?: CaseRequestPublisher;
  signals?: VerificationSignals;
  options?: Partial<VerificationOptions>;
};

@Module({})
export class VerificationModule {
  static register(o: VerificationModuleOptions): DynamicModule {
    const storage =
      o.storage === 'redis'
        ? [
            { provide: QUEUE_REDIS, useValue: o.redis },
            { provide: VERIFICATION_STORE, useClass: RedisVerificationStore },
            { provide: VERIFICATION_SCHEDULES, useFactory: (clock: Clock) => new RedisEventSchedules(o.redis, clock), inject: [CLOCK] },
          ]
        : [
            o.store ? { provide: VERIFICATION_STORE, useValue: o.store } : { provide: VERIFICATION_STORE, useFactory: (clock: Clock) => new MemoryVerificationStore(clock), inject: [CLOCK] },
            { provide: VERIFICATION_SCHEDULES, useValue: o.schedules ?? new MemoryEventSchedules() },
          ];
    return {
      module: VerificationModule,
      controllers: [VerificationController],
      providers: [
        SubmitVerification,
        SubmitAppeal,
        ReadVerification,
        GetVerificationAppeal,
        ResolveVerificationAppeal,
        ...storage,
        { provide: REVERIFICATION, useValue: o.reverification ?? unavailableReverification },
        { provide: VERIFICATION_RISK, useValue: o.risk ?? unavailableVerificationRisk },
        { provide: CASE_REQUESTS, useValue: o.cases ?? unavailableCaseRequests },
        { provide: VERIFICATION_OPTIONS, useValue: { ...DEFAULT_VERIFICATION_OPTIONS, ...o.options } },
        ...(o.signals ? [{ provide: VERIFICATION_SIGNALS, useValue: o.signals }] : []),
      ],
      exports: [GetVerificationAppeal, ResolveVerificationAppeal],
    };
  }
}
