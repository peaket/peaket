// 뿌리 모듈: 컨텍스트 모듈(경보 티켓 중계 하나)을 모은다. 중계는 자기 DB가 없다(docs/observability.md §5 티켓 중계).
import { type DynamicModule, Module } from '@nestjs/common';
import { type RelayAlerts, RelayModule, type VerifyWebhook } from './modules/relay/index.js';

@Module({})
export class AppModule {
  static register(o: { relay: RelayAlerts; verify: VerifyWebhook }): DynamicModule {
    return { module: AppModule, imports: [RelayModule.register(o)] };
  }
}
