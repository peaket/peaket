// F-06-1 N-T19 ⑦⑧⑨·N-T20 ③: 이메일·웹 푸시·문자 세 채널, 문자 실패 갈래, 구독·한 번 누름 수신 거부.
// 정본: docs/features/notify.md §3.4·§4.4·§7.4·§8·§10·§14, docs/design/d5 §9.1(4144·4190·4217), data-classification '알림 발송 작업·기록'.
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
  type FanNoticeKind,
  type NotificationJob,
  type Recipient,
  type RecipientDirectory,
  type Vars,
} from '../src/modules/notify/index.js';
import { NOW_MS } from './support.js';
import { OPTOUT_KEY, pushKeyPair, vapidKeys } from './fan-notify-support.js';

type SmsFailureKind = 'RETRYABLE' | 'PERMANENT' | 'UNKNOWN';

/** 문자 대행 오류. 워커는 `kind` 칸으로 재시도·영구 실패·결과 모름을 가른다(계획 §3.3) */
class FakeSmsError extends Error {
  constructor(
    readonly kind: SmsFailureKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'SmsTransportError';
  }
}

/** SmsTransport 포트와 같은 모양(기준 트리에는 아직 타입이 없어 시험 쪽에서 짝을 맞춘다) */
interface SmsTransportPort {
  send(input: { to: string; body: string; messageKey: string }): Promise<{ providerMessageId?: string }>;
}

