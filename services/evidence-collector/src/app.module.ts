// 뿌리 모듈: 컨텍스트 모듈(증거 수집 하나)을 모은다. 수집기는 자기 DB가 없다(docs/observability.md §5 '진단 증거').
import { type DynamicModule, Module } from '@nestjs/common';
import { type CollectEvidence, CollectorModule, type VerifyWebhook } from './modules/collector/index.js';

@Module({})
export class AppModule {
  static register(o: { collect: CollectEvidence; verify: VerifyWebhook }): DynamicModule {
    return { module: AppModule, imports: [CollectorModule.register(o)] };
  }
}
