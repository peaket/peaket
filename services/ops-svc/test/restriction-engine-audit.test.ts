// F-06-4 구현 리뷰 IR-10: 제한 행 저장과 감사가 같은 저장 호출(트랜잭션)에 실리는지.
// 특히 새 행을 만드는 insert 경로와 사본 실패로 끝나는 경로를 본다(재리뷰 IR-10).
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

type StoreFn = (row: RestrictionRow, audit?: AuditRecord) => Promise<void>;
const storeOf = (insert: StoreFn, update: StoreFn): BookingRestrictionStore => ({
  rows: async () => [],
  find: async () => row(),
  // 새 승인: 행이 없다 → execute가 insert 경로를 탄다
  findByApproval: async () => undefined,
  insert,
  update,
  seed: async () => undefined,
});

describe('IR-10 제한 행·감사 같은 트랜잭션', () => {
  test('새 행 insert가 RESTRICTION_APPLIED 감사를 받고 applied update에 중복 감사가 없다', async () => {
    const audit = new MemoryAuditChain();
    const insert = vi.fn(async (_row: RestrictionRow, _audit?: AuditRecord) => undefined);
    const update = vi.fn(async (_row: RestrictionRow, _audit?: AuditRecord) => undefined);
    const copies: RestrictionCopies = { queue: async () => ({ changed: true }), purchase: async () => ({ changed: true }), view: async () => ({ changed: true }) };
    const engine = new BookingRestrictions({ store: storeOf(insert, update), copies, clock: { now: () => NOW }, audit });

    await engine.execute({ approvalId: row().approvalId!, targetRef: row().accountId, reasonCode: 'ABUSE_CANCEL', restrictionEndsAtMs: row().endsAtMs, approvedBy: null });

    expect(insert).toHaveBeenCalledTimes(1);
    expect(insert.mock.calls[0]?.[1]).toMatchObject({ recordType: 'RESTRICTION_APPLIED', recordId: row().approvalId });
    // 성공 update에도 같은 감사를 또 쓰지 않는다(한 행에 한 감사)
    expect(update.mock.calls.some((c) => (c[1] as AuditRecord | undefined)?.recordType === 'RESTRICTION_APPLIED')).toBe(false);
    expect(audit.entries).toEqual([]);
  });

  test('사본이 실패해 PENDING으로 끝나도 새 행과 RESTRICTION_APPLIED 감사가 같은 insert에 남는다', async () => {
    const audit = new MemoryAuditChain();
    const insert = vi.fn(async (_row: RestrictionRow, _audit?: AuditRecord) => undefined);
    const update = vi.fn(async (_row: RestrictionRow, _audit?: AuditRecord) => undefined);
    const copies: RestrictionCopies = {
      queue: async () => { throw new Error('queue unavailable'); },
      purchase: async () => ({ changed: true }),
      view: async () => ({ changed: true }),
    };
    const engine = new BookingRestrictions({ store: storeOf(insert, update), copies, clock: { now: () => NOW }, audit });

    await expect(engine.execute({ approvalId: row().approvalId!, targetRef: row().accountId, reasonCode: 'ABUSE_CANCEL', restrictionEndsAtMs: row().endsAtMs, approvedBy: null })).resolves.toEqual({ status: 'PENDING' });

    expect(insert).toHaveBeenCalledTimes(1);
    expect(insert.mock.calls[0]?.[1]).toMatchObject({ recordType: 'RESTRICTION_APPLIED' });
    expect(update.mock.calls.at(-1)?.[1]).toBeUndefined();
    expect(audit.entries).toEqual([]);
  });

  test('lift는 행 update에 RESTRICTION_LIFTED 감사를 넘기고 따로 append하지 않는다', async () => {
    const audit = new MemoryAuditChain();
    const insert = vi.fn(async (_row: RestrictionRow, _audit?: AuditRecord) => undefined);
    const update = vi.fn(async (_row: RestrictionRow, _audit?: AuditRecord) => undefined);
    const copies: RestrictionCopies = { queue: async () => ({ changed: true }), purchase: async () => ({ changed: true }), view: async () => ({ changed: true }) };
    const engine = new BookingRestrictions({ store: storeOf(insert, update), copies, clock: { now: () => NOW }, audit });

    await engine.lift(row().restrictionId);
    expect(update.mock.calls.at(-1)?.[1]).toMatchObject({ recordType: 'RESTRICTION_LIFTED' });
    expect(audit.entries).toEqual([]);
  });
});
