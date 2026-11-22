// 입장 키 알림 내부 입구 HTTP 시험(BUILD_ORDER GAT-020, F-05-1, docs/features/notify.md §4.7, docs/features/offline-gate.md §11 O-T48, ADR-0363 결정 4).
// POST /internal/v1/notify/ticket-events가 이메일 하나와 그 계정의 살아 있는 웹 푸시 구독마다 작업 하나를 만들고, 같은 noticeId는 하나만 적으며,
// 변수에 이메일·공개키·keyId가 없고, 정의 밖 칸은 422인지 본다. 문안(제목·본문·링크)은 정본 글에서 적고 워커가 실제로 보낸 메일·푸시를 풀어 본다.
// 바꿔 끼우는 것은 메일·푸시 대행사(Fake*Transport, 짝 가짜)·수신자 찾기(MemoryRecipientDirectory)·알림 저장소(MemoryFanNotifyStore, Drizzle의 짝 가짜)·시계다.
import 'reflect-metadata';
import { createDecipheriv, hkdfSync, randomUUID } from 'node:crypto';
import { createService, fakeClock } from '@peaket/platform';
import { afterEach, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { FakeMailTransport, FakePushTransport, FanNotificationWorker, MemoryFanNotifyStore, MemoryRecipientDirectory, type FanNotifyWiring } from '../src/modules/notify/index.js';
import { FakeIdentity, quiet } from './support.js';
import { OPTOUT_KEY, pushKeyPair, vapidKeys } from './fan-notify-support.js';

/** 등록 시각: 2026-11-23 23:47 KST(밤, 거래·안전 알림은 밤에도 보낸다 §7.2) */
const REGISTERED_AT = Date.parse('2026-11-23T14:47:31.000Z');
const INTERNAL_TOKEN = 'f051-core-internal-9b2e';
const TITLE = '티켓 입장 키를 새 휴대폰에 등록했습니다';

/** RFC 8291 aes128gcm 본문을 구독 개인키로 푼다(push-crypto.test.ts와 같은 방법) */
function decrypt(body: Buffer, ua: ReturnType<typeof pushKeyPair>): string {
  const salt = body.subarray(0, 16);
  const idlen = body.readUInt8(20);
  const asPublic = body.subarray(21, 21 + idlen);
  const ciphertext = body.subarray(21 + idlen);
  const shared = ua.privateKey.computeSecret(asPublic);
  const uaPublic = Buffer.from(ua.p256dh, 'base64url');
  const authInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', shared, Buffer.from(ua.auth, 'base64url'), authInfo, 32));
  const prk = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.alloc(0), 32));
  const cek = Buffer.from(hkdfSync('sha256', prk, Buffer.alloc(0), Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', prk, Buffer.alloc(0), Buffer.from('Content-Encoding: nonce\0'), 12));
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(ciphertext.subarray(-16));
  const plain = Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()]);
  return plain.subarray(0, plain.length - 1).toString('utf8');
}

const opened: Awaited<ReturnType<typeof createService>>[] = [];
afterEach(async () => {
  for (const s of opened.splice(0)) await s.close().catch(() => {});
});

