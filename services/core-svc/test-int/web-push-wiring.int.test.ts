// 웹 푸시 구독·로그아웃 차례 실제 서버 연결 시험(BUILD_ORDER GAT-040, F-05-1 계획 §8, docs/architecture.md §8.6 4의 4,
// docs/frontend.md §6 FE-T47·FE-T48·FE-T43 서버 쪽, docs/features/notify.md §3.4·§4.7, docs/features/offline-gate.md §11 O-T48 core 쪽).
// 가짜 API로 끝내지 않는다: 웹의 화면 흐름 모듈(apps/web features/web-push/flow.ts·features/session-cleanup/routine.ts)을 동적으로 가져와
// 로컬 게이트웨이 대역(apps/web/scripts/local-fan-gateway.mjs, coreUrl) → 실제 core-svc HTTP 앱(알림 저장소는 실제 DrizzleFanNotifyStore)
// → 실제 PostgreSQL 18(core 마이그레이션)로 잇는다. 입장 키 알림 내부 입구도 같은 앱에 보내 작업 행 수를 DB에서 센다.
// - 실제가 아닌 것: 브라우저의 푸시 서비스(고정 구독을 주는 PushManager 대역), 메일·푸시 대행사(Fake*Transport), 수신자 찾기(메모리),
//   서버 로그아웃(앱 서버 POST /logout 대역: 차례만 기록), DNS 찾기(공개 주소를 준다).
import 'reflect-metadata';
import { createECDH, createHash, generateKeyPairSync, randomBytes, randomUUID, sign as signBytes } from 'node:crypto';
import { Writable } from 'node:stream';
import { createDatabase, createService, type Database, ensureMonthlyPartitions, fakeClock, systemClock } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migrateCore } from '../scripts/migrate.mjs';
import { AppModule } from '../src/app.module.js';
import { DrizzleFanNotifyStore, FakeMailTransport, FakePushTransport, MemoryRecipientDirectory, type FanNotifyWiring } from '../src/modules/notify/index.js';
import { FakeIdentity } from '../test/support.js';
import { OPTOUT_KEY, vapidKeys } from '../test/fan-notify-support.js';
import { type PostgresContainer, startPostgres } from './postgres.js';

const web = (p: string) => new URL(`../../../apps/web/${p}`, import.meta.url).href;
const ISS = 'https://identity.f051-push.test';
const WEB_ORIGIN = 'http://localhost:3000';
const INTERNAL_TOKEN = 'f051-push-wiring-internal';
const ACCOUNT_A = randomUUID();
const ACCOUNT_B = randomUUID();
const quiet = () => new Writable({ write: (_c, _e, cb) => cb() });

// 화면 흐름 모듈의 바깥 모양
interface WebPush {
  enable(): Promise<{ kind: string; status?: number; reason?: string }>;
  rebind(): Promise<{ kind: string }>;
  unbind(): Promise<{ kind: string; status?: number }>;
}
interface WebFlow {
  createWebPush(d: Record<string, unknown>): WebPush;
  runLogoutCleanup(d: Record<string, unknown>, o: { wallet: boolean; server: boolean }): Promise<{ push: string; server: string }>;
}

let pg: PostgresContainer;
let admin: Database;
let svc: Awaited<ReturnType<typeof createService>>;
let gateway: { url: string; close(): Promise<void> };
let flow: WebFlow;
let sign: (sub: string) => Promise<string>;
const recipients = new MemoryRecipientDirectory();

