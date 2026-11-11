// 구매 세션 저장소의 메모리 구현과 플랫폼 구매 요청 인증 포트(resolve·advance)·세션 읽기(get)의 운영 어댑터 StoredPurchaseSessions
// (docs/features/seat-hold.md §2 '구매 세션 열기와 확인의 첫 구현', BUILD_ORDER PRF-136). 실제 Valkey Lua는 test-int/purchase-session.int.test.ts가 같은 사례로 돈다.
import { diffieHellman, generateKeyPairSync } from 'node:crypto';
import { fakeClock, type Principal, purchaseRequestKey } from '@peaket/platform';
import type { FastifyRequest } from 'fastify';
import { describe, expect, test } from 'vitest';
import {
  KEY_PART,
  MemoryPurchaseSessionStore,
  PURCHASE_SESSION_INFO,
  type PurchaseSessionStore,
  RedisPurchaseSessionStore,
  SEAT_STORE_RETRY_AFTER_SEC,
  SESSION_KEY_GRACE_MS,
  SESSION_STARTED_GRACE_MS,
  ServerEcdhKey,
  StoredPurchaseSessions,
  parseClientEphemeralKey,
  seatKeys,
  sessionKeys,
} from '../src/modules/inventory/index.js';
import { slotOf } from '../src/modules/inventory/index.js';
import { b64 } from './admission-fixtures.js';
import { ACCOUNT, EVENT, JOURNEY, LOGIN, newJti, openInput, purchaseSessionStoreCases, type SessionHarness } from './purchase-session-cases.js';

const NOW = Date.parse('2026-11-04T03:00:00.000Z');

function memoryHarness(): SessionHarness & { mem: MemoryPurchaseSessionStore; clock: ReturnType<typeof fakeClock> } {
  const clock = fakeClock({ now: NOW });
  const mem = new MemoryPurchaseSessionStore(clock);
  return { mem, clock, store: mem, now: () => clock.now(), pass: async (ms) => clock.advance(ms), end: async (jti) => mem.endSession(jti), skewMs: 0 };
}

describe('MemoryPurchaseSessionStore (저장소 계약 사례)', () => {
  purchaseSessionStoreCases(memoryHarness);
});

describe('MemoryPurchaseSessionStore (키 수명 모형: Redis와 같은 순간에 사라진다)', () => {
  test('ADR0183_8_세션 상태는 처음 최대 체류 + 60초에, 재사용 차단 표지는 reissueUntil + 60초에 사라진다: 그 사이 다시 받은 토큰은 ENDED, 표지까지 사라지면 다시 열린다(한계)', async () => {
    const h = memoryHarness();
    const jti = newJti();
    const a = openInput(h, jti);
    expect((await h.store.open(a)).kind).toBe('CREATED');
    // 세션 상태 수명 직전: 아직 있다
    await h.pass(a.expiresAtMs - h.now() + SESSION_KEY_GRACE_MS - 1);
    expect(await h.store.read(jti)).toBeDefined();
    await h.pass(1);
    expect(await h.store.read(jti)).toBeUndefined();
    expect(await h.store.markStarted(jti)).toBe(false);
    // 다시 받은 토큰(exp 90분 안): 표지가 남아 ENDED
    const b = openInput(h, jti, { expiresAtMs: a.expiresAtMs + 40 * 60_000, reissueUntilMs: a.reissueUntilMs + 40 * 60_000 });
    expect(await h.store.open(b)).toEqual({ kind: 'ENDED' });
    // 표지 수명(reissueUntil + 60초)이 지나면 표지도 없다: 이 토큰의 exp가 남아 있고 첫 사용 기한 안이면 새로 열린다
    await h.pass(a.reissueUntilMs - h.now() + SESSION_KEY_GRACE_MS);
    const c = openInput(h, jti, { expiresAtMs: h.now() + 45 * 60_000, reissueUntilMs: h.now() + 90 * 60_000 });
    expect((await h.store.open(c)).kind).toBe('CREATED');
  });

  test('ADR0183_8_더 늦은 exp의 토큰으로 REPLAY하면 표지 수명이 그 토큰의 reissueUntil + 60초로 늘어난다(줄지 않는다)', async () => {
    const h = memoryHarness();
    const jti = newJti();
    const a = openInput(h, jti);
    await h.store.open(a);
    // 처음 표지 수명(a.reissueUntil + 60초) 뒤에도 exp가 남아 있는 다시 받은 토큰
    const b = { ...a, expiresAtMs: a.expiresAtMs + 50 * 60_000, reissueUntilMs: a.expiresAtMs + 50 * 60_000 + 45 * 60_000 };
    expect((await h.store.open(b)).kind).toBe('REPLAY');
    expect((await h.store.open(a)).kind).toBe('REPLAY');
    // 처음 세션이 끝나고 처음 표지 수명이 지났어도 b가 늘린 표지 수명까지는 표지가 남아 ENDED다(새 세션이 열리지 않는다)
    await h.pass(a.reissueUntilMs - h.now() + SESSION_KEY_GRACE_MS + 1);
    expect(await h.store.read(jti)).toBeUndefined();
    expect(await h.store.open({ ...b, firstUseDeadlineMs: h.now() + 60_000 })).toEqual({ kind: 'ENDED' });
  });
});

