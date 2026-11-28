// F-06-6 GAT-250 E1~E2: 대행사 Retry-After를 어댑터가 읽고 워커가 max(정본 간격, retryAfterMs)로 미룬다.
// 정본: docs/features/notify.md §10, docs/review/plans/F-06-6.md §3.5.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fakeClock } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import {
  FakePushTransport,
  FakeSmsTransport,
  FanNotificationWorker,
  MemoryFanNotifyStore,
  MemoryRecipientDirectory,
  NotificationIntake,
} from '../src/modules/notify/index.js';
import { NOW_MS } from './support.js';
import { OPTOUT_KEY, vapidKeys } from './fan-notify-support.js';

interface SesInput {
  FromEmailAddress: string;
  Destination: { ToAddresses: string[] };
  Content: { Simple: { Subject: { Data: string }; Body: { Text: { Data: string } } } };
  ConfigurationSetName: string;
  EmailTags: { Name: string; Value: string }[];
}
interface SesClient {
  send(input: SesInput): Promise<{ MessageId?: string }>;
}
interface SesTransport {
  send(input: { to: string; subject: string; body: string; headers: Record<string, string>; messageKey: string }): Promise<{ providerMessageId?: string }>;
}
interface SolapiResult {
  status: number;
  headers?: Record<string, string>;
  text(): Promise<string>;
}
interface SolapiTransport {
  send(input: { to: string; body: string; messageKey: string }): Promise<{ providerMessageId?: string }>;
}

const sesUrl = new URL('../src/modules/notify/adapters/ses-mail-transport.ts', import.meta.url).href;
const solapiUrl = new URL('../src/modules/notify/adapters/solapi-sms-transport.ts', import.meta.url).href;
const sesPath = fileURLToPath(sesUrl);
const solapiPath = fileURLToPath(solapiUrl);

const setup = (mail: SesTransport | { send(input: { to: string; subject: string; body: string; headers: Record<string, string>; messageKey: string }): Promise<{ providerMessageId?: string }> }, sms = new FakeSmsTransport()) => {
  const clock = fakeClock({ now: NOW_MS });
  const store = new MemoryFanNotifyStore();
  const recipients = new MemoryRecipientDirectory();
  const accountId = randomUUID();
  recipients.rows.set(accountId, { accountId, status: 'ACTIVE', verified: true, locale: 'ko', email: 'fan@example.com', phone: '01099998888' });
  const intake = new NotificationIntake({ store, clock, optOutKey: OPTOUT_KEY });
  const worker = new FanNotificationWorker({ store, mail, push: new FakePushTransport(), sms, recipients, clock, optOutKey: OPTOUT_KEY, vapid: vapidKeys() });
  return { store, recipients, accountId, intake, worker };
};

describe('GAT-250 E 대행사 Retry-After', () => {
  test('GAT-250 E1 SES 429의 Retry-After 300을 읽어 300초 뒤로 미루고, 10초면 정본 60초로 올린다', async () => {
    expect(existsSync(sesPath)).toBe(true);
    if (!existsSync(sesPath)) return;
    const mod = (await import(/* @vite-ignore */ sesUrl)) as { SesMailTransport?: new (o: {
      client: SesClient; region: string; snsTopicArn: string; from: string; fromDomain: string; configurationSet: string;
    }) => SesTransport };
    expect(typeof mod.SesMailTransport).toBe('function');
    if (typeof mod.SesMailTransport !== 'function') return;

    let retryAfter = '300';
    const client: SesClient = {
      send: async () => {
        throw Object.assign(new Error('429'), { $metadata: { httpStatusCode: 429 }, $response: { headers: { 'retry-after': retryAfter } } });
      },
    };
    const mail = new mod.SesMailTransport({
      client,
      region: 'ap-northeast-2',
      snsTopicArn: 'arn:aws:sns:ap-northeast-2:123456789012:peaket-notify-events',
      from: 'no-reply@notify.peaket.example',
      fromDomain: 'notify.peaket.example',
      configurationSet: 'peaket-notify-events',
    });
    const t = setup(mail);
    await t.intake.tradeEvent({ type: 'REFUNDED', orderId: randomUUID(), eventId: randomUUID(), accountId: t.accountId, occurredAtMs: NOW_MS, refundAmount: 110_000 });
    expect(await t.worker.processDue(new Date(NOW_MS))).toMatchObject({ retrying: 1 });
    const long = [...t.store.jobs.values()][0]!;
    expect(long.status).toBe('RETRYING');
    expect(long.nextAttemptAt.getTime() - NOW_MS).toBe(300_000);

    retryAfter = '10';
    await t.intake.tradeEvent({ type: 'REFUNDED', orderId: randomUUID(), eventId: randomUUID(), accountId: t.accountId, occurredAtMs: NOW_MS, refundAmount: 110_000 });
    expect(await t.worker.processDue(new Date(NOW_MS))).toMatchObject({ retrying: 1 });
    const short = [...t.store.jobs.values()].find((j) => j.dedupKey !== long.dedupKey)!;
    expect(short.nextAttemptAt.getTime() - NOW_MS).toBe(60_000);
  });

  test('GAT-250 E2 Solapi 429의 Retry-After 300도 읽고, 쓸모 기한을 넘기면 EXPIRED다', async () => {
    expect(existsSync(solapiPath)).toBe(true);
    if (!existsSync(solapiPath)) return;
    const mod = (await import(/* @vite-ignore */ solapiUrl)) as { SolapiSmsTransport?: new (o: {
      apiKey: string; apiSecret: string; senderNumber: string;
      fetch: (url: string, init: { method: 'POST'; headers: Record<string, string>; body: string }) => Promise<SolapiResult>;
    }) => SolapiTransport };
    expect(typeof mod.SolapiSmsTransport).toBe('function');
    if (typeof mod.SolapiSmsTransport !== 'function') return;

    const sms = new mod.SolapiSmsTransport({
      apiKey: 'k',
      apiSecret: 's',
      senderNumber: '01012345678',
      fetch: async () => ({ status: 429, headers: { 'retry-after': '300' }, text: async () => '{"error":"too many"}' }),
    });
    const t = setup({ send: async () => ({ providerMessageId: 'unused' }) }, sms);
    await t.intake.notice({
      kind: 'WALLET_OPEN_REMINDER',
      targetId: randomUUID(),
      accountId: t.accountId,
      channel: 'SMS',
      vars: { title: '월렛을 열어 주세요', body: '공연 전날입니다.', url: '/my/tickets' },
      expiresAt: new Date(NOW_MS + 120_000),
    });
    const r = await t.worker.processDue(new Date(NOW_MS));
    expect(r).toMatchObject({ expired: 1 });
    expect(t.store.jobs.size).toBe(0);
    expect(t.store.deliveries.at(-1)).toMatchObject({ channel: 'SMS', status: 'EXPIRED' });
  });
});
