// notify 모듈 조립. 웹훅 관리·발송기와 BAT-455 팬 알림(신청·푸시 구독·원장·워커)을 싣는다.
// 주기 실행은 main의 WebhookWorker·FanNotificationWorker가 맡는다.
import { type DynamicModule, Module, type Provider } from '@nestjs/common';
import { type Clock, type Database, CLOCK, INTERNAL_TOKEN, createExternalHttpClient, isProductionLikeEnv } from '@peaket/platform';
import { dnsLookup } from './adapters/dns-lookup.js';
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
import { FanSubscriptions, PushSubscriptions, SubscriptionOptOuts } from './application/fan-notify.js';
import { NotificationIntake } from './application/notification-intake.js';
import { FanNotificationWorker } from './application/fan-notification-worker.js';
import { FanNotifyController } from './inbound/fan-notify.controller.js';
import { InternalNotifyIdentityController } from './inbound/internal-notify-identity.controller.js';
import { InternalNotifyTicketController } from './inbound/internal-notify-ticket.controller.js';
import { MemoryFanNotifyStore } from './adapters/memory-fan-notify-store.js';
import { DrizzleFanNotifyStore } from './adapters/db/drizzle-fan-notify-store.js';
import { MemoryNotificationEventDirectory } from './adapters/memory-event-directory.js';
import { DrizzleNotificationEventDirectory } from './adapters/db/drizzle-event-directory.js';
import { FakeMailTransport, FakePushTransport, FakeSmsTransport, unavailableMail, unavailablePush, unavailableSms } from './adapters/fake-transports.js';
import { pushTransportFromEnv } from './adapters/file-push-transport.js';
import { MemoryAbsorbedNoticeInbox } from './application/absorbed-notices.js';
import { HttpsPushTransport } from './adapters/https-push-transport.js';
import { GrpcRecipientDirectory, unavailableRecipients } from './adapters/grpc-recipient-directory.js';
import { mailProviderConfigFromEnv, mailTransportFromEnv, optOutKeyFromEnv, publicOriginFromEnv, smsProviderConfigFromEnv, smsTransportFromEnv, topicKeyFromEnv, vapidFromEnv } from './adapters/config.js';
import { NotifyWorkerMetrics, ProviderEvents, ProviderEventsMetrics, type ProviderEventsWiring } from './application/provider-events.js';
import { ProviderEventsController } from './inbound/provider-events.controller.js';
import type { AbsorbedNoticeInbox, FanNotifyStore, MailTransport, NotificationEventDirectory, PushLookup, PushTransport, RecipientDirectory, SmsTransport, VapidConfig } from './domain/fan-notify-ports.js';
import type { NotificationWorkerSignals } from './application/fan-notification-worker.js';
import { MemoryCatalogRepository } from '../catalog/index.js';

export const NOTIFY_PARTNER_DATABASE = Symbol.for('peaket.notify.partner-database');
export const NOTIFY_APP_STORE = Symbol.for('peaket.notify.app-store');
export const FAN_NOTIFY_STORE = Symbol.for('peaket.notify.fan-store');
export const FAN_NOTIFY_SENDER_STORE = Symbol.for('peaket.notify.fan-sender-store');
export const FAN_NOTIFY_EVENTS = Symbol.for('peaket.notify.fan-events');
export const FAN_NOTIFY_MAIL = Symbol.for('peaket.notify.mail');
export const FAN_NOTIFY_SMS = Symbol.for('peaket.notify.sms');
export const FAN_NOTIFY_PUSH = Symbol.for('peaket.notify.push');
export const FAN_NOTIFY_RECIPIENTS = Symbol.for('peaket.notify.recipients');
export const FAN_NOTIFY_OPTOUT_KEY = Symbol.for('peaket.notify.optout-key');
export const FAN_NOTIFY_VAPID = Symbol.for('peaket.notify.vapid');
export const FAN_NOTIFY_LOOKUP = Symbol.for('peaket.notify.lookup');

export interface FanNotifyWiring {
  store?: FanNotifyStore;
  events?: NotificationEventDirectory;
  mail?: MailTransport;
  push?: PushTransport;
  sms?: SmsTransport;
  recipients?: RecipientDirectory;
  absorbedNotices?: AbsorbedNoticeInbox;
  lookup?: PushLookup;
  optOutKey?: string;
  vapid?: VapidConfig;
  publicOrigin?: string;
  topicKey?: string;
  providerEvents?: ProviderEventsWiring;
  signals?: NotificationWorkerSignals;
}

