// F-04-15 ops-svc 소명 화면용 사본 시험(동결 로컬, LCH-310).
// 정본: docs/features/forensic-replay.md §6.7.5 '팬 화면', docs/api/proto/peaket/core/v1/core.proto
// SetFraudAppealView, ADR-0173 결정 3·4. 소명 요청은 결제자·받은 사람 사본을 함께 쓴다.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import {
  Investigations,
  MemoryInvestigationStore,
  type FraudCaseRecord,
  type FraudClusterMemberRecord,
} from '../src/modules/investigations/index.js';
import type { SaleScheduleSource } from '../src/modules/readiness/index.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-11-26T00:00:00.000Z');
const SHOW = Date.parse('2026-12-06T10:00:00.000Z');
const ENTRY = SHOW;
const CASE = '0194b220-0000-7000-8000-000000000501';
const EVENT = '0194b220-0000-7000-8000-000000000502';
const A1 = '0194b220-0000-7000-8000-000000000511';
const H1 = '0194b220-0000-7000-8000-000000000521';
const T1 = '0194b220-0000-7000-8000-000000000531';
const ADMIN = '0194b220-0000-7000-8000-000000000541';
const iso = (ms: number) => new Date(ms).toISOString();

const member = (accountId: string): FraudClusterMemberRecord => ({
  accountId,
  ticketCount: 1,
  signals: ['LINK_GRAPH'],
  addedBy: 'SYSTEM',
  removedAtMs: null,
  appealResult: 'NOT_REQUESTED',
  appealDueAtMs: null,
  lockExpiresAtMs: null,
  objectionResult: 'NONE',
} as FraudClusterMemberRecord);

const caseOf = (): FraudCaseRecord =>
  ({
    caseId: CASE,
    eventId: EVENT,
    clusterId: randomUUID(),
    status: 'INVESTIGATING',
    reasonCategory: 'MACRO_BOT',
    assigneeId: ADMIN,
    cancelDeadlineAtMs: SHOW - 26 * HOUR,
    appealDueAtMs: null,
    approvalId: null,
    investigatorOpinion: null,
    outcomeLabel: null,
    version: 1,
    createdAtMs: NOW - DAY,
    closedAtMs: null,
    members: [member(A1)],
    events: [{ seq: 1, kind: 'CREATED', actorId: ADMIN, note: null, detail: null, occurredAtMs: NOW - DAY }],
  }) as FraudCaseRecord;

describe('소명 화면용 사본', () => {
  test('C-T70 ③ 소명 요청은 결제자·받은 사람 사본을 사유·기한·잠금과 함께 쓴다', async () => {
    const store = new MemoryInvestigationStore();
    await store.putCase(caseOf());
    const copies: any[] = [];
    const schedule: SaleScheduleSource = { get: async (eventId) => (eventId === EVENT ? { opensAtMs: NOW - DAY, saleEndsAtMs: SHOW - 24 * HOUR, entryOpensAtMs: ENTRY, entryClosedAtMs: ENTRY + 3 * HOUR } : undefined) };
    const locks = { sets: [] as any[], async set(i: any) { this.sets.push(i); return { lockedTicketCount: 1, withdrawnOfferCount: 0, holders: [{ accountId: H1, ticketIds: [T1] }] }; }, async release() {} };
    const investigations = new Investigations({
      store,
      identity: { designations: async () => ['FRAUD_INVESTIGATOR'] },
      schedule,
      locks,
      tickets: { listForAction: async () => [{ ticketId: T1, payerAccountId: A1, holderAccountId: H1, status: 'ISSUED', entryRecorded: false, eventId: EVENT }] },
      copies: { set: async (i: any) => void copies.push(i) },
      notifier: { holderNotice: async () => undefined },
      labels: { apply: async () => undefined },
      alerts: { raise: async () => undefined },
      access: { record: async () => undefined },
      events: { emit: () => undefined },
      verifier: { verify: async () => ({ ok: true, mismatchedTables: [] }) },
      now: () => NOW,
    } as any);

    const out = await investigations.appeal({ accountId: ADMIN, role: 'cs_lead' }, CASE, { accountRef: ADMIN, operation: 'FRAUD_CASE_APPEAL', key: randomUUID(), requestHash: new Uint8Array([1]) }, {
      accountIds: [A1],
      reasonCategories: ['MACRO_BOT'],
      dueAt: iso(NOW + 2 * DAY),
    });
    expect(out).toMatchObject({ caseId: CASE, accountIds: [A1], dueAt: iso(NOW + 2 * DAY) });
    expect(locks.sets).toHaveLength(1);
    const payer = copies.find((c) => c.party === 'PAYER' && c.accountId === A1);
    expect(payer).toMatchObject({ caseId: CASE, eventId: EVENT, lockActive: true, reasonCategories: ['MACRO_BOT'], dueAtMs: NOW + 2 * DAY, state: 'OPEN', version: 2, lockExpiresAtMs: NOW + 14 * DAY });
    expect(payer.lockedTicketIds).toEqual([T1]);
    expect(payer.heldTicketIds).toEqual([]);
    const holder = copies.find((c) => c.party === 'HOLDER' && c.accountId === H1);
    expect(holder).toMatchObject({ heldTicketIds: [T1], lockedTicketIds: [], reasonCategories: [], lockActive: false, dueAtMs: NOW + 2 * DAY, state: 'OPEN', version: 2 });
    expect(holder.lockExpiresAtMs).toBeNull();
  });
});
