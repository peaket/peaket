// F-05-11 core-svc 양도 알림 입구 시험(계획 docs/review/plans/F-05-11.md §4·§5 T11).
// 시험 담당이 구현 전에 썼다(ADR-0372·0381). POST /internal/v1/notify/transfer-events는 아직 없다(기준 트리에서 404).
// 정본: docs/features/notify.md §4.8(종류 일곱·당사자별 문안·링크·받는 사람), §7.2(밤에도 보낸다), docs/features/transfer-refund.md §5·§11 R-T25.
// 시험 리뷰 TR-02·TR-03 반영: 사유별 제목·본문, 링크, 일곱 종류·이메일·웹 푸시를 모두 본다.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { createService, fakeClock } from '@peaket/platform';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
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
beforeEach(() => {
  store.jobs.clear();
  store.push.clear();
  mail.sent.length = 0;
  push.sent.length = 0;
  push.responses.length = 0;
});

const transferEvent = (body: Record<string, unknown>) =>
  svc.http.inject({ method: 'POST', url: '/internal/v1/notify/transfer-events', headers: { 'content-type': 'application/json' }, payload: JSON.stringify(body) });

const ids = () => ({ offerId: randomUUID(), ticketId: randomUUID(), eventId: randomUUID(), noticeId: randomUUID() });
const base = (type: string, party: string, accountId: string, o: Record<string, unknown> = {}) => ({ ...ids(), type, party, accountId, occurredAtMs: NOW_MS, ...o });

/** 계정 하나에 이메일 주소와 웹 푸시 구독 하나를 준비한다 */
function subscriber(): string {
  const accountId = randomUUID();
  recipients.rows.set(accountId, { accountId, status: 'ACTIVE', verified: true, locale: 'ko', email: `${accountId.slice(0, 8)}@example.com` });
  const key = pushKeyPair();
  store.push.set(`p-${accountId}`, { id: `p-${accountId}`, accountId, endpoint: 'https://fcm.googleapis.com/send/i', endpointHash: 'i'.repeat(43), service: 'FCM', p256dh: key.p256dh, auth: key.auth, expiresAt: null, boundAt: new Date(NOW_MS), createdAt: new Date(NOW_MS) });
  return accountId;
}

/** 한 건을 보내고(202) 작업을 처리한 뒤 그 계정의 이메일·웹 푸시 작업을 돌려준다 */
async function sendAndProcess(body: Record<string, unknown>) {
  const r = await transferEvent(body);
  expect(r.statusCode, r.payload).toBe(202);
  push.responses.push(201);
  const worker = svc.app.get(FanNotificationWorker);
  await worker.processDue(new Date(NOW_MS));
  const accountId = body.accountId as string;
  const email = mail.sent.filter((m) => m.to === recipients.rows.get(accountId)?.email).at(-1);
  const emailJob = [...store.jobs.values()].find((j) => j.accountId === accountId && j.channel === 'EMAIL');
  const pushJob = [...store.jobs.values()].find((j) => j.accountId === accountId && j.channel === 'WEB_PUSH');
  return { email, emailJob, pushJob, response: r };
}

