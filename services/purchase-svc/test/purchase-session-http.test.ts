// 실제 구매 세션 저장소(StoredPurchaseSessions)와 열기 유스케이스(OpenPurchaseSession)로 홀드 경로를 끝까지 돌린다(BUILD_ORDER PRF-136, S-T28 ③, S-T35, [ASVS v5.0.0-8.2.1]·[ASVS v5.0.0-9.1.1]).
// 시험 대역 MemoryPurchaseSessions 대신 입장 토큰을 서명해 열고, 클라이언트 임시 키로 요청 인증 키를 따로 계산해 홀드 요청에 서명한다.
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
  SeatStoreUnavailable,
  ServerEcdhKey,
  StoredPurchaseSessions,
} from '../src/modules/inventory/index.js';
import { claimsOf, ISS, JNY, newKey, signAdmission } from './admission-fixtures.js';
import { account, DAY, newEvent, SEAT_COUNT, SEAT_DEFS } from './hold-cases.js';
import { clientKeyOf } from './session-fixtures.js';

const NOW = Date.parse('2026-11-04T03:00:00.000Z');
const logs: string[] = [];
const quiet = new Writable({
  write: (c, _e, cb) => {
    logs.push(String(c));
    cb();
  },
});
const clock = fakeClock({ now: NOW });
const inner = new MemorySeatStore(clock);
const seatMap = new MemorySeatMap();
const attempts = new RecordingHoldAttempts();
const mem = new MemoryPurchaseSessionStore(clock);
const startedLog = new RecordingSessionStartedLog();
const admissionKey = newKey('k1');

const serverPriv = (() => {
  // 서버 고정 ECDH 키(시험용으로 새로 만든다). 클라이언트는 공개 JWK로 요청 인증 키를 합의한다
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const j = privateKey.export({ format: 'jwk' }) as Record<string, string>;
  return new ServerEcdhKey({ kty: 'EC', crv: 'P-256', x: j.x!, y: j.y!, d: j.d!, kid: 'ecdh-1' });
})();
const serverPub = createPublicKey({ key: serverPriv.publicJwk(), format: 'jwk' });
// 좌석 Redis 장애를 만드는 얇은 겉: read는 몇 번째 호출에서 던질지(failReadAt, 1부터)·advance는 늘 던지게 정한다(PRF-136 리뷰)
const flaky: { read?: unknown; readAt?: number; readCalls: number; advance?: unknown } = { readCalls: 0 };
const flakyStore: PurchaseSessionStore = {
  open: (i) => mem.open(i),
  read: async (jti) => {
    flaky.readCalls += 1;
    if (flaky.read !== undefined && (flaky.readAt === undefined || flaky.readCalls === flaky.readAt)) throw flaky.read;
    return mem.read(jti);
  },
  advance: async (jti, seq) => {
    if (flaky.advance !== undefined) throw flaky.advance;
    return mem.advance(jti, seq);
  },
  markStarted: (jti) => mem.markStarted(jti),
  claimSeatBehavior: async () => null,
  recordHold: (jti, holdId, seatIds) => mem.recordHold(jti, holdId, seatIds),
  end: (jti) => mem.end(jti),
  sweep: (jti) => mem.sweep(jti),
  setPaying: (jti, paying) => mem.setPaying(jti, paying),
};
const sessions = new StoredPurchaseSessions({ store: flakyStore, ecdh: serverPriv, clock });
const opener = new OpenPurchaseSession({ store: mem, log: startedLog, keys: new Map([['k1', admissionKey.pub]]), issuer: ISS, clock });

