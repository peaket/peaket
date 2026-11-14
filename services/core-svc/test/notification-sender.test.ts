// core-notify-sender 첫 몫(BAT-425 GAT-130 잔여, FR-040) 단위 시험.
import { describe, expect, test } from 'vitest';
import { FakeNotificationTransport, NotificationSender } from '../src/modules/notify/application/notification-sender.js';

const EVENT = '01900000-0000-7000-8000-000000000001';
const ORDER = '01900000-0000-7000-8000-000000000002';
const ACCOUNT = '01900000-0000-7000-8000-000000000003';

describe('core-notify-sender [BAT-425]', () => {
  test('fake 모드에서 회차 취소·환급 사건을 가짜 전송기로 보내고 중복은 한 번만 보낸다', async () => {
    const transport = new FakeNotificationTransport();
    const sender = new NotificationSender(transport, { PEAKET_NOTIFY_SENDER_MODE: 'fake' });
    const a = await sender.send({ type: 'EVENT_CANCELLATION_CONFIRMED', orderId: ORDER, eventId: EVENT, accountId: ACCOUNT, occurredAtMs: 1, fanNoticeReason: '공연이 취소되었습니다' });
    expect(a).toMatchObject({ status: 'SENT', message: '공연이 취소되었습니다' });
    const b = await sender.send({ type: 'EVENT_CANCELLATION_CONFIRMED', orderId: ORDER, eventId: EVENT, accountId: ACCOUNT, occurredAtMs: 2 });
    expect(b).toEqual(a);
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]).toMatchObject({ accountId: ACCOUNT, title: '공연이 취소되었습니다' });
    const refund = await sender.send({ type: 'REFUNDED', orderId: '01900000-0000-7000-8000-000000000004', eventId: EVENT, accountId: ACCOUNT, occurredAtMs: 3, refundAmount: 110_000 });
    expect(refund).toMatchObject({ status: 'SENT', message: '환급이 완료되었습니다' });
    expect(transport.sent[1]).toMatchObject({ title: '환급이 완료되었습니다', body: '환급 금액 110000원이 결제 수단으로 돌아갑니다.' });
  });

  test('fake 모드가 아니면 UNAVAILABLE로 답하고 바깥으로 보내지 않는다', async () => {
    const transport = new FakeNotificationTransport();
    const sender = new NotificationSender(transport, {});
    expect(await sender.send({ type: 'REFUNDED', orderId: ORDER, eventId: EVENT, accountId: ACCOUNT, occurredAtMs: 1, refundAmount: 110_000 })).toMatchObject({ status: 'UNAVAILABLE' });
    expect(transport.sent).toHaveLength(0);
  });

  test('모르는 종류·모양 틀린 ID는 INVALID다', async () => {
    const sender = new NotificationSender(new FakeNotificationTransport(), { PEAKET_NOTIFY_SENDER_MODE: 'fake' });
    await expect(sender.send({ type: 'UNKNOWN' as never, orderId: ORDER, eventId: EVENT, accountId: ACCOUNT, occurredAtMs: 1 })).rejects.toMatchObject({ code: 'INVALID' });
    await expect(sender.send({ type: 'REFUNDED', orderId: 'x', eventId: EVENT, accountId: ACCOUNT, occurredAtMs: 1 })).rejects.toMatchObject({ code: 'INVALID' });
  });
});
