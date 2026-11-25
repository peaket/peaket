// F-05-11 core-svc 양도 알림 입구 시험(계획 docs/review/plans/F-05-11.md §4·§5 T11).
// 시험 담당이 구현 전에 썼다(ADR-0372·0381). POST /internal/v1/notify/transfer-events는 아직 없다(기준 트리에서 404).
// 정본: docs/features/notify.md §4.8(종류 일곱·문안·링크·받는 사람), §7.2(밤에도 보낸다), docs/features/transfer-refund.md §5·§11 R-T25.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { createService, fakeClock } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { FakeMailTransport, FakePushTransport, FanNotificationWorker, MemoryFanNotifyStore, MemoryRecipientDirectory, type FanNotifyWiring } from '../src/modules/notify/index.js';
import { FakeIdentity, NOW_MS, quiet } from './support.js';
import { OPTOUT_KEY, pushKeyPair, vapidKeys } from './fan-notify-support.js';

const store = new MemoryFanNotifyStore();
const mail = new FakeMailTransport();
const push = new FakePushTransport();
const recipients = new MemoryRecipientDirectory();
const clock = fakeClock({ now: NOW_MS });
const wiring: FanNotifyWiring = { store, mail, push, recipients, optOutKey: OPTOUT_KEY, vapid: vapidKeys(), lookup: async () => [{ address: '142.250.196.110', family: 4 }] };
let svc: Awaited<ReturnType<typeof createService>>;

beforeAll(async () => {
  svc = await createService({
    name: 'core-svc',
    module: AppModule.register({ memory: true, notify: { fanNotify: wiring } }),
    env: { PEAKET_ENV: 'ci' },
    clock,
    logDestination: quiet(),
    adminAuthz: new FakeIdentity(),
  });
});
afterAll(async () => {
  await svc?.close();
});

const transferEvent = (body: Record<string, unknown>) =>
  svc.http.inject({ method: 'POST', url: '/internal/v1/notify/transfer-events', headers: { 'content-type': 'application/json' }, payload: JSON.stringify(body) });

const ids = () => ({ offerId: randomUUID(), ticketId: randomUUID(), eventId: randomUUID(), noticeId: randomUUID() });
const base = (type: string, accountId: string, o: Record<string, unknown> = {}) => ({ ...ids(), type, accountId, occurredAtMs: NOW_MS, ...o });

describe('F-05-11 T11 양도 알림 입구', () => {
  test('F-05-11 T11 ① TRANSFER_OFFERED는 이메일·웹 푸시 작업을 만들고 문안·링크가 notify §4.8과 같다', async () => {
    const accountId = randomUUID();
    recipients.rows.set(accountId, { accountId, status: 'ACTIVE', verified: true, locale: 'ko', email: 'fan@example.com' });
    const key = pushKeyPair();
    store.push.set('p1', { id: 'p1', accountId, endpoint: 'https://fcm.googleapis.com/send/i', endpointHash: 'i'.repeat(43), service: 'FCM', p256dh: key.p256dh, auth: key.auth, expiresAt: null, boundAt: new Date(NOW_MS), createdAt: new Date(NOW_MS) });
    const body = base('TRANSFER_OFFERED', accountId);
    const r = await transferEvent(body);
    expect(r.statusCode, r.payload).toBe(202);
    expect(JSON.parse(r.payload)).toMatchObject({ created: 2, duplicate: 0 });
    const again = await transferEvent(body);
    expect(again.statusCode).toBe(202);
    expect(JSON.parse(again.payload)).toMatchObject({ created: 0, duplicate: 2 });
    expect(store.jobs.size).toBe(2);

    push.responses.push(201);
    const worker = svc.app.get(FanNotificationWorker);
    await worker.processDue(new Date(NOW_MS));
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]!.subject).toBe('양도 요청이 도착했습니다');
    expect(mail.sent[0]!.body).toContain('티켓 양도 요청이 도착했습니다');
    expect(push.sent).toHaveLength(1);
  });

  test('F-05-11 T11 ② 철회 문안은 공개 사유로 가르고, 받는 사람 응답에 금액·연락처가 없다', async () => {
    for (const [reason, subject] of [
      ['EVENT_CANCELLED', '공연이 취소되어 양도 요청이 철회되었습니다'],
      ['EVENT_POSTPONED', '공연 일정이 바뀌어 양도 요청이 철회되었습니다'],
      ['SENDER', '양도 요청이 철회되었습니다'],
      ['OTHER', '양도 요청이 철회되었습니다'],
    ] as const) {
      const accountId = randomUUID();
      recipients.rows.set(accountId, { accountId, status: 'ACTIVE', verified: true, locale: 'ko', email: 'fan@example.com' });
      const r = await transferEvent(base('TRANSFER_WITHDRAWN', accountId, { reason }));
      expect(r.statusCode, `${reason}: ${r.payload}`).toBe(202);
      expect(store.jobs.size).toBeGreaterThan(0);
      const job = [...store.jobs.values()].find((j) => j.accountId === accountId && j.channel === 'EMAIL')!;
      expect(job).toBeDefined();
      expect(job.kind).toBe('TRANSFER_WITHDRAWN');
      expect(JSON.stringify(job.vars)).not.toMatch(/amount|contact|phone/i);
    }
  });

  test('F-05-11 T11 ③ 모르는 종류·모양 틀림은 422이고 작업을 만들지 않는다', async () => {
    const before = store.jobs.size;
    const badType = await transferEvent(base('TRANSFER_SOMETHING', randomUUID()));
    expect(badType.statusCode).toBe(422);
    expect(JSON.parse(badType.payload)).toMatchObject({ type: expect.stringMatching(/invalid-notify-event$/) });
    const badId = await transferEvent({ ...base('TRANSFER_OFFERED', randomUUID()), offerId: 'not-a-uuid' });
    expect(badId.statusCode).toBe(422);
    const badReason = await transferEvent(base('TRANSFER_WITHDRAWN', randomUUID(), { reason: 'FRAUD_LOCK' }));
    expect(badReason.statusCode).toBe(422);
    expect(store.jobs.size).toBe(before);
  });

  test('F-05-11 T11 ④ 내부 토큰이 설정된 조립에서는 토큰 없이 401이다', async () => {
    const secured = await createService({
      name: 'core-svc',
      module: AppModule.register({ memory: true, notify: { fanNotify: wiring, env: { PEAKET_ENV: 'ci', PEAKET_INTERNAL_TOKEN: 'f0511-token' } } }),
      env: { PEAKET_ENV: 'ci', PEAKET_INTERNAL_TOKEN: 'f0511-token' },
      clock,
      logDestination: quiet(),
      adminAuthz: new FakeIdentity(),
    });
    const res = await secured.http.inject({ method: 'POST', url: '/internal/v1/notify/transfer-events', headers: { 'content-type': 'application/json' }, payload: JSON.stringify(base('TRANSFER_OFFERED', randomUUID())) });
    expect(res.statusCode).toBe(401);
    await secured.close();
  });
});