/** 시험마다 새 서비스(TA-V01). 계정 하나에 웹 푸시 구독 둘, 다른 계정에 구독 하나 */
async function harness() {
  const store = new MemoryFanNotifyStore();
  const mail = new FakeMailTransport();
  const push = new FakePushTransport();
  const recipients = new MemoryRecipientDirectory();
  const clock = fakeClock({ now: REGISTERED_AT + 5_000 });
  const wiring: FanNotifyWiring = { store, mail, push, recipients, optOutKey: OPTOUT_KEY, vapid: vapidKeys(), lookup: async () => [{ address: '142.250.196.110', family: 4 }] };
  const svc = await createService({
    name: 'core-svc',
    module: AppModule.register({ memory: true, notify: { fanNotify: wiring, env: { PEAKET_ENV: 'ci', PEAKET_INTERNAL_TOKEN: INTERNAL_TOKEN } } }),
    env: { PEAKET_ENV: 'ci', PEAKET_INTERNAL_TOKEN: INTERNAL_TOKEN },
    clock,
    logDestination: quiet(),
    adminAuthz: new FakeIdentity(),
  });
  opened.push(svc);
  const accountId = randomUUID();
  const other = randomUUID();
  recipients.rows.set(accountId, { accountId, status: 'ACTIVE', verified: true, locale: 'ko', email: 'fan.f051@example.com' });
  const subs = [pushKeyPair(), pushKeyPair()];
  const addSub = (owner: string, key: ReturnType<typeof pushKeyPair>, n: string) => {
    const id = randomUUID();
    store.push.set(id, {
      id, accountId: owner, endpoint: `https://fcm.googleapis.com/send/f051-${n}`, endpointHash: n.padEnd(43, 'k'), service: 'FCM',
      p256dh: key.p256dh, auth: key.auth, expiresAt: null, boundAt: new Date(REGISTERED_AT - 60_000), createdAt: new Date(REGISTERED_AT - 60_000),
    });
  };
  addSub(accountId, subs[0]!, 'a');
  addSub(accountId, subs[1]!, 'b');
  addSub(other, pushKeyPair(), 'z');
  const send = (body: unknown, token: string | null = INTERNAL_TOKEN) =>
    svc.http.inject({
      method: 'POST',
      url: '/internal/v1/notify/ticket-events',
      headers: { 'content-type': 'application/json', ...(token ? { 'x-peaket-internal-token': token } : {}) },
      payload: JSON.stringify(body),
    });
  return { svc, store, mail, push, accountId, other, subs, send, clock };
}

const event = (h: { accountId: string }, over: Record<string, unknown> = {}) => ({
  noticeId: randomUUID(),
  type: 'DEVICE_KEY_REISSUED',
  accountId: h.accountId,
  ticketId: randomUUID(),
  registeredAtMs: REGISTERED_AT,
  ...over,
});

