// F-06-1 N-T23 ③: POL-034 계정 병합의 흡수 계정 이메일 완료 통지.
// 주소는 Kafka 사건에 없고, 병합 통지 사본을 내부 gRPC로 읽어 한 번 보낸다(계획 §3.1).
// 가짜는 identity 조회·메일·푸시 경계에만 쓰고, 인테이크·워커·중복 키는 진짜를 쓴다.
import 'reflect-metadata';
import { createService, fakeClock } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
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

/** identity MergeNoticeService.FetchAbsorbedEmail 대역. 주소는 여기에만 있고 작업·기록에는 넣지 않는다 */
class MemoryMergeNotice {
  readonly rows = new Map<string, string>();
  readonly asked: string[] = [];
  async fetchAbsorbedEmail(mergeId: string): Promise<{ email: string; expiresAt: Date } | undefined> {
    this.asked.push(mergeId);
    const email = this.rows.get(mergeId);
    return email ? { email, expiresAt: new Date(NOW_MS + 24 * 60 * 60 * 1000) } : undefined;
  }
}

const store = new MemoryFanNotifyStore();
const mail = new FakeMailTransport();
const push = new FakePushTransport();
const recipients = new MemoryRecipientDirectory();
const mergeNotice = new MemoryMergeNotice();
const clock = fakeClock({ now: NOW_MS });
const wiring: FanNotifyWiring & { mergeNotice: MemoryMergeNotice } = {
  store,
  mail,
  push,
  recipients,
  mergeNotice,
  optOutKey: OPTOUT_KEY,
  vapid: vapidKeys(),
  lookup: async () => [{ address: '142.250.196.110', family: 4 }],
};
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
beforeEach(() => {
  // 시험마다 같은 저장소를 비운다(서비스가 들고 있는 저장소 객체는 그대로)
  store.jobs.clear();
  store.dedup.clear();
  store.subscriptions.clear();
  store.push.clear();
  store.deliveries.length = 0;
  mail.sent.length = 0;
  push.sent.length = 0;
  push.responses.length = 0;
  recipients.rows.clear();
  mergeNotice.rows.clear();
  mergeNotice.asked.length = 0;
});

const merged = (mergeId: string, primary: string, absorbed: string) =>
  svc.http.inject({
    method: 'POST',
    url: '/internal/v1/notify/identity-events',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ type: 'ACCOUNT_MERGED', eventKey: mergeId, primaryAccountId: primary, mergedAccountId: absorbed, occurredAtMs: NOW_MS }),
  });

const activeAccount = (accountId: string, email: string) =>
  recipients.rows.set(accountId, { accountId, status: 'ACTIVE', verified: true, locale: 'ko', email });

describe('N-T23 계정 병합 흡수 계정 이메일', () => {
  test('N-T23 ③ 대표 계정과 흡수 계정에 각각 한 번 통지하고, 주소는 작업에 남기지 않는다 [ASVS v5.0.0-6.8.1] [ASVS v5.0.0-14.3.2]', async () => {
    const primary = randomUUID();
    const absorbed = randomUUID();
    activeAccount(primary, 'primary@example.com');
    activeAccount(absorbed, 'absorbed@example.com');
    const mergeId = randomUUID();
    mergeNotice.rows.set(mergeId, 'absorbed@example.com');
    const key = pushKeyPair();
    store.push.set('p-absorbed', {
      id: 'p-absorbed', accountId: absorbed, endpoint: 'https://fcm.googleapis.com/send/m', endpointHash: 'm'.repeat(43), service: 'FCM',
      p256dh: key.p256dh, auth: key.auth, expiresAt: null, boundAt: new Date(NOW_MS), createdAt: new Date(NOW_MS),
    });

    const created = await merged(mergeId, primary, absorbed);
    expect(created.statusCode).toBe(202);
    expect(mergeNotice.asked).toEqual([mergeId]);

    const keys = [...store.jobs.keys()];
    expect(keys).toContain(`ACCOUNT_MERGED:${mergeId}:${primary}:EMAIL`);
    expect(keys).toContain(`ACCOUNT_MERGED:${mergeId}:${primary}:WEB_PUSH`);
    expect(keys).toContain(`ACCOUNT_MERGED_ABSORBED:${mergeId}:${absorbed}:EMAIL`);
    const jobs = JSON.stringify([...store.jobs.values()]);
    expect(jobs).not.toContain('primary@example.com');
    expect(jobs).not.toContain('absorbed@example.com');

    push.responses.push(201);
    expect(await svc.app.get(FanNotificationWorker).processDue(new Date(NOW_MS))).toMatchObject({ attempted: 3, sent: 3 });
    expect(mail.sent.map((m) => m.to).sort()).toEqual(['absorbed@example.com', 'primary@example.com']);
    expect(mail.sent.find((m) => m.to === 'absorbed@example.com')!.subject).toBe('계정을 합쳤습니다');
    expect(push.sent).toHaveLength(1);

    // 같은 병합 사건을 다시 와도 작업은 늘지 않는다
    const again = await merged(mergeId, primary, absorbed);
    expect(again.statusCode).toBe(202);
    expect(JSON.parse(again.payload)).toMatchObject({ created: 0, duplicate: 3 });
    expect(await svc.app.get(FanNotificationWorker).processDue(new Date(NOW_MS))).toMatchObject({ attempted: 0, sent: 0 });
  });

  test('N-T23 ③ 통지 사본이 없으면 흡수 계정 작업을 만들지 않고 대표 계정 통지만 한다', async () => {
    const primary = randomUUID();
    const absorbed = randomUUID();
    activeAccount(primary, 'primary2@example.com');
    activeAccount(absorbed, 'absorbed2@example.com');
    const key = pushKeyPair();
    store.push.set('p-primary', {
      id: 'p-primary', accountId: primary, endpoint: 'https://fcm.googleapis.com/send/p2', endpointHash: 'p'.repeat(43), service: 'FCM',
      p256dh: key.p256dh, auth: key.auth, expiresAt: null, boundAt: new Date(NOW_MS), createdAt: new Date(NOW_MS),
    });
    const mergeId = randomUUID();

    const created = await merged(mergeId, primary, absorbed);
    expect(created.statusCode).toBe(202);
    const keys = [...store.jobs.keys()];
    expect(keys.some((k) => k.startsWith('ACCOUNT_MERGED_ABSORBED:'))).toBe(false);
    expect(keys).toContain(`ACCOUNT_MERGED:${mergeId}:${primary}:EMAIL`);

    push.responses.push(201);
    expect(await svc.app.get(FanNotificationWorker).processDue(new Date(NOW_MS))).toMatchObject({ attempted: 2, sent: 2 });
    expect(mail.sent.filter((m) => m.to === 'absorbed2@example.com')).toHaveLength(0);
  });
});
