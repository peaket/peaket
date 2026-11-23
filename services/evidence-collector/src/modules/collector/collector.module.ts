// 모듈 조립 파일: 웹훅 받는 층에 유스케이스(수집·토큰 확인)를 묶는다(층 규칙의 밖). 유스케이스는 조립(collector-app.ts)이 만들어 넘긴다.
import { type DynamicModule, Module } from '@nestjs/common';
import { CollectEvidence } from './application/collect-evidence.js';
import { VerifyWebhook } from './application/verify-webhook.js';
import { AlertsController } from './inbound/alerts.controller.js';
import { WebhookTokenGuard } from './inbound/webhook-token.guard.js';

@Module({})
export class CollectorModule {
  static register(o: { collect: CollectEvidence; verify: VerifyWebhook }): DynamicModule {
    return {
      module: CollectorModule,
      controllers: [AlertsController],
      providers: [{ provide: CollectEvidence, useValue: o.collect }, { provide: VerifyWebhook, useValue: o.verify }, WebhookTokenGuard],
    };
  }
}
