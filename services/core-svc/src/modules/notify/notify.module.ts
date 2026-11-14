// notify 모듈 조립. 지금은 웹훅 관리·발송 원장만이고, 발송기·재시도 워커는 후속이다.
import { type DynamicModule, Module, type Provider } from '@nestjs/common';
import { type Clock, type Database, CLOCK } from '@peaket/platform';
import { Webhooks } from './application/webhooks.js';
import { WEBHOOK_STORE, type WebhookStore } from './domain/ports.js';
import { DrizzleWebhookStore } from './adapters/db/drizzle-webhook-store.js';
import { MemoryWebhookStore } from './adapters/memory-webhook-store.js';
import { PartnerWebhookController } from './inbound/partner-webhook.controller.js';

export const NOTIFY_PARTNER_DATABASE = Symbol.for('peaket.notify.partner-database');

@Module({})
export class NotifyModule {
  static register(o: { storage: 'memory'; store?: WebhookStore } | { storage: 'database'; database: Database; partnerDatabase: Database }): DynamicModule {
    const providers: Provider[] = [
      {
        provide: Webhooks,
        useFactory: (store: WebhookStore, clock: Clock) => new Webhooks({ store, clock }),
        inject: [WEBHOOK_STORE, CLOCK],
      },
    ];
    if (o.storage === 'database') {
      return {
        module: NotifyModule,
        controllers: [PartnerWebhookController],
        providers: [
          ...providers,
          { provide: NOTIFY_PARTNER_DATABASE, useValue: o.partnerDatabase },
          { provide: WEBHOOK_STORE, useFactory: (db: Database) => new DrizzleWebhookStore(db), inject: [NOTIFY_PARTNER_DATABASE] },
        ],
      };
    }
    return {
      module: NotifyModule,
      controllers: [PartnerWebhookController],
      providers: [...providers, { provide: WEBHOOK_STORE, useValue: o.store ?? new MemoryWebhookStore() }],
    };
  }
}
