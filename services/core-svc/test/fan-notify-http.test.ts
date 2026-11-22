// BAT-455 N-T17·N-T18·N-T20: 신청 설정·웹 푸시 구독·한 번 누름 수신 거부(core-svc notify).
import 'reflect-metadata';
import { createService, fakeClock } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { MemoryCatalogRepository } from '../src/modules/catalog/index.js';
import {
  FakeMailTransport,
  FakePushTransport,
  MemoryFanNotifyStore,
  MemoryRecipientDirectory,
  optOutTokenFor,
  type FanNotifyWiring,
} from '../src/modules/notify/index.js';
import { FakeIdentity, NOW_MS, fan, quiet } from './support.js';
import { OPTOUT_KEY, pushKeyPair, seedEvent } from './fan-notify-support.js';

const repo = new MemoryCatalogRepository();
const store = new MemoryFanNotifyStore();
const mail = new FakeMailTransport();
const push = new FakePushTransport();
const recipients = new MemoryRecipientDirectory();
const clock = fakeClock({ now: NOW_MS });
const wiring: FanNotifyWiring = {
  store,
  mail,
  push,
  recipients,
  optOutKey: OPTOUT_KEY,
  lookup: async (hostname) => (hostname === 'fcm.googleapis.com' || hostname === 'web.push.apple.com' ? [{ address: '142.250.196.110', family: 4 }] : [{ address: '10.0.0.8', family: 4 }]),
};
let svc: Awaited<ReturnType<typeof createService>>;

beforeAll(async () => {
  svc = await createService({
    name: 'core-svc',
    module: AppModule.register({ memory: true, catalog: repo, notify: { fanNotify: wiring } }),
    env: { PEAKET_ENV: 'ci' },
    clock,
    logDestination: quiet(),
    adminAuthz: new FakeIdentity(),
  });
});
afterAll(async () => {
  await svc?.close();
});

const headers = (accountId: string) => ({ ...fan(accountId), 'content-type': 'application/json' });
const post = (accountId: string, eventId: string, body: Record<string, unknown>) =>
  svc.http.inject({ method: 'POST', url: `/v1/events/${eventId}/subscriptions`, headers: headers(accountId), payload: JSON.stringify(body) });
const list = (accountId: string, query = '') => svc.http.inject({ method: 'GET', url: `/v1/subscriptions${query}`, headers: fan(accountId) });
const remove = (accountId: string, eventId: string, kind: 'OPEN' | 'CANCELLATION') =>
  svc.http.inject({ method: 'DELETE', url: `/v1/events/${eventId}/subscriptions?kind=${kind}`, headers: fan(accountId) });
const registerPush = (accountId: string, body: Record<string, unknown>) =>
  svc.http.inject({ method: 'POST', url: '/v1/push-subscriptions', headers: headers(accountId), payload: JSON.stringify(body) });
const removePush = (accountId: string, key: string) => svc.http.inject({ method: 'DELETE', url: `/v1/push-subscriptions/${key}`, headers: fan(accountId) });

