// F-06-8 N-T25·N-T27: 예매 확정 알림의 트리거·중복·vars·상태 가드·재시도·보류.
// 흉내 SES·흉내 푸시·고정 시계·메모리 원장. 실제 수신자 주소·전화번호를 쓰지 않는다.
import { randomUUID } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { MailTransportError, messageOf, type NotificationJob } from '../src/modules/notify/index.js';
import { assertVars } from '../src/modules/notify/domain/fan-notify.js';
import { bookingJob, eventOf, noticeOf, setupBooking, NOW } from './booking-confirmed-support.js';

type JobWithVersion = NotificationJob & { templateVersion?: string };
type MailWithHtml = { to: string; subject: string; body: string; html?: string; headers: Record<string, string> };

const VARS_KEYS = ['amount', 'bookingNoLast4', 'eventStartsAt', 'orderId', 'productionName', 'seatSummary', 'venueName'];

describe('F-06-8 예매 확정 알림', () => {
  test('N-T25 CONFIRMED만 이메일 한 통과 구독마다 웹 푸시 한 번을 5분 안에 보내고 중복·가상계좌·입금 오류 재확정에도 늘지 않는다', async () => {
    const t = setupBooking({ subscriptions: 2 });
    const emailKey = `BOOKING_CONFIRMED:${t.orderId}:CONFIRMED:${t.accountId}:EMAIL`;
    const pushKeys = [...t.store.push.values()].map((p) => `BOOKING_CONFIRMED:${t.orderId}:CONFIRMED:${t.accountId}:WEB_PUSH:${p.endpointHash}`);

    expect(await t.intake.bookingConfirmed(eventOf(t))).toEqual({ created: 3, duplicate: 0 });
    expect([...t.store.jobs.keys()].sort()).toEqual([emailKey, ...pushKeys].sort());
    for (const job of t.store.jobs.values()) {
      expect(job).toMatchObject({ kind: 'BOOKING_CONFIRMED', targetId: t.orderId, accountId: t.accountId, status: 'PENDING' });
      expect((job as JobWithVersion).templateVersion).toBe('v1');
      expect(job.expiresAt.getTime() - job.createdAt.getTime()).toBe(24 * 60 * 60 * 1000);
      expect(Object.keys(job.vars).sort()).toEqual(VARS_KEYS);
    }
    expect(t.intake.bookingConfirmed(eventOf(t))).toEqual({ created: 0, duplicate: 3 });
    expect(t.store.jobs.size).toBe(3);
    // 사건의 좌석 라벨·이름·전화번호는 vars에 들어가지 않는다
    for (const job of t.store.jobs.values()) {
      for (const value of ['A01', 'A02', 'B01', '2026101400001', '홍길동', '010-1234-5678']) expect(JSON.stringify(job.vars)).not.toContain(value);
    }

    // APPROVED·ISSUE_DELAYED·AWAITING_DEPOSIT·PARTIALLY_REFUNDED만으로는 가지 않는다
    for (const type of ['APPROVED', 'ISSUE_DELAYED', 'AWAITING_DEPOSIT', 'PARTIALLY_REFUNDED']) {
      const other = setupBooking({ subscriptions: 2 });
      const r = await other.intake.bookingConfirmed(eventOf(other, { type }));
      expect(r).toMatchObject({ created: 0, duplicate: 0, suppressed: 'not_confirmed' });
      expect(other.store.jobs.size).toBe(0);
      expect(other.noticeReader.calls).toHaveLength(0);
    }

    // 가상계좌는 CONFIRMED 때 처음 가고, 입금 오류로 돌아갔다 다시 확정되어도 한 번만 간다
    const va = setupBooking({ subscriptions: 0 });
    expect(await va.intake.bookingConfirmed(eventOf(va, { type: 'AWAITING_DEPOSIT' }))).toMatchObject({ created: 0, suppressed: 'not_confirmed' });
    expect(await va.intake.bookingConfirmed(eventOf(va, { type: 'CONFIRMED' }))).toEqual({ created: 1, duplicate: 0 });
    expect(await va.intake.bookingConfirmed(eventOf(va, { type: 'CONFIRMED', eventKey: randomUUID() }))).toEqual({ created: 0, duplicate: 1 });
    expect(va.store.jobs.size).toBe(1);

    // 5분 [가정] 안에 보낸다. 작업 만료는 24시간이라 5분은 목표치다
    const run = await t.worker.processDue(new Date(NOW + 5 * 60_000 - 1));
    expect(run).toMatchObject({ attempted: 3, sent: 3 });
    expect(t.mail.sent).toHaveLength(1);
    expect(t.push.sent).toHaveLength(2);
    const email = t.mail.sent[0] as MailWithHtml;
    const emailDelivery = t.store.deliveries.find((d) => d.channel === 'EMAIL')!;
    expect(emailDelivery.sentAt.getTime() - emailDelivery.createdAt.getTime()).toBeLessThanOrEqual(5 * 60_000);
    const emailLatency = t.counts.latency.find((x) => x.kind === 'BOOKING_CONFIRMED' && x.channel === 'EMAIL');
    expect(emailLatency).toBeTruthy();
    expect(emailLatency!.seconds).toBeGreaterThan(0);
    expect(emailLatency!.seconds).toBeLessThanOrEqual(300);
    expect(t.counts.emailSent).toBe(1);
    expect(t.counts.emailFailed).toBe(0);
    expect(t.counts.dueBacklog.reduce((n, x) => n + x.count, 0)).toBe(3);

    // 이메일은 판매자 7항목·법정 고지를 담고, 좌석 번호·예매번호 전체·이름·전화번호는 어느 채널에도 없다
    expect(email.subject).toContain('겨울 콘서트');
    expect(email.html).toBeTruthy();
    for (const value of ['(주)겨울공연', '김대표', '서울특별시 중구 세종대로 1', '02-1234-5678', 'seller@example.test', '123-45-67890', '2026-서울중구-0001', '통신판매중개자', '만 19세 미만', '공연일 10일 이내']) {
      expect(`${email.body}\n${email.html}`).toContain(value);
    }
    for (const value of ['A01', 'A02', 'B01', '2026101400001', '홍길동', '010-1234-5678']) {
      expect(`${email.body}\n${email.html}`).not.toContain(value);
    }
    expect(t.push.sent.map((p) => p.subscriptionKey).sort()).toEqual([...t.store.push.values()].map((p) => p.endpointHash).sort());

    // 웹 푸시 평문은 2,048바이트 [가정] 아래다
    const pushMsg = messageOf('BOOKING_CONFIRMED' as never, {
      productionName: '겨울 콘서트',
      eventStartsAt: '2026-12-24T19:30:00+09:00',
      venueName: '피켓홀',
      seatSummary: 'R석 2매, S석 1매',
      amount: 308_000,
      bookingNoLast4: '0001',
      orderId: t.orderId,
    });
    expect(pushMsg).toMatchObject({ title: '겨울 콘서트 예매가 확정되었습니다', url: '/my/tickets' });
    expect(Buffer.byteLength(JSON.stringify({ v: 1, kind: 'BOOKING_CONFIRMED', ...pushMsg, tag: 'a'.repeat(32) }), 'utf8')).toBeLessThan(2_048);
    // 웹 푸시 본문·작업 vars에도 좌석 번호·예매번호 전체·이름·전화번호가 없다
    for (const value of ['A01', 'A02', 'B01', '2026101400001', '홍길동', '010-1234-5678']) {
      expect(JSON.stringify(pushMsg)).not.toContain(value);
    }

    // 실패·DEAD는 이메일 지표·SEV3로 남고, 주문·결제·발권 변경 스파이와 fetch를 부르지 않는다(ADR-0180)
    const failed = setupBooking({ subscriptions: 1 });
    const emailJob = bookingJob(failed, { channel: 'EMAIL', templateVersion: 'v1' });
    const pushJob = bookingJob(failed, {
      channel: 'WEB_PUSH',
      subscriptionKey: [...failed.store.push.values()][0]!.endpointHash,
      templateVersion: 'v1',
    });
    failed.mail.fail.push(new MailTransportError('PERMANENT', '400'));
    failed.push.responses.push(500);
    // 대조군: 스파이가 실제로 상태 변경을 잡는지 먼저 확인하고 되돌린다
    expect(() => failed.businessChanges.changeOrder('CANCELLED')).toThrow();
    expect(failed.businessChanges.calls).toEqual(['order:CANCELLED']);
    expect(failed.businessChanges.state.order).toBe('CANCELLED');
    failed.businessChanges.calls.length = 0;
    failed.businessChanges.state.order = 'CONFIRMED';
    const fetchCalls: string[] = [];
    const previousFetch = globalThis.fetch;
    globalThis.fetch = (async (...args: unknown[]) => {
      fetchCalls.push(String(args[0]));
      throw new Error('알림이 바깥 상태 변경 API를 불렀다');
    }) as typeof fetch;
    try {
      const deadRun = await failed.worker.processDue(new Date(NOW));
      expect(deadRun).toMatchObject({ attempted: 2, sent: 0, dead: 1, retrying: 1 });
      expect(failed.counts.emailFailed).toBe(1);
      expect(failed.counts.emailSent).toBe(0);
      expect(failed.counts.dead).toEqual(['BOOKING_CONFIRMED']);
      expect(failed.store.deliveries[0]).toMatchObject({ status: 'DEAD', channel: 'EMAIL' });
      expect(failed.store.jobs.has(emailJob.dedupKey)).toBe(false);
      expect(failed.store.jobs.has(pushJob.dedupKey)).toBe(true);
      expect(failed.businessChanges.calls).toEqual([]);
      expect(failed.businessChanges.state).toEqual({ order: 'CONFIRMED', payment: 'APPROVED', ticket: 'ISSUED' });
      expect(fetchCalls).toEqual([]);
    } finally {
      globalThis.fetch = previousFetch;
    }

    // 5분 [가정]을 넘긴 발송은 지연 지표와 99% 경보의 원천 신호를 남긴다
    const late = setupBooking({ subscriptions: 0 });
    bookingJob(late, { channel: 'EMAIL', templateVersion: 'v1', createdAt: NOW - 5 * 60_000 - 1 });
    expect((await late.worker.processDue(new Date(NOW))).sent).toBe(1);
    const lateLatency = late.counts.latency.find((x) => x.kind === 'BOOKING_CONFIRMED' && x.channel === 'EMAIL');
    expect(lateLatency).toBeTruthy();
    expect(lateLatency!.seconds).toBeGreaterThan(300);
    expect(late.counts.latencyOverTarget).toEqual([{ kind: 'BOOKING_CONFIRMED', channel: 'EMAIL', seconds: lateLatency!.seconds }]);
  });

  test('N-T27 ③ R석 2매·S석 1매 주문의 vars는 일곱 키뿐이고 seatSummary가 R석 2매, S석 1매다', async () => {
    const t = setupBooking({ subscriptions: 0 });
    expect(await t.intake.bookingConfirmed(eventOf(t))).toEqual({ created: 1, duplicate: 0 });
    const email = [...t.store.jobs.values()].find((j) => j.channel === 'EMAIL')!;
    expect(Object.keys(email.vars).sort()).toEqual(VARS_KEYS);
    expect(email.vars).toMatchObject({
      productionName: '겨울 콘서트',
      eventStartsAt: '2026-12-24T19:30:00+09:00',
      venueName: '피켓홀',
      seatSummary: 'R석 2매, S석 1매',
      amount: 308_000,
      bookingNoLast4: '0001',
      orderId: t.orderId,
    });
    for (const forbidden of ['seller', 'name', 'phone', 'seatNumber', 'seats', 'bookingNo']) expect(email.vars).not.toHaveProperty(forbidden);
    expect(t.catalog.calls).toEqual([{ eventId: t.notice.eventId, tierIds: ['R', 'S'] }]);
  });

  test('N-T27 ④ 회차 취소가 진행 중이면 noticeAllowed=false라 작업을 만들지 않고 not_allowed를 센다', async () => {
    const t = setupBooking({ subscriptions: 2, notice: { status: 'CONFIRMED', noticeAllowed: false } });
    expect(await t.intake.bookingConfirmed(eventOf(t))).toEqual({ created: 0, duplicate: 0, suppressed: 'not_allowed' });
    expect(t.store.jobs.size).toBe(0);
    expect(t.counts.suppressed).toEqual(['not_allowed']);
  });

  test('N-T27 ⑤ 취소 뒤 늦게 온 CONFIRMED는 작업을 만들지 않고 워커도 보내기 전에 다시 본다', async () => {
    const late = setupBooking({ subscriptions: 2, notice: { status: 'REFUNDED', noticeAllowed: false } });
    expect(await late.intake.bookingConfirmed(eventOf(late))).toMatchObject({ created: 0, suppressed: 'not_allowed' });

    const t = setupBooking({ subscriptions: 2 });
    expect(await t.intake.bookingConfirmed(eventOf(t))).toEqual({ created: 3, duplicate: 0 });
    t.noticeReader.get = async () => noticeOf({ noticeAllowed: false });
    const run = await t.worker.processDue(new Date(NOW + 1_000));
    expect(run).toMatchObject({ attempted: 3, sent: 0, suppressed: 3 });
    expect(t.mail.sent).toHaveLength(0);
    expect(t.push.sent).toHaveLength(0);
    expect(t.store.jobs.size).toBe(0);
    expect(t.counts.suppressed).toEqual(['not_allowed', 'not_allowed', 'not_allowed']);
  });

  test('N-T27 ⑥ 예매번호가 없으면 SEV3로 작업을 만들지 않고, 등급 이름이 없으면 좌석 3매와 tier_name_missing을 남긴다', async () => {
    const noNo = setupBooking({ subscriptions: 2, notice: { bookingNo: null } });
    expect(await noNo.intake.bookingConfirmed(eventOf(noNo))).toEqual({ created: 0, duplicate: 0 });
    expect(noNo.store.jobs.size).toBe(0);
    expect(noNo.counts.bookingNoInvalid).toBe(1);

    const noTier = setupBooking({ subscriptions: 0 });
    // 등급 이름만 비운 catalog로 바꾼다(나머지 값은 그대로)
    noTier.catalog.getBookingNotice = async () => ({
      productionName: '겨울 콘서트',
      venueName: '피켓홀',
      eventStartsAt: '2026-12-24T19:30:00+09:00',
      tierNames: {},
      seller: null,
    });
    expect(await noTier.intake.bookingConfirmed(eventOf(noTier))).toEqual({ created: 1, duplicate: 0 });
    const email = [...noTier.store.jobs.values()][0]!;
    expect(email.vars.seatSummary).toBe('좌석 3매');
    expect(noTier.counts.tierNameMissing).toBe(1);
  });

  test('N-T27 ⑦ purchase-svc가 세 번 시간 초과하면 held_event로 보류하고 오프셋을 커밋한 것으로 다룬다', async () => {
    const t = setupBooking({ subscriptions: 2 });
    let calls = 0;
    t.noticeReader.get = async () => {
      calls += 1;
      throw new Error('purchase-svc timeout');
    };
    expect(await t.intake.bookingConfirmed(eventOf(t))).toMatchObject({ created: 0, duplicate: 0, held: true });
    expect(calls).toBe(3);
    expect(t.held.rows).toHaveLength(1);
    expect(t.held.rows[0]).toMatchObject({ eventKey: t.eventKey, kind: 'BOOKING_CONFIRMED', attempts: 3 });
    expect(t.store.jobs.size).toBe(0);

    // 같은 eventKey를 다시 넣어도 purchase-svc를 다시 부르지 않고 보류 표에 한 번만 남는다(오프셋을 적고 커밋한 것으로 본다)
    expect(await t.intake.bookingConfirmed(eventOf(t))).toMatchObject({ created: 0, duplicate: 0, held: true });
    expect(calls).toBe(3);
    expect(t.held.rows).toHaveLength(1);
  });

  test('N-T28 vars의 seller·name·phone은 거부되고 예매번호 끝 4자리만 넣는다', () => {
    const allowed = {
      productionName: '겨울 콘서트',
      eventStartsAt: '2026-12-24T19:30:00+09:00',
      venueName: '피켓홀',
      seatSummary: 'R석 2매',
      amount: 220_000,
      bookingNoLast4: '0001',
      orderId: randomUUID(),
    };
    expect(assertVars('BOOKING_CONFIRMED' as never, allowed)).toEqual(allowed);
    for (const key of ['seller', 'name', 'phone', 'seatNumber', 'bookingNo']) {
      expect(() => assertVars('BOOKING_CONFIRMED' as never, { ...allowed, [key]: 'x' })).toThrow();
    }
  });

});
