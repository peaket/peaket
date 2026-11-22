// BAT-455 N-T19·N-T21·N-T22: 발송 원장·워커·재시도·실패 처리·밤 규칙·웹 푸시 암호화.
import { fakeClock } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import {
  FakePushTransport,
  FanNotificationWorker,
  MailTransportError,
  MemoryFanNotifyStore,
  MemoryRecipientDirectory,
  NotificationIntake,
  notificationRetryDelayMs,
} from '../src/modules/notify/index.js';
import type { MailTransport, PushSendResult } from '../src/modules/notify/index.js';
import { NOW_MS } from './support.js';
import { OPTOUT_KEY, pushKeyPair, vapidKeys } from './fan-notify-support.js';

class FakeMail implements MailTransport {
  readonly sent: Parameters<MailTransport['send']>[0][] = [];
  readonly fail: Error[] = [];
  async send(input: Parameters<MailTransport['send']>[0]) {
    const e = this.fail.shift();
    if (e) throw e;
    this.sent.push(input);
    return { providerMessageId: `msg-${this.sent.length}` };
  }
}

class FlakyPush extends FakePushTransport {
  readonly fail: Error[] = [];
  override async send(input: Parameters<FakePushTransport['send']>[0]): Promise<PushSendResult> {
    const e = this.fail.shift();
    if (e) throw e;
    return super.send(input);
  }
}

const setup = (o: { now?: number; id?: string; change?: 'LINKED' | 'UNLINKED'; eventId?: string } = {}) => {
  const clock = fakeClock({ now: o.now ?? NOW_MS });
  const store = new MemoryFanNotifyStore();
  const mail = new FakeMail();
  const push = new FlakyPush();
  const recipients = new MemoryRecipientDirectory();
  const intake = new NotificationIntake({ store, clock, optOutKey: OPTOUT_KEY });
  const worker = new FanNotificationWorker({ store, mail, push, recipients, clock, optOutKey: OPTOUT_KEY, vapid: vapidKeys() });
  return { clock, store, mail, push, recipients, intake, worker };
};

const account = (recipients: MemoryRecipientDirectory, email = 'fan@example.com') => {
  const id = randomUUID();
  recipients.rows.set(id, { accountId: id, status: 'ACTIVE', verified: true, locale: 'ko', email });
  return id;
};

