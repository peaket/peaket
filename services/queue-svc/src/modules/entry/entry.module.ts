// 모듈 조립 파일: 진입 포트에 어댑터를 묶는다.
import { type DynamicModule, Module } from '@nestjs/common';
import { CLOCK, type Clock, type HotRedis } from '@peaket/platform';
import { MemoryEntryStore, MemoryEventSchedules, MemoryShuffleCommits } from './adapters/memory-entry-store.js';
import { QUEUE_REDIS, QUEUE_WAIT_REDIS, RedisEntryStore, RedisShuffleCommits } from './adapters/redis-entry-store.js';
import { RedisEventSchedules } from './adapters/redis-event-schedules.js';
import { MemoryWithdrawnKeys } from './adapters/memory-withdrawn-keys.js';
import { RedisWithdrawnKeys } from './adapters/redis-withdrawn-keys.js';
import { PurgeWithdrawnKeys } from './application/purge-withdrawn-keys.js';
import { DEFAULT_ENTRY_OPTIONS, ENTRY_OPTIONS, EnterQueue, type EntryOptions } from './application/enter-queue.js';
import { IssuePreverification } from './application/issue-preverification.js';
import { JoinLobby } from './application/join-lobby.js';
import { LeaveQueue } from './application/leave-queue.js';
import { ShuffleCommits } from './application/shuffle-commits.js';
import { ARRIVAL_COOKIES, ARRIVAL_SIGNALS, type ArrivalCookies, type ArrivalSignals, ENTRY_STORE, EVENT_SCHEDULES, type EventSchedules, LEAVE_SIGNALS, type LeaveSignals, DEGRADED_LIMITS, type DegradedLimits, LOBBY_SIGNALS, type LobbySignals, noSealer, QUEUE_TOKENS, type QueueTokens, RISK, type RiskPort, SEED_SEALER, type SeedSealer, SHUFFLE_COMMIT_STORE, WITHDRAWN_KEYS } from './domain/ports.js';
import { QueueController } from './inbound/queue.controller.js';

/** waitRedis: RB-05 복제 확인(WAIT) 전용 연결(ADR-0186). 없으면 공유 연결 */
export type EntryModuleOptions = ({ storage: 'redis'; redis: HotRedis; waitRedis?: HotRedis } | { storage: 'memory'; schedules?: EventSchedules }) & {
  tokens: QueueTokens;
  risk: RiskPort;
  options?: Partial<EntryOptions>;
  /** 도착 시각 쿠키 읽기(키 환경 값이 없으면 넘기지 않는다: 쿠키 없는 일반 진입뿐이다, ADR-0223) */
  arrivals?: ArrivalCookies;
  arrivalSignals?: ArrivalSignals;
  /** 시드 봉인(운영 KMS 어댑터 전에는 local·ci·demo의 시험 봉인만, 없으면 공시 때 503) */
  sealer?: SeedSealer;
  lobbySignals?: LobbySignals;
  leaveSignals?: LeaveSignals;
  /** 위험 판정을 받지 못할 때의 파드 메모리 한도(운영 조립이 넣는다, docs/features/bot-defense.md §11.2) */
  degradedLimits?: DegradedLimits;
};

@Module({})
export class EntryModule {
  static register(o: EntryModuleOptions): DynamicModule {
    const storage =
      o.storage === 'redis'
        ? [
            { provide: QUEUE_REDIS, useValue: o.redis },
            ...(o.waitRedis ? [{ provide: QUEUE_WAIT_REDIS, useValue: o.waitRedis }] : []),
            { provide: ENTRY_STORE, useClass: RedisEntryStore },
            { provide: EVENT_SCHEDULES, useClass: RedisEventSchedules },
            { provide: WITHDRAWN_KEYS, useClass: RedisWithdrawnKeys },
            { provide: SHUFFLE_COMMIT_STORE, useClass: RedisShuffleCommits },
          ]
        : [
            { provide: ENTRY_STORE, useFactory: (clock: Clock) => new MemoryEntryStore(clock), inject: [CLOCK] },
            { provide: EVENT_SCHEDULES, useValue: o.schedules ?? new MemoryEventSchedules() },
            { provide: WITHDRAWN_KEYS, useValue: new MemoryWithdrawnKeys() },
            { provide: SHUFFLE_COMMIT_STORE, useValue: new MemoryShuffleCommits() },
          ];
    return {
      module: EntryModule,
      controllers: [QueueController],
      providers: [
        IssuePreverification,
        EnterQueue,
        JoinLobby,
        LeaveQueue,
        ShuffleCommits,
        // 탈퇴 사건 처리기가 쓴다(BOT-037). Kafka 구독 실행은 HOT-010
        PurgeWithdrawnKeys,
        ...storage,
        { provide: QUEUE_TOKENS, useValue: o.tokens },
        { provide: RISK, useValue: o.risk },
        { provide: ENTRY_OPTIONS, useValue: { ...DEFAULT_ENTRY_OPTIONS, ...o.options } },
        { provide: SEED_SEALER, useValue: o.sealer ?? noSealer },
        ...(o.lobbySignals ? [{ provide: LOBBY_SIGNALS, useValue: o.lobbySignals }] : []),
        ...(o.degradedLimits ? [{ provide: DEGRADED_LIMITS, useValue: o.degradedLimits }] : []),
        ...(o.leaveSignals ? [{ provide: LEAVE_SIGNALS, useValue: o.leaveSignals }] : []),
        ...(o.arrivals ? [{ provide: ARRIVAL_COOKIES, useValue: o.arrivals }] : []),
        ...(o.arrivalSignals ? [{ provide: ARRIVAL_SIGNALS, useValue: o.arrivalSignals }] : []),
      ],
      exports: [PurgeWithdrawnKeys, ShuffleCommits],
    };
  }
}
