// 입장 확정: 메모리 저장소로 사례를 돌리고(test/admission-cases.ts), 입장 토큰 서명과 받는 층(HTTP)을 본다.
import 'reflect-metadata';
import { generateKeyPairSync } from 'node:crypto';
import { Writable } from 'node:stream';
import { createService, systemClock } from '@peaket/platform';
import { PurchaseSessionEnded, PurchaseSessionStarted } from '@peaket/contracts/asyncapi';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { ADMISSION_TOKEN_ISSUER_ENV, ADMISSION_TOKEN_KEY_ENV, Es256AdmissionTokens, PURCHASE_ECDH_PUBLIC_JWK_ENV } from '../src/modules/admission/adapters/es256-admission-tokens.js';
import { MemoryAdmissionStore } from '../src/modules/admission/adapters/memory-admission-store.js';
import { PurchaseSessionSlots } from '../src/modules/admission/application/purchase-session-slots.js';
import { AppModule } from '../src/app.module.js';
import { MemoryEventSchedules } from '../src/modules/entry/adapters/memory-entry-store.js';
import { ADMISSION_JWK, admissionCases, type AdmissionHarness, ISSUER, readAdmissionToken, signer } from './admission-cases.js';
import { pidTransitionAdmissionCases } from './pid-transition-cases.js';
import { ACCOUNT, DEVICE, JNY, newEvent, openSchedule, PID, recordingRisk, tokens } from './support.js';

function memoryHarness(): AdmissionHarness {
  const store = new MemoryAdmissionStore(systemClock);
  const db = store.db;
  const schedules = new MemoryEventSchedules();
  return {
    store,
    clock: systemClock,
    schedules,
    setServing: async (e, n) => void db.ev(e).set('serving', n),
    logServing: async (e, at, n) => void db.servingLog(e).set(String(Math.floor(at / 1000)), n),
    addCall: async (e, last, at, valid) => {
      const m = `${at}:${valid}`;
      db.calls(e).set(m, last);
      return m;
    },
    callReq: async (e, m) => db.callReq(e).get(m) ?? 0,
    setRemoved: async (e, seq) => void db.removed(e).add(seq),
    isRemoved: async (e, seq) => db.removed(e).has(seq),
    setVerify: async (e, h, v) => void db.verify(e).set(h, v),
    verifyOf: async (e, h) => db.verify(e).get(h) ?? null,
    removedList: async (e) => [...db.removed(e)].sort((a, b) => a - b),
    addSkipped: async (e, line) => void db.skipped(e).push(line),
    setNotice: async (e, f) => void Object.entries(f).forEach(([k, v]) => db.notice(e).set(k, v)),
    setTarget: async (e, n) => void db.ctl(e).set('targetNow', String(n)),
    addSlot: async (e, jti, at) => void db.slots(e).set(jti, at),
    slots: async (e) => new Map(db.slots(e)),
    soon: async (e) => [...db.soon(e).entries()].sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1)).map(([h]) => h),
    soonFirst: async (e, h) => db.soonFirst(e).get(h) ?? null,
    dropSoon: async (e, h) => {
      db.soon(e).delete(h);
      db.soonAt(e).delete(h);
      db.soonFirst(e).delete(h);
    },
    admitted: async (e) => db.ev(e).get('admitted') ?? 0,
    setLobbyResult: async (h, s, g) => void db.lobbyResults.set(h, `${s}:${g}`),
    addLobbyMember: async (e, h) => void db.lobbyMembers(e).add(h),
    setLobbyPublished: async (e, at) => void db.batchDone(e).set('pub:lobby', String(at)),
    lobbyRepair: async (e) => db.batchDone(e).get('repair:lobby') ?? null,
    setDup: async (p, e, v) => void db.dup.set(`${p}|${e}`, v),
    dup: async (p, e) => db.dup.get(`${p}|${e}`) ?? null,
    adm: async (p, e) => db.adm.get(`${p}|${e}`) ?? null,
    setAdm: async (p, e, v) => void db.adm.set(`${p}|${e}`, v),
    setIssuedAt: async (e, h, at) => store.setIssuedAtForTest(e, h, at),
  };
}

admissionCases('메모리', async () => memoryHarness());
pidTransitionAdmissionCases('메모리', async () => memoryHarness());