describe('시작 사건 유예(SESSION_STARTED_GRACE_MS)', () => {
  test('ADR0183_11_유예는 좌석 저장소 503의 Retry-After(2초)보다 짧다: 열기 응답을 잃은 재시도가 유예 안에 닿아 시작 사건을 영영 못 더하는 일이 없다', () => {
    expect(SESSION_STARTED_GRACE_MS).toBeLessThan(SEAT_STORE_RETRY_AFTER_SEC * 1000);
  });
});

describe('키 이름', () => {
  test('ST28_표지 s:jti:{jti}와 세션 상태 s:session:{jti}는 해시 태그가 같아 같은 슬롯이다(열기가 Lua 한 번). 회차 Stream과는 다른 슬롯이다 [ASVS v5.0.0-8.2.1]', () => {
    for (const jti of ['a', '0190f3a1-7c2e-7a00-8000-0000000000a1', 'jti-123-abc', 'x'.repeat(64)]) {
      expect(sessionKeys.marker(jti)).toBe(`s:jti:{${jti}}`);
      expect(sessionKeys.session(jti)).toBe(`s:session:{${jti}}`);
      expect(slotOf(sessionKeys.marker(jti))).toBe(slotOf(sessionKeys.session(jti)));
    }
    expect(slotOf(sessionKeys.marker('0190f3a1-7c2e-7a00-8000-0000000000a1'))).not.toBe(slotOf(seatKeys.stream('ev-1')));
  });

  test('ST28_회차 Stream 키는 좌석 쪽 seatKeys와 같다(구매 세션 사건이 홀드 사건과 같은 Stream에 들어간다)', () => {
    expect(sessionKeys.stream('ev-1')).toBe(seatKeys.stream('ev-1'));
  });
});

// ── 운영 어댑터 ──────────────────────────────────────────────────────────────────────────────────────────────

interface World {
  clock: ReturnType<typeof fakeClock>;
  mem: MemoryPurchaseSessionStore;
  reads: string[];
  advances: Array<[string, number]>;
  sessions: StoredPurchaseSessions;
  server: ServerEcdhKey;
  /** 클라이언트: 임시 키쌍을 만들고 서버 공개키로 요청 인증 키를 계산한다 */
  client(jti: string): { text: string; key: Buffer };
}

