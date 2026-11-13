// 받는 층: 좌석 스냅샷 GET /v1/events/{eventId}/seatmap-snapshot(openapi seats, docs/features/seat-hold.md §2 '스냅샷 API의 첫 구현', docs/frontend.md §4.4.2, BUILD_ORDER PRF-137).
// AppModule을 메모리 조립으로 띄워 fastify inject로 부른다. 신원은 게이트웨이 내부 머리, 입장 토큰은 서명해서 보낸다. 구매 세션 요청 서명은 없다(첫 사용 요청이라 세션이 아직 없다).
import 'reflect-metadata';
import { createPublicKey, diffieHellman, generateKeyPairSync, randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { createService, DEADLINE_HEADER, fakeClock, PROBLEM_TYPE_BASE, purchaseMac, purchaseMacInput, purchaseRequestKey } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import {
  decodeSnapshot,
  KEEP_AFTER_SALE_END_MS,
  MemoryPurchaseSessionStore,
  MemorySeatMap,
  MemorySeatStore,
  RecordingHoldAttempts,
  RecordingSessionStartedLog,
  type SeatCallOptions,
  type SeatSnapshots,
  type SeatStore,
  SeatStoreUnavailable,
  ServerEcdhKey,
  type SnapshotReadInput,
  type SnapshotReadResult,
  StoredPurchaseSessions,
} from '../src/modules/inventory/index.js';
import { claimsOf, ISS, newKey, signAdmission } from './admission-fixtures.js';
import { account, DAY, newEvent, SEAT_COUNT, SEAT_DEFS } from './hold-cases.js';
import { clientKeyOf } from './session-fixtures.js';

const NOW = Date.parse('2026-11-04T03:00:00.000Z');
const HEADER = 12;
/** 서비스 로그(한 줄에 JSON 하나). 입장 토큰·jti·키 이름이 로그에 남지 않는지 본다([ASVS v5.0.0-16.2.5]) */
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
const startedLog = new RecordingSessionStartedLog();
const admissionKey = newKey('k1');

const serverPriv = (() => {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const j = privateKey.export({ format: 'jwk' }) as Record<string, string>;
  return new ServerEcdhKey({ kty: 'EC', crv: 'P-256', x: j.x!, y: j.y!, d: j.d!, kid: 'ecdh-1' });
})();
const serverPub = createPublicKey({ key: serverPriv.publicJwk(), format: 'jwk' });
const sessions = new StoredPurchaseSessions({ store: mem, ecdh: serverPriv, clock });

/** 좌석 저장소 겉: 스냅샷 읽기에 장애를 끼우고 호출 인자를 적는다(나머지는 메모리 저장소 그대로) */
const faults: { read?: unknown } = {};
const readCalls: { input: SnapshotReadInput; options: SeatCallOptions | undefined }[] = [];
const store: SeatStore & SeatSnapshots = {
  hold: (i, o) => inner.hold(i, o),
  holdAuto: (i, o) => inner.holdAuto(i, o),
  autoCursor: (eventId, field) => inner.autoCursor(eventId, field),
  replay: (i, o) => inner.replay(i, o),
  openSale: (i) => inner.openSale(i),
  read: async (i: SnapshotReadInput, o?: SeatCallOptions): Promise<SnapshotReadResult> => {
    readCalls.push({ input: i, options: o });
    if (faults.read !== undefined) throw faults.read;
    return inner.read(i, o);
  },
};

let svc: Awaited<ReturnType<typeof createService>>;
beforeAll(async () => {
  svc = await createService({
    name: 'purchase-svc',
    module: AppModule.register({
      memory: true,
      store,
      seatMap,
      attempts,
      sessions,
      admission: { store: mem, startedLog, keys: new Map([['k1', admissionKey.pub]]), issuer: ISS },
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

/** 회차 하나(좌석맵 판·판매 열기)와, 그 회차의 입장 토큰을 가진 팬(구매 세션은 아직 열지 않았다) */
async function world(o: { map?: boolean; open?: boolean } = {}) {
  const eventId = newEvent();
  if (o.map !== false) seatMap.put({ eventId, layoutVersion: '3', seatCount: SEAT_COUNT, perAccountLimit: 4, saleEndsAtMs: NOW + DAY }, SEAT_DEFS);
  if (o.open !== false) await inner.openSale({ eventId, seatCount: SEAT_COUNT, keepUntilMs: NOW + DAY + KEEP_AFTER_SALE_END_MS });
  const fan = (k: number, c: { tokenEvent?: string; tokenAccount?: string; nowMs?: number } = {}): Fan => {
    const jti = randomUUID();
    const accountId = account(k);
    const login = `ls-${eventId}-${k}`;
    const token = signAdmission(admissionKey, claimsOf({ nowMs: c.nowMs ?? clock.now(), jti, accountId: c.tokenAccount ?? accountId, loginSessionId: login, eventId: c.tokenEvent ?? eventId }));
    const client = clientKeyOf();
    const macKey = Buffer.from(purchaseRequestKey(diffieHellman({ privateKey: client.privateKey, publicKey: serverPub }), jti));
    return { accountId, login, jti, token, clientKey: client.text, macKey };
  };
  return { eventId, fan, ev: () => inner.db.event(eventId) };
}

const FAN_IDENTITY = (f: Fan): Record<string, string> => ({ 'x-user-id': f.accountId, 'x-session-id': f.login, 'x-user-aud': 'fan', 'x-user-scope': 'ticket:buy' });

/** 스냅샷 GET. token·key가 null이면 그 머리를 싣지 않는다. identity가 null이면 신원 머리를 싣지 않는다 */
function get(
  eventId: string,
  f: Fan,
  o: { query?: string; token?: string | null; key?: string | null; identity?: Record<string, string> | null; headers?: Record<string, string>; url?: string } = {},
) {
  const url = o.url ?? `/v1/events/${eventId}/seatmap-snapshot${o.query ?? ''}`;
  const headers: Record<string, string> = { ...(o.identity === null ? {} : (o.identity ?? FAN_IDENTITY(f))) };
  if (o.token !== null) headers['x-admission-token'] = o.token ?? f.token;
  if (o.key !== null) headers['x-client-ephemeral-key'] = o.key ?? f.clientKey;
  Object.assign(headers, o.headers);
  return svc.http.inject({ method: 'GET', url, headers });
}

let seq = 0;
function postHold(eventId: string, f: Fan, seatIds: string[]) {
  const url = `/v1/events/${eventId}/holds`;
  const payload = JSON.stringify({ seatIds });
  const n = ++seq;
  return svc.http.inject({
    method: 'POST',
    url,
    headers: {
      ...FAN_IDENTITY(f),
      'content-type': 'application/json',
      'idempotency-key': randomUUID(),
      'x-admission-token': f.token,
      'x-purchase-seq': String(n),
      'x-purchase-mac': purchaseMac(f.macKey, purchaseMacInput('POST', url, n, Buffer.from(payload, 'utf8'))),
    },
    payload,
  });
}

const json = (r: { payload: string }) => JSON.parse(r.payload) as Record<string, unknown>;
const problem = (slug: string) => `${PROBLEM_TYPE_BASE}${slug}`;
const startedFor = (jti: string) => startedLog.entries.filter((e) => e.purchaseSessionId === jti).length;
/** 응답 전체(머리 + 본문) 글: 새면 안 되는 값을 찾는다 */
const everything = (r: { payload: string; headers: Record<string, unknown> }) => `${JSON.stringify(r.headers)}\n${r.payload}`;

describe('200 스냅샷', () => {
  test('FR009_ST28_[ASVS v5.0.0-3.2.1]_ 입장 토큰 첫 사용 요청은 200 application/octet-stream·no-store이고 본문은 decodeSnapshot으로 읽힌다(판 번호·세대·구역 표·비트맵 40비트) [ASVS v5.0.0-14.3.2]', async () => {
    const w = await world();
    const f = w.fan(1);
    const r = await get(w.eventId, f);
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('application/octet-stream');
    expect(r.headers['cache-control']).toBe('no-store');
    const body = decodeSnapshot(r.rawPayload);
    expect(body.sectionOnly).toBe(false);
    expect(body.layoutVersion).toBe(3);
    expect(body.seatEpoch).toBe(Math.floor(NOW / 1000));
    expect(body.sections).toEqual([
      { sectionIndex: 0, sectionVersion: 0 },
      { sectionIndex: 1, sectionVersion: 0 },
      { sectionIndex: 2, sectionVersion: 0 },
    ]);
    expect(body.bitmap.length).toBe(5);
    // 구역 3개(헤더 12 + 18) + 비트맵 5바이트
    expect(r.rawPayload.length).toBe(HEADER + 18 + 5);
  });

  test('ST28_ST35_ 첫 사용 요청이 구매 세션을 열고(입장 토큰의 회차·계정·로그인 세션에 묶임) SESSION_STARTED를 한 번 더한다. 서명 머리(x-purchase-seq·x-purchase-mac)는 없다 [ASVS v5.0.0-8.2.1]', async () => {
    const w = await world();
    const f = w.fan(2);
    expect(await mem.read(f.jti)).toBeUndefined();
    const before = startedFor(f.jti);
    const r = await get(w.eventId, f);
    expect(r.statusCode).toBe(200);
    expect(await mem.read(f.jti)).toMatchObject({ accountId: f.accountId, loginSessionId: f.login, eventId: w.eventId, clientKey: f.clientKey });
    expect(startedFor(f.jti) - before).toBe(1);
  });

  test('FR009_ST28_ 구매 세션이 열린 뒤 키 없는 재요청도 200이고 본문이 같으며 SESSION_STARTED는 늘지 않는다. 구역 하나 요청도 키 없이 200이다', async () => {
    const w = await world();
    const f = w.fan(3);
    const first = await get(w.eventId, f);
    const again = await get(w.eventId, f, { key: null });
    expect(again.statusCode).toBe(200);
    expect(again.rawPayload.equals(first.rawPayload)).toBe(true);
    const part = await get(w.eventId, f, { key: null, query: '?section=1' });
    expect(part.statusCode).toBe(200);
    expect(decodeSnapshot(part.rawPayload)).toMatchObject({ sectionOnly: true, sections: [{ sectionIndex: 1, sectionVersion: 0 }] });
    expect(startedFor(f.jti)).toBe(1);
  });

  test('PRF192_ST28_ 세션이 열린 뒤 다른 임시 공개키를 보내면 401 admission-token-invalid이고 응답에 까닭이 없다 [ASVS v5.0.0-8.2.1]', async () => {
    const w = await world();
    const f = w.fan(4);
    expect((await get(w.eventId, f)).statusCode).toBe(200);
    const r = await get(w.eventId, f, { key: clientKeyOf().text });
    expect(r.statusCode).toBe(401);
    expect(r.headers['www-authenticate']).toBe('Cookie realm="peaket"');
    expect(json(r)).toMatchObject({ type: problem('admission-token-invalid'), status: 401, title: '입장 확인이 끝났습니다' });
    expect(json(r).detail).toBeUndefined();
  });

  test('FR009_ST35_⑥_ 구역 하나 요청(?section=1)은 flags 비트 0·구역 하나·그 구역 범위 비트만 담는다', async () => {
    const w = await world();
    const f = w.fan(5);
    const r = await get(w.eventId, f, { query: '?section=1' });
    expect(r.statusCode).toBe(200);
    expect(r.rawPayload[1]).toBe(1);
    const body = decodeSnapshot(r.rawPayload);
    expect(body.sectionOnly).toBe(true);
    expect(body.sections).toEqual([{ sectionIndex: 1, sectionVersion: 0 }]);
    // 구역 1은 좌석 색인 20 ~ 29: 비트 10개 = 2바이트
    expect(body.bitmap.length).toBe(2);
  });

  test('FR009_ST35_⑥_ 종단: 홀드를 잡은 뒤 스냅샷이 그 좌석 비트를 1로, 그 구역의 일련번호를 올린 값으로 담는다(키 없는 재요청으로)', async () => {
    const w = await world();
    const f = w.fan(6);
    expect((await get(w.eventId, f)).statusCode).toBe(200);
    const h = await postHold(w.eventId, f, ['A01', 'A03', 'B02']);
    expect(h.statusCode).toBe(201);
    const r = await get(w.eventId, f, { key: null });
    expect(r.statusCode).toBe(200);
    const body = decodeSnapshot(r.rawPayload);
    // A01(색인 0)·A03(2) → 바이트 0의 비트 0·2 = 0x05, B02(색인 21) → 바이트 2의 비트 5 = 0x20 (낮은 비트부터)
    expect(Buffer.from(body.bitmap).toString('hex')).toBe('0500200000');
    expect(body.sections).toEqual([
      { sectionIndex: 0, sectionVersion: 1 },
      { sectionIndex: 1, sectionVersion: 1 },
      { sectionIndex: 2, sectionVersion: 0 },
    ]);
    // 구역 하나로 받아도 같은 비트다: 구역 1(색인 20 ~ 29)에서 B02는 두 번째 좌석이라 비트 1(0x02)
    const part = decodeSnapshot((await get(w.eventId, f, { key: null, query: '?section=1' })).rawPayload);
    expect(Buffer.from(part.bitmap).toString('hex')).toBe('0200');
    expect(part.sections).toEqual([{ sectionIndex: 1, sectionVersion: 1 }]);
  });

  test('FR009_ 다른 팬의 홀드도 스냅샷에는 비트로만 보이고 누가 잡았는지는 응답 어디에도 없다 [ASVS v5.0.0-15.3.1]', async () => {
    const w = await world();
    const holder = w.fan(7);
    const viewer = w.fan(8);
    await get(w.eventId, holder);
    expect((await postHold(w.eventId, holder, ['A05'])).statusCode).toBe(201);
    const r = await get(w.eventId, viewer);
    expect(decodeSnapshot(r.rawPayload).bitmap[0]).toBe(0x10);
    expect(everything({ payload: r.rawPayload.toString('latin1'), headers: r.headers })).not.toContain(holder.accountId);
    expect(everything({ payload: r.rawPayload.toString('latin1'), headers: r.headers })).not.toContain(holder.jti);
  });
});

describe('입장 토큰·신원 거절', () => {
  test('PRF192_ST28_[ASVS v5.0.0-16.3.1]_ 입장 토큰 없음·서명 틀림·만료·첫 사용 기한 지남·남의 계정 토큰은 모두 401 admission-token-invalid이고 WWW-Authenticate Cookie realm="peaket"이며 어느 검사에 걸렸는지 싣지 않고 구매 세션이 생기지 않는다 [ASVS v5.0.0-8.2.1]', async () => {
    const w = await world();
    const base = w.fan(1);
    const cases: [string, Fan, Parameters<typeof get>[2]][] = [
      ['토큰 없음', base, { token: null }],
      ['서명 틀림', base, { token: `${base.token.slice(0, -4)}AAAA` }],
      ['모양이 아닌 글', base, { token: 'not.a.jwt' }],
      ['만료', w.fan(2, { nowMs: NOW - 60 * 60_000 }), {}],
      ['첫 사용 기한 지남', w.fan(3, { nowMs: NOW - 10 * 60_000 }), {}],
      ['남의 계정 토큰', w.fan(4, { tokenAccount: account(99) }), {}],
    ];
    for (const [what, f, o] of cases) {
      const r = await get(w.eventId, f, o);
      expect({ what, status: r.statusCode }).toEqual({ what, status: 401 });
      expect({ what, challenge: r.headers['www-authenticate'] }).toEqual({ what, challenge: 'Cookie realm="peaket"' });
      expect({ what, body: json(r) }).toMatchObject({ what, body: { type: problem('admission-token-invalid'), status: 401, title: '입장 확인이 끝났습니다' } });
      expect(json(r).detail).toBeUndefined();
      const text = everything(r);
      for (const secret of [f.token, f.jti, f.accountId, f.clientKey]) expect({ what, leaked: text.includes(secret) }).toEqual({ what, leaked: false });
      expect({ what, session: await mem.read(f.jti) }).toEqual({ what, session: undefined });
      expect({ what, started: startedFor(f.jti) }).toEqual({ what, started: 0 });
    }
    expect(w.ev().bits.size).toBe(0);
  });

  test('[ASVS v5.0.0-16.3.1]_ 거절 이유는 서비스 로그에만 남고 로그에도 입장 토큰·jti·임시 공개키가 없다', async () => {
    const w = await world();
    const f = w.fan(1, { tokenEvent: 'ev-other' });
    logs.length = 0;
    const r = await get(w.eventId, f);
    expect(r.statusCode).toBe(403);
    const text = logs.join('');
    expect(text).toContain('구매 세션 열기 거절');
    for (const secret of [f.token, f.jti, f.clientKey]) expect(text.includes(secret)).toBe(false);
  });

  test('ST28_③_ 입장 토큰의 회차와 주소의 회차가 다르면(게이트웨이를 거치지 않고 바로 넣음) 403·이름 없는 본문이고 구매 세션이 생기지 않으며 좌석에 변화가 없다 [ASVS v5.0.0-8.2.2]', async () => {
    const a = await world();
    const b = await world();
    const f = a.fan(1);
    const r = await get(b.eventId, f);
    expect(r.statusCode).toBe(403);
    expect(json(r)).toMatchObject({ type: 'about:blank', status: 403 });
    expect(r.headers['cache-control']).toBe('no-store');
    expect(await mem.read(f.jti)).toBeUndefined();
    expect(startedFor(f.jti)).toBe(0);
    for (const w of [a, b]) {
      expect(w.ev().bits.size).toBe(0);
      expect(w.ev().stream).toHaveLength(0);
    }
    // 같은 팬이 자기 회차 주소로는 열린다
    expect((await get(a.eventId, f)).statusCode).toBe(200);
  });

  test('ST28_ 열린 세션의 회차와 다른 주소로 다시 요청해도 403이다(회차 B에는 판과 세대 키가 있다)', async () => {
    const a = await world();
    const b = await world();
    const f = a.fan(2);
    expect((await get(a.eventId, f)).statusCode).toBe(200);
    const r = await get(b.eventId, f, { key: null });
    expect(r.statusCode).toBe(403);
    expect(json(r)).toMatchObject({ type: 'about:blank', status: 403 });
  });

  test('FR009_ST28_ 첫 사용 요청에 임시 공개키 머리가 없거나 모양이 틀리면 400·이름 없는 본문이고 구매 세션이 생기지 않는다(키를 제대로 보내면 열린다)', async () => {
    const w = await world();
    const f = w.fan(1);
    for (const key of [null, '', 'not-a-key', 'A'.repeat(86), 'A'.repeat(88), `${f.clientKey.slice(0, -1)}!`]) {
      const r = await get(w.eventId, f, { key });
      expect({ key, status: r.statusCode }).toEqual({ key, status: 400 });
      expect(json(r)).toMatchObject({ type: 'about:blank', status: 400 });
      expect(json(r).detail).toBeUndefined();
      expect(r.headers['cache-control']).toBe('no-store');
    }
    expect(await mem.read(f.jti)).toBeUndefined();
    expect(startedFor(f.jti)).toBe(0);
    expect((await get(w.eventId, f)).statusCode).toBe(200);
  });

  test('[ASVS v5.0.0-8.1.1]_ 팬 신원이 없으면 401(WWW-Authenticate)이고 구매 세션을 열지 않는다. 신원 머리가 일부만 있어도 같다', async () => {
    const w = await world();
    const f = w.fan(1);
    const none = await get(w.eventId, f, { identity: null });
    expect(none.statusCode).toBe(401);
    expect(none.headers['www-authenticate']).toBe('Cookie realm="peaket"');
    expect(json(none)).toMatchObject({ type: 'about:blank', status: 401 });
    const partial = await get(w.eventId, f, { identity: { 'x-user-id': f.accountId, 'x-user-aud': 'fan' } });
    expect(partial.statusCode).toBe(401);
    expect(await mem.read(f.jti)).toBeUndefined();
  });

  test('[ASVS v5.0.0-8.1.1]_ 팬이 아닌 역할(ops·partner·scanner)의 신원은 이 팬 경로를 못 쓴다: 플랫폼 가드가 401로 거절하고(역할이 맞지 않으면 신원을 인정하지 않는다) 구매 세션을 열지 않는다', async () => {
    const w = await world();
    const f = w.fan(1);
    for (const aud of ['ops', 'partner', 'scanner']) {
      const r = await get(w.eventId, f, { identity: { 'x-user-id': f.accountId, 'x-session-id': f.login, 'x-user-aud': aud } });
      expect({ aud, status: r.statusCode }).toEqual({ aud, status: 401 });
    }
    expect(await mem.read(f.jti)).toBeUndefined();
  });
});

describe('section 검사(경로·쿼리 스키마, [ASVS v5.0.0-2.1.1]·[ASVS v5.0.0-15.3.7])', () => {
  const bad = ['?section=abc', '?section=-1', '?section=65536', '?section=1.5', '?section=1&section=2', '?section=1&section=1', '?section=3', '?section=100', '?section=65535'];

  test('section이 정수가 아니거나(abc·1.5) 0 ~ 65535 밖이거나 두 번 오거나 판의 구역 수 밖이면 400·이름 없는 본문이고 구매 세션을 열지 않는다 [ASVS v5.0.0-2.1.1] [ASVS v5.0.0-15.3.7]', async () => {
    const w = await world();
    const f = w.fan(1);
    for (const query of bad) {
      const r = await get(w.eventId, f, { query });
      expect({ query, status: r.statusCode }).toEqual({ query, status: 400 });
      expect({ query, body: json(r) }).toMatchObject({ query, body: { type: 'about:blank', status: 400 } });
      expect(json(r).detail).toBeUndefined();
    }
    // 어느 거절에서도 입장 토큰이 쓰이지 않았다: 구매 세션도 SESSION_STARTED도 없다
    expect(await mem.read(f.jti)).toBeUndefined();
    expect(startedFor(f.jti)).toBe(0);
  });

  test('[ASVS v5.0.0-2.1.1]_ 구역 수 안의 section(0·1·2)은 200이고, 주소의 회차 ID가 키 조각 모양이 아니면 400이다', async () => {
    const w = await world();
    const f = w.fan(1);
    for (const section of [0, 1, 2]) {
      const r = await get(w.eventId, f, { query: `?section=${section}`, key: section === 0 ? undefined : null });
      expect({ section, status: r.statusCode }).toEqual({ section, status: 200 });
      expect(decodeSnapshot(r.rawPayload).sections.map((s) => s.sectionIndex)).toEqual([section]);
    }
    for (const bad of ['a%7Db', '%7Bx%7D', 'a%20b', 'x'.repeat(65)]) {
      const r = await get(w.eventId, f, { url: `/v1/events/${bad}/seatmap-snapshot` });
      expect({ bad, status: r.statusCode }).toEqual({ bad, status: 400 });
    }
  });
});

describe('503 seat-store-unavailable', () => {
  const unavailable = (r: { statusCode: number; headers: Record<string, unknown>; payload: string }) => {
    expect(r.statusCode).toBe(503);
    expect(r.headers['retry-after']).toBe('2');
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(json(r)).toMatchObject({ type: problem('seat-store-unavailable'), status: 503 });
  };

  test('NFR015_ST26_③_ 그 회차 좌석맵 판이 없으면 503 seat-store-unavailable·Retry-After 2·no-store이고 입장 토큰을 쓰지 않는다(구매 세션 없음)', async () => {
    const w = await world({ map: false, open: false });
    const f = w.fan(1);
    const calls = readCalls.length;
    unavailable(await get(w.eventId, f));
    expect(readCalls.length).toBe(calls);
    expect(await mem.read(f.jti)).toBeUndefined();
    expect(startedFor(f.jti)).toBe(0);
  });

  test('NFR015_ST26_③_ 세대 키가 없으면(판은 있음) 503이고 좌석을 읽지 못했을 뿐 구매 세션은 열려 있어, 세대 키가 서면 키 없는 재요청이 200이다', async () => {
    const w = await world({ open: false });
    const f = w.fan(2);
    unavailable(await get(w.eventId, f));
    expect(await mem.read(f.jti)).toMatchObject({ eventId: w.eventId });
    await inner.openSale({ eventId: w.eventId, seatCount: SEAT_COUNT, keepUntilMs: NOW + DAY + KEEP_AFTER_SALE_END_MS });
    expect((await get(w.eventId, f, { key: null })).statusCode).toBe(200);
    expect(startedFor(f.jti)).toBe(1);
  });

  test('NFR015_ 좌석 저장소의 일시 장애(SeatStoreUnavailable)는 503 seat-store-unavailable이다. 장애가 풀리면 같은 요청이 200이다', async () => {
    const w = await world();
    const f = w.fan(3);
    faults.read = new SeatStoreUnavailable(new Error('down'));
    try {
      unavailable(await get(w.eventId, f));
    } finally {
      faults.read = undefined;
    }
    expect((await get(w.eventId, f, { key: null })).statusCode).toBe(200);
  });

  test('NFR015_ 좌석 저장소 메모리 부족(oom)도 일시 장애와 같은 모양의 503이고 응답에 까닭(oom·maxmemory·reason)을 싣지 않는다 [ASVS v5.0.0-16.3.4]', async () => {
    const w = await world();
    const answer = async (err: unknown, k: number) => {
      faults.read = err;
      try {
        return await get(w.eventId, w.fan(k));
      } finally {
        faults.read = undefined;
      }
    };
    const oom = await answer(new SeatStoreUnavailable(new Error("OOM command not allowed when used memory > 'maxmemory'."), 'oom'), 4);
    const down = await answer(new SeatStoreUnavailable(new Error('down')), 5);
    unavailable(oom);
    unavailable(down);
    const shape = (r: { payload: string }) => {
      const { type, status, title, detail } = json(r);
      return { keys: Object.keys(json(r)).sort(), type, status, title, detail };
    };
    expect(shape(oom)).toEqual(shape(down));
    expect(oom.payload).not.toMatch(/oom|maxmemory|reason/i);
    expect(Object.keys(oom.headers).filter((h) => /reason/i.test(h))).toEqual([]);
  });

  test('[ASVS v5.0.0-16.2.5]_ 저장소의 쓰기 전 지킴 오류(PEAKET_CORRUPT_KEY)는 키 이름을 싣지 않은 채 500으로 나간다(응답·로그에 s:{event: 같은 키 이름이 없다)', async () => {
    const w = await world();
    const f = w.fan(6);
    faults.read = new Error(`ERR PEAKET_CORRUPT_KEY s:{event:${w.eventId}}:secver`);
    try {
      logs.length = 0;
      const r = await get(w.eventId, f);
      expect(r.statusCode).toBe(500);
      expect(everything(r)).not.toContain('s:{event');
      expect(everything(r)).not.toContain(w.eventId + '}');
      expect(logs.join('')).not.toContain('s:{event');
      expect(logs.join('')).toContain('CORRUPT_KEY');
    } finally {
      faults.read = undefined;
    }
  });

  test('NFR003_ 남은 시간 머리(x-peaket-deadline-ms)가 60이면 좌석 읽기 마감은 60ms, 머리가 없으면 서비스 상한이라 100ms다', async () => {
    const w = await world();
    const f = w.fan(7);
    const from = readCalls.length;
    expect((await get(w.eventId, f, { headers: { [DEADLINE_HEADER]: '60' } })).statusCode).toBe(200);
    expect((await get(w.eventId, f, { key: null })).statusCode).toBe(200);
    expect(readCalls.slice(from).map((c) => c.options)).toEqual([{ deadlineMs: 60 }, { deadlineMs: 100 }]);
  });
});

describe('오류 응답도 캐시하지 않는다([ASVS v5.0.0-14.3.2])', () => {
  test('FR009_ 처리기가 내는 오류(section이 구역 수 밖 400·임시 공개키 400·입장 토큰 401·회차 403·503)는 모두 Cache-Control no-store다 [ASVS v5.0.0-14.3.2]', async () => {
    const w = await world();
    const other = await world();
    const missing = await world({ map: false, open: false });
    const f = w.fan(1);
    const rs = {
      sectionOutOfRange: await get(w.eventId, f, { query: '?section=9' }),
      key: await get(w.eventId, f, { key: null }),
      token: await get(w.eventId, f, { token: null }),
      mismatch: await get(other.eventId, w.fan(2, { tokenEvent: w.eventId })),
      notReady: await get(missing.eventId, missing.fan(3)),
    };
    for (const [what, r] of Object.entries(rs)) expect.soft({ what, cache: r.headers['cache-control'] }).toEqual({ what, cache: 'no-store' });
  });

  test('FR009_ 가드 단계의 거절(신원 없음 401·팬 아닌 역할 401·경로 스키마 400)도 no-store다 [ASVS v5.0.0-14.3.2]', async () => {
    const w = await world();
    const f = w.fan(1);
    const rs = {
      noIdentity: await get(w.eventId, f, { identity: null }),
      notFan: await get(w.eventId, f, { identity: { 'x-user-id': f.accountId, 'x-session-id': f.login, 'x-user-aud': 'ops' } }),
      badSection: await get(w.eventId, f, { query: '?section=1&section=2' }),
      notInteger: await get(w.eventId, f, { query: '?section=abc' }),
    };
    for (const [what, r] of Object.entries(rs)) expect.soft({ what, cache: r.headers['cache-control'] }).toEqual({ what, cache: 'no-store' });
  });
});
