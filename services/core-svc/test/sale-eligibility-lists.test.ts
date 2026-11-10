// 유스케이스 SaleEligibilityLists를 저장소 대역으로 직접 불러 잠금 밖·안 판정의 차례와 남은 시간 처리를 본다(리뷰 C6, BUILD_ORDER HOT-250).
// 대역은 잠금 밖에서 읽은 상태와 잠금 안에서 읽은 상태를 다르게 줄 수 있다(그 사이에 다른 요청이 끼어든 경우).
import 'reflect-metadata';
import { type Clock, Deadline, ProblemError, type RequestContext, runInRequestContext } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { SaleEligibilityLists } from '../src/modules/catalog/application/sale-eligibility-lists.js';
import type { MemberCodeDirectory, SaleEligibilityCopy } from '../src/modules/catalog/domain/eligibility-ports.js';
import type { SaleState, SaleStore, SaleTx, StoredList } from '../src/modules/catalog/domain/sale-ports.js';

const PROD = randomUUID();
const TENANT = randomUUID();
const who = { tenantId: TENANT, accountId: randomUUID() };
const list = (key: string): StoredList => ({ id: randomUUID(), key, name: key, memberCount: 1, version: 1, copySeq: 1, copiedSeq: null, uploadedAt: new Date(0), lockedAt: null, destroyDueAt: new Date('2026-12-24T10:00:00Z') });
const state = (lists: StoredList[]): SaleState => ({
  production: { id: PROD, promoterId: TENANT, saleReview: 'DRAFT', saleApprovedAt: null, rules: [], pendingRules: undefined, salePolicyVersion: 1 },
  events: [{ eventId: randomUUID(), status: 'SCHEDULED', version: 1, openAt: new Date('2026-11-20T11:00:00Z'), lobbyMinutes: 10, entryOpensAt: null, startsAt: new Date('2026-12-24T10:00:00Z'), endsAt: new Date('2026-12-24T12:00:00Z'), lobbyShuffle: true, openBatch: true, seatAssignment: 'PICK', perPersonLimit: 4 }],
  eventChanges: {},
  addedEvents: [],
  grades: [],
  lists,
});

/** 잠금 밖 read와 잠금 안 state를 따로 준다 */
function fakeStore(outside: SaleState, inside: SaleState, onTx?: () => void): SaleStore & { deleted: string[] } {
  const deleted: string[] = [];
  const tx = { state: async () => inside, deleteList: async (id: string) => (deleted.push(id), 1), putList: async () => 1 } as unknown as SaleTx;
  return {
    deleted,
    owner: async () => ({ approvedBefore: false, suspended: false }),
    read: async () => outside,
    eventProduction: async () => undefined,
    withLockedProduction: async <T>(_p: string, _t: string, fn: (t: SaleTx) => Promise<T>) => {
      onTx?.();
      return fn(tx);
    },
    markCopied: async () => undefined,
    takeUploadSlot: async () => ({ ok: true }),
    dropDone: async () => undefined,
  } as unknown as SaleStore & { deleted: string[] };
}
const clock: Clock = { now: () => Date.parse('2026-11-05T00:00:00Z'), monotonicMs: () => 0 };
const noCopy: SaleEligibilityCopy = { connected: true, put: async () => undefined, drop: async () => undefined };
const noCodes: MemberCodeDirectory = { resolve: async () => new Map() };
const make = (store: SaleStore) => new SaleEligibilityLists(store, noCodes, noCopy, { ref: (v) => v }, clock);

describe('지우기의 잠금 안 판정 차례(리뷰 C6)', () => {
  test('잠금 밖에서 본 명단이 잠금 안에서 없어졌으면 공연당 10개 제한보다 먼저 없는 명단 404다', async () => {
    const ten = Array.from({ length: 10 }, (_, i) => list(`list-${i}`));
    const store = fakeStore(state([list('gone'), ...ten.slice(0, 9)]), state(ten));
    const err = await make(store)
      .remove({ productionId: PROD, listKey: 'gone', who, role: 'partner_admin' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProblemError);
    expect([(err as ProblemError).status, (err as ProblemError).slug]).toEqual([404, 'not-found']);
    expect(store.deleted).toEqual([]);
  });
});

describe('올리기의 남은 시간(리뷰 C6)', () => {
  test('사본 넘기기 앞에 남은 시간이 모자라면 넘기지 않고(정비가 다시 넘긴다) 올리기는 200이다', async () => {
    let mono = 0;
    const timed: Clock = { now: clock.now, monotonicMs: () => mono };
    const puts: unknown[] = [];
    const copy: SaleEligibilityCopy = { connected: true, put: async (c) => void puts.push(c), drop: async () => undefined };
    // 트랜잭션 안에서 91초가 지나 남은 시간(4초)이 사본 넘기기 하한(5초 [가정]) 밑이다
    const store = fakeStore(state([]), state([]), () => {
      mono += 91_000;
    });
    const lists = new SaleEligibilityLists(store, noCodes, copy, { ref: (v) => v }, timed);
    const form = { fields: [{ name: 'key', value: 'list-a' }, { name: 'name', value: '명단' }], files: [{ field: 'file', name: 'l.csv', type: 'text/csv', size: 9, bytes: async () => new TextEncoder().encode('PK7-42Q9\n') }] };
    const ctx = { traceId: '0'.repeat(32), deadline: Deadline.after(95_000, timed), route: 'x', method: 'POST', log: { set() {}, identify() {}, dependency() {}, keep() {} } } as unknown as RequestContext;
    const out = await runInRequestContext(ctx, () => lists.upload({ productionId: PROD, who, role: 'partner_admin', form }));
    expect(out.listKey).toBe('list-a');
    expect(puts).toEqual([]);
  });
});