export function fanNotifyProviders(o: { storage: 'memory' | 'database'; wiring?: FanNotifyWiring; env: Record<string, string | undefined>; appDatabase?: Database; senderDatabase?: Database; catalog?: MemoryCatalogRepository }): { providers: Provider[]; store: FanNotifyStore } {
  const env = o.env;
  // 운영은 provider·SES·Solapi·VAPID 필수 값이 없으면 여기서 던져 listen() 전에 멈춘다
  if (isProductionLikeEnv(env)) {
    mailProviderConfigFromEnv(env);
    smsProviderConfigFromEnv(env);
    vapidFromEnv(env);
  }
  const store = o.storage === 'memory' ? (o.wiring?.store ?? new MemoryFanNotifyStore()) : new DrizzleFanNotifyStore(o.appDatabase!);
  const senderStore = o.storage === 'memory' ? store : new DrizzleFanNotifyStore(o.senderDatabase!);
  const events = o.storage === 'memory' ? (o.wiring?.events ?? new MemoryNotificationEventDirectory(o.catalog ?? new MemoryCatalogRepository())) : new DrizzleNotificationEventDirectory(o.appDatabase!);
  const mail = o.wiring?.mail ?? mailTransportFromEnv(env) ?? (o.storage === 'memory' ? new FakeMailTransport() : unavailableMail);
  const push = o.wiring?.push ?? pushTransportFromEnv(env) ?? (o.storage === 'memory' ? new FakePushTransport() : new HttpsPushTransport());
  const sms = o.wiring?.sms ?? smsTransportFromEnv(env) ?? (o.storage === 'memory' ? new FakeSmsTransport() : unavailableSms);
  const absorbedNotices = o.wiring?.absorbedNotices ?? new MemoryAbsorbedNoticeInbox();
  const recipients = o.wiring?.recipients ?? (env.PEAKET_IDENTITY_GRPC_URL ? new GrpcRecipientDirectory(env.PEAKET_IDENTITY_GRPC_URL) : unavailableRecipients);
  const optOutKey = o.wiring?.optOutKey ?? optOutKeyFromEnv(env);
  const vapid = o.wiring?.vapid ?? vapidFromEnv(env);
  const lookup = o.wiring?.lookup ?? dnsLookup;
  const providerEventsMetrics = new ProviderEventsMetrics();
  const workerMetrics = new NotifyWorkerMetrics();
  const providerEvents = new ProviderEvents({
    wiring: o.wiring?.providerEvents ?? providerEventsWiringFromEnv(env),
    signals: providerEventsMetrics,
    log: (line) => console.log(JSON.stringify(line)),
  });
  const providers: Provider[] = [
    { provide: FAN_NOTIFY_STORE, useValue: store },
    { provide: FAN_NOTIFY_SENDER_STORE, useValue: senderStore },
    { provide: FAN_NOTIFY_EVENTS, useValue: events },
    { provide: FAN_NOTIFY_MAIL, useValue: mail },
    { provide: FAN_NOTIFY_SMS, useValue: sms },
    { provide: FAN_NOTIFY_PUSH, useValue: push },
    { provide: FAN_NOTIFY_RECIPIENTS, useValue: recipients },
    { provide: FAN_NOTIFY_OPTOUT_KEY, useValue: optOutKey },
    { provide: FAN_NOTIFY_LOOKUP, useValue: lookup },
    { provide: FAN_NOTIFY_VAPID, useValue: vapid },
    { provide: ProviderEvents, useValue: providerEvents },
    { provide: ProviderEventsMetrics, useValue: providerEventsMetrics },
    { provide: NotifyWorkerMetrics, useValue: workerMetrics },
    {
      provide: FanSubscriptions,
      useFactory: (s: FanNotifyStore, e: NotificationEventDirectory, c: Clock) => new FanSubscriptions({ store: s, events: e, clock: c }),
      inject: [FAN_NOTIFY_STORE, FAN_NOTIFY_EVENTS, CLOCK],
    },
    {
      provide: PushSubscriptions,
      useFactory: (s: FanNotifyStore, c: Clock, l: PushLookup) => new PushSubscriptions({ store: s, clock: c, lookup: l }),
      inject: [FAN_NOTIFY_STORE, CLOCK, FAN_NOTIFY_LOOKUP],
    },
    { provide: SubscriptionOptOuts, useFactory: (s: FanNotifyStore, k: string) => new SubscriptionOptOuts({ store: s, optOutKey: k }), inject: [FAN_NOTIFY_STORE, FAN_NOTIFY_OPTOUT_KEY] },
    { provide: NotificationIntake, useFactory: (s: FanNotifyStore, c: Clock, k: string) => new NotificationIntake({ store: s, clock: c, optOutKey: k, absorbedNotices }), inject: [FAN_NOTIFY_STORE, CLOCK, FAN_NOTIFY_OPTOUT_KEY] },
    {
      provide: FanNotificationWorker,
      useFactory: (s: FanNotifyStore, m: MailTransport, p: PushTransport, r: RecipientDirectory, c: Clock, k: string, v?: VapidConfig) =>
        new FanNotificationWorker({ store: s, mail: m, push: p, sms, recipients: r, clock: c, optOutKey: k, absorbedNotices, ...(v ? { vapid: v } : {}), publicOrigin: o.wiring?.publicOrigin ?? publicOriginFromEnv(env), topicKey: o.wiring?.topicKey ?? topicKeyFromEnv(env, k), signals: o.wiring?.signals ?? workerMetrics, log: (line) => console.log(JSON.stringify(line)) }),
      inject: [FAN_NOTIFY_SENDER_STORE, FAN_NOTIFY_MAIL, FAN_NOTIFY_PUSH, FAN_NOTIFY_RECIPIENTS, CLOCK, FAN_NOTIFY_OPTOUT_KEY, { token: FAN_NOTIFY_VAPID, optional: true }],
    },
  ];
  return { providers, store };
}

