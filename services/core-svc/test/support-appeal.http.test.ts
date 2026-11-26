// F-04-15 core-svc support 모듈 HTTP 시험(동결 로컬, LCH-310).
// 정본: docs/features/forensic-replay.md §6.7.5 '소명 받기', docs/api/openapi.yaml 태그 support,
// docs/data.md appeal·sup:far:{account}, docs/features/transfer-refund.md §7.1.
// 소명은 core DB에 두고, FRAUD_CASE만 ops-svc 내부 경로로 잇는다. 화면용 사본은 판이 클 때만 바뀐다.
// 이 시험은 실제 MemorySupportAppealStore·MemoryFraudAppealViews를 쓴다(TR-03).
import 'reflect-metadata';
import { createService, fakeClock } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { FakeIdentity, NOW_MS, fan, quiet } from './support.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const CASE = '0194b220-0000-7000-8000-000000000301';
const T1 = '0194b220-0000-7000-8000-000000000401';
const iso = (ms: number) => new Date(ms).toISOString();

/** 구현 전에는 모듈이 없어 실패하고, 구현 뒤에는 같은 이름을 쓴다(문자열 동적 import라 타입 검사를 깨지 않는다). */
const loadSupport = async (): Promise<any> => import(new URL('../src/modules/support/index.js', import.meta.url).href);

class FakeFraudCases {
  readonly calls: any[] = [];
  result: 'SUBMITTED' | 'OBJECTION_SUBMITTED' | 'EXPIRED' | 'INVALID' = 'SUBMITTED';
  async submit(i: any) {
    this.calls.push(i);
    return { result: this.result };
  }
}

class FakeTargets {
  readonly calls: any[] = [];
  async submit(i: any) {
    this.calls.push(i);
    return { result: 'UNAVAILABLE' as const };
  }
}

let mod: any;
let appeals: any;
let views: any;
const fraudCases = new FakeFraudCases();
const targets = new FakeTargets();
let svc: Awaited<ReturnType<typeof createService>>;

beforeAll(async () => {
  mod = await loadSupport();
  appeals = new mod.MemorySupportAppealStore();
  views = new mod.MemoryFraudAppealViews();
  svc = await createService({
    name: 'core-svc',
    module: AppModule.register({
      memory: true,
      support: { appeals, views, fraudCases, targets, now: () => NOW_MS },
    } as never),
    env: { PEAKET_ENV: 'ci' },
    clock: fakeClock({ now: NOW_MS }),
    logDestination: quiet(),
    adminAuthz: new FakeIdentity(),
  });
});
afterAll(async () => {
  await svc?.close();
});
beforeEach(() => {
  fraudCases.calls.length = 0;
  fraudCases.result = 'SUBMITTED';
  targets.calls.length = 0;
});

const headers = (accountId: string, key: string = randomUUID()) => ({ ...fan(accountId), 'content-type': 'application/json', 'idempotency-key': key });
const submit = (accountId: string, body: Record<string, unknown>, key?: string) =>
  svc.http.inject({ method: 'POST', url: '/v1/appeals', headers: headers(accountId, key), payload: JSON.stringify(body) });
const list = (accountId: string) => svc.http.inject({ method: 'GET', url: '/v1/appeals', headers: fan(accountId) });
const get = (accountId: string, id: string) => svc.http.inject({ method: 'GET', url: `/v1/appeals/${id}`, headers: fan(accountId) });
const fraudViews = (accountId: string) => svc.http.inject({ method: 'GET', url: '/v1/fraud-appeal-requests', headers: fan(accountId) });
const json = (r: { payload: string }) => JSON.parse(r.payload) as Record<string, any>;

