// notify 모듈 조립. 웹훅 관리·발송 원장·발송기(내부 입구)를 싣는다. 주기 실행은 main의 WebhookWorker가 맡는다.
import { type DynamicModule, Module, type Provider } from '@nestjs/common';
import { type Clock, type Database, CLOCK, INTERNAL_TOKEN } from '@peaket/platform';
import { Webhooks } from './application/webhooks.js';
import { WebhookDispatcher } from './application/dispatcher.js';
import { WEBHOOK_STORE, WEBHOOK_TRANSPORT, type WebhookStore, type WebhookTransport } from './domain/ports.js';
import { DrizzleWebhookStore } from './adapters/db/drizzle-webhook-store.js';
import { MemoryWebhookStore } from './adapters/memory-webhook-store.js';
import { PartnerWebhookController } from './inbound/partner-webhook.controller.js';
import { InternalWebhookEventController } from './inbound/internal-webhook-event.controller.js';
import { HttpsWebhookTransport } from './adapters/https-transport.js';
import { FakeNotificationTransport, NotificationSender, type NotificationTransport } from './application/notification-sender.js';
import { InternalNotifyController } from './inbound/internal-notify.controller.js';

export const NOTIFY_PARTNER_DATABASE = Symbol.for('peaket.notify.partner-database');
export const NOTIFY_APP_STORE = Symbol.for('peaket.notify.app-store');

@Module({})
export class NotifyModule {
  static register(
    o:
      | { storage: 'memory'; store?: WebhookStore; transport?: WebhookTransport; notificationTransport?: NotificationTransport; env?: Record<string, string | undefined> }
      | { storage: 'database'; /** 웹훅 발송기 전용 core_notify 연결(ADR-0350). 팬 경로 DATABASE 풀과 섞지 않는다 */ notifyDatabase: Database; partnerDatabase: Database; transport?: WebhookTransport; notificationTransport?: NotificationTransport; env?: Record<string, string | undefined> },
  ): DynamicModule {
    const providers: Provider[] = [
      {
        provide: Webhooks,
        useFactory: (store: WebhookStore, clock: Clock) => new Webhooks({ store, clock }),
        inject: [WEBHOOK_STORE, CLOCK],
      },
      { provide: INTERNAL_TOKEN, useValue: process.env.PEAKET_INTERNAL_TOKEN },
      { provide: NotificationSender, useFactory: () => new NotificationSender(o.notificationTransport ?? new FakeNotificationTransport(), o.env ?? process.env) },
      {
        provide: WebhookDispatcher,
        useFactory: (store: WebhookStore, transport: WebhookTransport, clock: Clock) => new WebhookDispatcher({ store, transport, clock }),
        inject: [NOTIFY_APP_STORE, WEBHOOK_TRANSPORT, CLOCK],
      },
    ];
    if (o.storage === 'database') {
      return {
        module: NotifyModule,
        controllers: [PartnerWebhookController, InternalWebhookEventController, InternalNotifyController],
        providers: [
          ...providers,
          { provide: NOTIFY_PARTNER_DATABASE, useValue: o.partnerDatabase },
          // 발송기(내부 입구·주기 작업)는 core_notify 역할의 연결로만 두 표를 쓴다(ADR-0350 결정 2). 팬 경로 DATABASE를 주입하지 않는다
          { provide: NOTIFY_APP_STORE, useFactory: () => new DrizzleWebhookStore(o.notifyDatabase) },
          { provide: WEBHOOK_STORE, useFactory: (db: Database) => new DrizzleWebhookStore(db), inject: [NOTIFY_PARTNER_DATABASE] },
          { provide: WEBHOOK_TRANSPORT, useValue: o.transport ?? new HttpsWebhookTransport() },
        ],
      };
    }
    const store = o.store ?? new MemoryWebhookStore();
    return {
      module: NotifyModule,
      controllers: [PartnerWebhookController, InternalWebhookEventController, InternalNotifyController],
      providers: [
        ...providers,
        { provide: WEBHOOK_STORE, useValue: store },
        { provide: NOTIFY_APP_STORE, useValue: store },
        {
          provide: WEBHOOK_TRANSPORT,
          useValue:
            o.transport ??
            ({
              send: async () => {
                throw new Error('웹훅 발송기가 조립되지 않았습니다');
              },
            } satisfies WebhookTransport),
        },
      ],
    };
  }
}
