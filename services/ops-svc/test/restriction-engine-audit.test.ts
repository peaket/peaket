// F-06-4 구현 리뷰 IR-10: 제한 행 저장과 감사가 같은 저장 호출(트랜잭션)에 실리는지.
import { describe, expect, test, vi } from 'vitest';
import { MemoryAuditChain } from '../src/modules/audit/index.js';
import type { AuditRecord } from '../src/modules/audit/audit.js';
import { BookingRestrictions, type BookingRestrictionStore, type RestrictionCopies, type RestrictionRow } from '../src/modules/restrictions/index.js';

const NOW = Date.parse('2026-11-27T01:00:00.000Z');

const row = (): RestrictionRow => ({
  restrictionId: '0194f064-0000-7000-8000-000000000501',
  approvalId: '0194f064-0000-7000-8000-000000000601',
  accountId: '0194f064-0000-7000-8000-000000000701',
  reasonCode: 'ABUSE_CANCEL',
  fraudCaseId: null,
  confirmedBy: null,
  startsAtMs: NOW,
  endsAtMs: NOW + 86_400_000,
  appealDueAtMs: NOW + 86_400_000,
  status: 'ACTIVE',
  version: 1,
  deliveryDone: false,
  copyNextAtMs: NOW,
  copyAttempts: 0,
});

describe('IR-10 제한 행·감사 같은 트랜잭션', () => {
  test('execute·lift가 store.insert/update에 감사 기록을 넘기고 따로 append하지 않는다', async () => {
    const audit = new MemoryAuditChain();
    const insert = vi.fn(async (_row: RestrictionRow, _audit?: AuditRecord) => undefined);
    const update = vi.fn(async (_row: RestrictionRow, _audit?: AuditRecord) => undefined);
    const store: BookingRestrictionStore = {
      rows: async () => [],
      find: async () => row(),
      findByApproval: async () => undefined,
      insert,
      update,
      seed: async () => undefined,
    };
    const copies: RestrictionCopies = { queue: async () => ({ changed: true }), purchase: async () => ({ changed: true }), view: async () => ({ changed: true }) };
    const engine = new BookingRestrictions({ store, copies, clock: { now: () => NOW }, audit });

    await engine.execute({ approvalId: row().approvalId!, targetRef: row().accountId, reasonCode: 'ABUSE_CANCEL', restrictionEndsAtMs: row().endsAtMs, approvedBy: null });
    expect([...insert.mock.calls, ...update.mock.calls].some((c) => (c[1] as { recordType?: string } | undefined)?.recordType === 'RESTRICTION_APPLIED')).toBe(true);

    await engine.lift(row().restrictionId);
    expect(update.mock.calls.at(-1)?.[1]).toMatchObject({ recordType: 'RESTRICTION_LIFTED' });
    expect(audit.entries).toEqual([]);
  });
});