function world(): World {
  const clock = fakeClock({ now: NOW });
  const mem = new MemoryPurchaseSessionStore(clock);
  const reads: string[] = [];
  const advances: Array<[string, number]> = [];
  const spy: PurchaseSessionStore = {
    open: (i) => mem.open(i),
    read: (jti) => {
      reads.push(jti);
      return mem.read(jti);
    },
    advance: (jti, seq) => {
      advances.push([jti, seq]);
      return mem.advance(jti, seq);
    },
    markStarted: (jti) => mem.markStarted(jti),
    claimSeatBehavior: async () => null,
    recordHold: (jti, holdId, seatIds) => mem.recordHold(jti, holdId, seatIds),
    end: (jti) => mem.end(jti),
    sweep: (jti) => mem.sweep(jti),
    setPaying: (jti, paying) => mem.setPaying(jti, paying),
  };
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const j = privateKey.export({ format: 'jwk' }) as Record<string, string>;
  const server = new ServerEcdhKey({ kty: 'EC', crv: 'P-256', x: j.x!, y: j.y!, d: j.d!, kid: 'ecdh-1' });
  const sessions = new StoredPurchaseSessions({ store: spy, ecdh: server, clock });
  return {
    clock,
    mem,
    reads,
    advances,
    sessions,
    server,
    client: (jti) => {
      const c = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
      const cj = c.publicKey.export({ format: 'jwk' }) as Record<string, string>;
      const text = Buffer.concat([Buffer.from([4]), Buffer.from(cj.x!, 'base64url'), Buffer.from(cj.y!, 'base64url')]).toString('base64url');
      return { text, key: Buffer.from(purchaseRequestKey(diffieHellman({ privateKey: c.privateKey, publicKey }), jti)) };
    },
  };
}

const principal = (over: Partial<Principal> = {}): Principal => ({ accountId: ACCOUNT, sessionId: LOGIN, aud: 'fan', scopes: ['ticket:buy'], ...over });
/** 게이트웨이가 넘긴 입장 토큰(서명은 게이트웨이가 확인했다. 어댑터는 jti만 읽는다) */
const admissionHeader = (jti: unknown) => `${b64({ alg: 'ES256', typ: 'admission+jwt', kid: 'k1' })}.${b64({ jti })}.${Buffer.alloc(64, 1).toString('base64url')}`;
const req = (headers: Record<string, string | string[] | undefined>) => ({ headers }) as unknown as FastifyRequest;
const tokenReq = (jti: unknown) => req({ 'x-admission-token': admissionHeader(jti) });

async function opened(w: World, over: { accountId?: string; loginSessionId?: string; eventId?: string } = {}) {
  const jti = newJti();
  const c = w.client(jti);
  const r = await w.mem.open(openInput({ now: () => w.clock.now() }, jti, { clientKey: c.text, ...over }));
  expect(r.kind).toBe('CREATED');
  return { jti, ...c };
}