/** 설정이 있으면 대행사 웹훅 수신기를 조립한다. 없으면 두 경로 모두 403이다 */
function providerEventsWiringFromEnv(env: Record<string, string | undefined>): ProviderEventsWiring {
  const mail = mailProviderConfigFromEnv(env);
  const sms = smsProviderConfigFromEnv(env);
  const ses = mail.kind === 'ses'
    ? {
        allowedTopicArn: mail.snsTopicArn,
        certHost: `sns.${mail.region}.amazonaws.com`,
        certResolver: async (url: string) => {
          const cert = new URL(url);
          const client = createExternalHttpClient({ provider: 'sns-cert', baseUrl: cert.origin, timeoutCapMs: 5_000 });
          const res = await client.request({ method: 'GET', path: cert.pathname });
          if (!res.ok) throw new Error(`SNS 인증서 응답 ${res.status}`);
          const body = await res.text();
          if (body.length > 64 * 1024) throw new Error('SNS 인증서가 너무 큽니다');
          return body;
        },
      }
    : undefined;
  const smsCfg = sms.kind === 'solapi' ? { secret: sms.webhookSecret } : undefined;
  return { ...(ses ? { ses } : {}), ...(smsCfg ? { sms: smsCfg } : {}) };
}

@Module({})
export class NotifyModule {
  static register(
    o:
      | ({ storage: 'memory'; store?: WebhookStore; transport?: WebhookTransport; notificationTransport?: NotificationTransport; env?: Record<string, string | undefined>; catalog?: MemoryCatalogRepository } & { fanNotify?: FanNotifyWiring })
      | ({
          storage: 'database';
          /** 웹훅 발송기 전용 core_notify 연결(ADR-0351). 팬 경로 DATABASE 풀과 섞지 않는다 */
          notifyDatabase: Database;
          /** 팬 경로 core_app 연결(신청·구독·원장 적기) */
          database: Database;
          partnerDatabase: Database;
          transport?: WebhookTransport;
          notificationTransport?: NotificationTransport;
          env?: Record<string, string | undefined>;
        } & { fanNotify?: FanNotifyWiring }),
  ): DynamicModule {
    const env = o.env ?? process.env;
    const fan = fanNotifyProviders({
      storage: o.storage,
      ...(o.fanNotify ? { wiring: o.fanNotify } : {}),
      env,
      ...(o.storage === 'database' ? { appDatabase: o.database, senderDatabase: o.notifyDatabase } : {}),
      ...(o.storage === 'memory' && o.catalog ? { catalog: o.catalog } : {}),
    });
    const providers: Provider[] = [
      {
        provide: Webhooks,
        useFactory: (store: WebhookStore, clock: Clock) => new Webhooks({ store, clock }),
        inject: [WEBHOOK_STORE, CLOCK],
      },
      { provide: INTERNAL_TOKEN, useValue: env.PEAKET_INTERNAL_TOKEN },
      {
        provide: NotificationSender,
        useFactory: (intake: NotificationIntake, worker: FanNotificationWorker, clock: Clock) =>
          new NotificationSender(o.notificationTransport ?? new FakeNotificationTransport(), env, () => clock.now(), { intake, worker, clock }),
        inject: [NotificationIntake, FanNotificationWorker, CLOCK],
      },
      {
        provide: WebhookDispatcher,
        useFactory: (store: WebhookStore, transport: WebhookTransport, clock: Clock) => new WebhookDispatcher({ store, transport, clock }),
        inject: [NOTIFY_APP_STORE, WEBHOOK_TRANSPORT, CLOCK],
      },
      ...fan.providers,
    ];
    const controllers = [PartnerWebhookController, InternalWebhookEventController, InternalNotifyController, FanNotifyController, InternalNotifyIdentityController, InternalNotifyTicketController, ProviderEventsController];
    if (o.storage === 'database') {
      return {
        module: NotifyModule,
        controllers,
        providers: [
          ...providers,
          { provide: NOTIFY_PARTNER_DATABASE, useValue: o.partnerDatabase },
          // 발송기(내부 입구·주기 작업)는 core_notify 역할의 연결로만 두 표를 쓴다(ADR-0351 결정 2). 팬 경로 DATABASE를 주입하지 않는다
          { provide: NOTIFY_APP_STORE, useFactory: () => new DrizzleWebhookStore(o.notifyDatabase) },
          { provide: WEBHOOK_STORE, useFactory: (db: Database) => new DrizzleWebhookStore(db), inject: [NOTIFY_PARTNER_DATABASE] },
          { provide: WEBHOOK_TRANSPORT, useValue: o.transport ?? new HttpsWebhookTransport() },
        ],
      };
    }
    const store = o.store ?? new MemoryWebhookStore();
    return {
      module: NotifyModule,
      controllers,
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