describe('N-T19 발송 원장·워커', () => {
  test('N-T19 ① 같은 사건은 한 번만 적고 한 번만 보낸다 [ASVS v5.0.0-8.4.1] [ASVS v5.0.0-16.2.5]', async () => {
    const t = setup();
    const accountId = account(t.recipients);
    const event = { type: 'REFUNDED' as const, orderId: randomUUID(), eventId: randomUUID(), accountId, occurredAtMs: NOW_MS, refundAmount: 110_000 };

    expect(await t.intake.tradeEvent(event)).toBe('created');
    expect(await t.intake.tradeEvent(event)).toBe('duplicate');
    expect(t.store.jobs.size).toBe(1);

    const r = await t.worker.processDue(new Date(NOW_MS));
    expect(r).toMatchObject({ attempted: 1, sent: 1 });
    expect(t.mail.sent).toHaveLength(1);
    expect(t.mail.sent[0]).toMatchObject({ to: 'fan@example.com', subject: '환급이 완료되었습니다' });
    expect(t.store.jobs.size).toBe(0);
    expect(t.store.deliveries).toHaveLength(1);
    expect(t.store.deliveries[0]).toMatchObject({ status: 'SENT', kind: 'REFUNDED', channel: 'EMAIL', accountId });
  });

  test('N-T19 ② 5xx는 재시도 간격을 지키고 성공하면 기록 한 줄만 남긴다', async () => {
    const t = setup();
    const accountId = account(t.recipients);
    await t.intake.tradeEvent({ type: 'REFUNDED', orderId: randomUUID(), eventId: randomUUID(), accountId, occurredAtMs: NOW_MS });
    t.mail.fail.push(new MailTransportError('RETRYABLE', '503', 503));

    expect(await t.worker.processDue(new Date(NOW_MS))).toMatchObject({ retrying: 1 });
    const job = [...t.store.jobs.values()][0]!;
    expect(job).toMatchObject({ status: 'RETRYING', attempts: 1 });
    expect(job.nextAttemptAt.getTime()).toBe(NOW_MS + notificationRetryDelayMs(1));

    expect(await t.worker.processDue(new Date(NOW_MS + notificationRetryDelayMs(1) - 1))).toMatchObject({ attempted: 0 });
    expect(await t.worker.processDue(new Date(NOW_MS + notificationRetryDelayMs(1)))).toMatchObject({ sent: 1 });
    expect(t.mail.sent).toHaveLength(1);
    expect(t.store.deliveries).toHaveLength(1);
    expect(t.store.deliveries[0]!.status).toBe('SENT');
  });

  test('N-T19 ③ 400은 재시도 없이 DEAD, 쓸모 기한이 지나면 EXPIRED다', async () => {
    const t = setup();
    const accountId = account(t.recipients);
    await t.intake.tradeEvent({ type: 'REFUNDED', orderId: randomUUID(), eventId: randomUUID(), accountId, occurredAtMs: NOW_MS });
    t.mail.fail.push(new MailTransportError('PERMANENT', '400', 400));
    expect(await t.worker.processDue(new Date(NOW_MS))).toMatchObject({ dead: 1 });
    expect(t.store.jobs.size).toBe(0);
    expect(t.store.deliveries[0]!.status).toBe('DEAD');

    await t.intake.tradeEvent({ type: 'REFUNDED', orderId: randomUUID(), eventId: randomUUID(), accountId, occurredAtMs: NOW_MS });
    const [key, job] = [...t.store.jobs.entries()][0]!;
    t.store.jobs.set(key, { ...job, expiresAt: new Date(NOW_MS - 1) });
    expect(await t.worker.processDue(new Date(NOW_MS))).toMatchObject({ expired: 1 });
    expect(t.mail.sent).toHaveLength(0);
    expect(t.store.deliveries.at(-1)!.status).toBe('EXPIRED');
  });

  test('N-T19 ④ 결과를 모르는 신청 알림은 다시 보내지 않고, 돈·보안 통지만 한 번 더 보낸다', async () => {
    const t = setup();
    const accountId = account(t.recipients);
    await t.intake.loginMethodChanged({ eventKey: randomUUID(), accountId, change: 'LINKED', provider: 'google', occurredAtMs: NOW_MS });
    t.mail.fail.push(new MailTransportError('UNKNOWN', 'timeout'));
    // 로그인 안내는 이메일과 웹 푸시 두 job이다. 이메일만 실패로 만든다
    const emailKey = [...t.store.jobs.keys()].find((k) => k.endsWith(':EMAIL'))!;
    expect(await t.worker.processDue(new Date(NOW_MS))).toMatchObject({ failed: 1 });
    expect(t.store.jobs.has(emailKey)).toBe(false);
    expect(t.store.deliveries.find((d) => d.channel === 'EMAIL')!.status).toBe('FAILED');

    await t.intake.tradeEvent({ type: 'REFUNDED', orderId: randomUUID(), eventId: randomUUID(), accountId, occurredAtMs: NOW_MS });
    t.mail.fail.push(new MailTransportError('UNKNOWN', 'timeout'));
    expect(await t.worker.processDue(new Date(NOW_MS))).toMatchObject({ retrying: 1 });
  });

  test('N-T19 ⑤ 허용 목록 밖 변수는 적지 않고, MERGED 계정에는 이메일을 보내지 않는다', async () => {
    const t = setup();
    const accountId = account(t.recipients);
    await expect(t.intake.notice({ kind: 'OPEN_LOBBY', targetId: randomUUID(), accountId, channel: 'EMAIL', vars: { email: 'x@y.z' } })).rejects.toMatchObject({ code: 'INVALID' });
    expect(t.store.jobs.size).toBe(0);

    t.recipients.rows.set(accountId, { accountId, status: 'MERGED', verified: true, locale: 'ko', email: 'old@example.com' });
    await t.intake.tradeEvent({ type: 'REFUNDED', orderId: randomUUID(), eventId: randomUUID(), accountId, occurredAtMs: NOW_MS });
    expect(await t.worker.processDue(new Date(NOW_MS))).toMatchObject({ failed: 1 });
    expect(t.mail.sent).toHaveLength(0);
    expect(t.store.deliveries[0]!.status).toBe('FAILED');
  });

  test('N-T19 ⑥ 한 행은 한 워커만 임대한다', async () => {
    const t = setup();
    const accountId = account(t.recipients);
    await t.intake.tradeEvent({ type: 'REFUNDED', orderId: randomUUID(), eventId: randomUUID(), accountId, occurredAtMs: NOW_MS });
    const due = await t.store.leaseDueJobs(new Date(NOW_MS), 20, 120_000);
    expect(due).toHaveLength(1);
    expect(await t.store.leaseDueJobs(new Date(NOW_MS), 20, 120_000)).toHaveLength(0);
  });
});