describe('StoredPurchaseSessions.resolve (구매 요청 인증 포트)', () => {
  test('ST16_세션이 있고 계정·로그인 세션이 맞으면 { ref: jti, key }를 주고 key는 클라이언트가 따로 계산한 요청 인증 키와 같다 [ASVS v5.0.0-8.2.1]', async () => {
    const w = world();
    const s = await opened(w);
    const r = await w.sessions.resolve(tokenReq(s.jti), principal());
    expect(r?.ref).toBe(s.jti);
    expect(Buffer.from(r!.key as Uint8Array).equals(s.key)).toBe(true);
  });

  test('BAT028_resolve는_인증에_쓴_구매_세션_정보와_최대체류경계를_요청에_붙인다(홀드가 다시 읽지 않게)', async () => {
    const w = world();
    const s = await opened(w);
    const request = tokenReq(s.jti);
    await w.sessions.resolve(request, principal());
    expect((request as unknown as Record<symbol, unknown>)[PURCHASE_SESSION_INFO]).toMatchObject({
      sessionId: s.jti,
      accountId: ACCOUNT,
      eventId: EVENT,
      journeyId: JOURNEY,
    });
    const info = (request as unknown as Record<symbol, { maxStayUntilMs?: number }>)[PURCHASE_SESSION_INFO]!;
    expect(info.maxStayUntilMs).toBeGreaterThan(w.clock.now());
    expect(w.reads).toEqual([s.jti]);
  });

  test('resolve는 구매 세션 상태를 한 번 읽을 뿐 일련번호를 올리지 않는다 [ASVS v5.0.0-8.2.1]', async () => {
    const w = world();
    const s = await opened(w);
    await w.sessions.resolve(tokenReq(s.jti), principal());
    expect(w.reads).toEqual([s.jti]);
    expect(w.advances).toEqual([]);
    expect((await w.mem.read(s.jti))?.lastSeq).toBe(0);
  });

  test('입장 토큰 머리가 없거나 하나가 아니거나 모양이 틀리거나 jti가 키 조각 모양이 아니면 undefined이고 저장소를 읽지 않는다 [ASVS v5.0.0-8.2.1]', async () => {
    const w = world();
    const ok = admissionHeader('a-jti');
    const bad: Array<Record<string, string | string[] | undefined>> = [
      {},
      { 'x-admission-token': undefined },
      { 'x-admission-token': '' },
      { 'x-admission-token': [ok, ok] },
      { 'x-admission-token': 'a.b' },
      { 'x-admission-token': 'a.b.c.d' },
      { 'x-admission-token': ok.replace(/\./, '=') },
      { 'x-admission-token': `${ok} ` },
      { 'x-admission-token': `${b64({})}.${Buffer.from('not json').toString('base64url')}.x` },
      { 'x-admission-token': `${b64({})}.${Buffer.from('[]').toString('base64url')}.x` },
      { 'x-admission-token': admissionHeader(undefined) },
      { 'x-admission-token': admissionHeader(7) },
      { 'x-admission-token': admissionHeader('') },
      { 'x-admission-token': admissionHeader('a}b') },
      { 'x-admission-token': admissionHeader('{x}') },
      { 'x-admission-token': admissionHeader('a:b') },
      { 'x-admission-token': admissionHeader('x'.repeat(65)) },
      { 'x-admission-token': ok.padEnd(2049, 'A') },
    ];
    for (const h of bad) expect(await w.sessions.resolve(req(h), principal()), JSON.stringify(h)).toBeUndefined();
    expect(w.reads).toEqual([]);
    expect(KEY_PART.test('a-jti')).toBe(true);
  });

  test('남의 jti로는 세션을 못 찾는다: 계정이나 로그인 세션이 구매 세션 상태와 다르면 undefined다(헤더의 jti는 조회 손잡이일 뿐이다) [ASVS v5.0.0-8.2.1] [ASVS v5.0.0-8.2.2]', async () => {
    const w = world();
    const s = await opened(w);
    expect(await w.sessions.resolve(tokenReq(s.jti), principal({ accountId: 'acct-2' }))).toBeUndefined();
    expect(await w.sessions.resolve(tokenReq(s.jti), principal({ sessionId: 'login-2' }))).toBeUndefined();
    expect(await w.sessions.resolve(tokenReq('unknown-jti'), principal())).toBeUndefined();
  });

  test('최대 체류가 지났거나 세션이 끝났으면 undefined다 [ASVS v5.0.0-9.2.1]', async () => {
    const w = world();
    const s = await opened(w);
    expect(await w.sessions.resolve(tokenReq(s.jti), principal())).toBeDefined();
    w.clock.advance(45 * 60_000 - 1);
    expect(await w.sessions.resolve(tokenReq(s.jti), principal())).toBeDefined();
    w.clock.advance(1);
    expect(await w.sessions.resolve(tokenReq(s.jti), principal())).toBeUndefined();
    const t = await opened(w);
    w.mem.endSession(t.jti);
    expect(await w.sessions.resolve(tokenReq(t.jti), principal())).toBeUndefined();
  });

  test('저장된 임시 공개키가 망가졌으면(곡선 위의 점이 아님) 세션이 없는 것으로 본다. 던지지 않는다 [ASVS v5.0.0-8.2.1]', async () => {
    const w = world();
    const jti = newJti();
    // 저장소 계약은 점 검증을 하지 않는다. 운영에서는 열기 유스케이스가 거르지만, 저장소가 망가져도 resolve가 500을 내지 않는다
    await w.mem.open(openInput({ now: () => w.clock.now() }, jti, { clientKey: Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]).toString('base64url') }));
    expect(parseClientEphemeralKey(Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]).toString('base64url'))).toBeUndefined();
    expect(await w.sessions.resolve(tokenReq(jti), principal())).toBeUndefined();
  });
});

