// 구매 세션 저장소의 메모리 구현과 플랫폼 구매 요청 인증 포트(resolve·advance)·세션 읽기(get)의 운영 어댑터 StoredPurchaseSessions
// (docs/features/seat-hold.md §2 '구매 세션 열기와 확인의 첫 구현', BUILD_ORDER PRF-136). 실제 Valkey Lua는 test-int/purchase-session.int.test.ts가 같은 사례로 돈다.
import { diffieHellman, generateKeyPairSync } from 'node:crypto';
import { fakeClock, type Principal, purchaseRequestKey } from '@peaket/platform';
import type { FastifyRequest } from 'fastify';
import { describe, expect, test } from 'vitest';
import {
  KEY_PART,
  MemoryPurchaseSessionStore,
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
  test('ST28_ASVS8.2.1_표지 s:jti:{jti}와 세션 상태 s:session:{jti}는 해시 태그가 같아 같은 슬롯이다(열기가 Lua 한 번). 회차 Stream과는 다른 슬롯이다 [ASVS v5.0.0-8.2.1]', () => {
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
    recordHold: (jti, holdId, seatIds) => mem.recordHold(jti, holdId, seatIds),
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
  test('ASVS8.2.1_ST16_세션이 있고 계정·로그인 세션이 맞으면 { ref: jti, key }를 주고 key는 클라이언트가 따로 계산한 요청 인증 키와 같다 [ASVS v5.0.0-8.2.1]', async () => {
    const w = world();
    const s = await opened(w);
    const r = await w.sessions.resolve(tokenReq(s.jti), principal());
    expect(r?.ref).toBe(s.jti);
    expect(Buffer.from(r!.key as Uint8Array).equals(s.key)).toBe(true);
  });

  test('ASVS8.2.1_resolve는 구매 세션 상태를 한 번 읽을 뿐 일련번호를 올리지 않는다 [ASVS v5.0.0-8.2.1]', async () => {
    const w = world();
    const s = await opened(w);
    await w.sessions.resolve(tokenReq(s.jti), principal());
    expect(w.reads).toEqual([s.jti]);
    expect(w.advances).toEqual([]);
    expect((await w.mem.read(s.jti))?.lastSeq).toBe(0);
  });

  test('ASVS8.2.1_입장 토큰 머리가 없거나 하나가 아니거나 모양이 틀리거나 jti가 키 조각 모양이 아니면 undefined이고 저장소를 읽지 않는다 [ASVS v5.0.0-8.2.1]', async () => {
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

  test('ASVS8.2.1_ASVS8.2.2_남의 jti로는 세션을 못 찾는다: 계정이나 로그인 세션이 구매 세션 상태와 다르면 undefined다(헤더의 jti는 조회 손잡이일 뿐이다) [ASVS v5.0.0-8.2.1] [ASVS v5.0.0-8.2.2]', async () => {
    const w = world();
    const s = await opened(w);
    expect(await w.sessions.resolve(tokenReq(s.jti), principal({ accountId: 'acct-2' }))).toBeUndefined();
    expect(await w.sessions.resolve(tokenReq(s.jti), principal({ sessionId: 'login-2' }))).toBeUndefined();
    expect(await w.sessions.resolve(tokenReq('unknown-jti'), principal())).toBeUndefined();
  });

  test('ASVS9.2.1_최대 체류가 지났거나 세션이 끝났으면 undefined다 [ASVS v5.0.0-9.2.1]', async () => {
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

  test('ASVS8.2.1_저장된 임시 공개키가 망가졌으면(곡선 위의 점이 아님) 세션이 없는 것으로 본다. 던지지 않는다 [ASVS v5.0.0-8.2.1]', async () => {
    const w = world();
    const jti = newJti();
    // 저장소 계약은 점 검증을 하지 않는다. 운영에서는 열기 유스케이스가 거르지만, 저장소가 망가져도 resolve가 500을 내지 않는다
    await w.mem.open(openInput({ now: () => w.clock.now() }, jti, { clientKey: Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]).toString('base64url') }));
    expect(parseClientEphemeralKey(Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]).toString('base64url'))).toBeUndefined();
    expect(await w.sessions.resolve(tokenReq(jti), principal())).toBeUndefined();
  });
});

describe('StoredPurchaseSessions.advance / get', () => {
  test('ASVS9.1.1_advance는 저장소의 일련번호 올리기를 그대로 따른다: 클 때만 true. 모양이 틀린 참조·번호는 저장소를 부르지 않고 false다 [ASVS v5.0.0-9.1.1]', async () => {
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