let svc: Awaited<ReturnType<typeof createService>>;
beforeAll(async () => {
  svc = await createService({
    name: 'purchase-svc',
    module: AppModule.register({ memory: true, store: inner, seatMap, attempts, sessions }),
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
  macKey: Buffer;
}

/** 회차 하나(좌석맵 판·판매 열기)와, 그 회차에서 입장 토큰으로 구매 세션을 연 팬 */
async function world() {
  const eventId = newEvent();
  seatMap.put({ eventId, layoutVersion: 'v1', seatCount: SEAT_COUNT, perAccountLimit: 4, saleEndsAtMs: NOW + DAY }, SEAT_DEFS);
  await inner.openSale({ eventId, seatCount: SEAT_COUNT, keepUntilMs: NOW + DAY + KEEP_AFTER_SALE_END_MS });
  const fan = async (k: number, tokenEvent = eventId): Promise<Fan> => {
    const jti = randomUUID();
    const accountId = account(k);
    const login = `ls-${eventId}-${k}`;
    const token = signAdmission(admissionKey, claimsOf({ nowMs: clock.now(), jti, accountId, loginSessionId: login, eventId: tokenEvent }));
    const client = clientKeyOf();
    // 열기는 토큰의 회차로 연다(주소의 회차 = 토큰의 회차)
    await opener.execute({ token, accountId, loginSessionId: login, eventId: tokenEvent, clientKey: client.text });
    const macKey = Buffer.from(purchaseRequestKey(diffieHellman({ privateKey: client.privateKey, publicKey: serverPub }), jti));
    return { accountId, login, jti, token, macKey };
  };
  return { eventId, fan, ev: () => inner.db.event(eventId) };
}

let seq = 0;
function post(eventId: string, f: Fan, o: { macKey?: Buffer; token?: string | null; login?: string; seq?: number } = {}) {
  const url = `/v1/events/${eventId}/holds`;
  const payload = JSON.stringify({ seatIds: ['A01'] });
  const n = o.seq ?? ++seq;
  const headers: Record<string, string> = {
    'x-user-id': f.accountId,
    'x-session-id': o.login ?? f.login,
    'x-user-aud': 'fan',
    'x-user-scope': 'ticket:buy',
    'content-type': 'application/json',
    'idempotency-key': randomUUID(),
    'x-purchase-seq': String(n),
    'x-purchase-mac': purchaseMac(o.macKey ?? f.macKey, purchaseMacInput('POST', url, n, Buffer.from(payload, 'utf8'))),
  };
  if (o.token !== null) headers['x-admission-token'] = o.token ?? f.token;
  return svc.http.inject({ method: 'POST', url, headers, payload });
}
const json = (r: { payload: string }) => JSON.parse(r.payload) as Record<string, unknown>;

describe('실제 구매 세션으로 홀드', () => {
  test('ST28_ST35_입장 토큰으로 연 구매 세션의 요청 인증 키로 서명한 홀드는 201이고, 홀드 시도 기록의 여정 ID는 입장 토큰의 jny이며 Stream의 구매 세션 ID는 jti다 [ASVS v5.0.0-8.2.1] [ASVS v5.0.0-9.1.1]', async () => {
    const w = await world();
    const f = await w.fan(1);
    const r = await post(w.eventId, f, { seq: 7 });
    expect(r.statusCode).toBe(201);
    expect(attempts.records.at(-1)).toMatchObject({ eventId: w.eventId, accountId: f.accountId, purchaseSessionId: f.jti, journeyId: JNY, result: 'HELD' });
    expect(w.ev().stream[0]).toMatchObject({ type: 'HELD', purchaseSessionId: f.jti, accountId: f.accountId });
    // 서명이 맞아 일련번호가 올랐다
    expect((await mem.read(f.jti))?.lastSeq).toBe(7);
  });

  test('ST28_③_게이트웨이를 거치지 않고 다른 회차 주소를 바로 넣으면 구매 세션 상태의 회차와 달라 403이다. 그 회차 좌석에 변화가 없다 [ASVS v5.0.0-8.2.2]', async () => {
    const a = await world();
    const b = await world();
    const f = await a.fan(2);
    // 이 팬의 구매 세션은 회차 A용이다. 회차 B 주소로 서명해(이 주소에 대한 서명은 맞다) 보낸다
    const r = await post(b.eventId, f);
    expect(r.statusCode).toBe(403);
    expect(json(r)).toMatchObject({ type: 'about:blank', status: 403 });
    expect(b.ev().bits.size).toBe(0);
    expect(b.ev().quota.size).toBe(0);
    expect(b.ev().stream).toHaveLength(0);
  });

  test('ST28_다른 회차의 토큰으로는 구매 세션을 열 수 없다: 회차 B 주소로 연 시도는 EVENT_MISMATCH이고 세션이 생기지 않는다 [ASVS v5.0.0-8.2.1]', async () => {
    const a = await world();
    const jti = randomUUID();
    const token = signAdmission(admissionKey, claimsOf({ nowMs: NOW, jti, eventId: a.eventId }));
    await expect(opener.execute({ token, accountId: 'acct-1', loginSessionId: 'login-1', eventId: 'other-event', clientKey: clientKeyOf().text })).rejects.toMatchObject({ code: 'EVENT_MISMATCH' });
    expect(await mem.read(jti)).toBeUndefined();
  });

  test('입장 토큰 머리가 없거나 남의 계정·로그인 세션이면 401이고 일련번호를 올리지 않으며 좌석에 변화가 없다 [ASVS v5.0.0-8.2.1] [ASVS v5.0.0-9.1.1]', async () => {
    const w = await world();
    const f = await w.fan(3);
    const stranger = await w.fan(4);
    const noToken = await post(w.eventId, f, { token: null });
    expect(noToken.statusCode).toBe(401);
    // 남의 입장 토큰(jti)을 내 신원으로 보낸다: 계정이 구매 세션 상태와 달라 세션을 못 찾는다
    const stolen = await post(w.eventId, f, { token: stranger.token, macKey: stranger.macKey });
    expect(stolen.statusCode).toBe(401);
    // 같은 계정이어도 로그인 세션이 다르면(다른 기기의 로그인) 401이다
    const otherLogin = await post(w.eventId, f, { login: 'ls-other' });
    expect(otherLogin.statusCode).toBe(401);
    expect((await mem.read(f.jti))?.lastSeq).toBe(0);
    expect((await mem.read(stranger.jti))?.lastSeq).toBe(0);
    expect(w.ev().bits.size).toBe(0);
  });

  test('다른 키로 서명하면 401이고 일련번호를 올리지 않는다. 같은 일련번호를 다시 보내면 401(재전송)이다 [ASVS v5.0.0-9.1.1]', async () => {
    const w = await world();
    const f = await w.fan(5);
    const wrong = await post(w.eventId, f, { macKey: Buffer.alloc(32, 3), seq: 4 });
    expect(wrong.statusCode).toBe(401);
    expect((await mem.read(f.jti))?.lastSeq).toBe(0);
    expect((await post(w.eventId, f, { seq: 4 })).statusCode).toBe(201);
    expect((await post(w.eventId, f, { seq: 4 })).statusCode).toBe(401);
    expect((await post(w.eventId, f, { seq: 3 })).statusCode).toBe(401);
    expect((await mem.read(f.jti))?.lastSeq).toBe(4);
  });

  test('최대 체류(입장 토큰 exp)가 지난 구매 세션은 401이다 [ASVS v5.0.0-9.2.1]', async () => {
    const w = await world();
    const f = await w.fan(6);
    expect((await post(w.eventId, f)).statusCode).toBe(201);
    clock.advance(45 * 60_000);
    expect((await post(w.eventId, f)).statusCode).toBe(401);
  });
});

describe('좌석 Redis 장애면 구매 세션 확인이 500이 아니라 503이다(seat-hold.md §2·§9, PRF-136 리뷰)', () => {
  const problem = (slug: string) => `${PROBLEM_TYPE_BASE}${slug}`;
  const reset = () => {
    flaky.read = undefined;
    flaky.readAt = undefined;
    flaky.readCalls = 0;
    flaky.advance = undefined;
  };

  test('NFR015_ST28_구매 세션 읽기(요청 인증 훅의 resolve)가 일시 장애면 503 seat-store-unavailable과 Retry-After 2이고 좌석에 변화가 없다 [ASVS v5.0.0-16.3.4]', async () => {
    const w = await world();
    const f = await w.fan(7);
    flaky.read = new SeatStoreUnavailable(new Error('down'));
    try {
      const r = await post(w.eventId, f);
      expect(r.statusCode).toBe(503);
      expect(r.headers['retry-after']).toBe('2');
      expect(r.headers['content-type']).toMatch(/^application\/problem\+json/);
      expect(json(r)).toMatchObject({ type: problem('seat-store-unavailable'), status: 503 });
      expect(w.ev().bits.size).toBe(0);
    } finally {
      reset();
    }
  });

  test('NFR015_ST28_일련번호 올리기(advance)가 메모리 부족이어도 503이고 응답에 까닭(oom)을 싣지 않는다. 장애가 풀리면 같은 요청이 201이다 [ASVS v5.0.0-16.3.4]', async () => {
    const w = await world();
    const f = await w.fan(8);
    flaky.advance = new SeatStoreUnavailable(new Error('OOM command not allowed'), 'oom');
    try {
      const r = await post(w.eventId, f, { seq: 30 });
      expect(r.statusCode).toBe(503);
      expect(r.headers['retry-after']).toBe('2');
      expect(json(r)).toMatchObject({ type: problem('seat-store-unavailable'), status: 503 });
      expect(r.payload).not.toMatch(/oom|maxmemory|reason/i);
      expect(w.ev().bits.size).toBe(0);
    } finally {
      reset();
    }
    expect((await post(w.eventId, f, { seq: 31 })).statusCode).toBe(201);
  });

  test('NFR015_ST28_훅은 지났는데 홀드 유스케이스의 구매 세션 읽기(get)가 일시 장애여도 503이고 좌석에 변화가 없다 [ASVS v5.0.0-16.3.4]', async () => {
    const w = await world();
    const f = await w.fan(9);
    // 훅의 resolve가 첫 읽기, 유스케이스의 get이 둘째 읽기다
    flaky.read = new SeatStoreUnavailable(new Error('down'));
    flaky.readAt = 2;
    flaky.readCalls = 0;
    try {
      const r = await post(w.eventId, f);
      expect(r.statusCode).toBe(503);
      expect(r.headers['retry-after']).toBe('2');
      expect(json(r)).toMatchObject({ type: problem('seat-store-unavailable'), status: 503 });
      expect(w.ev().bits.size).toBe(0);
      expect(w.ev().stream).toHaveLength(0);
    } finally {
      reset();
    }
  });

  test('저장소의 쓰기 전 지킴 오류(PEAKET_CORRUPT_KEY)는 키 이름(구매 세션 ID가 든다)을 싣지 않은 채 500으로 나간다 [ASVS v5.0.0-16.2.5]', async () => {
    const w = await world();
    const f = await w.fan(10);
    flaky.advance = new Error(`ERR PEAKET_CORRUPT_KEY s:session:{${f.jti}}`);
    try {
      logs.length = 0;
      const r = await post(w.eventId, f);
      expect(r.statusCode).toBe(500);
      expect(r.payload).not.toContain(f.jti);
      expect(logs.join('')).not.toContain(f.jti);
      expect(logs.join('')).toContain('CORRUPT_KEY');
    } finally {
      reset();
    }
  });
});