/** 이 '브라우저'의 고정 푸시 구독(푸시 서비스 대역). 구독 주소는 허용한 푸시 서비스 호스트 */
const ENDPOINT = `https://fcm.googleapis.com/fcm/send/f051-wiring-${randomBytes(6).toString('hex')}`;
const SUB_KEYS = (() => {
  const e = createECDH('prime256v1');
  e.generateKeys();
  return { p256dh: e.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') };
})();
const VAPID = vapidKeys();

/** serviceWorker·PushManager 대역(브라우저의 등록·구독) */
function browserPush() {
  const sub = { endpoint: ENDPOINT, toJSON: () => ({ endpoint: ENDPOINT, expirationTime: null, keys: SUB_KEYS }) };
  let current: typeof sub | null = null;
  const pushManager = { getSubscription: async () => current, subscribe: async () => ((current = sub), sub) };
  let reg: { active: { state: string }; pushManager: typeof pushManager } | undefined;
  return {
    serviceWorker: {
      register: async () => (reg = { active: { state: 'activated' }, pushManager }),
      getRegistration: async (scope: string) => (scope === '/push/' ? reg : undefined),
    },
  };
}

/** 그 계정의 팬 쿠키를 실은 브라우저 fetch. log에 나간 차례를 남긴다 */
const fanFetch = (cookie: string, log: string[]): typeof fetch => (input, init = {}) => {
  const headers = new Headers(init.headers);
  headers.set('cookie', `__Secure-peaket_at=${cookie}`);
  headers.set('origin', WEB_ORIGIN);
  const { cache: _c, credentials: _cr, ...rest } = init;
  log.push(`${rest.method ?? 'GET'} ${new URL(String(input)).pathname}`);
  return fetch(input, { ...rest, headers });
};

const pushRows = async () => (await admin.pool.query('select account_id, endpoint_hash from push_subscription where endpoint = $1', [ENDPOINT])).rows as { account_id: string; endpoint_hash: string }[];
const jobCount = async (ticketId: string, channel?: string) =>
  ((await admin.pool.query(`select count(*)::int as n from notification_job where target_id = $1${channel ? ' and channel = $2' : ''}`, channel ? [ticketId, channel] : [ticketId])).rows[0] as { n: number }).n;
const ticketEvent = (accountId: string, ticketId: string, noticeId = randomUUID()) =>
  svc.http.inject({
    method: 'POST',
    url: '/internal/v1/notify/ticket-events',
    headers: { 'content-type': 'application/json', 'x-peaket-internal-token': INTERNAL_TOKEN },
    payload: JSON.stringify({ noticeId, type: 'DEVICE_KEY_REISSUED', accountId, ticketId, registeredAtMs: Date.parse('2026-11-23T09:00:00.000Z') }),
  });

beforeAll(async () => {
  pg = await startPostgres();
  await migrateCore(pg.url);
  admin = createDatabase({ url: pg.url, applicationName: 'core-svc-web-push-wiring-int', max: 6 });
  await ensureMonthlyPartitions(admin, systemClock, { table: 'notification_delivery', key: 'timestamptz' });
  for (const a of [ACCOUNT_A, ACCOUNT_B]) recipients.rows.set(a, { accountId: a, status: 'ACTIVE', verified: true, locale: 'ko', email: `${a.slice(0, 8)}@example.com` });
  const wiring: FanNotifyWiring = {
    store: new DrizzleFanNotifyStore(admin),
    mail: new FakeMailTransport(),
    push: new FakePushTransport(),
    recipients,
    optOutKey: OPTOUT_KEY,
    vapid: VAPID,
    lookup: async () => [{ address: '142.250.196.110', family: 4 }],
  };
  svc = await createService({
    name: 'core-svc',
    module: AppModule.register({ memory: true, notify: { fanNotify: wiring, env: { PEAKET_ENV: 'ci', PEAKET_INTERNAL_TOKEN: INTERNAL_TOKEN } } }),
    env: { PEAKET_ENV: 'ci', PORT: '0', PEAKET_MANAGEMENT_PORT: '0' },
    clock: fakeClock({ now: Date.parse('2026-11-23T09:00:05.000Z') }),
    logDestination: quiet(),
    adminAuthz: new FakeIdentity(),
  });
  const { port } = await svc.listen('127.0.0.1');

  // 팬 액세스 토큰(ES256, typ at+jwt). 게이트웨이 대역이 이 공개키로 검증해 신원 머리를 싣는다
  const access = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pub = access.publicKey.export({ format: 'jwk' }) as Record<string, string>;
  const accessJwk = { kty: 'EC', crv: 'P-256', x: pub.x, y: pub.y, kid: 'at-push', alg: 'ES256', use: 'sig' };
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
  sign = async (sub) => {
    const nowS = Math.floor(Date.now() / 1000);
    const head = b64({ alg: 'ES256', typ: 'at+jwt', kid: 'at-push' });
    const body = b64({ iss: ISS, aud: 'fan', sub, sid: randomUUID(), scope: 'openid', iat: nowS, exp: nowS + 3600 });
    return `${head}.${body}.${signBytes('sha256', Buffer.from(`${head}.${body}`), { key: access.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
  };
  const { startLocalFanGateway } = (await import(/* @vite-ignore */ web('scripts/local-fan-gateway.mjs'))) as { startLocalFanGateway(o: Record<string, unknown>): Promise<{ url: string; close(): Promise<void> }> };
  gateway = await startLocalFanGateway({ port: 0, identityUrl: 'http://127.0.0.1:9', webOrigin: WEB_ORIGIN, jwks: { keys: [accessJwk] }, issuer: ISS, env: { PEAKET_ENV: 'ci' }, coreUrl: `http://127.0.0.1:${port}` });
  const push = await import(/* @vite-ignore */ web('src/features/web-push/flow.ts'));
  const cleanup = await import(/* @vite-ignore */ web('src/features/session-cleanup/routine.ts'));
  // type-escape: 웹 모듈은 /* @vite-ignore */ 동적 가져오기라 타입이 없다. 쓰는 함수의 바깥 모양만 WebFlow로 적었다(F-05-1 계획 §5)
  flow = { ...push, ...cleanup } as unknown as WebFlow;
}, 240_000);

afterAll(async () => {
  await gateway?.close().catch(() => {});
  await svc?.close().catch(() => {});
  await admin?.close().catch(() => {});
  pg?.stop();
});

describe('웹 푸시 구독·로그아웃 연결 [GAT-040]', () => {
  test('FE-T48 연결 구독 등록 201 → 다른 계정 다시 묶기 200 → 정리 루틴의 DELETE 204가 서버 로그아웃보다 먼저이고 구독 행이 없다', async () => {
    const browser = browserPush();
    const logA: string[] = [];
    const pushA = flow.createWebPush({ origin: gateway.url, fetch: fanFetch(await sign(ACCOUNT_A), logA), serviceWorker: browser.serviceWorker, vapidKey: VAPID.publicKey, permission: () => 'default', requestPermission: async () => 'granted', pushSupported: true });
    expect(await pushA.enable()).toEqual({ kind: 'subscribed', status: 201 });
    expect(logA).toEqual(['POST /v1/push-subscriptions']);
    const key = createHash('sha256').update(ENDPOINT).digest('base64url');
    expect(await pushRows()).toEqual([{ account_id: ACCOUNT_A, endpoint_hash: key }]);

    // 같은 브라우저에 계정 B가 로그인: 권한이 이미 허용이라 묻지 않고 지금 계정으로 다시 묶는다(200)
    const logB: string[] = [];
    let asked = 0;
    const pushB = flow.createWebPush({ origin: gateway.url, fetch: fanFetch(await sign(ACCOUNT_B), logB), serviceWorker: browser.serviceWorker, vapidKey: VAPID.publicKey, permission: () => 'granted', requestPermission: async () => (asked++, 'granted'), pushSupported: true });
    expect(await pushB.rebind()).toMatchObject({ kind: 'bound' });
    expect(asked).toBe(0);
    expect(await pushRows()).toEqual([{ account_id: ACCOUNT_B, endpoint_hash: key }]);

    // O-T48 core 쪽: 계정 B의 입장 키 알림은 이메일 하나와 B의 구독 하나(실제 DB, 같은 noticeId 두 번이어도 작업 둘)
    const ticketId = randomUUID();
    const noticeId = randomUUID();
    expect((await ticketEvent(ACCOUNT_B, ticketId, noticeId)).statusCode).toBe(202);
    expect((await ticketEvent(ACCOUNT_B, ticketId, noticeId)).statusCode).toBe(202);
    expect([await jobCount(ticketId), await jobCount(ticketId, 'EMAIL'), await jobCount(ticketId, 'WEB_PUSH')]).toEqual([2, 1, 1]);

    // 로그아웃 정리 루틴: 웹 푸시 해제 DELETE → 저장물 → 다른 탭 → 서버 로그아웃(앱 서버 대역)
    const order: string[] = [];
    const r = await flow.runLogoutCleanup(
      {
        local: null,
        session: null,
        idb: null,
        caches: null,
        serviceWorker: null,
        pushUnbind: async () => {
          const out = await pushB.unbind();
          order.push(`push:${out.kind}:${out.status}`);
          return out;
        },
        broadcast: () => order.push('broadcast'),
        fetch: async (url: string, init: RequestInit) => {
          order.push(`${init.method} ${url}`);
          return { type: 'opaqueredirect', status: 0, ok: false };
        },
      },
      { wallet: false, server: true },
    );
    expect(r).toEqual({ push: 'done', server: 'ok' });
    expect(order).toEqual(['push:deleted:204', 'broadcast', 'POST /logout']);
    expect(logB.at(-1)).toBe(`DELETE /v1/push-subscriptions/${key}`);
    expect(await pushRows()).toEqual([]);

    // 구독이 사라진 뒤의 알림은 이메일 하나뿐이다
    const after = randomUUID();
    expect((await ticketEvent(ACCOUNT_B, after)).statusCode).toBe(202);
    expect([await jobCount(after, 'EMAIL'), await jobCount(after, 'WEB_PUSH')]).toEqual([1, 0]);
  });

  test('FE-T48 연결 다른 계정의 구독 키로는 해제되지 않는다(계정 대조)', async () => {
    const browser = browserPush();
    const pushA = flow.createWebPush({ origin: gateway.url, fetch: fanFetch(await sign(ACCOUNT_A), []), serviceWorker: browser.serviceWorker, vapidKey: VAPID.publicKey, permission: () => 'granted', requestPermission: async () => 'granted', pushSupported: true });
    expect((await pushA.enable()).kind).toBe('subscribed');
    const pushB = flow.createWebPush({ origin: gateway.url, fetch: fanFetch(await sign(ACCOUNT_B), []), serviceWorker: browser.serviceWorker, vapidKey: VAPID.publicKey, permission: () => 'granted', pushSupported: true });
    await pushB.unbind();
    expect((await pushRows()).map((x) => x.account_id)).toEqual([ACCOUNT_A]);
    expect((await pushA.unbind()).kind).toBe('deleted');
    expect(await pushRows()).toEqual([]);
  });
});
