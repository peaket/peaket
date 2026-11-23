// 모듈 조립: 웹훅 받는 층에 유스케이스(중계·토큰 확인)를 묶는다. 유스케이스는 조립(relay-app.ts)이 만들어 넘긴다.
import { type DynamicModule, Module } from '@nestjs/common';
import { RelayAlerts } from './application/relay-alerts.js';
import { VerifyWebhook } from './application/verify-webhook.js';
import { AlertsController } from './inbound/alerts.controller.js';
import { WebhookTokenGuard } from './inbound/webhook-token.guard.js';

@Module({})
export class RelayModule {
  static register(o: { relay: RelayAlerts; verify: VerifyWebhook }): DynamicModule {
    return {
      module: RelayModule,
      controllers: [AlertsController],
      providers: [{ provide: RelayAlerts, useValue: o.relay }, { provide: VerifyWebhook, useValue: o.verify }, WebhookTokenGuard],
    };
  }
}
