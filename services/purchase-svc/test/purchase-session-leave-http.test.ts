// 받는 층: 구매 세션 나가기 DELETE /v1/events/{eventId}/purchase-session(PurchaseSessionController, docs/features/seat-hold.md §2 '구매 세션 종료와 정리'의 '구매 화면을 나갈 때(LEFT)',
// BUILD_ORDER PRF-138, 상태 기계 T9·T11, Q-T11, S-T33 ⑥, ASVS 8.2.1·8.2.2). AppModule을 메모리 조립으로 띄워 fastify inject로 부른다.
// 실제 구매 세션 저장소(StoredPurchaseSessions)와 열기 유스케이스(OpenPurchaseSession)로 입장 토큰을 서명해 열고, 클라이언트 임시 키로 요청 인증 키를 따로 계산해 요청에 서명한다.
import 'reflect-metadata';
import { createPublicKey, diffieHellman, generateKeyPairSync, randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { createService, fakeClock, PROBLEM_TYPE_BASE, purchaseMac, purchaseMacInput, purchaseRequestKey } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import {
  KEEP_AFTER_SALE_END_MS,
  MemoryPurchaseSessionStore,
  MemorySeatMap,
  MemorySeatStore,
  OpenPurchaseSession,
  type PurchaseSessionStore,
  RecordingHoldAttempts,
  RecordingSessionStartedLog,
  type SeatSignals,
  SeatStoreUnavailable,
  ServerEcdhKey,
  type SessionEndReason,
  StoredPurchaseSessions,
} from '../src/modules/inventory/index.js';
import { claimsOf, ISS, newKey, signAdmission } from './admission-fixtures.js';
import { account, DAY, newEvent, SEAT_COUNT, SEAT_DEFS } from './hold-cases.js';
import { clientKeyOf } from './session-fixtures.js';

const NOW = Date.parse('2026-11-04T03:00:00.000Z');
/** 서비스 로그(한 줄에 JSON 하나). 입장 토큰·jti가 로그에 남지 않는지 본다(ASVS 16.2.5) */
const logs: string[] = [];
const quiet = new Writable({
  write: (c, _e, cb) => {
    logs.push(String(c));
    cb();
  },
});
const clock = fakeClock({ now: NOW, monotonic: 50 });
const inner = new MemorySeatStore(clock);
const seatMap = new MemorySeatMap();
const attempts = new RecordingHoldAttempts();
const mem = new MemoryPurchaseSessionStore(clock);
/** SESSION_STARTED·SESSION_ENDED를 더하는 길과 정리 색인을 한 객체가 맡는다 */
const log = new RecordingSessionStartedLog();
const admissionKey = newKey('k1');
/** 끝낸 까닭 지표(purchase_sessions_ended_total{reason}) */
const endedMetric: SessionEndReason[] = [];
const signals: SeatSignals = { luaError: () => undefined, sessionEnded: (r) => void endedMetric.push(r) };

const serverPriv = (() => {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const j = privateKey.export({ format: 'jwk' }) as Record<string, string>;
  return new ServerEcdhKey({ kty: 'EC', crv: 'P-256', x: j.x!, y: j.y!, d: j.d!, kid: 'ecdh-1' });
})();
const serverPub = createPublicKey({ key: serverPriv.publicJwk(), format: 'jwk' });
/** 좌석 Redis 장애를 끼우는 얇은 겉: end가 던지게 한다(나머지는 메모리 저장소 그대로) */
const faults: { end?: unknown } = {};
const store: PurchaseSessionStore = {
  open: (i) => mem.open(i),
  read: (jti) => mem.read(jti),
  advance: (jti, seq) => mem.advance(jti, seq),
  markStarted: (jti) => mem.markStarted(jti),
  recordHold: (jti, holdId, seatIds, o) => mem.recordHold(jti, holdId, seatIds, o),
  end: async (jti, o) => {
    if (faults.end !== undefined) throw faults.end;
    return mem.end(jti, o);
  },
  sweep: (jti, o) => mem.sweep(jti, o),
  setPaying: (jti, paying, o) => mem.setPaying(jti, paying, o),
};
const sessions = new StoredPurchaseSessions({ store, ecdh: serverPriv, clock });
const keys = new Map([['k1', admissionKey.pub]]);
const opener = new OpenPurchaseSession({ store, log, keys, issuer: ISS, clock });

let svc: Awaited<ReturnType<typeof createService>>;
beforeAll(async () => {
  svc = await createService({
    name: 'purchase-svc',
    module: AppModule.register({
      memory: true,
      store: inner,
      seatMap,
      attempts,
      sessions,
      signals,
      admission: { store, startedLog: log, endedLog: log, index: log, keys, issuer: ISS },
    }),
    purchaseSessions: sessions,
    env: { PEAKET_ENV: 'ci' },
    clock,
    logDestination: quiet,
  });
});
afterAll(async () => {
  await svc?.close();
});

interface Fan {
  accountId: string;
  login: string;
  jti: string;
  token: string;
  clientKey: string;
  macKey: Buffer;
}

/** 회차 하나(좌석맵 판·판매 열기)와, 그 회차에서 입장 토큰으로 구매 세션을 연 팬을 만드는 함수 */
async function world() {
  const eventId = newEvent();
  seatMap.put({ eventId, layoutVersion: '3', seatCount: SEAT_COUNT, perAccountLimit: 4, saleEndsAtMs: NOW + DAY }, SEAT_DEFS);
  await inner.openSale({ eventId, seatCount: SEAT_COUNT, keepUntilMs: NOW + DAY + KEEP_AFTER_SALE_END_MS });
  const fan = async (k: number): Promise<Fan> => {
    const jti = randomUUID();
    const accountId = account(k);
    const login = `ls-${eventId}-${k}`;
    const token = signAdmission(admissionKey, claimsOf({ nowMs: clock.now(), jti, accountId, loginSessionId: login, eventId }));
    const client = clientKeyOf();
    await opener.execute({ token, accountId, loginSessionId: login, eventId, clientKey: client.text });
    const macKey = Buffer.from(purchaseRequestKey(diffieHellman({ privateKey: client.privateKey, publicKey: serverPub }), jti));
    return { accountId, login, jti, token, clientKey: client.text, macKey };
  };
  return { eventId, fan, ev: () => inner.db.event(eventId) };
}

const identity = (f: Fan, aud = 'fan', login = f.login): Record<string, string> => ({ 'x-user-id': f.accountId, 'x-session-id': login, 'x-user-aud': aud, 'x-user-scope': 'ticket:buy' });

let seq = 0;
/** 나가기 DELETE(본문 없음). 서명은 이 주소에 대한 것이다 */
function leave(
  eventId: string,
  f: Fan,
  o: { urlEvent?: string; macKey?: Buffer; token?: string | null; login?: string; seq?: number; sign?: boolean; aud?: string } = {},
) {
  const url = `/v1/events/${o.urlEvent ?? eventId}/purchase-session`;
  const n = o.seq ?? ++seq;
  const headers: Record<string, string> = identity(f, o.aud, o.login);
  if (o.sign !== false) {
    headers['x-purchase-seq'] = String(n);
    headers['x-purchase-mac'] = purchaseMac(o.macKey ?? f.macKey, purchaseMacInput('DELETE', url, n, Buffer.alloc(0)));
  }
  if (o.token !== null) headers['x-admission-token'] = o.token ?? f.token;
  return svc.http.inject({ method: 'DELETE', url, headers });
}

function postHold(eventId: string, f: Fan, seatIds: string[]) {
  const url = `/v1/events/${eventId}/holds`;
  const payload = JSON.stringify({ seatIds });
  const n = ++seq;
  return svc.http.inject({
    method: 'POST',
    url,
    headers: {
      ...identity(f),
      'content-type': 'application/json',
      'idempotency-key': randomUUID(),
      'x-admission-token': f.token,
      'x-purchase-seq': String(n),
      'x-purchase-mac': purchaseMac(f.macKey, purchaseMacInput('POST', url, n, Buffer.from(payload, 'utf8'))),
    },
    payload,
  });
}

/** 스냅샷 GET(구매 세션 서명 없이 입장 토큰과 임시 공개키) */
function snapshot(eventId: string, f: Fan) {
  return svc.http.inject({ method: 'GET', url: `/v1/events/${eventId}/seatmap-snapshot`, headers: { ...identity(f), 'x-admission-token': f.token, 'x-client-ephemeral-key': f.clientKey } });
}

const json = (r: { payload: string }) => JSON.parse(r.payload) as Record<string, unknown>;
const problem = (slug: string) => `${PROBLEM_TYPE_BASE}${slug}`;
const endedFor = (jti: string) => log.endedEntries.filter((e) => e.purchaseSessionId === jti);
const startedFor = (jti: string) => log.entries.filter((e) => e.purchaseSessionId === jti);
const inIndex = (eventId: string, jti: string) => log.index.get(eventId)?.has(jti) ?? false;

describe('DELETE /v1/events/{eventId}/purchase-session: 나가기(LEFT)', () => {
  test('QT11_ST33_ASVS8.2.1_ 서명한 나가기는 204·no-store·빈 본문이고 구매 세션이 끝난다(상태 지워짐·SESSION_ENDED(LEFT) 한 건·정리 색인에서 빠짐·지표 한 번). 다른 팬의 세션은 그대로다 [ASVS v5.0.0-8.2.1]', async () => {
    const w = await world();
    const f = await w.fan(1);
    const other = await w.fan(2);
    endedMetric.length = 0;
    clock.advance(1500);
    const r = await leave(w.eventId, f);
    expect(r.statusCode).toBe(204);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.payload).toBe('');
    expect(await mem.read(f.jti)).toBeUndefined();
    expect(endedFor(f.jti)).toEqual([{ eventId: w.eventId, purchaseSessionId: f.jti, admissionJti: f.jti, reason: 'LEFT', endedAtMs: clock.now() }]);
    expect(inIndex(w.eventId, f.jti)).toBe(false);
    expect(endedMetric).toEqual(['LEFT']);
    // 다른 팬의 세션은 그대로
    expect(await mem.read(other.jti)).toMatchObject({ sessionId: other.jti, eventId: w.eventId });
    expect(endedFor(other.jti)).toEqual([]);
    expect((await leave(w.eventId, other)).statusCode).toBe(204);
  });

  test('QT11_ST33_ 이미 끝난 세션의 나가기(새 일련번호로 다시 보냄·같은 일련번호 재전송)는 구매 세션 확인에서 401이고 SESSION_ENDED는 늘지 않는다', async () => {
    const w = await world();
    const f = await w.fan(3);
    expect((await leave(w.eventId, f, { seq: 10 })).statusCode).toBe(204);
    endedMetric.length = 0;
    expect((await leave(w.eventId, f)).statusCode).toBe(401);
    expect((await leave(w.eventId, f, { seq: 10 })).statusCode).toBe(401);
    expect(endedFor(f.jti)).toHaveLength(1);
    expect(endedMetric).toEqual([]);
  });

  test('QT11_ST33_ASVS9.1.1_ 서명 머리가 없거나 다른 키로 서명했거나 입장 토큰 머리가 없으면 401이고 세션은 그대로이며 일련번호도 올리지 않는다 [ASVS v5.0.0-9.1.1]', async () => {
    const w = await world();
    const f = await w.fan(4);
    const rs = {
      unsigned: await leave(w.eventId, f, { sign: false }),
      wrongKey: await leave(w.eventId, f, { macKey: Buffer.alloc(32, 3), seq: 4 }),
      noToken: await leave(w.eventId, f, { token: null }),
    };
    for (const [what, r] of Object.entries(rs)) expect({ what, status: r.statusCode }).toEqual({ what, status: 401 });
    expect(await mem.read(f.jti)).toMatchObject({ sessionId: f.jti, lastSeq: 0 });
    expect(endedFor(f.jti)).toEqual([]);
  });

  test('QT11_ST33_ASVS8.2.1_ 남의 입장 토큰·다른 로그인 세션의 신원으로는 나가기가 401이고 그 세션을 끝내지 못한다 [ASVS v5.0.0-8.2.1]', async () => {
    const w = await world();
    const f = await w.fan(5);
    const stranger = await w.fan(6);
    const stolen = await leave(w.eventId, f, { token: stranger.token, macKey: stranger.macKey });
    const otherLogin = await leave(w.eventId, f, { login: 'ls-other' });
    expect(stolen.statusCode).toBe(401);
    expect(otherLogin.statusCode).toBe(401);
    expect(await mem.read(f.jti)).toBeDefined();
    expect(await mem.read(stranger.jti)).toBeDefined();
    expect(log.endedEntries.filter((e) => e.purchaseSessionId === f.jti || e.purchaseSessionId === stranger.jti)).toEqual([]);
  });

  test('QT11_ST33_ASVS8.2.2_ 구매 세션의 회차와 주소의 회차가 다르면 403·no-store이고 세션은 그대로이며 사건도 지표도 없다. 맞는 주소로 다시 보내면 204다 [ASVS v5.0.0-8.2.2]', async () => {
    const a = await world();
    const b = await world();
    const f = await a.fan(7);
    endedMetric.length = 0;
    // 이 팬의 구매 세션은 회차 A용이다. 회차 B 주소로 서명해(이 주소에 대한 서명은 맞다) 보낸다
    const r = await leave(a.eventId, f, { urlEvent: b.eventId });
    expect(r.statusCode).toBe(403);
    expect(json(r)).toMatchObject({ type: 'about:blank', status: 403 });
    expect(r.headers['cache-control']).toBe('no-store');
    expect(await mem.read(f.jti)).toMatchObject({ sessionId: f.jti, eventId: a.eventId });
    expect(endedFor(f.jti)).toEqual([]);
    expect(endedMetric).toEqual([]);
    expect((await leave(a.eventId, f)).statusCode).toBe(204);
    expect(await mem.read(f.jti)).toBeUndefined();
  });

  test.each([
    ['unavailable', undefined],
    ['oom', 'oom'],
  ] as const)(
    'QT11_NFR015_ST33_좌석 Redis 장애(%s)로 세션을 끝내지 못하면 503 seat-store-unavailable·Retry-After 2·no-store이고 세션은 그대로이며 사건도 지표도 없다. 장애가 풀리면 같은 요청이 204다 [ASVS v5.0.0-16.3.4]',
    async (_what, reason) => {
      const w = await world();
      const f = await w.fan(8);
      endedMetric.length = 0;
      faults.end = new SeatStoreUnavailable(new Error('OOM command not allowed'), reason);
      try {
        const r = await leave(w.eventId, f);
        expect(r.statusCode).toBe(503);
        expect(r.headers['retry-after']).toBe('2');
        expect(r.headers['content-type']).toMatch(/^application\/problem\+json/);
        expect(r.headers['cache-control']).toBe('no-store');
        expect(json(r)).toMatchObject({ type: problem('seat-store-unavailable'), status: 503 });
        expect(r.payload).not.toMatch(/oom|maxmemory|reason/i);
        expect(await mem.read(f.jti)).toBeDefined();
        expect(endedFor(f.jti)).toEqual([]);
        expect(endedMetric).toEqual([]);
      } finally {
        faults.end = undefined;
      }
      expect((await leave(w.eventId, f)).statusCode).toBe(204);
      expect(endedFor(f.jti)).toHaveLength(1);
    },
  );

  test('QT11_ST33_ASVS8.1.1_ 팬이 아닌 역할(ops·partner·scanner)의 신원은 이 팬 경로를 못 쓴다: 플랫폼 가드가 401로 거절하고 세션은 그대로다 [ASVS v5.0.0-8.1.1]', async () => {
    const w = await world();
    const f = await w.fan(9);
    for (const aud of ['ops', 'partner', 'scanner']) {
      const r = await leave(w.eventId, f, { aud });
      expect({ aud, status: r.statusCode }).toEqual({ aud, status: 401 });
    }
    expect(await mem.read(f.jti)).toBeDefined();
    expect(endedFor(f.jti)).toEqual([]);
  });

  test('QT11_ASVS16.2.5_ 나가기를 처리해도 서비스 로그에 입장 토큰·구매 세션 ID가 남지 않는다 [ASVS v5.0.0-16.2.5]', async () => {
    const w = await world();
    const f = await w.fan(10);
    logs.length = 0;
    expect((await leave(w.eventId, f)).statusCode).toBe(204);
    const text = logs.join('');
    for (const secret of [f.token, f.jti, f.clientKey]) expect(text.includes(secret)).toBe(false);
  });
});

