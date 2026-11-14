// 모듈 조립 파일: 입장 확정 포트에 어댑터를 묶는다.
import { generateKeyPairSync } from 'node:crypto';
import { type DynamicModule, Module } from '@nestjs/common';
import { CLOCK, type Clock, type HotRedis, INTERNAL_TOKEN, InternalTokenGuard } from '@peaket/platform';
import { type EventSchedules, MemoryEventSchedules, QUEUE_REDIS, type QueueTokens, RedisEventSchedules } from '../entry/index.js';
import { Es256AdmissionTokens } from './adapters/es256-admission-tokens.js';
import { MemoryAdmissionStore } from './adapters/memory-admission-store.js';
import { MemoryBookingRestrictions } from './adapters/memory-booking-restrictions.js';
import { MemoryPriorityGrantStore } from './adapters/memory-priority-grants.js';
import { RedisAdmissionStore } from './adapters/redis-admission-store.js';
import { RedisBookingRestrictions } from './adapters/redis-booking-restrictions.js';
import { RedisPriorityGrantStore } from './adapters/redis-priority-grants.js';
import { ADMISSION_SCHEDULES, ADMISSION_TICKETS, ConfirmAdmission } from './application/confirm-admission.js';
import { PurchaseSessionSlots } from './application/purchase-session-slots.js';
import { SetPriorityGrant } from './application/set-priority-grant.js';
import { ADMISSION_POLICY, ADMISSION_SIGNALS, ADMISSION_STORE, ADMISSION_TOKENS, BOOKING_RESTRICTIONS, PRIORITY_GRANTS, type AdmissionPolicy, type AdmissionSignals, type AdmissionStore, type AdmissionTokens, type BookingRestrictions, type PriorityGrantStore, noSignals } from './domain/ports.js';
import { AdmissionController } from './inbound/admission.controller.js';
import { PriorityGrantInternalController } from './inbound/priority-grant-internal.controller.js';

export type AdmissionModuleOptions = (
  | { storage: 'redis'; redis: HotRedis; signer: AdmissionTokens }
  /** 시험: 저장소·일정 사본을 넘기지 않으면 새로 만들고, 서명기를 넘기지 않으면 시험용 키를 만든다 */
  | {
      storage: 'memory';
      store?: AdmissionStore;
      schedules?: EventSchedules;
      signer?: AdmissionTokens;
      priorityGrants?: PriorityGrantStore;
      /** 예매 제한 사본(GAT-310). 없으면 제한 검사를 하지 않는다 */
      bookingRestrictions?: BookingRestrictions;
    }
) & {
  tokens: QueueTokens;
  signals?: AdmissionSignals;
  /** 입장 확정 규칙 값(유예 등). 넘기지 않으면 정본의 기본값이다 */
  policy?: AdmissionPolicy;
};

/** 메모리(시험) 조립에서 서명기를 넘기지 않았을 때 쓰는 일회용 키 */
function testSigner(): AdmissionTokens {
  const jwk = { ...generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'jwk' }), kid: 'test' };
  return new Es256AdmissionTokens({ jwk, issuer: 'https://queue.test.invalid' });
}

@Module({})
export class AdmissionModule {
  static register(o: AdmissionModuleOptions): DynamicModule {
    const storage =
      o.storage === 'redis'
        ? [
            { provide: QUEUE_REDIS, useValue: o.redis },
            { provide: ADMISSION_STORE, useClass: RedisAdmissionStore },
            { provide: ADMISSION_SCHEDULES, useFactory: (clock: Clock) => new RedisEventSchedules(o.redis, clock), inject: [CLOCK] },
            { provide: PRIORITY_GRANTS, useClass: RedisPriorityGrantStore },
            { provide: BOOKING_RESTRICTIONS, useClass: RedisBookingRestrictions },
          ]
        : [
            o.store ? { provide: ADMISSION_STORE, useValue: o.store } : { provide: ADMISSION_STORE, useFactory: (clock: Clock) => new MemoryAdmissionStore(clock), inject: [CLOCK] },
            { provide: ADMISSION_SCHEDULES, useValue: o.schedules ?? new MemoryEventSchedules() },
            { provide: PRIORITY_GRANTS, useValue: o.priorityGrants ?? new MemoryPriorityGrantStore() },
            { provide: BOOKING_RESTRICTIONS, useValue: o.bookingRestrictions ?? new MemoryBookingRestrictions() },
          ];
    return {
      module: AdmissionModule,
      controllers: [AdmissionController, PriorityGrantInternalController],
      providers: [
        ConfirmAdmission,
        PurchaseSessionSlots,
        SetPriorityGrant,
        ...storage,
        { provide: ADMISSION_TICKETS, useValue: o.tokens },
        { provide: ADMISSION_TOKENS, useValue: o.signer ?? testSigner() },
        { provide: ADMISSION_SIGNALS, useValue: o.signals ?? noSignals },
        { provide: ADMISSION_POLICY, useValue: o.policy ?? {} },
        { provide: INTERNAL_TOKEN, useValue: process.env.PEAKET_INTERNAL_TOKEN },
        InternalTokenGuard,
      ],
      exports: [PurchaseSessionSlots, SetPriorityGrant],
    };
  }
}