describe('입장 토큰 서명(ES256, ADR-0050 결정 9, ADR-0183)', () => {
  test('[ASVS v5.0.0-9.2.2] 머리는 alg ES256·typ admission+jwt·kid이고 클레임은 iss·sub·aud purchase·jti·sid·event·jny·iat·exp(= iat + 45분)이다', () => {
    const now = 1_790_000_000_123;
    const { token, expiresAtMs } = signer.sign({ jti: 'j-1', accountId: ACCOUNT, sessionId: 's-1', eventId: 'ev-1', jny: JNY, nowMs: now });
    const { header, claims } = readAdmissionToken(token);
    expect(header).toEqual({ alg: 'ES256', typ: 'admission+jwt', kid: 'adm-1' });
    expect(claims).toEqual({ iss: ISSUER, sub: ACCOUNT, aud: 'purchase', jti: 'j-1', sid: 's-1', event: 'ev-1', jny: JNY, iat: 1_790_000_000, exp: 1_790_000_000 + 45 * 60 });
    expect(expiresAtMs).toBe(1_790_002_700_000);
  });

  test('설정 확인: 개인 JWK가 아니거나 P-256이 아니거나 kid가 없거나 발급자가 https가 아니면 시작하지 않는다', () => {
    const iss = { [ADMISSION_TOKEN_ISSUER_ENV]: ISSUER };
    expect(() => Es256AdmissionTokens.fromEnv(iss)).toThrow(ADMISSION_TOKEN_KEY_ENV);
    expect(() => Es256AdmissionTokens.fromEnv({ ...iss, [ADMISSION_TOKEN_KEY_ENV]: 'not json' })).toThrow();
    const { d: _d, ...pub } = ADMISSION_JWK;
    expect(() => Es256AdmissionTokens.fromEnv({ ...iss, [ADMISSION_TOKEN_KEY_ENV]: JSON.stringify(pub) })).toThrow('개인 JWK');
    const { kid: _kid, ...noKid } = ADMISSION_JWK;
    expect(() => Es256AdmissionTokens.fromEnv({ ...iss, [ADMISSION_TOKEN_KEY_ENV]: JSON.stringify(noKid) })).toThrow('kid');
    const p384 = { ...generateKeyPairSync('ec', { namedCurve: 'P-384' }).privateKey.export({ format: 'jwk' }), kid: 'x' };
    expect(() => Es256AdmissionTokens.fromEnv({ ...iss, [ADMISSION_TOKEN_KEY_ENV]: JSON.stringify(p384) })).toThrow('P-256');
    expect(() => Es256AdmissionTokens.fromEnv({ [ADMISSION_TOKEN_ISSUER_ENV]: 'http://queue', [ADMISSION_TOKEN_KEY_ENV]: JSON.stringify(ADMISSION_JWK) })).toThrow('https');
  });

  test('서버 ECDH 공개키는 설정한 공개 JWK만 싣고(개인 성분이 있으면 시작하지 않는다) 없으면 뺀다', () => {
    const base = { [ADMISSION_TOKEN_ISSUER_ENV]: ISSUER, [ADMISSION_TOKEN_KEY_ENV]: JSON.stringify(ADMISSION_JWK) };
    expect(Es256AdmissionTokens.fromEnv(base).serverEcdhPublicKey()).toBeUndefined();
    const ecdh = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'jwk' });
    const { d: _d, ...pub } = ecdh;
    const signerWithEcdh = Es256AdmissionTokens.fromEnv({ ...base, [PURCHASE_ECDH_PUBLIC_JWK_ENV]: JSON.stringify({ ...pub, kid: 'ecdh-1' }) });
    expect(signerWithEcdh.serverEcdhPublicKey()).toEqual({ kty: 'EC', crv: 'P-256', x: pub.x, y: pub.y, kid: 'ecdh-1' });
    expect(() => Es256AdmissionTokens.fromEnv({ ...base, [PURCHASE_ECDH_PUBLIC_JWK_ENV]: JSON.stringify({ ...ecdh, kid: 'e' }) })).toThrow('공개 JWK');
  });
});