describe('N-T17 신청 설정', () => {
  test('N-T17 ① 오픈·취소표 신청을 켜고 nightPush를 고치며 회차별 상태를 준다 [ASVS v5.0.0-2.1.3]', async () => {
    const account = randomUUID();
    const { eventId } = seedEvent(repo);
    const other = seedEvent(repo).eventId;

    const created = await post(account, eventId, { kind: 'OPEN', nightPush: true });
    expect(created.statusCode).toBe(201);
    expect(created.headers['cache-control']).toBe('no-store');
    expect(JSON.parse(created.payload)).toMatchObject({ eventId, open: true, cancellation: false, nightPush: true });

    const again = await post(account, eventId, { kind: 'OPEN' });
    expect(again.statusCode).toBe(200);
    expect(JSON.parse(again.payload)).toMatchObject({ eventId, open: true, nightPush: false });

    const cancel = await post(account, eventId, { kind: 'CANCELLATION', nightPush: true });
    expect(cancel.statusCode).toBe(201);
    expect(JSON.parse(cancel.payload)).toMatchObject({ eventId, open: true, cancellation: true, cancellationStatus: 'ACTIVE', sentCount: 0, nightPush: true });

    const states = await list(account, `?eventIds=${eventId},${other}`);
    expect(states.statusCode).toBe(200);
    expect(states.headers['cache-control']).toBe('no-store');
    const items = JSON.parse(states.payload).items;
    expect(items.map((i: { eventId: string }) => i.eventId)).toEqual([eventId, other]);
    expect(items[0]).toMatchObject({ open: true, cancellation: true, cancellationStatus: 'ACTIVE' });
    expect(items[1]).toMatchObject({ eventId: other, open: false, cancellation: false, nightPush: false });

    expect((await remove(account, eventId, 'OPEN')).statusCode).toBe(204);
    expect((await remove(account, eventId, 'OPEN')).statusCode).toBe(204);
    const after = JSON.parse((await list(account, `?eventIds=${eventId}`)).payload).items[0];
    expect(after).toMatchObject({ open: false, cancellation: true });
  });

  test('N-T17 ② 오픈이 지난 OPEN과 판매가 끝난 CANCELLATION은 410이다', async () => {
    const account = randomUUID();
    const openPast = seedEvent(repo, { openAt: new Date(NOW_MS - 1) }).eventId;
    const r1 = await post(account, openPast, { kind: 'OPEN' });
    expect(r1.statusCode).toBe(410);
    expect(JSON.parse(r1.payload).type).toMatch(/open-passed$/);

    const saleEnded = seedEvent(repo, { startsAt: new Date(NOW_MS + 23 * 60 * 60 * 1000) }).eventId;
    const r2 = await post(account, saleEnded, { kind: 'CANCELLATION' });
    expect(r2.statusCode).toBe(410);
    expect(JSON.parse(r2.payload).type).toMatch(/sale-ended$/);

    expect((await post(account, randomUUID(), { kind: 'OPEN' })).statusCode).toBe(404);
  });

  test('N-T17 ③ 끝난 취소표 신청은 다시 신청하면 ACTIVE·sentCount 0으로 돌아간다', async () => {
    const account = randomUUID();
    const { eventId } = seedEvent(repo);
    await post(account, eventId, { kind: 'CANCELLATION' });
    const row = [...store.subscriptions.values()].find((s) => s.accountId === account && s.eventId === eventId && s.kind === 'CANCELLATION')!;
    store.subscriptions.set(`${row.accountId}:${row.eventId}:${row.kind}`, { ...row, status: 'ENDED', endReason: 'SENT_MAX', sentCount: 5 });

    const r = await post(account, eventId, { kind: 'CANCELLATION', nightPush: true });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.payload)).toMatchObject({ cancellation: true, cancellationStatus: 'ACTIVE', endReason: null, sentCount: 0, nightPush: true });
  });

  test('N-T17 ④ 살아 있는 신청 200건을 넘으면 422, 목록은 최근 순 커서다', async () => {
    const account = randomUUID();
    for (let i = 0; i < 200; i++) {
      const eventId = randomUUID();
      store.subscriptions.set(`${account}:${eventId}:OPEN`, {
        id: randomUUID(), accountId: account, eventId, kind: 'OPEN', nightPush: false, sentCount: 0, status: 'ACTIVE', endReason: null,
        createdAt: new Date(NOW_MS + i), updatedAt: new Date(NOW_MS + i),
      });
    }
    const { eventId } = seedEvent(repo);
    const over = await post(account, eventId, { kind: 'OPEN' });
    expect(over.statusCode).toBe(422);
    expect(JSON.parse(over.payload).type).toMatch(/subscription-limit$/);

    const paged = await list(account, '?limit=2');
    expect(paged.statusCode).toBe(200);
    const body = JSON.parse(paged.payload);
    expect(body.items).toHaveLength(2);
    expect(body.nextCursor).toEqual(expect.any(String));
    const next = await list(account, `?limit=2&cursor=${encodeURIComponent(body.nextCursor)}`);
    expect(JSON.parse(next.payload).items[0].eventId).not.toBe(body.items[0].eventId);
  });
});