/** 문자 대행 자리(운영 Solapi 어댑터는 F-06-6) */
class RecordingSms implements SmsTransportPort {
  readonly sent: { to: string; body: string; messageKey: string }[] = [];
  readonly fail: FakeSmsError[] = [];
  async send(input: { to: string; body: string; messageKey: string }) {
    const e = this.fail.shift();
    if (e) throw e;
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
  const logs: string[] = [];
  const intake = new NotificationIntake({ store, clock, optOutKey: OPTOUT_KEY });
  // deps를 변수로 두어 새 칸(sms)이 생겨도 기준 트리에서 타입 검사가 막지 않게 한다. 지금 워커는 sms를 무시하고 DEAD로 끝낸다
  const deps = { store, mail, push, sms, recipients, clock, optOutKey: OPTOUT_KEY, vapid: vapidKeys(), log: (line: Record<string, unknown>) => logs.push(JSON.stringify(line)) };
  const worker = new FanNotificationWorker(deps);
  return { clock, store, mail, push, sms, recipients, intake, worker, logs };
};

const account = (t: ReturnType<typeof harness>, phone: string | null = '+821012345678'): string => {
  const accountId = randomUUID();
  t.recipients.rows.set(accountId, { accountId, status: 'ACTIVE', verified: true, locale: 'ko', email: 'fan@example.com', phone });
  return accountId;
};

/** 문자 작업을 직접 적는다. `WALLET_OPEN_REMINDER`는 d5 4144의 월렛·키 미등록 자리다(계획 §3.3) */
const smsJob = (o: { accountId: string; kind?: string; vars?: Record<string, string> }): NotificationJob => {
  const kind = o.kind ?? 'WALLET_OPEN_REMINDER';
  const targetId = randomUUID();
  return {
    dedupKey: `${kind}:${targetId}:${o.accountId}:SMS`,
    kind,
    targetId,
    accountId: o.accountId,
    channel: 'SMS',
    vars: o.vars ?? { title: '공연 전날 월렛 안내', body: '내일 공연입니다. 월렛에서 티켓을 열어 두세요.', url: '/my/tickets' },
    status: 'PENDING',
    attempts: 0,
    nextAttemptAt: new Date(NOW_MS),
    leaseUntil: null,
    expiresAt: new Date(NOW_MS + 24 * 60 * 60 * 1000),
    createdAt: new Date(NOW_MS),
  };
};

describe('N-T19 낱건 원장·워커의 채널', () => {
  test('N-T19 ⑦ 이메일·웹 푸시·문자를 각각 한 번 보내고 작업·기록·로그에 주소·전화번호가 없다 [ASVS v5.0.0-14.3.2]', async () => {
    const t = harness();
    const accountId = account(t);
    const key = pushKeyPair();
    t.store.push.set('p1', {
      id: 'p1', accountId, endpoint: 'https://fcm.googleapis.com/send/i', endpointHash: 'i'.repeat(43), service: 'FCM',
      p256dh: key.p256dh, auth: key.auth, expiresAt: null, boundAt: new Date(NOW_MS), createdAt: new Date(NOW_MS),
    });
    const targetId = randomUUID();
    const vars = { provider: 'google' };
    await t.intake.notice({ kind: 'LOGIN_METHOD_LINKED', targetId, accountId, channel: 'EMAIL', vars });
    await t.intake.notice({ kind: 'LOGIN_METHOD_LINKED', targetId, accountId, channel: 'WEB_PUSH', vars });

    // 월렛·키 미등록은 store.enqueue가 아니라 intake.notice의 FAN_NOTICE_KINDS·VARS_ALLOWED·SMS_ALLOWED_KINDS 경로로 만든다
    const fanNotify = (await import(/* @vite-ignore */ new URL('../src/modules/notify/domain/fan-notify.ts', import.meta.url).href)) as { FAN_NOTICE_KINDS?: readonly string[] };
    expect(fanNotify.FAN_NOTICE_KINDS).toEqual(expect.arrayContaining(['WALLET_OPEN_REMINDER', 'ACCOUNT_MERGED_ABSORBED']));
    type PlannedNotice = { kind: string; targetId: string; accountId: string; channel: 'SMS'; vars: Vars };
    type PlannedIntake = NotificationIntake & { notice(i: PlannedNotice): Promise<'created' | 'duplicate'> };
    const planned = t.intake as PlannedIntake;
    const wallet = {
      kind: 'WALLET_OPEN_REMINDER',
      targetId: randomUUID(),
      accountId,
      channel: 'SMS' as const,
      vars: { title: '공연 전날 월렛 안내', body: '내일 공연입니다. 월렛에서 티켓을 열어 두세요.', url: '/my/tickets' } satisfies Vars,
    };
    expect(await planned.notice(wallet)).toBe('created');
    expect(t.store.jobs.size).toBe(3);

    expect(await t.worker.processDue(new Date(NOW_MS))).toEqual({ attempted: 3, sent: 3, retrying: 0, dead: 0, expired: 0, failed: 0, suppressed: 0 });

    expect(t.mail.sent).toHaveLength(1);
    expect(t.mail.sent[0]).toMatchObject({ to: 'fan@example.com', subject: '로그인 수단을 연결했습니다' });
    expect(t.push.sent).toHaveLength(1);
    expect(t.push.sent[0]!.endpoint).toBe('https://fcm.googleapis.com/send/i');
    expect(t.sms.sent).toHaveLength(1);
    expect(t.sms.sent[0]).toEqual({
      to: '+821012345678',
      body: '[피켓] 공연 전날 월렛 안내\n내일 공연입니다. 월렛에서 티켓을 열어 두세요.',
      messageKey: `WALLET_OPEN_REMINDER:${wallet.targetId}:${accountId}:SMS`,
    });

    // 전화번호는 문자를 보낼 때만(includeEmail=false·includePhone=true), 이메일은 includeEmail=true일 때만 묻는다
    const smsCalls = t.recipients.calls.filter((c) => c.includePhone === true);
    expect(smsCalls).toEqual([{ ids: [accountId], includeEmail: false, includePhone: true }]);
    const emailCalls = t.recipients.calls.filter((c) => c.includeEmail === true);
    expect(emailCalls).toHaveLength(1);
    expect(emailCalls[0]!.includePhone).toBeUndefined();
    expect(t.store.deliveries.map((d) => d.channel).sort()).toEqual(['EMAIL', 'SMS', 'WEB_PUSH']);
    expect(t.store.deliveries.every((d) => d.status === 'SENT')).toBe(true);

    for (const text of [JSON.stringify([...t.store.jobs.values()]), JSON.stringify(t.store.deliveries), t.logs.join('\n')]) {
      expect(text).not.toContain('fan@example.com');
      expect(text).not.toContain('+821012345678');
    }

    // 같은 바퀴를 다시 돌아도 더 보내지 않는다
    expect(await t.worker.processDue(new Date(NOW_MS))).toEqual({ attempted: 0, sent: 0, retrying: 0, dead: 0, expired: 0, failed: 0, suppressed: 0 });
    expect(t.sms.sent).toHaveLength(1);
  });

  test('N-T19 ⑧ 회차 취소·환급·입장 키·신청 알림·광고는 문자로 만들지 않고, 전화번호가 없으면 재시도 없이 FAILED다', async () => {
    const t = harness();
    const accountId = account(t, null);
    const rejected: { kind: FanNoticeKind; vars: Vars }[] = [
      { kind: 'EVENT_CANCELLATION_CONFIRMED', vars: { fanNoticeReason: '회차 취소' } },
      { kind: 'EVENT_POSTPONED', vars: { fanNoticeReason: '연기', postponedTo: '2026-12-01T10:00:00.000Z', refundWindowClosesAt: '2026-12-08T10:00:00.000Z' } },
      { kind: 'REFUNDED', vars: { refundAmount: 110_000 } },
      { kind: 'REFUND_FAILED', vars: { fanNoticeReason: 'failed' } },
      { kind: 'DEVICE_KEY_REISSUED', vars: { type: 'DEVICE_KEY_REISSUED', registeredAt: new Date(NOW_MS).toISOString(), ticketId: randomUUID() } },
      { kind: 'DEVICE_KEY_LATE_ISSUE', vars: { type: 'DEVICE_KEY_LATE_ISSUE', registeredAt: new Date(NOW_MS).toISOString(), ticketId: randomUUID() } },
      { kind: 'OPEN_LOBBY', vars: { title: '대기실이 열렸습니다', body: '공연 상세에서 들어가세요.', url: '/events/x' } },
      { kind: 'OPEN_VERIFY', vars: { title: '본인확인을 마쳐 주세요', body: '대기실에 들어가려면 본인확인이 필요합니다.', url: '/events/x' } },
      { kind: 'CANCELLATION_ALERT', vars: { title: '취소표가 나왔습니다', body: '좌석이 돌아왔습니다.', url: '/events/x', eventTitle: '겨울 콘서트', startsAt: '2026-12-24T19:00:00+09:00' } },
      // contact에 이메일 꼴을 넣지 않는다. 그래야 '광고라서 SMS를 거절'하는지 본다
      { kind: 'AD', vars: { title: '피켓 소식', body: '새 소식', sender: '피켓', contact: '피켓 고객센터', unsubscribeUrl: '/u' } },
    ];
    for (const one of rejected) {
      await expect(t.intake.notice({ kind: one.kind, targetId: randomUUID(), accountId, channel: 'SMS', vars: one.vars })).rejects.toMatchObject({
        code: 'INVALID',
        message: expect.stringContaining('문자'),
      });
    }
    expect(t.store.jobs.size).toBe(0);

    // 웹 푸시 실패 뒤 대체 채널: 웹 푸시가 주 채널인 거래·안전 알림만 SMS 대체 작업을 만든다
    const fallback = harness();
    const fallbackAccount = account(fallback);
    type PlannedFallback = NotificationIntake & { smsFallback(i: { kind: string; targetId: string; accountId: string }): Promise<'created' | 'duplicate' | 'not-applicable'> };
    const fallbackIntake = fallback.intake as PlannedFallback;
    expect(typeof fallbackIntake.smsFallback).toBe('function');
    if (typeof fallbackIntake.smsFallback !== 'function') return;
    const fallbackTarget = randomUUID();
    expect(await fallbackIntake.smsFallback({ kind: 'ACCOUNT_MERGED', targetId: fallbackTarget, accountId: fallbackAccount })).toBe('created');
    expect([...fallback.store.jobs.keys()]).toEqual([`ACCOUNT_MERGED:${fallbackTarget}:${fallbackAccount}:SMS:fallback`]);
    expect(await fallbackIntake.smsFallback({ kind: 'EVENT_CANCELLATION_CONFIRMED', targetId: randomUUID(), accountId: fallbackAccount })).toBe('not-applicable');
    expect(await fallback.worker.processDue(new Date(NOW_MS))).toMatchObject({ attempted: 1, sent: 1 });
    expect(fallback.sms.sent[0]!.body.startsWith('[피켓] ')).toBe(true);

    await t.store.enqueue(smsJob({ accountId }), new Date(NOW_MS));
    expect(await t.worker.processDue(new Date(NOW_MS))).toMatchObject({ attempted: 1, sent: 0, retrying: 0, dead: 0, failed: 1 });
    expect(t.sms.sent).toHaveLength(0);
    expect(t.store.deliveries).toHaveLength(1);
    expect(t.store.deliveries[0]).toMatchObject({ channel: 'SMS', status: 'FAILED' });
  });

  test('N-T19 ⑨ 문자 429·5xx는 재시도하고 400은 DEAD, 결과 모름은 한 번 더, 2,000자 초과는 FAILED다', async () => {
    // 429와 503: 1분·5분 뒤 다시 보내고 성공한다(경계 −1ms는 집지 않는다)
    const retry = harness();
    const retryAccount = account(retry);
    await retry.store.enqueue(smsJob({ accountId: retryAccount }), new Date(NOW_MS));
    retry.sms.fail.push(new FakeSmsError('RETRYABLE', '429', 429));
    expect(await retry.worker.processDue(new Date(NOW_MS))).toMatchObject({ attempted: 1, retrying: 1 });
    const firstRetry = [...retry.store.jobs.values()][0]!;
    expect(firstRetry).toMatchObject({ status: 'RETRYING', attempts: 1 });
    expect(firstRetry.nextAttemptAt.getTime()).toBe(NOW_MS + 60_000);
    expect(await retry.worker.processDue(new Date(NOW_MS + 60_000 - 1))).toMatchObject({ attempted: 0 });

    retry.sms.fail.push(new FakeSmsError('RETRYABLE', '503', 503));
    expect(await retry.worker.processDue(new Date(NOW_MS + 60_000))).toMatchObject({ retrying: 1 });
    const secondRetry = [...retry.store.jobs.values()][0]!;
    expect(secondRetry).toMatchObject({ status: 'RETRYING', attempts: 2 });
    expect(secondRetry.nextAttemptAt.getTime()).toBe(NOW_MS + 60_000 + 300_000);
    expect(await retry.worker.processDue(new Date(NOW_MS + 60_000 + 300_000))).toMatchObject({ sent: 1 });
    expect(retry.sms.sent).toHaveLength(1);

    // 400: 재시도 없이 DEAD
    const dead = harness();
    const deadAccount = account(dead);
    await dead.store.enqueue(smsJob({ accountId: deadAccount }), new Date(NOW_MS));
    dead.sms.fail.push(new FakeSmsError('PERMANENT', '400', 400));
    expect(await dead.worker.processDue(new Date(NOW_MS))).toMatchObject({ dead: 1 });
    expect(dead.store.deliveries[0]!.status).toBe('DEAD');

    // 결과 모름: 돈·보안·법정 통지라 같은 키로 한 번 더 본다
    const unknown = harness();
    const unknownAccount = account(unknown);
    await unknown.store.enqueue(smsJob({ accountId: unknownAccount }), new Date(NOW_MS));
    unknown.sms.fail.push(new FakeSmsError('UNKNOWN', 'timeout'));
    expect(await unknown.worker.processDue(new Date(NOW_MS))).toMatchObject({ retrying: 1 });
    expect(await unknown.worker.processDue(new Date(NOW_MS + 60_000))).toMatchObject({ sent: 1 });

    // 2,000자 초과: 보내지 않고 FAILED(sms-too-long)
    const tooLong = harness();
    const longAccount = account(tooLong);
    await tooLong.store.enqueue(smsJob({ accountId: longAccount, vars: { title: '월렛', body: '가'.repeat(2_001) } }), new Date(NOW_MS));
    expect(await tooLong.worker.processDue(new Date(NOW_MS))).toMatchObject({ failed: 1, sent: 0 });
    expect(tooLong.sms.sent).toHaveLength(0);
    expect(tooLong.store.deliveries[0]!.status).toBe('FAILED');
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