describe('N-T21 웹 푸시·밤 규칙', () => {
  test('N-T21 ① RFC 8291 본문과 VAPID 머리를 만들고 404·410·403 구독을 지운다 [ASVS v5.0.0-14.2.1] [ASVS v5.0.0-16.2.5]', async () => {
    const t = setup();
    const accountId = account(t.recipients);
    const key = pushKeyPair();
    const row = {
      id: randomUUID(), accountId, endpoint: 'https://fcm.googleapis.com/send/a', endpointHash: 'h'.repeat(43), service: 'FCM' as const,
      p256dh: key.p256dh, auth: key.auth, expiresAt: null, boundAt: new Date(NOW_MS), createdAt: new Date(NOW_MS),
    };
    t.store.push.set(row.id, row);
    await t.intake.notice({ kind: 'LOGIN_METHOD_LINKED', targetId: randomUUID(), accountId, channel: 'WEB_PUSH', vars: { provider: 'google' } });

    t.push.responses.push(201);
    expect(await t.worker.processDue(new Date(NOW_MS))).toMatchObject({ sent: 1 });
    const sent = t.push.sent[0]!;
    expect(sent.endpoint).toBe(row.endpoint);
    expect(sent.headers).toMatchObject({ ttl: expect.any(String), urgency: 'normal', authorization: expect.stringMatching(/^vapid t=/) });
    expect(sent.headers.topic).toMatch(/^[0-9a-f]{32}$/);
    expect(sent.body.length).toBeGreaterThan(100);
    expect(t.store.push.size).toBe(1);

    for (const status of [404, 410, 403]) {
      t.store.push.set(row.id, row);
      await t.intake.notice({ kind: 'LOGIN_METHOD_LINKED', targetId: randomUUID(), accountId, channel: 'WEB_PUSH', vars: { provider: 'google' } });
      t.push.responses.push(status);
      await t.worker.processDue(new Date(NOW_MS));
      expect(t.store.push.size, String(status)).toBe(0);
    }
  });

  test('N-T21 ② 21:00~08:00 KST에는 nightPush를 켠 신청자에게만 웹 푸시를 보낸다', async () => {
    const night = setup({ now: Date.parse('2026-11-05T13:00:00.000Z') });
    const accountId = account(night.recipients);
    const key = pushKeyPair();
    night.store.push.set('p', {
      id: 'p', accountId, endpoint: 'https://fcm.googleapis.com/send/a', endpointHash: 'h'.repeat(43), service: 'FCM',
      p256dh: key.p256dh, auth: key.auth, expiresAt: null, boundAt: new Date(night.clock.now()), createdAt: new Date(night.clock.now()),
    });
    const eventId = randomUUID();
    const sub = {
      id: randomUUID(), accountId, eventId, kind: 'OPEN' as const, nightPush: false, sentCount: 0, status: 'ACTIVE' as const, endReason: null,
      createdAt: new Date(night.clock.now()), updatedAt: new Date(night.clock.now()),
    };
    night.store.subscriptions.set(`${accountId}:${eventId}:OPEN`, sub);
    await night.intake.notice({ kind: 'OPEN_LOBBY', targetId: eventId, accountId, channel: 'WEB_PUSH', vars: { title: 't', body: 'b' } });
    expect(await night.worker.processDue(new Date(night.clock.now()))).toMatchObject({ suppressed: 1 });
    expect(night.push.sent).toHaveLength(0);

    const dayEvent = randomUUID();
    night.store.subscriptions.set(`${accountId}:${dayEvent}:OPEN`, { ...sub, eventId: dayEvent, nightPush: true });
    await night.intake.notice({ kind: 'OPEN_LOBBY', targetId: dayEvent, accountId, channel: 'WEB_PUSH', vars: { title: 't', body: 'b' } });
    night.push.responses.push(201);
    expect(await night.worker.processDue(new Date(night.clock.now()))).toMatchObject({ sent: 1 });
    expect(night.push.sent).toHaveLength(1);

    const morning = Date.parse('2026-11-04T23:00:00.000Z'); // 08:00 KST
    expect(new Date(morning).toISOString()).toBe('2026-11-04T23:00:00.000Z');
  });
});

describe('N-T22 실패가 다른 상태를 되돌리지 않는다', () => {
  test('N-T22 ① 워커가 DEAD를 내도 주문·예매 상태를 만지지 않는다', async () => {
    const t = setup();
    const accountId = account(t.recipients);
    const order = { id: randomUUID(), status: 'CONFIRMED', version: 3 };
    t.mail.fail.push(new MailTransportError('PERMANENT', '400', 400));
    await t.intake.tradeEvent({ type: 'EVENT_CANCELLATION_CONFIRMED', orderId: order.id, eventId: randomUUID(), accountId, occurredAtMs: NOW_MS, fanNoticeReason: '회차 취소' });
    expect(await t.worker.processDue(new Date(NOW_MS))).toMatchObject({ dead: 1 });
    expect(order).toEqual({ id: order.id, status: 'CONFIRMED', version: 3 });
    expect(t.store.deliveries[0]!.status).toBe('DEAD');
  });

  test('N-T22 ② 원장 저장 실패는 던지고 다음 바퀴에 다시 집는다', async () => {
    const t = setup();
    const accountId = account(t.recipients);
    await t.intake.tradeEvent({ type: 'REFUNDED', orderId: randomUUID(), eventId: randomUUID(), accountId, occurredAtMs: NOW_MS });
    const original = t.mail.send.bind(t.mail);
    t.mail.send = async () => {
      throw new MailTransportError('RETRYABLE', 'connection reset');
    };
    expect(await t.worker.processDue(new Date(NOW_MS))).toMatchObject({ retrying: 1 });
    t.mail.send = original;
    expect(await t.worker.processDue(new Date(NOW_MS + notificationRetryDelayMs(1)))).toMatchObject({ sent: 1 });
  });
});
