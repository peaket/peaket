// BAT-455 N-T23: 로그인 수단 연결·해제 안내(I-T34)와 계정 병합 설정 이동(POL-034).
import 'reflect-metadata';
import { createService, fakeClock } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import {
  FakeMailTransport,
  FakePushTransport,
  FanNotificationWorker,
  MemoryFanNotifyStore,
  MemoryRecipientDirectory,
  type FanNotifyWiring,
} from '../src/modules/notify/index.js';
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

const identityEvent = (body: Record<string, unknown>) =>
  svc.http.inject({ method: 'POST', url: '/internal/v1/notify/identity-events', headers: { 'content-type': 'application/json' }, payload: JSON.stringify(body) });

describe('N-T23 로그인 수단 변경·계정 병합', () => {
  test('N-T23 ① 같은 연결 사건은 한 번만 적고 이메일·웹 푸시로 한 번 보낸다', async () => {
    const accountId = randomUUID();
    recipients.rows.set(accountId, { accountId, status: 'ACTIVE', verified: true, locale: 'ko', email: 'fan@example.com' });
    const key = pushKeyPair();
    store.push.set('p1', {
      id: 'p1', accountId, endpoint: 'https://fcm.googleapis.com/send/i', endpointHash: 'i'.repeat(43), service: 'FCM',
      p256dh: key.p256dh, auth: key.auth, expiresAt: null, boundAt: new Date(NOW_MS), createdAt: new Date(NOW_MS),
    });
    const event = { type: 'LOGIN_METHOD_CHANGED', eventKey: randomUUID(), accountId, change: 'LINKED', provider: 'google', occurredAtMs: NOW_MS };
    expect((await identityEvent(event)).statusCode).toBe(202);
    expect((await identityEvent(event)).statusCode).toBe(202);
    expect(store.jobs.size).toBe(2); // EMAIL·WEB_PUSH

    push.responses.push(201);
    const worker = svc.app.get(FanNotificationWorker);
    expect(await worker.processDue(new Date(NOW_MS))).toMatchObject({ sent: 2 });
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]!.subject).toBe('로그인 수단을 연결했습니다');
    expect(push.sent).toHaveLength(1);

    expect((await identityEvent({ ...event, change: 'UNLINKED', eventKey: randomUUID() })).statusCode).toBe(202);
    push.responses.push(201);
    await worker.processDue(new Date(NOW_MS));
    expect(mail.sent.at(-1)!.subject).toBe('로그인 수단을 해제했습니다');
  });

  test('N-T23 ② 병합은 흡수 계정의 신청·구독을 대표 계정으로 옮기고 겹치면 하나만 남긴다', async () => {
    const primary = randomUUID();
    const absorbed = randomUUID();
    recipients.rows.set(primary, { accountId: primary, status: 'ACTIVE', verified: true, locale: 'ko', email: 'primary@example.com' });
    const eventId = randomUUID();
    const base = { nightPush: false, sentCount: 0, status: 'ACTIVE' as const, endReason: null, createdAt: new Date(NOW_MS), updatedAt: new Date(NOW_MS) };
    store.subscriptions.set(`${absorbed}:${eventId}:OPEN`, { ...base, id: 's-absorbed', accountId: absorbed, eventId, kind: 'OPEN' });
    store.subscriptions.set(`${primary}:${eventId}:CANCELLATION`, { ...base, id: 's-primary', accountId: primary, eventId, kind: 'CANCELLATION', sentCount: 2 });
    store.subscriptions.set(`${absorbed}:${eventId}:CANCELLATION`, { ...base, id: 's-dup', accountId: absorbed, eventId, kind: 'CANCELLATION', sentCount: 4 });
    const k = pushKeyPair();
    store.push.set('push-absorbed', {
      id: 'push-absorbed', accountId: absorbed, endpoint: 'https://fcm.googleapis.com/send/m', endpointHash: 'm'.repeat(43), service: 'FCM',
      p256dh: k.p256dh, auth: k.auth, expiresAt: null, boundAt: new Date(NOW_MS), createdAt: new Date(NOW_MS),
    });

    const r = await identityEvent({ type: 'ACCOUNT_MERGED', eventKey: randomUUID(), primaryAccountId: primary, mergedAccountId: absorbed, occurredAtMs: NOW_MS });
    expect(r.statusCode).toBe(202);
    expect(store.subscriptions.has(`${absorbed}:${eventId}:OPEN`)).toBe(false);
    expect(store.subscriptions.has(`${absorbed}:${eventId}:CANCELLATION`)).toBe(false);
    expect(store.subscriptions.get(`${primary}:${eventId}:OPEN`)).toMatchObject({ accountId: primary, kind: 'OPEN' });
    expect(store.subscriptions.get(`${primary}:${eventId}:CANCELLATION`)).toMatchObject({ accountId: primary, sentCount: 4 });
    expect(store.push.get('push-absorbed')).toMatchObject({ accountId: primary });

    // 대표 계정 이메일과 옮긴 웹 푸시로 완료 통지 job이 적힌다
    const keys = [...store.jobs.keys()];
    expect(keys.some((x) => x.includes('ACCOUNT_MERGED') && x.endsWith(':EMAIL'))).toBe(true);
    expect(keys.some((x) => x.includes('ACCOUNT_MERGED') && x.endsWith(':WEB_PUSH'))).toBe(true);
    push.responses.push(201);
    await svc.app.get(FanNotificationWorker).processDue(new Date(NOW_MS));
    expect(mail.sent.some((m) => m.subject.includes('계정을 합쳤습니다'))).toBe(true);
    expect(push.sent.some((p) => p.endpoint.includes('fcm.googleapis.com'))).toBe(true);
  });
});