describe('O-T48 입장 키 알림 core-svc 내부 입구 [GAT-020]', () => {
  test('O-T48 ① 이메일 하나와 그 계정의 웹 푸시 구독마다 작업 하나를 만들고 같은 noticeId는 두 번 와도 작업이 하나다', async () => {
    const h = await harness();
    const e = event(h);
    const first = await h.send(e);
    expect(first.statusCode).toBe(202);
    const second = await h.send(e);
    expect(second.statusCode).toBe(202);
    const jobs = [...h.store.jobs.values()];
    expect(jobs.map((j) => j.channel).sort()).toEqual(['EMAIL', 'WEB_PUSH', 'WEB_PUSH']);
    expect(jobs.every((j) => j.accountId === h.accountId && j.kind === 'DEVICE_KEY_REISSUED' && j.targetId === e.ticketId)).toBe(true);
    // 중복 키 {type}:{ticketId}:{noticeId}:{accountId}:{채널}(notify §4.3·§4.7). 웹 푸시는 구독마다 작업이라 채널 칸까지가 정본 꼴이다
    const base = `DEVICE_KEY_REISSUED:${e.ticketId}:${e.noticeId}:${h.accountId}`;
    expect(jobs.filter((j) => j.channel === 'EMAIL').map((j) => j.dedupKey)).toEqual([`${base}:EMAIL`]);
    for (const j of jobs.filter((x) => x.channel === 'WEB_PUSH')) expect(j.dedupKey.startsWith(`${base}:WEB_PUSH`)).toBe(true);
    expect(new Set(jobs.map((j) => j.dedupKey)).size).toBe(3);
  });

  test('O-T48 ② 작업 변수는 type·registeredAt·ticketId 셋이고 이메일·공개키·keyId 원문이 없다', async () => {
    const h = await harness();
    const e = event(h, { type: 'DEVICE_KEY_LATE_ISSUE' });
    expect((await h.send(e)).statusCode).toBe(202);
    for (const j of h.store.jobs.values()) {
      expect(Object.keys(j.vars).sort()).toEqual(['registeredAt', 'ticketId', 'type']);
      expect(j.vars.type).toBe('DEVICE_KEY_LATE_ISSUE');
      expect(j.vars.ticketId).toBe(e.ticketId);
      expect(Date.parse(String(j.vars.registeredAt))).toBe(REGISTERED_AT);
      expect(JSON.stringify(j.vars)).not.toMatch(/@|example\.com/);
    }
  });

  test('O-T48 ③ 정의 밖 칸·모르는 종류·빠진 칸·틀린 ID는 422이고 작업을 만들지 않는다', async () => {
    const h = await harness();
    for (const [label, body] of [
      ['keyId 칸', { ...event(h), keyId: 'AAAAAAAAAAA' }],
      ['publicKey 칸', { ...event(h), publicKey: 'Ag' }],
      ['email 칸', { ...event(h), email: 'fan.f051@example.com' }],
      ['모르는 종류', event(h, { type: 'KEY_REGISTERED' })],
      ['noticeId 없음', (({ noticeId: _n, ...rest }) => rest)(event(h))],
      ['ticketId가 UUID 아님', event(h, { ticketId: 'tkt-1' })],
      ['registeredAtMs 음수', event(h, { registeredAtMs: -1 })],
    ] as const) {
      const r = await h.send(body);
      expect(r.statusCode, label).toBe(422);
    }
    expect(h.store.jobs.size).toBe(0);
  });

  test('O-T48 ④ 내부 토큰이 없거나 틀리면 받지 않는다', async () => {
    const h = await harness();
    for (const token of [null, 'wrong-token']) {
      const r = await h.send(event(h), token);
      expect(r.statusCode, String(token)).toBe(403);
    }
    expect(h.store.jobs.size).toBe(0);
  });

  test('O-T48 ⑤ 워커는 밤에도 이메일 한 통과 구독마다 푸시 한 건을 보내고 문안은 notify §4.7이다', async () => {
    const h = await harness();
    const reissued = event(h);
    const late = event(h, { type: 'DEVICE_KEY_LATE_ISSUE' });
    expect((await h.send(reissued)).statusCode).toBe(202);
    expect((await h.send(late)).statusCode).toBe(202);
    h.push.responses.push(201, 201, 201, 201);
    const worker = h.svc.app.get(FanNotificationWorker);
    // 2026-11-23 23:47:36 KST
    expect(await worker.processDue(new Date(h.clock.now()))).toMatchObject({ sent: 6 });
    expect(h.mail.sent.map((m) => [m.to, m.subject])).toEqual([
      ['fan.f051@example.com', TITLE],
      ['fan.f051@example.com', TITLE],
    ]);
    // 메일은 그 사건의 이메일 작업 중복 키로 찾는다(링크 /my/tickets/{ticketId}는 웹 푸시의 여는 주소로 본다. 메일 본문의 링크는 정본이 따로 정하지 않았다)
    const bodyOf = (ticketId: string) => h.mail.sent.find((m) => m.messageKey.includes(`:${ticketId}:`) && m.messageKey.endsWith(':EMAIL'))?.body ?? '';
    expect(bodyOf(reissued.ticketId)).toMatch(/티켓 한 장의 입장 키를 .*23:47.*에 새 휴대폰으로 옮겼습니다\. 이전 휴대폰의 QR은 더 쓸 수 없습니다\. 직접 하신 일이 아니면 고객센터로 알려 주세요/);
    expect(bodyOf(late.ticketId)).toMatch(/입장이 시작된 뒤 티켓 한 장을 .*23:47.*에 이 계정의 휴대폰에 등록했습니다\. 직접 하신 일이 아니면 고객센터로 알려 주세요/);
    for (const m of h.mail.sent) expect(m.body).not.toMatch(/keyId|publicKey/);

    // 푸시: 이 계정의 두 구독에 사건마다 한 건씩(다른 계정 구독 z에는 없다)
    expect(h.push.sent.map((p) => p.endpoint).sort()).toEqual([
      'https://fcm.googleapis.com/send/f051-a',
      'https://fcm.googleapis.com/send/f051-a',
      'https://fcm.googleapis.com/send/f051-b',
      'https://fcm.googleapis.com/send/f051-b',
    ]);
    const payloads = h.push.sent.map((p) => JSON.parse(decrypt(p.body, p.endpoint.endsWith('-a') ? h.subs[0]! : h.subs[1]!)) as { title: string; body: string; url: string });
    expect(payloads.map((p) => p.title)).toEqual([TITLE, TITLE, TITLE, TITLE]);
    expect(payloads.map((p) => p.url).sort()).toEqual([`/my/tickets/${late.ticketId}`, `/my/tickets/${late.ticketId}`, `/my/tickets/${reissued.ticketId}`, `/my/tickets/${reissued.ticketId}`].sort());
  });
});
