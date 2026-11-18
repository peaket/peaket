// 입장 토큰 공개키 묶음을 한 번도 받지 못했을 때의 받는 층(Q-T69 ④, docs/features/seat-hold.md §2 '입장 토큰 공개키 묶음 주기 읽기'의 '한 번도 받지 못했을 때',
// ADR-0288 결정 7, BUILD_ORDER HOT-400·PRF-137 묶음 BAT-057 계획 §6 U10). AppModule을 메모리 조립으로 띄우고 공개키 묶음은 주기 읽기(AdmissionJwksLoader)에
// 이 시험의 대역 fetch를 넣는다. 정본 값: 503 dependency-unavailable, Retry-After 1초, 구매 세션을 열지 않는다(jti를 쓰지 않는다), 홀드 다시 읽기도 같다.
// '구매 세션을 열지 않음'은 저장소 open 호출이 없고 SESSION_STARTED가 없으며, 묶음을 받은 뒤 같은 입장 토큰이 새 세션으로 열리는 것(표지가 없었다)으로 본다.
import 'reflect-metadata';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { createService, fakeClock, PROBLEM_TYPE_BASE } from '@peaket/platform';
import { afterAll, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import {
  AdmissionJwksLoader,
  KEEP_AFTER_SALE_END_MS,
  ManageHolds,
  MemoryPurchaseSessionStore,
  MemorySeatMap,
  MemorySeatStore,
  RecordingHoldAttempts,
  RecordingSessionStartedLog,
  ServerEcdhKey,
  StoredPurchaseSessions,
} from '../src/modules/inventory/index.js';
import { claimsOf, ISS, newKey, signAdmission } from './admission-fixtures.js';
import { account, DAY, newEvent, SEAT_COUNT, SEAT_DEFS } from './hold-cases.js';
import { clientKeyOf } from './session-fixtures.js';

const NOW = Date.parse('2026-11-19T03:00:00.000Z');
const quiet = new Writable({ write: (_c, _e, cb) => cb() });
const clock = fakeClock({ now: NOW, monotonic: 50 });
const inner = new MemorySeatStore(clock);
const seatMap = new MemorySeatMap();
const mem = new MemoryPurchaseSessionStore(clock);
/** 저장소 open(구매 세션 표지 s:jti와 세션 상태를 쓰는 Lua)을 부른 jti */
const opened: string[] = [];
const store = new Proxy(mem, {
  get(t, p) {
    if (p === 'open') return (i: { jti: string }) => (opened.push(i.jti), t.open(i as Parameters<typeof t.open>[0]));
    const v = Reflect.get(t, p, t) as unknown;
    return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
  },
});
const startedLog = new RecordingSessionStartedLog();
const admissionKey = newKey('k1');
const serverPriv = (() => {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const j = privateKey.export({ format: 'jwk' }) as Record<string, string>;
  return new ServerEcdhKey({ kty: 'EC', crv: 'P-256', x: j.x!, y: j.y!, d: j.d!, kid: 'ecdh-1' });
})();
const sessions = new StoredPurchaseSessions({ store, ecdh: serverPriv, clock });

/** 대역 묶음 서버: 처음에는 500(묶음을 받지 못함), good이 참이면 정상 묶음 */
const server = { good: false, calls: 0 };
const fakeFetch = (async () => {
  server.calls++;
  if (!server.good) return new Response('{"type":"about:blank"}', { status: 500 });
  return new Response(JSON.stringify({ keys: [{ ...admissionKey.publicJwk, alg: 'ES256', use: 'sig' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
}) as typeof globalThis.fetch;
/** 띄운 조립(맨 끝에 닫는다). 읽개는 시험 안에서 만든다: 읽개가 없는 트리에서도 시험마다 실패로 보이게 */
const booted: { svc: Awaited<ReturnType<typeof createService>>; loader: AdmissionJwksLoader }[] = [];
async function boot(fetchImpl: typeof globalThis.fetch, holdsFor?: (loader: AdmissionJwksLoader) => ManageHolds) {
  const loader = new AdmissionJwksLoader({ url: 'http://queue-svc.queue.svc.cluster.local:8080/internal/jwks/admission.json', fetch: fetchImpl });
  await loader.start();
  const manageHolds = holdsFor?.(loader);
  const svc = await createService({
    name: 'purchase-svc',
    module: AppModule.register({ memory: true, store: inner, seatMap, attempts: new RecordingHoldAttempts(), sessions, admission: { store, startedLog, keys: loader, issuer: ISS, ...(manageHolds ? { manageHolds } : {}) } }),
    purchaseSessions: sessions,
    env: { PEAKET_ENV: 'ci' },
    clock,
    logDestination: quiet,
  });
  booted.push({ svc, loader });
  return { svc, loader };
}
afterAll(async () => {
  for (const o of booted) {
    await o.loader.stop();
    await o.svc.close();
  }
});

async function world() {
  const eventId = newEvent();
  seatMap.put({ eventId, layoutVersion: '3', seatCount: SEAT_COUNT, perAccountLimit: 4, saleEndsAtMs: NOW + DAY }, SEAT_DEFS);
  await inner.openSale({ eventId, seatCount: SEAT_COUNT, keepUntilMs: NOW + DAY + KEEP_AFTER_SALE_END_MS });
  const jti = randomUUID();
  const accountId = account(1);
  const login = `ls-${eventId}`;
  const token = signAdmission(admissionKey, claimsOf({ nowMs: clock.now(), jti, accountId, loginSessionId: login, eventId }));
  const identity = { 'x-user-id': accountId, 'x-session-id': login, 'x-user-aud': 'fan', 'x-user-scope': 'ticket:buy' };
  return { eventId, jti, token, identity, clientKey: clientKeyOf().text };
}
const problem = (slug: string) => `${PROBLEM_TYPE_BASE}${slug}`;

describe('Q-T69 ④ 공개키 묶음을 한 번도 받지 못했을 때', () => {
  test('Q-T69 ④ 스냅샷 첫 사용은 503 dependency-unavailable·Retry-After: 1이고 구매 세션을 열지 않는다(open 없음·SESSION_STARTED 없음). 묶음을 받은 뒤 같은 입장 토큰이 새로 열린다', async () => {
    const { svc, loader } = await boot(fakeFetch);
    const w = await world();
    expect(loader.keys(), '받은 적 없음').toBeUndefined();
    const r = await svc.http.inject({ method: 'GET', url: `/v1/events/${w.eventId}/seatmap-snapshot`, headers: { ...w.identity, 'x-admission-token': w.token, 'x-client-ephemeral-key': w.clientKey } });
    expect(r.statusCode).toBe(503);
    expect(String(r.headers['content-type'])).toMatch(/^application\/problem\+json\b/);
    expect(JSON.parse(r.payload).type).toBe(problem('dependency-unavailable'));
    expect(r.headers['retry-after']).toBe('1');
    expect(opened, '저장소 open을 불렀다(jti를 썼다)').not.toContain(w.jti);
    expect(await mem.read(w.jti)).toBeUndefined();
    expect(startedLog.entries.filter((e) => e.purchaseSessionId === w.jti)).toEqual([]);
    expect(server.calls, '대역 서버가 실제로 실패를 냈다').toBeGreaterThanOrEqual(1);

    // 묶음을 받으면(받기 전에는 1초마다 다시 읽는다) 같은 토큰이 새 세션으로 열린다: 503 동안 표지가 없었다
    server.good = true;
    const until = Date.now() + 5_000;
    while (loader.keys() === undefined && Date.now() < until) await new Promise((res) => setTimeout(res, 50));
    expect(loader.keys(), '5초 안에 묶음을 받지 못했다').toBeDefined();
    const again = await svc.http.inject({ method: 'GET', url: `/v1/events/${w.eventId}/seatmap-snapshot`, headers: { ...w.identity, 'x-admission-token': w.token, 'x-client-ephemeral-key': w.clientKey } });
    expect(again.statusCode).toBe(200);
    expect(await mem.read(w.jti)).toMatchObject({ accountId: w.identity['x-user-id'], eventId: w.eventId });
    expect(startedLog.entries.filter((e) => e.purchaseSessionId === w.jti).length, '새로 열렸다(CREATED)').toBe(1);
    server.good = false;
  });
});

describe('Q-T69 ④ 홀드 다시 읽기(GET /v1/holds/{holdId})', () => {
  /** 홀드 Lua·세션 읽기를 부른 기록(503이면 부르지 않는다) */
  const reached: string[] = [];
  /** 받은 적 없는 새 읽개(대역은 늘 500)를 공개키 묶음으로 쓰는 홀드 다시 읽기 쓰임새(시작 파일과 같은 조립) */
  const holdsWith = (loader: AdmissionJwksLoader) =>
    new ManageHolds({
      lifecycle: {
        read: async () => (reached.push('lua read'), { kind: 'NOT_FOUND' }),
        release: async () => (reached.push('lua release'), { kind: 'NOT_FOUND' }),
        extend: async () => (reached.push('lua extend'), { kind: 'NOT_FOUND' }),
        markOrdered: async () => (reached.push('lua mark'), { kind: 'OK', added: 0 }),
      } as never,
      seatMap,
      sessions: {
        read: async () => (reached.push('session read'), undefined),
        heldSeats: async () => (reached.push('held seats'), null),
        sessionHolds: async () => [],
        forgetHold: async () => undefined,
      } as never,
      keys: loader,
      issuer: ISS,
      clock,
    });

  test('Q-T69 ④ 받은 적이 없으면 홀드 다시 읽기도 503 dependency-unavailable·Retry-After: 1이다', async () => {
    const { svc: svc2 } = await boot((async () => new Response('{}', { status: 500 })) as typeof globalThis.fetch, holdsWith);
    const w = await world();
    const r = await svc2.http.inject({ method: 'GET', url: `/v1/holds/${randomUUID()}`, headers: { ...w.identity, 'x-admission-token': w.token } });
    expect(r.statusCode).toBe(503);
    expect(JSON.parse(r.payload).type).toBe(problem('dependency-unavailable'));
    expect(r.headers['retry-after']).toBe('1');
    expect(opened).not.toContain(w.jti);
    expect(reached, '503인데 세션·홀드를 읽었다').toEqual([]);
  });
});
