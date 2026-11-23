// 관제 SSE 모듈(ADR-0100, ADR-0360). AppModule은 LiveModule.register(new OpsLiveFeed({ commands, checkpoints }))로 부르고(모양 그대로),
// 이 모듈이 전역 DATABASE(platform databaseModule은 @Global)를 있으면 받아 DB 길(알림 표·접속자 표·정비 반복)과 메모리 길을 스스로 고른다.
// 위젯 값 원천은 live-wiring이 환경 값으로 고른다. 종료 세션 목록은 platform 인증 상태(전역 주입 이름)에서 읽는다.
// F-03-3(ADR-0371): 회차 단계·T-30분 점검·Go/No-Go 판정 컨텍스트(readiness)를 imports로 싣고, 관제 판단 위젯 원천 넷, 자동 제어 상태 감시(대기열 Redis 읽기),
// 경보 목록 REST를 더한다. app.module.ts를 고치지 않으려는 것이다(계획 '감독에게' 3 (가)).
import { type DynamicModule, Module, type Provider } from '@nestjs/common';
import { CLOCK, type Clock, createHotRedis, DATABASE, type Database, INTERNAL_TOKEN_REQUIRED, PLATFORM_LOGGER, type PlatformLogger } from '@peaket/platform';
import { DrizzleOpsAlertStore, MemoryOpsAlertStore, type OpsAlertList, type OpsAlertStore } from '../alerts/index.js';
import { MemoryAuditChain } from '../audit/index.js';
import {
  DrizzleJudgementStore,
  HttpCoreSaleSchedule,
  MemoryJudgementStore,
  PrometheusReadinessProbe,
  ReadinessModule,
  ReadinessService,
  UnavailableSaleSchedule,
  type JudgementStore,
  type ReadinessProbe,
  type ReadinessServiceDeps,
  type SaleScheduleSource,
} from '../readiness/index.js';
import { ControlWatch, type ControlWatchOptions } from './application/control-watch.js';
import { OpsLiveFeed } from './application/ops-live-feed.js';
import { PresenceHub, type PresenceOptions } from './application/presence.js';
import { PushHub, type PushHubOptions } from './application/push-hub.js';
import { WidgetFeed, type WidgetFeedOptions } from './application/widget-feed.js';
import { DrizzlePresence } from './adapters/db/drizzle-presence.js';
import { DrizzlePushEvents } from './adapters/db/drizzle-push-events.js';
import { MemoryPresence, MemoryPushEvents } from './adapters/memory-push-events.js';
import {
  PendingDiagnosticsSource,
  PrometheusBudgetSource,
  PrometheusQuery,
  PrometheusSaturationSource,
  ReadinessWidgetSource,
  UnavailableJudgementSource,
} from './adapters/prometheus-judgement-sources.js';
import { RedisControlReader } from './adapters/redis-control-reader.js';
import type { ControlReader, PresenceStore, PushEventSource, WidgetSource } from './domain/ports.js';
import { OpsAlertsController } from './inbound/ops-alerts.controller.js';
import { OpsEventLiveController } from './inbound/ops-event-live.controller.js';
import { OpsLiveController } from './inbound/ops-live.controller.js';
import { OpsWidgetsController } from './inbound/ops-widgets.controller.js';
import type { TerminatedSessionsView } from './inbound/sse-connection.js';
import { ControlWatchJob } from './jobs/control-watch.job.js';
import { PushRetentionJob } from './jobs/push-retention.js';
import { judgeAccountRefOf, liveWiringOf, widgetSourcesFromEnv, type LiveWiring } from './live-wiring.js';
import { CONTROL_READER, LIVE_ALERT_STORE, LIVE_RETENTION_ENABLED, LIVE_WIRING, PRESENCE_STORE, PUSH_EVENT_SOURCE, TERMINATED_SESSIONS, WIDGET_SOURCES } from './tokens.js';

/** platform 인증 상태의 전역 주입 이름(platform AUTH_STATE와 같은 Symbol.for 값) */
const PLATFORM_AUTH_STATE = Symbol.for('peaket.platform.authState');

/** 시험이 바꿔 끼우는 것(넘기지 않으면 시작 조립의 기본) */
export interface LiveModuleExtras {
  readonly pushEvents?: PushEventSource;
  readonly presence?: PresenceStore;
  readonly widgetSources?: readonly WidgetSource[];
  readonly env?: Record<string, string | undefined>;
  readonly hub?: Omit<PushHubOptions, 'now' | 'logger'>;
  readonly presenceOptions?: Omit<PresenceOptions, 'now'>;
  readonly widgetOptions?: Omit<WidgetFeedOptions, 'now'>;
  /** 정비 반복을 켤지. 기본은 DB가 있을 때 켠다 */
  readonly retention?: boolean;
  /** 경보 기록 표(F-03-3 입력 없음 경보·경보 목록). 없으면 DB 조립은 DrizzleOpsAlertStore, 메모리 조립은 새 MemoryOpsAlertStore */
  readonly alerts?: OpsAlertStore & OpsAlertList;
  /** 자동 제어 상태 읽기. null이면 끈다. 없으면 환경 값의 대기열 Redis로 만든다 */
  readonly controlReader?: ControlReader | null;
  readonly controlOptions?: Pick<ControlWatchOptions, 'tickMs'>;
  /** readiness 원천·저장소 바꿔 끼우기 */
  readonly readiness?: { readonly schedules?: SaleScheduleSource; readonly probe?: ReadinessProbe; readonly judgements?: JudgementStore };
}

