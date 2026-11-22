// 내부 팬 알림 사건 경로(BAT-425 GAT-130 잔여, R-592 / BAT-455 원장화) HTTP 시험.
import 'reflect-metadata';
import { createService } from '@peaket/platform';
import { afterEach, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { FakeMailTransport, MemoryFanNotifyStore, MemoryRecipientDirectory } from '../src/modules/notify/index.js';
import { FakeIdentity, quiet } from './support.js';
import { OPTOUT_KEY } from './fan-notify-support.js';

const ORDER = '01900000-0000-7000-8000-000000000002';
const EVENT = '01900000-0000-7000-8000-000000000001';
const ACCOUNT = '01900000-0000-7000-8000-000000000003';
const services: Awaited<ReturnType<typeof createService>>[] = [];

afterEach(async () => {
  delete process.env.PEAKET_NOTIFY_SENDER_MODE;
  await Promise.all(services.splice(0).map((s) => s.close()));
});

const start = async () => {
  const mail = new FakeMailTransport();
  const recipients = new MemoryRecipientDirectory();
  recipients.rows.set(ACCOUNT, { accountId: ACCOUNT, status: 'ACTIVE', verified: true, locale: 'ko', email: 'fan@example.com' });
  const svc = await createService({
    name: 'core-svc-notify',
    module: AppModule.register({ memory: true, notify: { fanNotify: { store: new MemoryFanNotifyStore(), mail, recipients, optOutKey: OPTOUT_KEY } } }),
    env: { PEAKET_ENV: 'ci' },
    logDestination: quiet(),
    adminAuthz: new FakeIdentity(),
  });
  services.push(svc);
  return { svc, mail };
};

describe('POST /internal/v1/notify/trade-events [BAT-455 원장]', () => {
  test('fake 모드는 원장에 적어 보내고, 모드가 없으면 503으로 닫는다', async () => {
    process.env.PEAKET_NOTIFY_SENDER_MODE = 'fake';
    const { svc, mail } = await start();
    const ok = await svc.http.inject({ method: 'POST', url: '/internal/v1/notify/trade-events', headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ type: 'REFUNDED', orderId: ORDER, eventId: EVENT, accountId: ACCOUNT, occurredAtMs: 1, refundAmount: 110_000 }) });
    expect(ok.statusCode).toBe(202);
    expect(JSON.parse(ok.payload)).toMatchObject({ status: 'SENT', type: 'REFUNDED' });
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]!.subject).toBe('환급이 완료되었습니다');

    delete process.env.PEAKET_NOTIFY_SENDER_MODE;
    const { svc: svc2 } = await start();
    const unavailable = await svc2.http.inject({ method: 'POST', url: '/internal/v1/notify/trade-events', headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ type: 'REFUND_FAILED', orderId: ORDER, eventId: EVENT, accountId: ACCOUNT, occurredAtMs: 1, fanNoticeReason: '실패' }) });
    expect(unavailable.statusCode).toBe(503);
    expect(JSON.parse(unavailable.payload)).toMatchObject({ type: expect.stringMatching(/notify-sender-unavailable$/) });
  });
});
