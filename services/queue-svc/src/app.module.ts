// 뿌리 모듈: 컨텍스트 모듈을 모은다. 진입(사전 검증·진입)과 대기 상태 파일이 있다.
import { type DynamicModule, Module } from '@nestjs/common';
import type { HotRedis } from '@peaket/platform';
import { EntryModule, type EventSchedules, type QueueTokens, type RiskPort } from './modules/entry/index.js';
import { StateModule, type StateSnapshots } from './modules/state/index.js';

@Module({})
export class AppModule {
  /** 운영은 redis, 시험은 memory를 고른다(저장소가 없을 때 조용히 메모리로 가지 않게 둘 중 하나를 꼭 적는다) */
  static register(
    o: ({ redis: HotRedis } | { memory: true; schedules?: EventSchedules; snapshots?: StateSnapshots }) & {
      tokens: QueueTokens;
      risk: RiskPort;
      /** 대기 상태 파일: 교차 출처 허용과 매초 다시 만들기(시험은 끈다) */
      state?: { webOrigin?: string; autoTick?: boolean };
    },
  ): DynamicModule {
    const entry = 'redis' in o ? EntryModule.register({ storage: 'redis', redis: o.redis, tokens: o.tokens, risk: o.risk }) : EntryModule.register({ storage: 'memory', schedules: o.schedules, tokens: o.tokens, risk: o.risk });
    const options = { ...(o.state?.webOrigin ? { webOrigin: o.state.webOrigin } : {}), ...(o.state?.autoTick !== undefined ? { autoTick: o.state.autoTick } : {}) };
    const state = 'redis' in o ? StateModule.register({ storage: 'redis', redis: o.redis, options }) : StateModule.register({ storage: 'memory', schedules: o.schedules, snapshots: o.snapshots, options });
    return { module: AppModule, imports: [entry, state] };
  }
}