@Module({})
export class LiveModule {
  static register(feed: OpsLiveFeed, extras: LiveModuleExtras = {}): DynamicModule {
    const env = extras.env ?? process.env;
    const optionalDb = { token: DATABASE, optional: true };
    const optionalLocal = { token: INTERNAL_TOKEN_REQUIRED, optional: true };
    const wiringOf = (internalTokenRequired: boolean | undefined) => liveWiringOf(env, internalTokenRequired === false);

    const readiness = ReadinessModule.register({
      inject: [optionalDb, CLOCK, optionalLocal],
      useFactory: ((db: Database | undefined, clock: Clock, internalTokenRequired: boolean | undefined): ReadinessServiceDeps => {
        const w = wiringOf(internalTokenRequired);
        const now = () => clock.now();
        return {
          schedules: extras.readiness?.schedules ?? (w.coreUrl ? HttpCoreSaleSchedule.fromUrl(w.coreUrl, now, w.internalToken) : new UnavailableSaleSchedule()),
          probe: extras.readiness?.probe ?? PrometheusReadinessProbe.fromUrl(w.prometheusUrl, w.cloudLocal),
          // 메모리 조립의 감사 체인은 이 저장소만의 것이다(시험·local, DB 조립은 audit_chain에 같은 트랜잭션으로 남긴다)
          judgements: extras.readiness?.judgements ?? (db ? new DrizzleJudgementStore(db) : new MemoryJudgementStore(new MemoryAuditChain())),
          now,
          // 가명 키는 판정을 기록할 때 읽는다(키 없이 뜨는 데모·시험 조립을 깨지 않는다)
          accountRef: judgeAccountRefOf(env, w),
        };
      }) as (...args: never[]) => ReadinessServiceDeps,
    });

    const providers: Provider[] = [
      { provide: OpsLiveFeed, useValue: feed },
      { provide: LIVE_WIRING, useFactory: (internalTokenRequired: boolean | undefined): LiveWiring => wiringOf(internalTokenRequired), inject: [optionalLocal] },
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
        useFactory: (source: PushEventSource, clock: Clock, logger: PlatformLogger | undefined) =>
          new PushHub(source, feed, { ...(extras.hub ?? {}), now: () => clock.now(), ...(logger ? { logger } : {}) }),
        inject: [PUSH_EVENT_SOURCE, CLOCK, { token: PLATFORM_LOGGER, optional: true }],
      },
      {
        provide: PresenceHub,
        useFactory: (store: PresenceStore, clock: Clock) => new PresenceHub(store, { ...(extras.presenceOptions ?? {}), now: () => clock.now() }),
        inject: [PRESENCE_STORE, CLOCK],
      },
      {
        provide: WIDGET_SOURCES,
        // 넘긴 원천이 맡지 않은 키만 기본 원천으로 채운다(F-03-1 시험이 원격 위젯 둘의 원천을 바꿔 끼운다)
        useFactory: (w: LiveWiring, service: ReadinessService): readonly WidgetSource[] => {
          const given = extras.widgetSources ?? widgetSourcesFromEnv(env);
          const covered = new Set(given.flatMap((s) => [...s.keys]));
          const prom = w.prometheusUrl ? PrometheusQuery.fromUrl(w.prometheusUrl) : undefined;
          const defaults: WidgetSource[] = [
            ...(prom ? [new PrometheusBudgetSource(prom), new PrometheusSaturationSource(prom)] : [new UnavailableJudgementSource()]),
            new PendingDiagnosticsSource(),
            new ReadinessWidgetSource(service),
          ];
          // 지표 창고가 없으면 UnavailableJudgementSource가 버짓·포화도 둘을 함께 맡는다
          return [...given, ...defaults.filter((s) => s.keys.every((k) => !covered.has(k)))];
        },
        inject: [LIVE_WIRING, ReadinessService],
      },
      {
        provide: WidgetFeed,
        useFactory: (sources: readonly WidgetSource[], clock: Clock) => new WidgetFeed(sources, { ...(extras.widgetOptions ?? {}), now: () => clock.now() }),
        inject: [WIDGET_SOURCES, CLOCK],
      },
      {
        provide: LIVE_ALERT_STORE,
        useFactory: (db: Database | undefined): OpsAlertStore & OpsAlertList => extras.alerts ?? (db ? new DrizzleOpsAlertStore(db) : new MemoryOpsAlertStore()),
        inject: [optionalDb],
      },
      {
        provide: CONTROL_READER,
        // 대기열 Redis는 읽기 전용 사용자로 붙는다(운영). 시작 마감 안에 붙지 못하면 시작하지 않는다
        useFactory: async (w: LiveWiring): Promise<ControlReader | undefined> => {
          if (extras.controlReader !== undefined) return extras.controlReader ?? undefined;
          if (!w.queueRedis) return undefined;
          return new RedisControlReader(await createHotRedis({ ...(w.queueRedis.clusterUrls ? { clusterUrls: w.queueRedis.clusterUrls } : { url: w.queueRedis.url! }), cluster: 'queue' }));
        },
        inject: [LIVE_WIRING],
      },
      {
        provide: ControlWatch,
        useFactory: (reader: ControlReader | undefined, alerts: OpsAlertStore, clock: Clock, logger: PlatformLogger | undefined) =>
          new ControlWatch(reader, alerts, { ...(extras.controlOptions ?? {}), now: () => clock.now(), ...(logger ? { logger } : {}) }),
        inject: [{ token: CONTROL_READER, optional: true }, LIVE_ALERT_STORE, CLOCK, { token: PLATFORM_LOGGER, optional: true }],
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
      ControlWatchJob,
    ];
    return {
      module: LiveModule,
      imports: [readiness],
      controllers: [OpsLiveController, OpsEventLiveController, OpsWidgetsController, OpsAlertsController],
      providers,
      exports: [PushHub, WidgetFeed, PUSH_EVENT_SOURCE, PRESENCE_STORE, ControlWatch],
    };
  }
}