describe('support 소명 제출', () => {
  test('FX-T19 ⑫ [ASVS v5.0.0-2.2.2] 팬 소명 제출은 core DB에 저장하고 FRAUD_CASE만 ops 내부 경로로 잇는다', async () => {
    const me = randomUUID();
    const r = await submit(me, { kind: 'FRAUD_CASE', targetId: CASE, body: '가족이 대신 예매했습니다' });
    expect(r.statusCode).toBe(201);
    const body = json(r);
    expect(body).toMatchObject({ kind: 'FRAUD_CASE', targetId: CASE, status: 'SUBMITTED', caseId: null });
    expect(body.appealId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await appeals.get(body.appealId)).toMatchObject({ accountId: me, kind: 'FRAUD_CASE', targetId: CASE, status: 'SUBMITTED' });
    expect(fraudCases.calls).toHaveLength(1);
    expect(fraudCases.calls[0]).toMatchObject({ caseId: CASE, appealId: body.appealId, accountId: me, party: 'PAYER' });
    expect(fraudCases.calls[0]).not.toHaveProperty('body');
    expect(fraudCases.calls[0]).not.toHaveProperty('text');
    expect(JSON.stringify(fraudCases.calls[0])).not.toContain('가족이 대신 예매했습니다');
    expect(targets.calls).toHaveLength(0);
  });

  test('FX-T19 ⑫ 같은 Idempotency-Key는 처음 응답을 재생하고 다른 본문은 422다', async () => {
    const me = randomUUID();
    const key = randomUUID();
    const first = await submit(me, { kind: 'FRAUD_CASE', targetId: CASE, body: '가족이 대신 예매했습니다' }, key);
    const again = await submit(me, { kind: 'FRAUD_CASE', targetId: CASE, body: '가족이 대신 예매했습니다' }, key);
    expect(again.statusCode).toBe(201);
    expect(json(again).appealId).toBe(json(first).appealId);
    expect(json(await list(me)).items).toHaveLength(1);
    expect(fraudCases.calls).toHaveLength(1);
    const other = await submit(me, { kind: 'FRAUD_CASE', targetId: CASE, body: '다른 본문입니다' }, key);
    expect(other.statusCode).toBe(422);
    expect(json(other).type).toContain('idempotency-key-reused');
  });

  test('C-T71 ⑦ [ASVS v5.0.0-2.2.1] 소명 본문은 NFC·코드 포인트 1~2,000자이고 앞뒤 공백·제로 폭·제어 문자를 지운다', async () => {
    const me = randomUUID();
    const noKey = await svc.http.inject({ method: 'POST', url: '/v1/appeals', headers: { ...fan(me), 'content-type': 'application/json' }, payload: JSON.stringify({ kind: 'FRAUD_CASE', targetId: CASE, body: '내용' }) });
    expect(noKey.statusCode).toBe(400);
    expect((await submit(me, { kind: 'FRAUD_CASE', targetId: CASE, body: '   ' })).statusCode).toBe(422);
    expect((await submit(me, { kind: 'FRAUD_CASE', targetId: CASE, body: '\u200b'.repeat(2000) })).statusCode).toBe(422);
    // 2,001 한글은 계약 상한을 넘어 400이다(TR-05). 이모지는 코드 포인트로 센다.
    expect((await submit(me, { kind: 'FRAUD_CASE', targetId: CASE, body: '가'.repeat(2001) })).statusCode).toBe(400);
    expect((await submit(me, { kind: 'FRAUD_CASE', targetId: CASE, body: '😀'.repeat(2001) })).statusCode).toBe(400);

    const made2000 = await submit(me, { kind: 'FRAUD_CASE', targetId: CASE, body: '가'.repeat(2000) });
    expect(made2000.statusCode).toBe(201);
    expect((await appeals.get(json(made2000).appealId)).body).toBe('가'.repeat(2000));

    const emoji1001 = '😀'.repeat(1001);
    const madeEmoji1001 = await submit(me, { kind: 'FRAUD_CASE', targetId: CASE, body: emoji1001 });
    expect(madeEmoji1001.statusCode).toBe(201);
    expect((await appeals.get(json(madeEmoji1001).appealId)).body).toBe(emoji1001);

    const nfc = '\u1100\u1161'.repeat(1000);
    const madeNfc = await submit(me, { kind: 'FRAUD_CASE', targetId: CASE, body: nfc });
    expect(madeNfc.statusCode).toBe(201);
    expect((await appeals.get(json(madeNfc).appealId)).body).toBe('가'.repeat(1000));

    const dirty = `  가\u200b\u200b\u0000\u0007  `;
    const madeDirty = await submit(me, { kind: 'FRAUD_CASE', targetId: CASE, body: dirty });
    expect(madeDirty.statusCode).toBe(201);
    expect((await appeals.get(json(madeDirty).appealId)).body).toBe('가');

    const emoji = '😀'.repeat(1000);
    const madeEmoji = await submit(me, { kind: 'FRAUD_CASE', targetId: CASE, body: emoji });
    expect(madeEmoji.statusCode).toBe(201);
    expect((await appeals.get(json(madeEmoji).appealId)).body).toBe(emoji);
  });

  test('FX-T20 ⑬ 자기 소명만 목록·상세로 주고 남의 소명은 404다', async () => {
    const a = randomUUID();
    const b = randomUUID();
    const made = await submit(a, { kind: 'FRAUD_CASE', targetId: CASE, body: '내 소명' });
    const id = json(made).appealId;
    expect(json(await list(a)).items).toHaveLength(1);
    expect(json(await list(b)).items).toHaveLength(0);
    expect((await get(a, id)).statusCode).toBe(200);
    expect((await get(b, id)).statusCode).toBe(404);
  });

  test('FX-T20 ⑬ RESTRICTION·RECLAIM은 201로 저장하고 대상 연결은 닫힌 대역이다', async () => {
    const me = randomUUID();
    const r = await submit(me, { kind: 'RESTRICTION', targetId: 'restriction-1', body: '사정이 있습니다' });
    expect(r.statusCode).toBe(201);
    expect(json(r).status).toBe('SUBMITTED');
    expect(fraudCases.calls).toHaveLength(0);
    expect(targets.calls).toHaveLength(1);
    expect(json(await list(me)).items).toHaveLength(1);
  });

  test('C-T70 ④ ops가 INVALID·EXPIRED를 주면 소명을 닫는다', async () => {
    const me = randomUUID();
    fraudCases.result = 'INVALID';
    const made = await submit(me, { kind: 'FRAUD_CASE', targetId: CASE, body: '대상이 아님' });
    const id = json(made).appealId;
    expect((await get(me, id)).statusCode).toBe(200);
    expect(json(await get(me, id)).status).toBe('INVALID');

    fraudCases.result = 'EXPIRED';
    const expired = await submit(me, { kind: 'FRAUD_CASE', targetId: CASE, body: '기한 지남' });
    expect(json(await get(me, json(expired).appealId)).status).toBe('INVALID');
  });

  test('UI-05 [ASVS v5.0.0-14.3.2] 소명 응답은 private, no-store이고 다른 계정 정보를 싣지 않는다', async () => {
    const me = randomUUID();
    const r = await submit(me, { kind: 'FRAUD_CASE', targetId: CASE, body: '내 소명' });
    expect(String(r.headers['cache-control'])).toBe('private, no-store');
    expect(r.payload).not.toContain('otherAccounts');
    expect(r.payload).not.toContain('score');
    const listed = await list(me);
    expect(String(listed.headers['cache-control'])).toBe('private, no-store');
    expect(listed.payload).not.toContain('password');
  });

  test('C-T70 ④ GET /v1/fraud-appeal-requests는 자기 사본만 주고 사건의 다른 계정·점수·신호를 싣지 않는다', async () => {
    const me = randomUUID();
    const other = randomUUID();
    await views.set({ accountId: me, caseId: CASE, eventId: 'event-1', party: 'PAYER', reasonCategories: ['MACRO_BOT'], dueAt: iso(NOW_MS + 2 * DAY), lockedTicketIds: [T1], heldTicketIds: [], excludedTicketIds: [], lockActive: true, lockExpiresAt: iso(NOW_MS + 14 * DAY), state: 'OPEN', objectionDueAt: null, objectionState: 'NONE', objectionNote: null, actionResult: null, priorityPurchases: [], version: 3, updatedAtMs: NOW_MS });
    await views.set({ accountId: other, caseId: 'case-2', eventId: 'event-2', party: 'PAYER', reasonCategories: ['VELOCITY'], dueAt: iso(NOW_MS + DAY), lockedTicketIds: [], heldTicketIds: [], excludedTicketIds: [], lockActive: false, lockExpiresAt: null, state: 'OPEN', objectionDueAt: null, objectionState: 'NONE', objectionNote: null, actionResult: null, priorityPurchases: [], version: 1, updatedAtMs: NOW_MS });
    const r = await fraudViews(me);
    expect(r.statusCode).toBe(200);
    expect(String(r.headers['cache-control'])).toBe('private, no-store');
    const body = json(r);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ caseId: CASE, party: 'PAYER', reasonCategories: ['MACRO_BOT'], version: 3 });
    expect(body.items[0]).not.toHaveProperty('otherAccounts');
    expect(body.items[0]).not.toHaveProperty('score');
    expect(body.items[0]).not.toHaveProperty('signals');
  });

  test('support 경로는 팬 쿠키가 없으면 401이다', async () => {
    const r = await svc.http.inject({ method: 'GET', url: '/v1/fraud-appeal-requests' });
    expect(r.statusCode).toBe(401);
    const post = await svc.http.inject({ method: 'POST', url: '/v1/appeals', headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID() }, payload: JSON.stringify({ kind: 'FRAUD_CASE', targetId: CASE, body: '내용' }) });
    expect(post.statusCode).toBe(401);
  });
});

