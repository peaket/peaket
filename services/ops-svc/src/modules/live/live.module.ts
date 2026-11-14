// 관제 SSE 모듈(BAT-465 R-584). 명령 원장·감사 체크포인트를 읽는 곳은 AppModule이 넘긴다.
import { type DynamicModule, Module, type Provider } from '@nestjs/common';
import { OpsLiveFeed } from './application/ops-live-feed.js';
import { OpsLiveController } from './inbound/ops-live.controller.js';

@Module({})
export class LiveModule {
  static register(feed: OpsLiveFeed): DynamicModule {
    const providers: Provider[] = [{ provide: OpsLiveFeed, useValue: feed }];
    return { module: LiveModule, controllers: [OpsLiveController], providers };
  }
}