describe('구매 세션 사건(asyncapi trade.purchase-sessions, Q-T11)', () => {
  test('계약 모양의 시작 사건은 남은 자리를 최대 체류 시각으로 올리고, 종료 사건은 자리를 뺀다. 날짜가 아니면 던진다', async () => {
    const store = new MemoryAdmissionStore(systemClock);
    const slots = new PurchaseSessionSlots(store);
    const eventId = newEvent();
    store.db.slots(eventId).set('j-1', Date.now() + 60_000);
    const maxStayUntil = new Date(Date.now() + 45 * 60_000).toISOString();
    const started = PurchaseSessionStarted.parse({ eventId, purchaseSessionId: 'ps-1', admissionJti: 'j-1', journeyId: JNY, startedAt: new Date().toISOString(), maxStayUntil, eventKey: crypto.randomUUID() });
    expect(await slots.started(started)).toBe(true);
    expect(store.db.slots(eventId).get('j-1')).toBe(Date.parse(maxStayUntil));
    await expect(slots.started({ ...started, maxStayUntil: 'x' })).rejects.toThrow('maxStayUntil');
    const ended = PurchaseSessionEnded.parse({ eventId, purchaseSessionId: 'ps-1', admissionJti: 'j-1', reason: 'LEFT', endedAt: new Date().toISOString(), eventKey: crypto.randomUUID() });
    expect(await slots.ended(ended)).toBe(true);
    expect(store.db.slots(eventId).size).toBe(0);
    expect(await slots.started(started)).toBe(false);
  });
});