describe('StoredPurchaseSessions.advance / get', () => {
  test('advance는 저장소의 일련번호 올리기를 그대로 따른다: 클 때만 true. 모양이 틀린 참조·번호는 저장소를 부르지 않고 false다 [ASVS v5.0.0-9.1.1]', async () => {
    const w = world();
    const s = await opened(w);
    expect(await w.sessions.advance(s.jti, 1)).toBe(true);
    expect(await w.sessions.advance(s.jti, 1)).toBe(false);
    expect(await w.sessions.advance(s.jti, 2)).toBe(true);
    const calls = w.advances.length;
    for (const [ref, seq] of [
      ['a}b', 5],
      ['', 5],
      [s.jti, 0],
      [s.jti, -1],
      [s.jti, 1.5],
      [s.jti, Number.NaN],
      [s.jti, Number.MAX_SAFE_INTEGER + 1],
    ] as Array<[string, number]>) {
      expect(await w.sessions.advance(ref, seq), `${ref} ${seq}`).toBe(false);
    }
    expect(w.advances).toHaveLength(calls);
  });

  test('ST28_ST35_get은 구매 세션 ID(= jti)·계정·회차·여정 ID를 주고, 없거나 끝났거나 최대 체류가 지났거나 참조 모양이 틀리면 undefined다', async () => {
    const w = world();
    const s = await opened(w);
    expect(await w.sessions.get(s.jti)).toEqual({ sessionId: s.jti, accountId: ACCOUNT, eventId: EVENT, journeyId: JOURNEY });
    expect(await w.sessions.get('a}b')).toBeUndefined();
    expect(await w.sessions.get('unknown')).toBeUndefined();
    w.clock.advance(45 * 60_000);
    expect(await w.sessions.get(s.jti)).toBeUndefined();
    const t = await opened(w);
    w.mem.endSession(t.jti);
    expect(await w.sessions.get(t.jti)).toBeUndefined();
  });

  test('ST28_get의 sessionId는 resolve가 준 ref와 같다(@CurrentPurchaseSession()의 참조 = 구매 세션 ID)', async () => {
    const w = world();
    const s = await opened(w);
    const r = await w.sessions.resolve(tokenReq(s.jti), principal());
    expect((await w.sessions.get(r!.ref))?.sessionId).toBe(r!.ref);
  });
});

// ── 구매 세션의 홀드 기록(PRF-137, docs/features/seat-hold.md §3 '구매 세션의 홀드 기록과 첫 홀드 표시') ──────────────────────────────────────────────────────
import { type HoldRecordHarness, sessionHoldRecordCases } from './session-hold-record-cases.js';

function memoryRecordHarness(): HoldRecordHarness & ReturnType<typeof memoryHarness> {
  const m = memoryHarness();
  return { ...m, holds: async (jti) => m.mem.holdsOf(jti), exists: async (jti) => (await m.store.read(jti)) !== undefined };
}

describe('MemoryPurchaseSessionStore.recordHold (홀드 기록 계약 사례)', () => {
  sessionHoldRecordCases(memoryRecordHarness);

  test('ADR0183_8_기록은 세션 상태의 수명을 늘리지 않는다: 기록은 세션과 같은 순간(처음 최대 체류 + 60초)에 사라지고 그 뒤의 기록은 null이다', async () => {
    const h = memoryRecordHarness();
    const jti = newJti();
    const i = openInput(h, jti);
    expect((await h.store.open(i)).kind).toBe('CREATED');
    await h.pass(10 * 60_000);
    expect(await h.store.recordHold(jti, 'hold-late', ['A01'])).toBe(true);
    // 세션 상태 수명 직전: 기록이 아직 있다
    await h.pass(i.expiresAtMs - h.now() + SESSION_KEY_GRACE_MS - 1);
    expect((await h.holds(jti))?.get('hold-late')).toEqual(['A01']);
    expect(await h.store.recordHold(jti, 'hold-last', ['A02'])).toBe(false);
    await h.pass(1);
    expect(await h.store.read(jti)).toBeUndefined();
    expect(await h.holds(jti)).toBeUndefined();
    expect(await h.store.recordHold(jti, 'hold-after', ['A03'])).toBeNull();
    expect(await h.holds(jti)).toBeUndefined();
  });
});

describe('RedisPurchaseSessionStore.recordHold의 호출 마감', () => {
  test('NFR003_recordHold의 SeatCallOptions.deadlineMs를 evalScript의 마감으로 넘기고, 없으면 빈 선택값이다(마감 칸 없음, 플랫폼 기본)', async () => {
    const seen: Array<unknown> = [];
    const redis = {
      evalScript: async (_s: unknown, _keys: string[], _args: string[], o?: unknown) => {
        seen.push(o);
        return -1;
      },
    } as unknown as ConstructorParameters<typeof RedisPurchaseSessionStore>[0];
    const store = new RedisPurchaseSessionStore(redis);
    expect(await store.recordHold('jti-1', 'hold-1', ['A01'], { deadlineMs: 17 })).toBeNull();
    expect(await store.recordHold('jti-1', 'hold-1', ['A01'])).toBeNull();
    expect(seen[0]).toEqual({ deadlineMs: 17 });
    expect(seen[1]).toEqual({});
  });
});

