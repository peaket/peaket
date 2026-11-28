// F-06-6 GAT-250 E1~E2: 대행사 Retry-After를 원장 재시도 시각에 반영하고 쓸모 기한을 넘기면 EXPIRED.
// 정본: docs/features/notify.md §10, docs/review/plans/F-06-6.md §3.5.
import { fakeClock } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { MailTransportError, SmsTransportError } from '../src/modules/notify/index.js';
import {
  FakeMailTransport,
  FakePushTransport,
  FakeSmsTransport,
  FanNotificationWorker,
  MemoryFanNotifyStore,
  MemoryRecipientDirectory,
  NotificationIntake,
} from '../src/modules/notify/index.js';
import { NOW_MS } from './support.js';
import { OPTOUT_KEY, vapidKeys } from './fan-notify-support.js';

const RETRY_AFTER_MS = 300_000;

class RetryAfterMailError extends MailTransportError {
  readonly retryAfterMs: number;
  constructor() {
    super('RETRYABLE', '429', 429);
    this.retryAfterMs = RETRY_AFTER_MS;
  }
}
class RetryAfterSmsError extends SmsTransportError {
  readonly retryAfterMs: number;
  constructor() {
    super('RETRYABLE', '429', 429);
    this.retryAfterMs = RETRY_AFTER_MS;
  }
}

const setup = () => {
  const clock = fakeClock({ now: NOW_MS });
  const store = new MemoryFanNotifyStore();
  const mail = new FakeMailTransport();
  const sms = new FakeSmsTransport();
  const recipients = new MemoryRecipientDirectory();
  const accountId = randomUUID();
  recipients.rows.set(accountId, { accountId, status: 'ACTIVE', verified: true, locale: 'ko', email: 'fan@example.com', phone: '01099998888' });
  const intake = new NotificationIntake({ store, clock, optOutKey: OPTOUT_KEY });
  const worker = new FanNotificationWorker({ store, mail, push: new FakePushTransport(), sms, recipients, clock, optOutKey: OPTOUT_KEY, vapid: vapidKeys() });
  return { store, mail, sms, accountId, intake, worker };
};

describe('GAT-250 E 대행사 Retry-After', () => {
  test('GAT-250 E1 메일 Retry-After가 정본 간격보다 길면 그 시각까지 미룬다', async () => {
    const t = setup();
    await t.intake.tradeEvent({ type: 'REFUNDED', orderId: randomUUID(), eventId: randomUUID(), accountId: t.accountId, occurredAtMs: NOW_MS, refundAmount: 110_000 });
    t.mail.fail.push(new RetryAfterMailError());
    expect(await t.worker.processDue(new Date(NOW_MS))).toMatchObject({ retrying: 1 });
    const job = [...t.store.jobs.values()][0]!;
    expect(job.status).toBe('RETRYING');
    expect(job.nextAttemptAt.getTime() - NOW_MS).toBe(RETRY_AFTER_MS);
  });

  test('GAT-250 E2 문자 Retry-After도 같고, 쓸모 기한을 넘기면 EXPIRED다', async () => {
    const t = setup();
    await t.intake.notice({
      kind: 'WALLET_OPEN_REMINDER',
      targetId: randomUUID(),
      accountId: t.accountId,
      channel: 'SMS',
      vars: { title: '월렛을 열어 주세요', body: '공연 전날입니다.', url: '/my/tickets' },
      expiresAt: new Date(NOW_MS + 120_000),
    });
    t.sms.fail.push(new RetryAfterSmsError());
    const r = await t.worker.processDue(new Date(NOW_MS));
    expect(r).toMatchObject({ expired: 1 });
    expect(t.store.jobs.size).toBe(0);
    expect(t.store.deliveries.at(-1)).toMatchObject({ channel: 'SMS', status: 'EXPIRED' });
  });
});
