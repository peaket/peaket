// F-04-15 core-svc support 모듈 HTTP 시험(동결 로컬, LCH-310).
// 정본: docs/features/forensic-replay.md §6.7.5 '소명 받기', docs/api/openapi.yaml 태그 support,
// docs/data.md appeal·sup:far:{account}, docs/features/transfer-refund.md §7.1.
// 소명은 core DB에 두고, FRAUD_CASE만 ops-svc 내부 경로로 잇는다. 화면용 사본은 판이 클 때만 바뀐다.
import 'reflect-metadata';
import { createService, fakeClock } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { FakeIdentity, NOW_MS, fan, quiet } from './support.js';

const HOUR = 3_600_000;
const CASE = '0194b220-0000-7000-8000-000000000301';
const T1 = '0194b220-0000-7000-8000-000000000401';

const iso = (ms: number) => new Date(ms).toISOString();

class MemoryAppeals {
  readonly rows = new Map<string, Record<string, any>>();
  readonly idem = new Map<string, { body: string; result: Record<string, unknown> }>();
  async put(a: Record<string, any>, o?: { idem?: { key: string; requestHash: string }; result?: unknown }) {
    if (o?.idem) {
      const found = this.idem.get(o.idem.key);
      if (found) return { replayed: true, result: found.result };
      this.idem.set(o.idem.key, { body: o.idem.requestHash, result: (o.result ?? a) as Record<string, unknown> });
    }
    this.rows.set(String(a.id), { ...a });
    return { replayed: false };
  }
  async get(id: string) {
    return this.rows.get(id) ?? null;
  }
  async listByAccount(accountId: string, q: { limit: number }) {
    return { items: [...this.rows.values()].filter((a) => a.accountId === accountId).slice(0, q.limit), nextCursor: null };
  }
  async update(a: Record<string, any>) {
    this.rows.set(String(a.id), { ...a });
    return true;
  }
  async findIdempotent(idem: { key: string }) {
    const found = this.idem.get(idem.key);
    return found ? { kind: 'replay' as const, result: found.result } : { kind: 'none' as const };
  }
}

class MemoryViews {
  readonly rows = new Map<string, Record<string, any>>();
  readonly sets: Record<string, any>[] = [];
  async set(v: Record<string, any>) {
    this.sets.push(v);
    const key = `${v.accountId}:${v.caseId}`;
    const prev = this.rows.get(key);
    if (prev && Number(prev.version) >= Number(v.version)) return;
    this.rows.set(key, { ...v });
  }
  async list(accountId: string) {
    return [...this.rows.values()].filter((v) => v.accountId === accountId);
  }
}

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

const appeals = new MemoryAppeals();
const views = new MemoryViews();
const fraudCases = new FakeFraudCases();
const targets = new FakeTargets();
let svc: Awaited<ReturnType<typeof createService>>;

beforeAll(async () => {
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
  appeals.rows.clear();
  appeals.idem.clear();
  views.rows.clear();
  views.sets.length = 0;
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
    expect(appeals.rows.size).toBe(1);
    expect(fraudCases.calls).toHaveLength(1);
    expect(fraudCases.calls[0]).toMatchObject({ caseId: CASE, appealId: body.appealId, accountId: me, party: 'PAYER' });
    expect(targets.calls).toHaveLength(0);
  });

  test('FX-T19 ⑫ 같은 Idempotency-Key는 처음 응답을 재생하고 다른 본문은 422다', async () => {
    const me = randomUUID();
    const key = randomUUID();
    const first = await submit(me, { kind: 'FRAUD_CASE', targetId: CASE, body: '가족이 대신 예매했습니다' }, key);
    const again = await submit(me, { kind: 'FRAUD_CASE', targetId: CASE, body: '가족이 대신 예매했습니다' }, key);
    expect(again.statusCode).toBe(201);
    expect(json(again).appealId).toBe(json(first).appealId);
    expect(appeals.rows.size).toBe(1);
    expect(fraudCases.calls).toHaveLength(1);
    const other = await submit(me, { kind: 'FRAUD_CASE', targetId: CASE, body: '다른 본문입니다' }, key);
    expect(other.statusCode).toBe(422);
    expect(json(other).type).toContain('idempotency-key-reused');
  });

  test('C-T71 ⑦ [ASVS v5.0.0-2.2.1] 소명 본문은 NFC·코드 포인트 1~2,000자이고 키가 없으면 400이다', async () => {
    const me = randomUUID();
    const noKey = await svc.http.inject({ method: 'POST', url: '/v1/appeals', headers: { ...fan(me), 'content-type': 'application/json' }, payload: JSON.stringify({ kind: 'FRAUD_CASE', targetId: CASE, body: '내용' }) });
    expect(noKey.statusCode).toBe(400);
    const empty = await submit(me, { kind: 'FRAUD_CASE', targetId: CASE, body: '   ' });
    expect(empty.statusCode).toBe(422);
    const long = await submit(me, { kind: 'FRAUD_CASE', targetId: CASE, body: '가'.repeat(2001) });
    expect(long.statusCode).toBe(422);
    const ok = await submit(me, { kind: 'FRAUD_CASE', targetId: CASE, body: '가'.repeat(2000) });
    expect(ok.statusCode).toBe(201);
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

  test('UI-05 [ASVS v5.0.0-14.2.4] 소명 응답은 private, no-store이고 다른 계정 정보를 싣지 않는다', async () => {
    const me = randomUUID();
    const r = await submit(me, { kind: 'FRAUD_CASE', targetId: CASE, body: '내 소명' });
    expect(String(r.headers['cache-control'])).toContain('no-store');
    expect(r.payload).not.toContain('otherAccounts');
    expect(r.payload).not.toContain('score');
    const listed = await list(me);
    expect(String(listed.headers['cache-control'])).toContain('no-store');
    expect(listed.payload).not.toContain('password');
  });

  test('C-T70 ④ GET /v1/fraud-appeal-requests는 자기 사본만 주고 사건의 다른 계정·점수·신호를 싣지 않는다', async () => {
    const me = randomUUID();
    const other = randomUUID();
    await views.set({ accountId: me, caseId: CASE, eventId: 'event-1', party: 'PAYER', reasonCategories: ['MACRO_BOT'], dueAt: iso(NOW_MS + 2 * 24 * HOUR), lockedTicketIds: [T1], heldTicketIds: [], excludedTicketIds: [], lockActive: true, lockExpiresAt: iso(NOW_MS + 14 * 24 * HOUR), state: 'OPEN', objectionDueAt: null, objectionState: 'NONE', objectionNote: null, actionResult: null, priorityPurchases: [], version: 3 });
    await views.set({ accountId: other, caseId: 'case-2', eventId: 'event-2', party: 'PAYER', reasonCategories: ['VELOCITY'], dueAt: iso(NOW_MS + 24 * HOUR), lockedTicketIds: [], heldTicketIds: [], excludedTicketIds: [], lockActive: false, lockExpiresAt: null, state: 'OPEN', objectionDueAt: null, objectionState: 'NONE', objectionNote: null, actionResult: null, priorityPurchases: [], version: 1 });
    const r = await fraudViews(me);
    expect(r.statusCode).toBe(200);
    expect(String(r.headers['cache-control'])).toContain('no-store');
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
