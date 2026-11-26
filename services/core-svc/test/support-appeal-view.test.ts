// F-04-15 core-svc support 화면 사본 시험(동결 로컬, LCH-310).
// 정본: docs/api/proto/peaket/core/v1/core.proto FraudAppealViewService, docs/data.md sup:far:{account},
// docs/features/forensic-replay.md §6.7.5 '팬 화면'. 사본은 큰 판만 덮고 HOLDER는 사유·잠금·우선 구매·이용 제한을 비운다.
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
const T2 = '0194b220-0000-7000-8000-000000000402';
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
  actionResult: { cancelledTicketIds: [T1], restrictedUntil: iso(NOW_MS + 365 * DAY) },
  priorityPurchases: [{ grantId: 'g1', seatLabel: 'A구역', price: 154000, expiresAt: iso(NOW_MS + DAY), status: 'OFFERED' }],
  version: 3,
  updatedAtMs: NOW_MS,
  ...over,
});

let mod: any;
let appeals: any;
let views: any;
let svc: Awaited<ReturnType<typeof createService>>;

beforeAll(async () => {
  mod = await loadSupport();
  appeals = new mod.MemorySupportAppealStore();
  views = new mod.MemoryFraudAppealViews();
  svc = await createService({
    name: 'core-svc',
    module: AppModule.register({ memory: true, support: { appeals, views, fraudCases: { submit: async () => ({ result: 'SUBMITTED' }) }, targets: { submit: async () => ({ result: 'UNAVAILABLE' }) }, now: () => NOW_MS } } as never),
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
  test('C-T70 ④ [ASVS v5.0.0-2.3.3] SetFraudAppealView는 큰 판만 덮고 HOLDER 사본의 사유·잠금·우선 구매·이용 제한을 비운다', async () => {
    const holder = mod.normalizeFraudAppealView(seed({ accountId: randomUUID(), party: 'HOLDER', heldTicketIds: [T1], lockedTicketIds: [T1], excludedTicketIds: [T2] }), NOW_MS);
    expect(holder.party).toBe('HOLDER');
    expect(holder.reasonCategories).toEqual([]);
    expect(holder.lockActive).toBe(false);
    expect(holder.lockExpiresAtMs).toBeNull();
    expect(holder.lockedTicketIds).toEqual([]);
    expect(holder.priorityPurchases).toEqual([]);
    expect(holder.objectionDueAtMs).toBeNull();
    expect(holder.heldTicketIds).toEqual([T1]);
    expect(holder.excludedTicketIds).toEqual([T2]);
    expect(holder.actionResult).toEqual({ cancelledTicketIds: [T1] });
    expect(holder.actionResult.restrictedUntilMs).toBeUndefined();
  });

  test('C-T70 ④ applyFraudAppealView는 party 기본 PAYER·작은 판 무시·views.set 호출을 지킨다', async () => {
    const store = new mod.MemoryFraudAppealViews();
    await mod.applyFraudAppealView(store, seed({ accountId: 'a', party: '', version: 3 }), NOW_MS);
    await mod.applyFraudAppealView(store, seed({ accountId: 'a', version: 2, reasonCategories: ['VELOCITY'] }), NOW_MS);
    const first = (await store.list('a'))[0];
    expect(first).toMatchObject({ party: 'PAYER', version: 3, reasonCategories: ['MACRO_BOT'] });

    await mod.applyFraudAppealView(store, seed({ accountId: 'a', version: 4, reasonCategories: ['VELOCITY'] }), NOW_MS);
    const next = (await store.list('a'))[0];
    expect(next).toMatchObject({ version: 4, reasonCategories: ['VELOCITY'] });
  });

  test('C-T70 ④ GET /v1/fraud-appeal-requests는 자기 사본만 주고 사건의 다른 계정·점수·신호를 싣지 않는다', async () => {
    const me = `me-${randomUUID()}`;
    const other = `other-${randomUUID()}`;
    await views.set(seed({ accountId: me, caseId: CASE, party: 'PAYER' }));
    await views.set(seed({ accountId: other, caseId: 'case-2' }));
    const r = await svc.http.inject({ method: 'GET', url: '/v1/fraud-appeal-requests', headers: fan(me) });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.payload);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ caseId: CASE, party: 'PAYER', version: 3 });
    expect(body.items[0]).not.toHaveProperty('otherAccounts');
    expect(body.items[0]).not.toHaveProperty('score');
    expect(body.items[0]).not.toHaveProperty('signals');
  });

  test('C-T70 ④ 열린 사본은 나이와 무관하게 남고 결정된 사본은 정확히 30일까지 남는다', async () => {
    const me = `old-${randomUUID()}`;
    await views.set(seed({ accountId: me, caseId: 'case-open', state: 'OPEN', updatedAtMs: NOW_MS - 31 * DAY }));
    await views.set(seed({ accountId: me, caseId: 'case-edge', state: 'ACCEPTED', updatedAtMs: NOW_MS - 30 * DAY }));
    await views.set(seed({ accountId: me, caseId: 'case-gone', state: 'ACCEPTED', updatedAtMs: NOW_MS - 30 * DAY - 1 }));
    const body = JSON.parse((await svc.http.inject({ method: 'GET', url: '/v1/fraud-appeal-requests', headers: fan(me) })).payload);
    expect(body.items.map((x: { caseId: string }) => x.caseId).sort()).toEqual(['case-edge', 'case-open']);
  });

  test('C-T70 ④ HOLDER의 GET은 가진 표·기한만 주고 사유·잠금·이용 제한·우선 구매를 싣지 않는다', async () => {
    const me = `holder-${randomUUID()}`;
    await mod.applyFraudAppealView(views, seed({ accountId: me, party: 'HOLDER', heldTicketIds: [T1], lockedTicketIds: [T1], excludedTicketIds: [T2] }), NOW_MS);
    const body = JSON.parse((await svc.http.inject({ method: 'GET', url: '/v1/fraud-appeal-requests', headers: fan(me) })).payload);
    const item = body.items[0];
    expect(item).toMatchObject({ party: 'HOLDER', heldTicketIds: [T1], excludedTicketIds: [T2], lockActive: false, reasonCategories: [], lockedTicketIds: [], priorityPurchases: [] });
    expect(item.lockExpiresAt).toBeNull();
    expect(item.actionResult?.restrictedUntil).toBeUndefined();
    expect(item.actionResult?.cancelledTicketIds).toEqual([T1]);
  });

  test('IR-12 제출했지만 판단 전인 사본은 30일이 지나도 남고 CLEARED 사건 사본은 빈 목록이다', async () => {
    const me = `ir12-${randomUUID()}`;
    await views.set(seed({ accountId: me, caseId: 'case-submitted', state: 'SUBMITTED', updatedAtMs: NOW_MS - 31 * DAY }));
    await views.set(seed({ accountId: me, caseId: 'case-cleared', state: 'ACCEPTED', caseStatus: 'CLEARED', updatedAtMs: NOW_MS }));
    await views.set(seed({ accountId: me, caseId: 'case-decided', state: 'ACCEPTED', updatedAtMs: NOW_MS - 31 * DAY }));
    const body = JSON.parse((await svc.http.inject({ method: 'GET', url: '/v1/fraud-appeal-requests', headers: fan(me) })).payload);
    expect(body.items.map((x: { caseId: string }) => x.caseId).sort()).toEqual(['case-submitted']);
  });
});