// ── 구매 세션 종료와 정리(PRF-138, docs/features/seat-hold.md §2 '구매 세션 종료와 정리', 상태 기계 docs/planning/03 §2.2 T4~T12) ──────────────────────────────────
import { SESSION_IDLE_MS } from '../src/modules/inventory/index.js';
import { sessionEndCases } from './session-end-cases.js';

describe('MemoryPurchaseSessionStore.end·sweep·setPaying (종료·정리 계약 사례)', () => {
  sessionEndCases(memoryHarness);

  test('QT11_POL009_경계: 지금이 유휴 시한과 같으면 IDLE로 끝나고, 1ms 앞이면 LIVE다(지금 ≥ 유휴 시한). 끝낸 시각은 주입 시계의 지금이다', async () => {
    const h = memoryHarness();
    const jti = newJti();
    const r = await h.store.open(openInput(h, jti));
    if (r.kind !== 'CREATED') throw new Error('CREATED여야 한다');
    await h.pass(SESSION_IDLE_MS - 1);
    expect(await h.store.sweep(jti)).toEqual({ kind: 'LIVE', nextCheckMs: r.startedAtMs + SESSION_IDLE_MS });
    await h.pass(1);
    expect(await h.store.sweep(jti)).toEqual({ kind: 'ENDED', reason: 'IDLE', eventId: EVENT, journeyId: JOURNEY, endedAtMs: r.startedAtMs + SESSION_IDLE_MS });
    expect(await h.store.sweep(jti)).toEqual({ kind: 'GONE' });
  });

  test('QT11_ADR0183_8_경계: 최대 체류가 유휴 시한보다 이르면 지금이 최대 체류와 같을 때 MAX_STAY로 끝나고, 1ms 앞이면 LIVE(다음 점검 = 최대 체류)다', async () => {
    const h = memoryHarness();
    const jti = newJti();
    const i = openInput(h, jti, { expiresAtMs: NOW + 200_000 });
    expect((await h.store.open(i)).kind).toBe('CREATED');
    await h.pass(199_999);
    expect(await h.store.sweep(jti)).toEqual({ kind: 'LIVE', nextCheckMs: NOW + 200_000 });
    await h.pass(1);
    expect(await h.store.sweep(jti)).toEqual({ kind: 'ENDED', reason: 'MAX_STAY', eventId: EVENT, journeyId: JOURNEY, endedAtMs: NOW + 200_000 });
  });

  test('QT11_POL009_경계: Paying 세션은 유휴 시한을 한참 넘겨도 최대 체류 1ms 앞까지 LIVE(다음 점검 = 최대 체류)이고 최대 체류에서 MAX_STAY로 끝난다', async () => {
    const h = memoryHarness();
    const jti = newJti();
    const i = openInput(h, jti, { expiresAtMs: NOW + 20 * 60_000 });
    expect((await h.store.open(i)).kind).toBe('CREATED');
    expect(await h.store.setPaying(jti, true)).toBe(true);
    await h.pass(20 * 60_000 - 1);
    expect(await h.store.sweep(jti)).toEqual({ kind: 'LIVE', nextCheckMs: i.expiresAtMs });
    await h.pass(1);
    expect(await h.store.sweep(jti)).toMatchObject({ kind: 'ENDED', reason: 'MAX_STAY', endedAtMs: i.expiresAtMs });
  });

  test('QT11_메모리 키 수명 모형: 세션 상태 키가 사라진 뒤(처음 최대 체류 + 60초)의 end·sweep·setPaying은 null·GONE·false다', async () => {
    const h = memoryHarness();
    const jti = newJti();
    const i = openInput(h, jti);
    expect((await h.store.open(i)).kind).toBe('CREATED');
    await h.pass(i.expiresAtMs - h.now() + SESSION_KEY_GRACE_MS - 1);
    expect(await h.store.sweep(jti)).toMatchObject({ kind: 'ENDED', reason: 'MAX_STAY' });

    const gone = newJti();
    const j = openInput(h, gone, { expiresAtMs: h.now() + 1_000 });
    expect((await h.store.open(j)).kind).toBe('CREATED');
    await h.pass(1_000 + SESSION_KEY_GRACE_MS);
    expect(await h.store.sweep(gone)).toEqual({ kind: 'GONE' });
    expect(await h.store.end(gone)).toBeNull();
    expect(await h.store.setPaying(gone, true)).toBe(false);
  });

  test('QT11_메모리 end는 세션 상태와 함께 홀드 기록·시작 표시·첫 홀드 표시를 지운다: 같은 jti로 다시 열 수 없으니 되살아날 길이 없다', async () => {
    const h = memoryRecordHarness();
    const jti = newJti();
    expect((await h.store.open(openInput(h, jti))).kind).toBe('CREATED');
    expect(await h.store.recordHold(jti, 'hold-1', ['A01'])).toBe(true);
    expect(await h.store.markStarted(jti)).toBe(true);
    expect((await h.holds(jti))?.get('hold-1')).toEqual(['A01']);
    expect(await h.store.end(jti)).toMatchObject({ eventId: EVENT, journeyId: JOURNEY });
    expect(await h.holds(jti)).toBeUndefined();
    expect(await h.store.recordHold(jti, 'hold-2', ['A02'])).toBeNull();
    expect(await h.holds(jti)).toBeUndefined();
  });
});

