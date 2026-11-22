// 관제 SSE 모듈(ADR-0100, ADR-0360). AppModule은 LiveModule.register(new OpsLiveFeed({ commands, checkpoints }))로 부르고(모양 그대로),
// 이 모듈이 전역 DATABASE(platform databaseModule은 @Global)를 있으면 받아 DB 길(알림 표·접속자 표·정비 반복)과 메모리 길을 스스로 고른다.
// 위젯 값 원천은 live-wiring이 환경 값으로 고른다. 종료 세션 목록은 platform 인증 상태(전역 주입 이름)에서 읽는다.
import { type DynamicModule, Module, type Provider } from '@nestjs/common';
import { CLOCK, type Clock, DATABASE, type Database } from '@peaket/platform';
import { OpsLiveFeed } from './application/ops-live-feed.js';
import { PresenceHub, type PresenceOptions } from './application/presence.js';
import { PushHub, type PushHubOptions } from './application/push-hub.js';
import { WidgetFeed, type WidgetFeedOptions } from './application/widget-feed.js';
import { DrizzlePresence } from './adapters/db/drizzle-presence.js';
import { DrizzlePushEvents } from './adapters/db/drizzle-push-events.js';
import { MemoryPresence, MemoryPushEvents } from './adapters/memory-push-events.js';
import type { PresenceStore, PushEventSource, WidgetSource } from './domain/ports.js';
import { OpsEventLiveController } from './inbound/ops-event-live.controller.js';
import { OpsLiveController } from './inbound/ops-live.controller.js';
import { OpsWidgetsController } from './inbound/ops-widgets.controller.js';
import type { TerminatedSessionsView } from './inbound/sse-connection.js';
import { PushRetentionJob } from './jobs/push-retention.js';
import { widgetSourcesFromEnv } from './live-wiring.js';
import { LIVE_RETENTION_ENABLED, PRESENCE_STORE, PUSH_EVENT_SOURCE, TERMINATED_SESSIONS, WIDGET_SOURCES } from './tokens.js';

/** platform 인증 상태의 전역 주입 이름(platform AUTH_STATE와 같은 Symbol.for 값) */
const PLATFORM_AUTH_STATE = Symbol.for('peaket.platform.authState');

/** 시험이 바꿔 끼우는 것(넘기지 않으면 시작 조립의 기본) */
export interface LiveModuleExtras {
  readonly pushEvents?: PushEventSource;
  readonly presence?: PresenceStore;
  readonly widgetSources?: readonly WidgetSource[];
  readonly env?: Record<string, string | undefined>;
  readonly hub?: Omit<PushHubOptions, 'now'>;
  readonly presenceOptions?: Omit<PresenceOptions, 'now'>;
  readonly widgetOptions?: Omit<WidgetFeedOptions, 'now'>;
  /** 정비 반복을 켤지. 기본은 DB가 있을 때 켠다 */
  readonly retention?: boolean;
}

@Module({})
export class LiveModule {
  static register(feed: OpsLiveFeed, extras: LiveModuleExtras = {}): DynamicModule {
    const optionalDb = { token: DATABASE, optional: true };
    const providers: Provider[] = [
      { provide: OpsLiveFeed, useValue: feed },
      {
        provide: PUSH_EVENT_SOURCE,
        useFactory: (db: Database | undefined, clock: Clock): PushEventSource =>
          extras.pushEvents ?? (db ? new DrizzlePushEvents(db) : new MemoryPushEvents(feed.deps.commands, () => clock.now(), feed.deps.limit ?? 100)),
        inject: [optionalDb, CLOCK],
      },
      {
        provide: PRESENCE_STORE,
        useFactory: (db: Database | undefined): PresenceStore => extras.presence ?? (db ? new DrizzlePresence(db) : new MemoryPresence()),
        inject: [optionalDb],
      },
      {
        provide: PushHub,
        useFactory: (source: PushEventSource, clock: Clock) => new PushHub(source, feed, { ...(extras.hub ?? {}), now: () => clock.now() }),
        inject: [PUSH_EVENT_SOURCE, CLOCK],
      },
      {
        provide: PresenceHub,
        useFactory: (store: PresenceStore, clock: Clock) => new PresenceHub(store, { ...(extras.presenceOptions ?? {}), now: () => clock.now() }),
        inject: [PRESENCE_STORE, CLOCK],
      },
      { provide: WIDGET_SOURCES, useValue: extras.widgetSources ?? widgetSourcesFromEnv(extras.env ?? process.env) },
      {
        provide: WidgetFeed,
        useFactory: (sources: readonly WidgetSource[], clock: Clock) => new WidgetFeed(sources, { ...(extras.widgetOptions ?? {}), now: () => clock.now() }),
        inject: [WIDGET_SOURCES, CLOCK],
      },
      {
        provide: TERMINATED_SESSIONS,
        useFactory: (auth: { terminated?: TerminatedSessionsView } | undefined): TerminatedSessionsView | undefined => auth?.terminated,
        inject: [{ token: PLATFORM_AUTH_STATE, optional: true }],
      },
      {
        provide: LIVE_RETENTION_ENABLED,
        useFactory: (db: Database | undefined) => extras.retention ?? db !== undefined,
        inject: [optionalDb],
      },
      PushRetentionJob,
    ];
    return {
      module: LiveModule,
      controllers: [OpsLiveController, OpsEventLiveController, OpsWidgetsController],
      providers,
      exports: [PushHub, WidgetFeed, PUSH_EVENT_SOURCE, PRESENCE_STORE],
    };
  }
}
