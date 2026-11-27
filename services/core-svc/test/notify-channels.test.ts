// F-06-1 N-T19 ⑦⑧·N-T20 ③: 이메일·웹 푸시·문자 세 채널과 구독·한 번 누름 수신 거부를 가짜 발송기로 끝까지 본다.
// 정본: docs/features/notify.md §3.4·§4.4·§7.4·§8·§10·§14, docs/security/data-classification.md '알림 발송 작업·기록'.
// 가짜는 경계(시계·메일·푸시·문자·받는 사람 조회)에만 쓰고, 인테이크·워커·수신 거부 규칙은 진짜를 쓴다.
import { fakeClock } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import {
  FakeMailTransport,
  FakePushTransport,
  FanNotificationWorker,
  MemoryFanNotifyStore,
  NotificationIntake,
  SubscriptionOptOuts,
  optOutTokenFor,
  type Recipient,
  type RecipientDirectory,
} from '../src/modules/notify/index.js';
import { NOW_MS } from './support.js';
import { OPTOUT_KEY, pushKeyPair, vapidKeys } from './fan-notify-support.js';

/** 문자 대행 자리(운영 Solapi 어댑터는 F-06-6). SmsTransport와 같은 모양이다 */
class RecordingSms {
  readonly sent: { to: string; body: string; messageKey: string }[] = [];
  async send(input: { to: string; body: string; messageKey: string }) {
    this.sent.push(input);
    return { providerMessageId: `sms-${this.sent.length}` };
  }
}

type PhoneRow = Recipient & { phone: string | null };

/** identity BatchGetRecipients 대역. 전화번호는 includePhone=true일 때만 준다 */
class PhoneDirectory implements RecipientDirectory {
  readonly rows = new Map<string, PhoneRow>();
  readonly calls: { ids: readonly string[]; includeEmail: boolean; includePhone: boolean | undefined }[] = [];

  async getMany(accountIds: readonly string[], includeEmail: boolean, includePhone?: boolean): Promise<Recipient[]> {
    this.calls.push({ ids: [...accountIds], includeEmail, includePhone });
    return accountIds.map((accountId) => {
      const r = this.rows.get(accountId);
      if (!r) return { accountId, status: 'NOT_FOUND', verified: false, locale: 'ko', ...(includeEmail ? { email: null } : {}) };
      return {
        accountId: r.accountId,
        status: r.status,
        verified: r.verified,
        locale: r.locale,
        ...(includeEmail ? { email: r.email ?? null } : {}),
        ...(includePhone ? { phone: r.phone } : {}),
      };
    });
  }
}

const harness = () => {
  const clock = fakeClock({ now: NOW_MS });
  const store = new MemoryFanNotifyStore();
  const mail = new FakeMailTransport();
  const push = new FakePushTransport();
  const sms = new RecordingSms();
  const recipients = new PhoneDirectory();
  const intake = new NotificationIntake({ store, clock, optOutKey: OPTOUT_KEY });
  // deps를 변수로 두어 새 칸(sms)이 생겨도 기준 트리에서 타입 검사가 막지 않게 한다. 지금 워커는 sms를 무시하고 DEAD로 끝낸다
  const deps = { store, mail, push, sms, recipients, clock, optOutKey: OPTOUT_KEY, vapid: vapidKeys() };
  const worker = new FanNotificationWorker(deps);
  return { clock, store, mail, push, sms, recipients, intake, worker };
};

const account = (t: ReturnType<typeof harness>, phone: string | null = '+821012345678'): string => {
  const accountId = randomUUID();
  t.recipients.rows.set(accountId, { accountId, status: 'ACTIVE', verified: true, locale: 'ko', email: 'fan@example.com', phone });
  return accountId;
};

