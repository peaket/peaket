// F-06-6 GAT-250 D1~D4: 광고 밤 금지·문안 필수 값·문자/알림톡 광고 금지 경계.
// 광고 수신 동의 자체는 F-06-9 몫이고, 이 시험은 발송 경계만 본다.
// 정본: docs/features/notify.md §7.2·§7.3·§8, docs/design/d5 §9.1.1, docs/review/plans/F-06-6.md §3.8.
import { fakeClock } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { ALIMTALK_ALLOWED_KINDS, NOTIFY_SUPPRESSED_METRIC, SMS_ALLOWED_KINDS, isAdSendAllowed } from '../src/modules/notify/domain/fan-notify.js';
import {
  FakeMailTransport,
  FakePushTransport,
  FanNotificationWorker,
  MemoryFanNotifyStore,
  MemoryRecipientDirectory,
  NotificationIntake,
} from '../src/modules/notify/index.js';
import { OPTOUT_KEY, vapidKeys } from './fan-notify-support.js';

const at = (iso: string): number => Date.parse(iso);
const EVENING = at('2026-11-28T20:59:59+09:00');
const NIGHT = at('2026-11-28T21:00:00+09:00');
const LATE_NIGHT = at('2026-11-29T07:59:59+09:00');
const MORNING = at('2026-11-29T08:00:00+09:00');

const adVars = () => ({
  title: '(광고) 겨울 콘서트',
  body: '새로 열린 회차를 확인해 보세요.',
  url: '/productions/01900000-0000-7000-8000-0000000000f1',
  sender: '피켓',
  contact: '고객센터',
  unsubscribeUrl: 'https://peaket.example/settings/notifications',
});

const setup = (nowMs: number) => {
  const clock = fakeClock({ now: nowMs });
  const store = new MemoryFanNotifyStore();
  const mail = new FakeMailTransport();
  const push = new FakePushTransport();
  const recipients = new MemoryRecipientDirectory();
  const suppressed: string[] = [];
  const accountId = randomUUID();
  recipients.rows.set(accountId, { accountId, status: 'ACTIVE', verified: true, locale: 'ko', email: 'fan@example.com', phone: '01099998888' });
  const intake = new NotificationIntake({ store, clock, optOutKey: OPTOUT_KEY });
  const worker = new FanNotificationWorker({
    store,
    mail,
    push,
    recipients,
    clock,
    optOutKey: OPTOUT_KEY,
    vapid: vapidKeys(),
    signals: { suppressed: (reason) => suppressed.push(reason) },
  });
  return { clock, store, mail, push, recipients, accountId, intake, worker, suppressed };
};

describe('GAT-250 D 광고 발송 경계', () => {
  test('GAT-250 D1 광고는 20:59:59에 실제로 나가고 21:00:00·07:59:59에는 막으며 08:00에 다시 허용한다', async () => {
    expect(isAdSendAllowed('AD', EVENING)).toBe(true);
    expect(isAdSendAllowed('AD', NIGHT)).toBe(false);
    expect(isAdSendAllowed('AD', LATE_NIGHT)).toBe(false);
    expect(isAdSendAllowed('AD', MORNING)).toBe(true);
    expect(isAdSendAllowed('REFUNDED', NIGHT)).toBe(true);

    const t = setup(EVENING);
    await t.intake.notice({ kind: 'AD', targetId: randomUUID(), accountId: t.accountId, channel: 'EMAIL', vars: adVars() });
    const r = await t.worker.processDue(new Date(EVENING));
    expect(t.mail.sent).toHaveLength(1);
    expect(t.mail.sent[0]!.to).toBe('fan@example.com');
    expect(r).toMatchObject({ attempted: 1, sent: 1, suppressed: 0 });
    expect(t.suppressed).toEqual([]);
  });

  test('GAT-250 D2 21:00 KST의 광고 이메일은 보내지 않고 작업을 지우며 quiet_ad·night 지표를 센다', async () => {
    const ad = setup(NIGHT);
    await ad.intake.notice({ kind: 'AD', targetId: randomUUID(), accountId: ad.accountId, channel: 'EMAIL', vars: adVars() });
    const r = await ad.worker.processDue(new Date(NIGHT));
    expect(ad.mail.sent).toHaveLength(0);
    expect(ad.store.jobs.size).toBe(0);
    expect(r).toMatchObject({ attempted: 1, sent: 0, suppressed: 1 });
    expect(ad.suppressed).toEqual(['quiet_ad']);
    expect(NOTIFY_SUPPRESSED_METRIC).toBe('notify_suppressed_total');

    const push = setup(NIGHT);
    const eventId = randomUUID();
    push.store.subscriptions.set(`${push.accountId}:${eventId}:CANCELLATION`, {
      id: 's-night',
      accountId: push.accountId,
      eventId,
      kind: 'CANCELLATION',
      nightPush: false,
      sentCount: 0,
      status: 'ACTIVE',
      endReason: null,
      createdAt: new Date(NIGHT),
      updatedAt: new Date(NIGHT),
    });
    await push.intake.notice({
      kind: 'CANCELLATION_ALERT',
      targetId: eventId,
      accountId: push.accountId,
      channel: 'WEB_PUSH',
      vars: { title: '취소표가 나왔습니다', body: '지금 확인해 보세요.', url: '/events/x' },
    });
    const pr = await push.worker.processDue(new Date(NIGHT));
    expect(push.push.sent).toHaveLength(0);
    expect(pr).toMatchObject({ suppressed: 1 });
    expect(push.suppressed).toEqual(['night']);
  });

  test('GAT-250 D3 광고 문안에 전송자·연락처·https 수신 거부·(광고) 표시가 없으면 작업을 만들지 않는다', async () => {
    for (const key of ['sender', 'contact', 'unsubscribeUrl'] as const) {
      const t = setup(EVENING);
      const vars: Record<string, string> = { ...adVars() };
      delete vars[key];
      await expect(t.intake.notice({ kind: 'AD', targetId: randomUUID(), accountId: t.accountId, channel: 'EMAIL', vars })).rejects.toMatchObject({
        name: 'FanNotifyProblem',
        code: 'INVALID',
      });
      expect(t.store.jobs.size).toBe(0);
    }
    for (const vars of [{ ...adVars(), unsubscribeUrl: 'http://peaket.example/settings/notifications' }, { ...adVars(), title: '겨울 콘서트' }]) {
      const t = setup(EVENING);
      await expect(t.intake.notice({ kind: 'AD', targetId: randomUUID(), accountId: t.accountId, channel: 'EMAIL', vars })).rejects.toMatchObject({
        name: 'FanNotifyProblem',
        code: 'INVALID',
      });
      expect(t.store.jobs.size).toBe(0);
    }
  });

  test('GAT-250 D4 광고는 문자·알림톡으로 만들 수 없다', async () => {
    expect(SMS_ALLOWED_KINDS.has('AD')).toBe(false);
    expect(ALIMTALK_ALLOWED_KINDS.has('AD')).toBe(false);
    for (const channel of ['SMS', 'ALIMTALK'] as const) {
      const t = setup(EVENING);
      await expect(t.intake.notice({ kind: 'AD', targetId: randomUUID(), accountId: t.accountId, channel, vars: adVars() })).rejects.toMatchObject({
        name: 'FanNotifyProblem',
        code: 'INVALID',
      });
      expect(t.store.jobs.size).toBe(0);
    }
  });
});