describe('RedisPurchaseSessionStore.end·sweep·setPaying의 Lua 호출 (가짜 Redis)', () => {
  interface Call {
    keys: string[];
    args: string[];
    o: unknown;
  }
  /** 스크립트 호출을 모으고 미리 정한 답을 차례로 돌려주는 가짜 좌석 Redis */
  function fake(replies: unknown[]) {
    const calls: Call[] = [];
    const redis = {
      evalScript: async (_s: unknown, keys: string[], args: string[], o?: unknown) => {
        calls.push({ keys, args, o });
        return replies[calls.length - 1];
      },
    } as unknown as ConstructorParameters<typeof RedisPurchaseSessionStore>[0];
    return { calls, store: new RedisPurchaseSessionStore(redis) };
  }

  test('NFR003_end·sweep·setPaying는 Lua 한 번씩이다: KEYS = [s:session:{jti}], sweep의 ARGV = [유휴 ms], setPaying의 ARGV = [1 또는 0, 유휴 ms]이고 SeatCallOptions.deadlineMs를 evalScript의 마감으로 넘기며 없으면 빈 선택값이다', async () => {
    const f = fake([['GONE'], ['GONE'], 0, ['GONE'], ['GONE'], 0]);
    expect(await f.store.end('jti-1', { deadlineMs: 17 })).toBeNull();
    expect(await f.store.sweep('jti-1', { deadlineMs: 19 })).toEqual({ kind: 'GONE' });
    expect(await f.store.setPaying('jti-1', true, { deadlineMs: 23 })).toBe(false);
    expect(await f.store.end('jti-1')).toBeNull();
    expect(await f.store.sweep('jti-1')).toEqual({ kind: 'GONE' });
    expect(await f.store.setPaying('jti-1', false)).toBe(false);
    expect(f.calls.map((c) => c.o)).toEqual([{ deadlineMs: 17 }, { deadlineMs: 19 }, { deadlineMs: 23 }, {}, {}, {}]);
    expect(f.calls.every((c) => c.keys.length === 1 && c.keys[0] === sessionKeys.session('jti-1'))).toBe(true);
    expect(f.calls[0]!.args).toEqual([]);
    expect(f.calls[1]!.args).toEqual([String(SESSION_IDLE_MS)]); // 점검 Lua의 ARGV 1 = 유휴 ms(Paying이어도 이만큼마다 다시 본다)
    expect(f.calls[2]!.args).toEqual(['1', String(SESSION_IDLE_MS)]);
    expect(f.calls[5]!.args).toEqual(['0', String(SESSION_IDLE_MS)]);
  });

  test('QT11_end의 Lua 답을 읽는다: ["ENDED", 회차, 여정]은 { eventId, journeyId }, ["GONE"]은 null이고 모르는 답은 일시 장애가 아닌 Error다', async () => {
    const f = fake([['ENDED', 'ev-1', JOURNEY], [Buffer.from('ENDED'), Buffer.from('ev-2'), Buffer.from(JOURNEY)], ['GONE'], ['WAT'], 'ENDED', null]);
    expect(await f.store.end('jti-1')).toEqual({ eventId: 'ev-1', journeyId: JOURNEY });
    expect(await f.store.end('jti-1')).toEqual({ eventId: 'ev-2', journeyId: JOURNEY });
    expect(await f.store.end('jti-1')).toBeNull();
    for (let k = 0; k < 3; k++) {
      const err = await f.store.end('jti-1').then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(RangeError);
    }
  });

  test('QT11_sweep의 Lua 답을 읽는다: LIVE는 다음 점검 시각, ENDED는 까닭(IDLE·MAX_STAY)·회차·여정·끝낸 시각, GONE이고 모르는 답·까닭·시각은 Error다', async () => {
    const f = fake([
      ['LIVE', '1793761199000'],
      ['LIVE', 1793761199000],
      ['ENDED', 'IDLE', 'ev-1', JOURNEY, '1793761199500'],
      ['ENDED', 'MAX_STAY', 'ev-2', JOURNEY, 1793761199500],
      ['GONE'],
      ['WAT'],
      ['ENDED', 'LEFT', 'ev-1', JOURNEY, '1793761199500'],
      ['ENDED', 'COMPLETED', 'ev-1', JOURNEY, '1793761199500'],
      ['LIVE', 'abc'],
      ['LIVE', '1.5'],
      ['ENDED', 'IDLE', 'ev-1', JOURNEY, 'abc'],
    ]);
    expect(await f.store.sweep('jti-1')).toEqual({ kind: 'LIVE', nextCheckMs: 1793761199000 });
    expect(await f.store.sweep('jti-1')).toEqual({ kind: 'LIVE', nextCheckMs: 1793761199000 });
    expect(await f.store.sweep('jti-1')).toEqual({ kind: 'ENDED', reason: 'IDLE', eventId: 'ev-1', journeyId: JOURNEY, endedAtMs: 1793761199500 });
    expect(await f.store.sweep('jti-1')).toEqual({ kind: 'ENDED', reason: 'MAX_STAY', eventId: 'ev-2', journeyId: JOURNEY, endedAtMs: 1793761199500 });
    expect(await f.store.sweep('jti-1')).toEqual({ kind: 'GONE' });
    for (let k = 0; k < 6; k++) {
      const err = await f.store.sweep('jti-1').then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err, `모르는 답 ${k}`).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(RangeError);
    }
  });

  test('POL009_setPaying의 Lua 답을 읽는다: 1(글 "1" 포함)은 true, 0은 false이고 그 밖은 Error다', async () => {
    const f = fake([1, '1', Buffer.from('1'), 0, '0', 7, 'x']);
    expect(await f.store.setPaying('jti-1', true)).toBe(true);
    expect(await f.store.setPaying('jti-1', true)).toBe(true);
    expect(await f.store.setPaying('jti-1', false)).toBe(true);
    expect(await f.store.setPaying('jti-1', true)).toBe(false);
    expect(await f.store.setPaying('jti-1', false)).toBe(false);
    await expect(f.store.setPaying('jti-1', true)).rejects.toThrow();
    await expect(f.store.setPaying('jti-1', true)).rejects.toThrow();
  });

  test('end·sweep·setPaying는 jti가 키 조각 모양이 아니면 Redis를 부르지 않고 RangeError다 [ASVS v5.0.0-1.2.4]', async () => {
    const f = fake([]);
    for (const bad of ['', 'a}b', '{x}', 'a:b', 'x'.repeat(65)]) {
      await expect(f.store.end(bad), bad).rejects.toThrow(RangeError);
      await expect(f.store.sweep(bad), bad).rejects.toThrow(RangeError);
      await expect(f.store.setPaying(bad, true), bad).rejects.toThrow(RangeError);
    }
    expect(f.calls).toHaveLength(0);
  });
});