describe('N-T19 낱건 원장·워커의 채널', () => {
  test('N-T19 ⑦ 이메일·웹 푸시·문자를 각각 한 번 보내고 작업·기록에 주소·전화번호가 없다 [ASVS v5.0.0-14.3.2]', async () => {
    const t = harness();
    const accountId = account(t);
    const key = pushKeyPair();
    t.store.push.set('p1', {
      id: 'p1', accountId, endpoint: 'https://fcm.googleapis.com/send/i', endpointHash: 'i'.repeat(43), service: 'FCM',
      p256dh: key.p256dh, auth: key.auth, expiresAt: null, boundAt: new Date(NOW_MS), createdAt: new Date(NOW_MS),
    });
    const targetId = randomUUID();
    const vars = { fanNoticeReason: '회차 취소' };
    await t.intake.notice({ kind: 'EVENT_CANCELLATION_CONFIRMED', targetId, accountId, channel: 'EMAIL', vars });
    await t.intake.notice({ kind: 'EVENT_CANCELLATION_CONFIRMED', targetId, accountId, channel: 'WEB_PUSH', vars });
    await t.intake.notice({ kind: 'EVENT_CANCELLATION_CONFIRMED', targetId, accountId, channel: 'SMS', vars });
    expect(t.store.jobs.size).toBe(3);

    expect(await t.worker.processDue(new Date(NOW_MS))).toEqual({ attempted: 3, sent: 3, retrying: 0, dead: 0, expired: 0, failed: 0, suppressed: 0 });

    expect(t.mail.sent).toHaveLength(1);
    expect(t.mail.sent[0]).toMatchObject({ to: 'fan@example.com', subject: '공연이 취소되었습니다' });
    expect(t.push.sent).toHaveLength(1);
    expect(t.push.sent[0]!.endpoint).toBe('https://fcm.googleapis.com/send/i');
    expect(t.sms.sent).toHaveLength(1);
    expect(t.sms.sent[0]).toEqual({ to: '+821012345678', body: '공연이 취소되었습니다\n회차 취소', messageKey: expect.any(String) });

    // 전화번호는 문자를 보낼 때만, 이메일은 includeEmail=true일 때만 묻는다
    expect(t.recipients.calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ includeEmail: true }),
        expect.objectContaining({ includeEmail: false, includePhone: true }),
      ]),
    );
    expect(t.store.deliveries.map((d) => d.channel).sort()).toEqual(['EMAIL', 'SMS', 'WEB_PUSH']);
    expect(t.store.deliveries.every((d) => d.status === 'SENT')).toBe(true);

    const jobs = JSON.stringify([...t.store.jobs.values()]);
    expect(jobs).not.toContain('fan@example.com');
    expect(jobs).not.toContain('+821012345678');
    const deliveries = JSON.stringify(t.store.deliveries);
    expect(deliveries).not.toContain('fan@example.com');
    expect(deliveries).not.toContain('+821012345678');

    // 같은 바퀴를 다시 돌아도 더 보내지 않는다
    expect(await t.worker.processDue(new Date(NOW_MS))).toEqual({ attempted: 0, sent: 0, retrying: 0, dead: 0, expired: 0, failed: 0, suppressed: 0 });
    expect(t.sms.sent).toHaveLength(1);
  });

  test('N-T19 ⑧ 신청 알림·광고는 문자로 만들지 않고, 전화번호가 없으면 재시도 없이 FAILED다', async () => {
    const t = harness();
    const accountId = account(t, null);
    await expect(
      t.intake.notice({ kind: 'OPEN_LOBBY', targetId: randomUUID(), accountId, channel: 'SMS', vars: { title: '대기실이 열렸습니다', body: '공연 상세에서 들어가세요.', url: '/events/x' } }),
    ).rejects.toMatchObject({ code: 'INVALID' });
    await expect(
      t.intake.notice({ kind: 'AD', targetId: randomUUID(), accountId, channel: 'SMS', vars: { title: '피켓 소식', body: '새 소식', sender: '피켓', contact: 'help@peaket.example', unsubscribeUrl: '/u' } }),
    ).rejects.toMatchObject({ code: 'INVALID' });
    expect(t.store.jobs.size).toBe(0);

    await t.intake.notice({ kind: 'REFUNDED', targetId: randomUUID(), accountId, channel: 'SMS', vars: { refundAmount: 110_000 } });
    expect(await t.worker.processDue(new Date(NOW_MS))).toMatchObject({ attempted: 1, sent: 0, retrying: 0, dead: 0, failed: 1 });
    expect(t.sms.sent).toHaveLength(0);
    expect(t.store.deliveries).toHaveLength(1);
    expect(t.store.deliveries[0]).toMatchObject({ channel: 'SMS', status: 'FAILED' });
  });
});

describe('N-T20 한 번 누름 수신 거부와 대기 작업', () => {
  test('N-T20 ③ 수신 거부한 신청의 대기 알림은 보내지 않고 작업을 지운다', async () => {
    const t = harness();
    const accountId = account(t);
    const eventId = randomUUID();
    const subscriptionId = randomUUID();
    const now = new Date(NOW_MS);
    await t.store.insertSubscription({
      id: subscriptionId, accountId, eventId, kind: 'CANCELLATION', nightPush: true, sentCount: 0, status: 'ACTIVE', endReason: null, createdAt: now, updatedAt: now,
    });
    await t.intake.notice({
      kind: 'CANCELLATION_ALERT',
      targetId: eventId,
      accountId,
      channel: 'EMAIL',
      vars: { title: '취소표가 나왔습니다', body: '좌석이 돌아왔습니다.', url: '/events/x', eventTitle: '겨울 콘서트', startsAt: '2026-12-24T19:00:00+09:00' },
    });
    const optOuts = new SubscriptionOptOuts({ store: t.store, optOutKey: OPTOUT_KEY });
    await optOuts.redeem(optOutTokenFor(subscriptionId, OPTOUT_KEY), { 'List-Unsubscribe': 'One-Click' });

    expect(await t.worker.processDue(new Date(NOW_MS))).toMatchObject({ attempted: 1, sent: 0, suppressed: 1 });
    expect(t.mail.sent).toHaveLength(0);
    expect(t.store.deliveries).toHaveLength(0);
    expect(t.store.jobs.size).toBe(0);
  });
});