describe('support 저장소', () => {
  test('FX-T19 ⑫ MemorySupportAppealStore는 저장·조회·목록·고치기·멱등 비교를 지킨다', async () => {
    const me = randomUUID();
    const key = randomUUID();
    const h1 = new TextEncoder().encode('hash-1');
    const h2 = new TextEncoder().encode('hash-2');
    const a = { id: randomUUID(), accountId: me, kind: 'FRAUD_CASE', targetId: CASE, body: '내 소명', status: 'SUBMITTED', result: null, caseId: null, submittedAtMs: NOW_MS, decidedAtMs: null };
    const idem = { accountRef: me, operation: 'CREATE_APPEAL', key, requestHash: h1 };
    expect(await appeals.put(a, { idem, result: { appealId: a.id } })).toMatchObject({ replayed: false });
    expect(await appeals.get(a.id)).toMatchObject({ body: '내 소명', status: 'SUBMITTED' });
    expect((await appeals.listByAccount(me, { limit: 10 })).items.map((x: any) => x.id)).toEqual([a.id]);
    expect(await appeals.findIdempotent(idem)).toMatchObject({ kind: 'replay' });
    expect(await appeals.findIdempotent({ ...idem, requestHash: h2 })).toMatchObject({ kind: 'reused' });
    expect(await appeals.findIdempotent({ ...idem, key: randomUUID() })).toMatchObject({ kind: 'none' });
    expect(await appeals.update({ ...a, status: 'INVALID', decidedAtMs: NOW_MS })).toBe(true);
    expect(await appeals.get(a.id)).toMatchObject({ status: 'INVALID', decidedAtMs: NOW_MS });
  });
});