describe('N-T18 웹 푸시 구독', () => {
  test('N-T18 ① 같은 구독 주소는 지금 계정에 다시 묶고 해제는 이 계정 행만 지운다', async () => {
    const { p256dh, auth } = pushKeyPair();
    const body = { endpoint: 'https://fcm.googleapis.com/send/abc123', keys: { p256dh, auth }, expirationTime: null };
    const a = randomUUID();
    const b = randomUUID();
    const first = await registerPush(a, body);
    expect(first.statusCode).toBe(201);
    const key = JSON.parse(first.payload).subscriptionKey;
    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.parse(first.payload).service).toBe('FCM');

    const again = await registerPush(b, body);
    expect(again.statusCode).toBe(200);
    expect(JSON.parse(again.payload).subscriptionKey).toBe(key);
    expect([...store.push.values()].filter((p) => p.endpoint === body.endpoint)).toHaveLength(1);
    expect([...store.push.values()].find((p) => p.endpoint === body.endpoint)?.accountId).toBe(b);

    expect((await removePush(a, key)).statusCode).toBe(204);
    expect([...store.push.values()].some((p) => p.endpoint === body.endpoint)).toBe(true);
    expect((await removePush(b, key)).statusCode).toBe(204);
    expect([...store.push.values()].some((p) => p.endpoint === body.endpoint)).toBe(false);
  });

  test('N-T18 ② 주소·키·개수 한도를 검사한다 [ASVS v5.0.0-1.1.1] [ASVS v5.0.0-1.3.6] [ASVS v5.0.0-2.2.1]', async () => {
    const account = randomUUID();
    const { p256dh, auth } = pushKeyPair();
    const bad = [
      { endpoint: 'http://fcm.googleapis.com/send/a', keys: { p256dh, auth } },
      { endpoint: 'https://fcm.googleapis.com:8443/send/a', keys: { p256dh, auth } },
      { endpoint: 'https://not-allowed.example/send/a', keys: { p256dh, auth } },
      { endpoint: 'https://evil.fcm.googleapis.com/send/a', keys: { p256dh, auth } },
      { endpoint: 'https://fcm.googleapis.com/send/a', keys: { p256dh: 'AAAA', auth } },
      { endpoint: 'https://fcm.googleapis.com/send/a', keys: { p256dh, auth: 'AAAA' } },
    ];
    for (const body of bad) {
      const r = await registerPush(account, body);
      expect(r.statusCode, body.endpoint).toBe(422);
      expect(JSON.parse(r.payload).type).toMatch(/(push-service-not-allowed|push-key-invalid)$/);
    }
    // 허용 호스트가 사설 IP로 풀리면 받지 않는다
    const privateHost = await svc.http.inject({
      method: 'POST', url: '/v1/push-subscriptions', headers: headers(account),
      payload: JSON.stringify({ endpoint: 'https://private.push.apple.com/send/a', keys: { p256dh, auth } }),
    });
    expect(privateHost.statusCode).toBe(422);

    for (let i = 0; i < 10; i++) {
      const id = randomUUID();
      store.push.set(id, {
        id, accountId: account, endpoint: `https://fcm.googleapis.com/send/${i}`, endpointHash: 'x'.repeat(43), service: 'FCM',
        p256dh, auth, expiresAt: null, boundAt: new Date(NOW_MS - 10_000 + i), createdAt: new Date(NOW_MS - 10_000 + i),
      });
    }
    const oldest = [...store.push.values()].filter((p) => p.accountId === account).sort((x, y) => x.boundAt.getTime() - y.boundAt.getTime())[0];
    const fresh = await registerPush(account, { endpoint: 'https://fcm.googleapis.com/send/new', keys: { p256dh, auth } });
    expect(fresh.statusCode).toBe(201);
    expect([...store.push.values()].some((p) => p.id === oldest.id)).toBe(false);
    expect([...store.push.values()].filter((p) => p.accountId === account)).toHaveLength(10);

    // 다른 계정의 구독을 꽉 찬 계정에 다시 묶어도 10개 한도를 지킨다
    const full = randomUUID();
    const mover = randomUUID();
    const moving = { endpoint: 'https://fcm.googleapis.com/send/move', keys: { p256dh, auth } };
    expect((await registerPush(mover, moving)).statusCode).toBe(201);
    for (let i = 0; i < 10; i++) {
      const id = randomUUID();
      store.push.set(id, { id, accountId: full, endpoint: `https://fcm.googleapis.com/send/f${i}`, endpointHash: `f${i}`.padEnd(43, 'x'), service: 'FCM', p256dh, auth, expiresAt: null, boundAt: new Date(NOW_MS - 20_000 + i), createdAt: new Date(NOW_MS - 20_000 + i) });
    }
    expect((await registerPush(full, moving)).statusCode).toBe(200);
    expect([...store.push.values()].filter((p) => p.accountId === full)).toHaveLength(10);
  });
});

describe('N-T20 한 번 누름 수신 거부', () => {
  const optOut = (token: string) =>
    svc.http.inject({ method: 'POST', url: `/v1/subscription-opt-outs/${token}`, headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'List-Unsubscribe=One-Click' });

  test('N-T20 ① 토큰이 가리키는 신청 하나만 지우고 다시 보내도 같은 200이다 [ASVS v5.0.0-14.2.1] [ASVS v5.0.0-14.3.2]', async () => {
    const account = randomUUID();
    const { eventId } = seedEvent(repo);
    await post(account, eventId, { kind: 'CANCELLATION' });
    const row = [...store.subscriptions.values()].find((s) => s.accountId === account && s.eventId === eventId && s.kind === 'CANCELLATION')!;
    const token = optOutTokenFor(row.id, OPTOUT_KEY);

    expect((await optOut(token)).statusCode).toBe(200);
    expect([...store.subscriptions.values()].some((s) => s.id === row.id)).toBe(false);
    expect((await optOut(token)).statusCode).toBe(200);
  });

  test('N-T20 ② 위조 토큰·맞지 않는 HMAC은 200이지만 아무것도 지우지 않고 GET은 없다', async () => {
    const account = randomUUID();
    const { eventId } = seedEvent(repo);
    await post(account, eventId, { kind: 'OPEN' });
    const row = [...store.subscriptions.values()].find((s) => s.accountId === account && s.eventId === eventId && s.kind === 'OPEN')!;
    const good = optOutTokenFor(row.id, OPTOUT_KEY);
    const forged = `${good.slice(0, -2)}AA`;

    expect((await optOut(forged)).statusCode).toBe(200);
    expect((await optOut('not-a-token')).statusCode).toBe(200);
    expect([...store.subscriptions.values()].some((s) => s.id === row.id)).toBe(true);
    expect((await svc.http.inject({ method: 'GET', url: `/v1/subscription-opt-outs/${good}` })).statusCode).toBe(404);
  });
});