describe('나간 뒤: 같은 입장 토큰으로 새 구매 세션을 열 수 없다(S-T33 ⑥, Q-T11)', () => {
  test('QT11_ST33_ 끝난 뒤 같은 입장 토큰으로 스냅샷을 다시 요청하면 401(TOKEN_USED, 재사용 차단 표지가 남아 ENDED)이고 새 세션이 열리지 않으며 SESSION_STARTED도 늘지 않는다 [ASVS v5.0.0-8.2.1]', async () => {
    const w = await world();
    const f = await w.fan(11);
    expect(startedFor(f.jti)).toHaveLength(1);
    expect((await leave(w.eventId, f)).statusCode).toBe(204);
    const r = await snapshot(w.eventId, f);
    expect(r.statusCode).toBe(401);
    expect(r.headers['www-authenticate']).toBe('Cookie realm="peaket"');
    expect(json(r)).toMatchObject({ type: 'about:blank', status: 401 });
    expect(await mem.read(f.jti)).toBeUndefined();
    expect(startedFor(f.jti)).toHaveLength(1);
    expect(endedFor(f.jti)).toHaveLength(1);
  });

  test('QT11_ST33_ 끝난 세션으로는 홀드도 못 잡는다: 서명이 맞아도 구매 세션이 없어 401이고 그 회차 좌석에 변화가 없다', async () => {
    const w = await world();
    const f = await w.fan(12);
    expect((await leave(w.eventId, f)).statusCode).toBe(204);
    const r = await postHold(w.eventId, f, ['A01']);
    expect(r.statusCode).toBe(401);
    expect(w.ev().bits.size).toBe(0);
    expect(w.ev().stream).toHaveLength(0);
  });

  test('QT11_ST33_ 홀드를 잡은 뒤 나가도 세션은 끝나고 이미 잡은 홀드는 지우지 않는다(LEFT가 홀드를 푸는 일은 해제 Lua가 생기는 HOT-070 뒤의 일이라 7분 만료로 풀린다)', async () => {
    const w = await world();
    const f = await w.fan(13);
    expect((await postHold(w.eventId, f, ['A02'])).statusCode).toBe(201);
    expect((await leave(w.eventId, f)).statusCode).toBe(204);
    expect(await mem.read(f.jti)).toBeUndefined();
    expect(w.ev().bits.size).toBe(1);
    expect(endedFor(f.jti)).toEqual([expect.objectContaining({ reason: 'LEFT' })]);
  });
});