describe('받는 층: POST /v1/queues/{eventId}/admission', () => {
  let svc: Awaited<ReturnType<typeof createService>>;
  const quiet = new Writable({ write: (_c, _e, cb) => cb() });
  const schedules = new MemoryEventSchedules();
  const store = new MemoryAdmissionStore(systemClock);

  beforeAll(async () => {
    svc = await createService({
      name: 'queue-svc',
      module: AppModule.register({ memory: true, schedules, tokens, risk: recordingRisk(), state: { autoTick: false }, admission: { store, signer } }),
      env: { PEAKET_ENV: 'ci' },
      clock: systemClock,
      logDestination: quiet,
    });
  });
  afterAll(async () => {
    await svc?.close();
  });

  const fan = (o: { scope?: string; pid?: string | null } = {}) => ({
    'x-user-id': ACCOUNT,
    'x-session-id': 's-1',
    'x-user-aud': 'fan',
    'x-user-scope': o.scope ?? 'ticket:buy',
    ...(o.pid === null ? {} : { 'x-user-pid': o.pid ?? PID }),
  });

  const world = async (serving = 200, turnAgoMs = 60_000) => {
    const eventId = newEvent();
    const now = Date.now();
    await schedules.set(eventId, openSchedule(now));
    store.db.ev(eventId).set('serving', serving);
    store.db.servingLog(eventId).set(String(Math.floor((now - turnAgoMs) / 1000)), serving);
    const ticket = (seq: number) => tokens.ticket({ e: eventId, a: ACCOUNT, d: DEVICE, s: seq, g: 1, seg: 0, rq: crypto.randomUUID(), jny: JNY });
    return { eventId, ticket };
  };
  const post = (eventId: string, payload: string, contentType = 'text/plain;charset=UTF-8', headers: Record<string, string> = fan()) =>
    svc.http.inject({ method: 'POST', url: `/v1/queues/${eventId}/admission`, headers: { ...headers, 'content-type': contentType }, payload });

  test('[ASVS v5.0.0-14.3.2] text/plain 본문으로 받아 200 ADMITTED·입장 토큰·서버 시각을 주고 캐시하지 않는다(Q-T41 ①)', async () => {
    const { eventId, ticket } = await world();
    const res = await post(eventId, JSON.stringify({ queueTicket: ticket(150) }));
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = JSON.parse(res.payload) as { status: string; admissionToken: string; serverTimeMs: number; verificationReason: null };
    expect(body.status).toBe('ADMITTED');
    expect(body.verificationReason).toBeNull();
    expect(Math.abs(body.serverTimeMs - Date.now())).toBeLessThan(5_000);
    expect(readAdmissionToken(body.admissionToken).claims).toMatchObject({ event: eventId, sid: 's-1', sub: ACCOUNT });
  });

  test('BAS-042 ADMITTED 응답에 입장 토큰의 만료(exp)를 purchaseSessionExpiresAt(ISO 시각)으로 싣는다(ADR-0214 결정 8)', async () => {
    const { eventId, ticket } = await world();
    const res = await post(eventId, JSON.stringify({ queueTicket: ticket(151) }));
    const body = JSON.parse(res.payload) as { status: string; admissionToken: string; purchaseSessionExpiresAt: string };
    expect(body.status).toBe('ADMITTED');
    expect(body.purchaseSessionExpiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(Date.parse(body.purchaseSessionExpiresAt)).toBe(Number(readAdmissionToken(body.admissionToken).claims.exp) * 1000);
  });

  test('BAS-042 같은 대기표로 다시 받은 입장 토큰도 첫 발급의 만료(exp)를 지키고 purchaseSessionExpiresAt도 그 시각이다(HOT-010 리뷰)', async () => {
    const { eventId, ticket } = await world();
    const t = ticket(152);
    const first = JSON.parse((await post(eventId, JSON.stringify({ queueTicket: t }))).payload) as { admissionToken: string; purchaseSessionExpiresAt: string };
    await new Promise((r) => setTimeout(r, 1_100));
    const again = JSON.parse((await post(eventId, JSON.stringify({ queueTicket: t }))).payload) as { admissionToken: string; purchaseSessionExpiresAt: string };
    const c1 = readAdmissionToken(first.admissionToken).claims;
    const c2 = readAdmissionToken(again.admissionToken).claims;
    expect(c2.jti).toBe(c1.jti);
    expect(Number(c2.iat)).toBeGreaterThan(Number(c1.iat));
    expect(c2.exp).toBe(c1.exp);
    expect(again.purchaseSessionExpiresAt).toBe(first.purchaseSessionExpiresAt);
  });

  test('[ASVS v5.0.0-3.5.2] 입장 확정은 application/json도 받고 그 밖의 형식은 415다', async () => {
    const { eventId, ticket } = await world();
    expect((await post(eventId, JSON.stringify({ queueTicket: ticket(150) }), 'application/json')).statusCode).toBe(200);
    expect((await post(eventId, 'queueTicket=x', 'application/x-www-form-urlencoded')).statusCode).toBe(415);
  });

  test('관측용 칸(firstEtaSec·firstEtaAtMs)의 모양이 틀려도 입장 확정은 400이 아니다(ADR-0183 결정 10)', async () => {
    const { eventId, ticket } = await world();
    const res = await post(eventId, JSON.stringify({ queueTicket: ticket(150), firstEtaSec: 1.5, firstEtaAtMs: 'soon' }));
    expect(res.statusCode).toBe(200);
  });

  test('본문이 비면 400, 대기표가 틀리면 403 queue-ticket-invalid, 다른 대기표 409 duplicate-admission, 만료 410 queue-ticket-expired(rejoinAllowed)', async () => {
    const { eventId, ticket } = await world();
    expect((await post(eventId, '{}')).statusCode).toBe(400);
    // 본문은 계약처럼 닫혀 있다(정하지 않은 칸은 400, BAS-040). 관측용 칸(firstEtaSec·firstEtaAtMs)은 모양만 묻지 않는다
    expect((await post(eventId, JSON.stringify({ queueTicket: ticket(150), zzz: 1 }))).statusCode).toBe(400);
    const bad = await post(eventId, JSON.stringify({ queueTicket: 'v1.k1.x.y' }));
    expect(bad.statusCode).toBe(403);
    expect(JSON.parse(bad.payload).type).toContain('queue-ticket-invalid');
    expect((await post(eventId, JSON.stringify({ queueTicket: ticket(150) }))).statusCode).toBe(200);
    const dup = await post(eventId, JSON.stringify({ queueTicket: ticket(160) }));
    expect(dup.statusCode).toBe(409);
    expect(JSON.parse(dup.payload).type).toContain('duplicate-admission');
    const late = await world(200, 20 * 60_000);
    const gone = await post(late.eventId, JSON.stringify({ queueTicket: late.ticket(150) }), 'text/plain;charset=UTF-8', fan({ pid: 'pid-late' }));
    expect(gone.statusCode).toBe(410);
    expect(JSON.parse(gone.payload)).toMatchObject({ rejoinAllowed: true });
    expect(JSON.parse(gone.payload).type).toContain('queue-ticket-expired');
  });

  test('Q-T34 ⑥ 기각된 대기표의 입장 확정은 410 queue-ticket-removed와 확장 칸 removeReason BLOCKED이고, 다른 빠진 번호는 그 칸이 없다', async () => {
    const { eventId, ticket } = await world();
    const blocked = ticket(150);
    store.db.removed(eventId).add(150);
    store.db.verify(eventId).set(tokens.hash(blocked), `BLOCKED:${Date.now()}:NETWORK`);
    const res = await post(eventId, JSON.stringify({ queueTicket: blocked }), 'text/plain;charset=UTF-8', fan({ pid: 'pid-blocked' }));
    expect(res.statusCode).toBe(410);
    expect(res.headers['content-type']).toContain('application/problem+json');
    const body = JSON.parse(res.payload) as Record<string, unknown>;
    expect(body.type).toMatch(/queue-ticket-removed$/);
    expect(body.removeReason).toBe('BLOCKED');
    expect('rejoinAllowed' in body).toBe(false);
    // 취소·중복으로 빠진 번호는 확장 칸 없이 같은 410이다(어떤 대기표가 왜 빠졌는지 더 드러내지 않는다)
    const left = ticket(151);
    store.db.removed(eventId).add(151);
    const other = await post(eventId, JSON.stringify({ queueTicket: left }), 'text/plain;charset=UTF-8', fan({ pid: 'pid-left' }));
    expect(other.statusCode).toBe(410);
    const otherBody = JSON.parse(other.payload) as Record<string, unknown>;
    expect(otherBody.type).toMatch(/queue-ticket-removed$/);
    expect('removeReason' in otherBody).toBe(false);
  });

  test('Q-T34 ⑤ 통과 전 입장 확정은 200 VERIFYING과 사유 범주이고, 통과하면 빠진 번호여도 200 ADMITTED다', async () => {
    const { eventId, ticket } = await world();
    const t = ticket(160);
    store.db.removed(eventId).add(160);
    store.db.verify(eventId).set(tokens.hash(t), `VERIFYING:${Date.now()}:INTERACTION`);
    const res = await post(eventId, JSON.stringify({ queueTicket: t }), 'text/plain;charset=UTF-8', fan({ pid: 'pid-verifying' }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toMatchObject({ status: 'VERIFYING', verificationReason: 'INTERACTION' });
    store.db.verify(eventId).set(tokens.hash(t), `PASSED:${Date.now()}:INTERACTION`);
    const passed = await post(eventId, JSON.stringify({ queueTicket: t }), 'text/plain;charset=UTF-8', fan({ pid: 'pid-verifying' }));
    expect(passed.statusCode).toBe(200);
    expect(JSON.parse(passed.payload)).toMatchObject({ status: 'ADMITTED', verificationReason: null });
  });

  test('[Q-T45] 옛 pid 머리(X-User-Pid-Prev)가 오면 옛 pid 키로도 1인 1순번을 보고, 키에 넣을 수 없는 모양이면 403 본인확인 필요다', async () => {
    const { eventId, ticket } = await world();
    const OLD = `pid-old-${crypto.randomUUID().slice(0, 8)}`;
    const NEW = `pid-new-${crypto.randomUUID().slice(0, 8)}`;
    const body = (t: string) => JSON.stringify({ queueTicket: t });
    expect((await post(eventId, body(ticket(150)), undefined, fan({ pid: OLD }))).statusCode).toBe(200);
    const dup = await post(eventId, body(ticket(160)), undefined, { ...fan({ pid: NEW }), 'x-user-pid-prev': OLD });
    expect(dup.statusCode).toBe(409);
    expect(JSON.parse(dup.payload).type).toMatch(/duplicate-admission$/);
    const bad = await post(eventId, body(ticket(170)), undefined, { ...fan({ pid: NEW }), 'x-user-pid-prev': 'pid:{x}' });
    expect(bad.statusCode).toBe(403);
    expect(JSON.parse(bad.payload).type).toMatch(/identity-verification-required$/);
  });

  test('곧 입장은 200 SOON과 retryAfterSeconds, 차례 전은 200 NOT_YET과 retryAfterMs, 우선 구매 권리는 404다', async () => {
    const { eventId, ticket } = await world();
    store.db.ctl(eventId).set('targetNow', '0');
    const soon = await post(eventId, JSON.stringify({ queueTicket: ticket(150) }));
    expect(JSON.parse(soon.payload)).toMatchObject({ status: 'SOON', retryAfterSeconds: 5, verificationReason: null });
    const early = await post(eventId, JSON.stringify({ queueTicket: ticket(999) }), 'text/plain;charset=UTF-8', fan({ pid: 'pid-other' }));
    expect(JSON.parse(early.payload)).toMatchObject({ status: 'NOT_YET', retryAfterMs: 60_000 });
    const prio = await post(eventId, JSON.stringify({ priorityGrantId: '0190f3a1-7c2e-7a00-8000-0000000000cc' }));
    expect(prio.statusCode).toBe(404);
    expect(JSON.parse(prio.payload).type).toContain('priority-grant-not-found');
  });

  test('본인확인 전(pid 없음)이나 구매 권한이 없으면 막는다', async () => {
    const { eventId, ticket } = await world();
    expect((await post(eventId, JSON.stringify({ queueTicket: ticket(150) }), 'text/plain;charset=UTF-8', fan({ pid: null }))).statusCode).toBe(403);
    expect((await post(eventId, JSON.stringify({ queueTicket: ticket(150) }), 'text/plain;charset=UTF-8', fan({ scope: '' }))).statusCode).toBe(403);
  });
});
