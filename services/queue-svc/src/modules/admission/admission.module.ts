// 모듈 조립 파일: 입장 확정 포트에 어댑터를 묶는다.
import { generateKeyPairSync } from 'node:crypto';
import { type DynamicModule, Module } from '@nestjs/common';
import { CLOCK, type Clock, type HotRedis } from '@peaket/platform';
import { type EventSchedules, MemoryEventSchedules, QUEUE_REDIS, type QueueTokens, RedisEventSchedules } from '../entry/index.js';
import { Es256AdmissionTokens } from './adapters/es256-admission-tokens.js';
import { MemoryAdmissionStore } from './adapters/memory-admission-store.js';
import { RedisAdmissionStore } from './adapters/redis-admission-store.js';
import { ADMISSION_SCHEDULES, ADMISSION_TICKETS, ConfirmAdmission } from './application/confirm-admission.js';
import { PurchaseSessionSlots } from './application/purchase-session-slots.js';
import { ADMISSION_SIGNALS, ADMISSION_STORE, ADMISSION_TOKENS, type AdmissionSignals, type AdmissionStore, type AdmissionTokens, noSignals } from './domain/ports.js';
import { AdmissionController } from './inbound/admission.controller.js';

export type AdmissionModuleOptions = (
  | { storage: 'redis'; redis: HotRedis; signer: AdmissionTokens }
  /** 시험: 저장소·일정 사본을 넘기지 않으면 새로 만들고, 서명기를 넘기지 않으면 시험용 키를 만든다 */
  | { storage: 'memory'; store?: AdmissionStore; schedules?: EventSchedules; signer?: AdmissionTokens }
) & {
  tokens: QueueTokens;
  signals?: AdmissionSignals;
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
          ]
        : [
            o.store ? { provide: ADMISSION_STORE, useValue: o.store } : { provide: ADMISSION_STORE, useFactory: (clock: Clock) => new MemoryAdmissionStore(clock), inject: [CLOCK] },
            { provide: ADMISSION_SCHEDULES, useValue: o.schedules ?? new MemoryEventSchedules() },
          ];
    return {
      module: AdmissionModule,
      controllers: [AdmissionController],
      providers: [
        ConfirmAdmission,
        PurchaseSessionSlots,
        ...storage,
        { provide: ADMISSION_TICKETS, useValue: o.tokens },
        { provide: ADMISSION_TOKENS, useValue: o.signer ?? testSigner() },
        { provide: ADMISSION_SIGNALS, useValue: o.signals ?? noSignals },
      ],
      exports: [PurchaseSessionSlots],
    };
  }
}
