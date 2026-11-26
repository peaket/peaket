// F-04-15 core-svc support 화면 사본 시험(동결 로컬, LCH-310).
// 정본: docs/api/proto/peaket/core/v1/core.proto FraudAppealViewService, docs/data.md sup:far:{account},
// docs/features/forensic-replay.md §6.7.5 '팬 화면'. 사본은 큰 판만 덮고 HOLDER는 사유·잠금·우선 구매를 비운다.
import 'reflect-metadata';
import { createService, fakeClock } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { FakeIdentity, NOW_MS, fan, quiet } from './support.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const CASE = '0194b220-0000-7000-8000-000000000301';
const T1 = '0194b220-0000-7000-8000-000000000401';
const iso = (ms: number) => new Date(ms).toISOString();

/** 구현 전에는 모듈이 없어 실패하고, 구현 뒤에는 같은 이름을 쓴다(문자열 동적 import라 타입 검사를 깨지 않는다). */
const loadSupport = async (): Promise<any> => import(new URL('../src/modules/support/index.js', import.meta.url).href);

const seed = (over: Record<string, any> = {}) => ({
  accountId: 'a',
  caseId: CASE,
  eventId: 'event-1',
  party: 'PAYER',
  reasonCategories: ['MACRO_BOT'],
  dueAt: iso(NOW_MS + 2 * DAY),
  lockedTicketIds: [T1],
  heldTicketIds: [],
  excludedTicketIds: [],
  lockActive: true,
  lockExpiresAt: iso(NOW_MS + 14 * DAY),
  state: 'OPEN',
  objectionDueAt: null,
  objectionState: 'NONE',
  objectionNote: null,
  actionResult: null,
  priorityPurchases: [{ grantId: 'g1', seatLabel: 'A구역', price: 154000, expiresAt: iso(NOW_MS + DAY), status: 'OFFERED' }],
  version: 3,
  updatedAtMs: NOW_MS,
  ...over,
});

let views: any;
let svc: Awaited<ReturnType<typeof createService>>;

class MemoryAppeals {
  readonly rows = new Map<string, Record<string, any>>();
  async put(a: Record<string, any>) {
    this.rows.set(String(a.id ?? randomUUID()), { ...a });
    return { replayed: false };
  }
  async get(id: string) {
    return this.rows.get(id) ?? null;
  }
  async listByAccount(accountId: string) {
    return { items: [...this.rows.values()].filter((a) => a.accountId === accountId), nextCursor: null };
  }
  async update(a: Record<string, any>) {
    this.rows.set(String(a.id), { ...a });
    return true;
  }
  async findIdempotent() {
    return { kind: 'none' as const };
  }
}

beforeAll(async () => {
  const mod = await loadSupport();
  views = new mod.MemoryFraudAppealViews();
  svc = await createService({
    name: 'core-svc',
    module: AppModule.register({ memory: true, support: { appeals: new MemoryAppeals(), views, fraudCases: { submit: async () => ({ result: 'SUBMITTED' }) }, targets: { submit: async () => ({ result: 'UNAVAILABLE' }) }, now: () => NOW_MS } } as never),
    env: { PEAKET_ENV: 'ci' },
    clock: fakeClock({ now: NOW_MS }),
    logDestination: quiet(),
    adminAuthz: new FakeIdentity(),
  });
});
afterAll(async () => {
  await svc?.close();
});

describe('화면 사본', () => {
  test('C-T70 ④ [ASVS v5.0.0-14.3.3] SetFraudAppealView는 큰 판만 덮고 HOLDER 사본의 사유·잠금·우선 구매를 비운다', async () => {
    const mod = await loadSupport();
    const holder = mod.normalizeFraudAppealView(seed({ accountId: randomUUID(), party: 'HOLDER', heldTicketIds: [T1] }), NOW_MS);
    expect(holder.party).toBe('HOLDER');
    expect(holder.reasonCategories).toEqual([]);
    expect(holder.lockActive).toBe(false);
    expect(holder.lockExpiresAtMs).toBeNull();
    expect(holder.priorityPurchases).toEqual([]);
    expect(holder.objectionDueAtMs).toBeNull();
    expect(holder.heldTicketIds).toEqual([T1]);

    const store = new mod.MemoryFraudAppealViews();
    await store.set(seed({ accountId: 'a', version: 3 }));
    await store.set(seed({ accountId: 'a', version: 2, reasonCategories: ['VELOCITY'] }));
    expect((await store.list('a'))[0].version).toBe(3);
    await store.set(seed({ accountId: 'a', version: 4, reasonCategories: ['VELOCITY'] }));
    expect((await store.list('a'))[0].version).toBe(4);
    expect((await store.list('a'))[0].reasonCategories).toEqual(['VELOCITY']);
  });

  test('C-T70 ④ GET /v1/fraud-appeal-requests는 자기 사본만 주고 사건의 다른 계정·점수·신호를 싣지 않는다', async () => {
    await views.set(seed({ accountId: 'me', caseId: CASE, party: 'PAYER' }));
    await views.set(seed({ accountId: 'other', caseId: 'case-2' }));
    const r = await svc.http.inject({ method: 'GET', url: '/v1/fraud-appeal-requests', headers: fan('me') });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.payload);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ caseId: CASE, party: 'PAYER', version: 3 });
    expect(body.items[0]).not.toHaveProperty('otherAccounts');
    expect(body.items[0]).not.toHaveProperty('score');
    expect(body.items[0]).not.toHaveProperty('signals');
  });

  test('C-T70 ④ 30일 지난 사본은 목록에서 빠진다', async () => {
    await views.set(seed({ accountId: 'old', caseId: 'case-old', updatedAtMs: NOW_MS - 31 * DAY, state: 'ACCEPTED' }));
    await views.set(seed({ accountId: 'old', caseId: 'case-new', updatedAtMs: NOW_MS, state: 'ACCEPTED' }));
    const r = await svc.http.inject({ method: 'GET', url: '/v1/fraud-appeal-requests', headers: fan('old') });
    const body = JSON.parse(r.payload);
    expect(body.items.map((x: { caseId: string }) => x.caseId)).toEqual(['case-new']);
  });
});