describe('F-05-11 T11 양도 알림 입구', () => {
  test('F-05-11 T11 ① TRANSFER_OFFERED는 이메일·웹 푸시를 만들고 제목·본문·링크가 notify §4.8과 같다', async () => {
    const accountId = subscriber();
    const body = base('TRANSFER_OFFERED', 'RECIPIENT', accountId);
    const first = await sendAndProcess(body);
    expect(first.email?.subject).toBe('양도 요청이 도착했습니다');
    expect(first.email?.body).toContain('티켓 양도 요청이 도착했습니다');
    expect(first.emailJob?.kind).toBe('TRANSFER_OFFERED');
    expect(first.pushJob?.vars?.url).toBe(`/my/transfers/${String(body.offerId)}`);
    expect(JSON.stringify(first.emailJob?.vars)).not.toMatch(/email|phone|contact|amount/i);
  });

  test('F-05-11 T11 ② 같은 noticeId는 작업을 늘리지 않고, 웹 푸시 링크는 수락 전이면 SCR-041이다', async () => {
    const accountId = subscriber();
    const body = base('TRANSFER_OFFERED', 'RECIPIENT', accountId);
    const first = await transferEvent(body);
    expect(JSON.parse(first.payload)).toMatchObject({ created: 2, duplicate: 0 });
    const again = await transferEvent(body);
    expect(again.statusCode).toBe(202);
    expect(JSON.parse(again.payload)).toMatchObject({ created: 0, duplicate: 2 });
    expect(store.jobs.size).toBe(2);
  });

  test('F-05-11 T11 ③ 철회 문안은 공개 사유와 당사자로 가르고, 이메일 본문에 금액·연락처가 없다', async () => {
    // 받는 사람: 사유별 제목이 다르다.
    for (const [reason, subject, bodyText] of [
      ['EVENT_CANCELLED', '공연이 취소되어 양도 요청이 철회되었습니다', '전액 환급'],
      ['EVENT_POSTPONED', '공연 일정이 바뀌어 양도 요청이 철회되었습니다', '바뀐 일정으로 다시'],
      ['SENDER', '양도 요청이 철회되었습니다', '보낸 분이 양도 요청을 철회했습니다'],
      ['OTHER', '양도 요청이 철회되었습니다', '보낸 분이 양도 요청을 철회했습니다'],
    ] as const) {
      const accountId = subscriber();
      store.jobs.clear();
      mail.sent.length = 0;
      const sent = await sendAndProcess(base('TRANSFER_WITHDRAWN', 'RECIPIENT', accountId, { reason }));
      expect(sent.email?.subject, reason).toBe(subject);
      expect(sent.email?.body, reason).toContain(bodyText);
      expect(sent.pushJob?.vars?.url).toBe('/my/tickets');
    }
    // 보낸 사람: 철회 확인 문안.
    const sender = subscriber();
    const sent = await sendAndProcess(base('TRANSFER_WITHDRAWN', 'SENDER', sender));
    expect(sent.email?.subject).toBe('양도 요청을 철회했습니다');
  });

  test('F-05-11 T11 ④ 일곱 종류 모두 202로 작업을 만들고, 당사자별 제목·본문이 notify §4.8과 같다', async () => {
    const cases = [
      ['TRANSFER_ACCEPTED', 'SENDER', '양도가 수락되었습니다', '수락했습니다'],
      ['TRANSFER_ACCEPTED', 'RECIPIENT', '티켓을 받았습니다', '입장용으로 등록'],
      ['TRANSFER_REJECTED', 'SENDER', '양도 요청이 거절되었습니다', '그대로 보낸 분'],
      ['TRANSFER_REJECTED', 'RECIPIENT', '양도 요청을 거절했습니다', '보낸 분에게'],
      ['TRANSFER_EXPIRED', 'SENDER', '양도 요청 기한이 지났습니다', '보낸 분에게'],
      ['TRANSFER_EXPIRED', 'RECIPIENT', '양도 요청 기한이 지났습니다', '보낸 분에게'],
      ['TICKET_RETURNED', 'PAYER', '티켓이 결제자에게 돌아왔습니다', '입장용으로 다시 등록'],
      ['TICKET_RETURNED', 'RETURNER', '티켓을 결제자에게 돌려주었습니다', ''],
      ['TRANSFER_WEAK_REAUTH', 'SENDER', '양도 요청을 보냈습니다', '간편 재인증'],
    ] as const;
    for (const [type, party, subject, bodyText] of cases) {
      const accountId = subscriber();
      store.jobs.clear();
      mail.sent.length = 0;
      const sent = await sendAndProcess(base(type, party, accountId));
      expect(sent.email?.subject, `${type}/${party}`).toBe(subject);
      if (bodyText !== '') expect(sent.email?.body, `${type}/${party}`).toContain(bodyText);
      expect(sent.pushJob, `${type}/${party} 웹 푸시 없음`).toBeDefined();
      expect(sent.pushJob?.vars?.url, `${type}/${party}`).toBe('/my/tickets');
      expect(sent.emailJob?.kind).toBe(type);
    }
  });

  test('F-05-11 T11 ⑤ 모르는 종류·당사자·사유·모양은 422이고 작업을 만들지 않는다', async () => {
    const before = store.jobs.size;
    const badType = await transferEvent(base('TRANSFER_SOMETHING', 'SENDER', randomUUID()));
    expect(badType.statusCode).toBe(422);
    expect(JSON.parse(badType.payload)).toMatchObject({ type: expect.stringMatching(/invalid-notify-event$/) });
    const badParty = await transferEvent(base('TRANSFER_OFFERED', 'PAYER', randomUUID()));
    expect(badParty.statusCode).toBe(422);
    const badId = await transferEvent({ ...base('TRANSFER_OFFERED', 'RECIPIENT', randomUUID()), offerId: 'not-a-uuid' });
    expect(badId.statusCode).toBe(422);
    const badReason = await transferEvent(base('TRANSFER_WITHDRAWN', 'RECIPIENT', randomUUID(), { reason: 'FRAUD_LOCK' }));
    expect(badReason.statusCode).toBe(422);
    expect(store.jobs.size).toBe(before);
  });

  test('F-05-11 T11 ⑥ 내부 토큰이 설정된 조립에서는 토큰 없이 401이다', async () => {
    const secured = await createService({
      name: 'core-svc',
      module: AppModule.register({ memory: true, notify: { fanNotify: wiring, env: { PEAKET_ENV: 'ci', PEAKET_INTERNAL_TOKEN: 'f0511-token' } } }),
      env: { PEAKET_ENV: 'ci', PEAKET_INTERNAL_TOKEN: 'f0511-token' },
      clock,
      logDestination: quiet(),
      adminAuthz: new FakeIdentity(),
    });
    const res = await secured.http.inject({ method: 'POST', url: '/internal/v1/notify/transfer-events', headers: { 'content-type': 'application/json' }, payload: JSON.stringify(base('TRANSFER_OFFERED', 'RECIPIENT', randomUUID())) });
    expect(res.statusCode).toBe(401);
    await secured.close();
  });
});
