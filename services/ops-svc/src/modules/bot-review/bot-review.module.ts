// 표본 검토 모듈 조립(FR-049, SCR-067, BAT-197).
// AppModule이 DB 갈래면 Drizzle 저장소를, 메모리 갈래면 MemoryBotReviewStore를 넘긴다.
// 후보 원장·trust 라벨이 없으면 경로는 그대로 있고 진행은 404(배치 없음)·판정은 503 label-unavailable이다.
import { type DynamicModule, Module, type Provider } from '@nestjs/common';
import { CLOCK, type Clock, type Database, PLATFORM_LOGGER, type PlatformLogger } from '@peaket/platform';
import { DrizzleBotReviewStore } from './adapters/db/drizzle-bot-review-store.js';
import { MemoryBotReviewStore } from './adapters/memory-bot-review-store.js';
import { SecurityBotReviewLog } from './adapters/security-bot-review-log.js';
import { FixtureBotReviewSource } from './adapters/fixture-bot-review-source.js';
import { GetBotReview } from './application/get-review.js';
import { ListBotReviewSamples } from './application/list-samples.js';
import { RecordBotReviewJudgement } from './application/record-judgement.js';
import type { BotReviewSignals, BotReviewSource, BotReviewStore, TrustLabels } from './domain/ports.js';
import { BotReviewController } from './inbound/bot-review.controller.js';

export const BOT_REVIEW_STORE = Symbol.for('peaket.ops.bot-review-store');

export interface BotReviewModuleDeps {
  /** 이미 만든 저장소. 없으면 database가 있으면 Drizzle, 없으면 메모리 */
  readonly store?: BotReviewStore;
  readonly database?: Database;
  /** 표본 후보 원장. 없으면 503 source-unavailable(진행은 배치가 없어 404) */
  readonly source?: BotReviewSource;
  /** trust-svc ApplyLabel. 없으면 HUMAN·BOT 판정이 503 label-unavailable이고 UNDECIDED는 기록된다 */
  readonly labels?: TrustLabels;
  /** 지표. 없으면 세지 않는다 */
  readonly signals?: BotReviewSignals;
  /** 처리자 관리 계정 ID를 로그 가명으로 바꾼다. 없으면 로그에 처리자를 싣지 않는다 */
  readonly accountRef?: (accountId: string) => string | undefined;
}

@Module({})
export class BotReviewModule {
  static register(deps: BotReviewModuleDeps = {}): DynamicModule {
    const source = deps.source ?? new FixtureBotReviewSource();
    const storeProvider: Provider = deps.store
      ? { provide: BOT_REVIEW_STORE, useValue: deps.store }
      : {
          provide: BOT_REVIEW_STORE,
          inject: [CLOCK],
          useFactory: (clock: Clock): BotReviewStore =>
            deps.database ? new DrizzleBotReviewStore(deps.database, clock) : new MemoryBotReviewStore(),
        };
    return {
      module: BotReviewModule,
      controllers: [BotReviewController],
      providers: [
        storeProvider,
        {
          provide: GetBotReview,
          inject: [BOT_REVIEW_STORE, CLOCK],
          useFactory: (store: BotReviewStore, clock: Clock) => new GetBotReview(store, source, () => clock.now()),
        },
        {
          provide: ListBotReviewSamples,
          inject: [BOT_REVIEW_STORE, CLOCK],
          useFactory: (store: BotReviewStore, clock: Clock) => new ListBotReviewSamples(store, () => clock.now()),
        },
        {
          provide: RecordBotReviewJudgement,
          inject: [BOT_REVIEW_STORE, CLOCK, PLATFORM_LOGGER],
          useFactory: (store: BotReviewStore, clock: Clock, logger: PlatformLogger) =>
            new RecordBotReviewJudgement({
              store,
              source,
              ...(deps.labels ? { labels: deps.labels } : {}),
              now: () => clock.now(),
              ...(deps.signals ? { signals: deps.signals } : {}),
              log: new SecurityBotReviewLog(logger),
              ...(deps.accountRef ? { accountRef: deps.accountRef } : {}),
            }),
        },
      ],
    };
  }
}
