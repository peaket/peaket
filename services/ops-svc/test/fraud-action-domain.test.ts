// F-04-13 조치 도메인 시험(동결 로컬, LCH-270·LCH-280, FX-T12).
// 정본: docs/features/forensic-replay.md §6.7.4~§6.7.5.
// [ASVS v5.0.0-2.1.2] 상태·기한·창 조합, [ASVS v5.0.0-2.1.3] 업무 한도.
import { describe, expect, test } from 'vitest';
import * as investigations from '../src/modules/investigations/index.js';

const HOUR = 3_600_000;
const DAY = 86_400_000;
const NOW = Date.parse('2026-11-25T00:00:00.000Z');
const SHOW = Date.parse('2026-12-02T10:00:00.000Z');
const CANCEL = SHOW - 26 * HOUR;
const id = (n: number) => `0194b220-3000-7000-8000-${n.toString(16).padStart(12, '0')}`;

const domain = investigations as unknown as Record<string, any>;

const member = (n: number, o: Record<string, any> = {}) => ({
  accountId: id(n),
  ticketCount: 1,
  signals: ['LINK_GRAPH'],
  addedBy: 'SYSTEM',
  removedAtMs: null,
  appealResult: 'REJECTED',
  appealDueAtMs: NOW - HOUR,
  lockExpiresAtMs: NOW + DAY,
  objectionResult: 'NONE',
  ...o,
});

const caseOf = (o: Record<string, any> = {}) => ({
  caseId: id(0x100),
  eventId: id(0x200),
  clusterId: id(0x300),
  status: 'APPEAL_PENDING',
  reasonCategory: 'MACRO_BOT',
  assigneeId: id(0x400),
  cancelDeadlineAtMs: CANCEL,
  appealDueAtMs: NOW - HOUR,
  approvalId: null,
  investigatorOpinion: null,
  outcomeLabel: null,
  version: 1,
  createdAtMs: NOW - DAY,
  closedAtMs: null,
  members: [member(1)],
  events: [{ seq: 1, kind: 'CREATED', actorId: id(0x400), note: null, detail: null, occurredAtMs: NOW - DAY }],
  ...o,
});

const problemOf = (fn: () => unknown): { type: string; status: number } | null => {
  try {
    fn();
    return null;
  } catch (e) {
    return e as { type: string; status: number };
  }
};

describe('F-04-13 조치 도메인', () => {
  test('FX-T12 63 상태 함수는 입력 사건을 바꾸지 않는다', () => {
    const freeze = (c: any) =>
      Object.freeze({
        ...c,
        members: Object.freeze(c.members.map((m: any) => Object.freeze({ ...m, signals: Object.freeze([...m.signals]) }))),
        events: Object.freeze(c.events.map((e: any) => Object.freeze({ ...e }))),
      });
    const investigating = caseOf({ status: 'INVESTIGATING', members: [member(1), member(2)] });
    const appealed = caseOf({ status: 'APPEAL_PENDING', members: [member(1)] });
    const objected = caseOf({ status: 'OBJECTED', members: [member(1, { objectionResult: 'SUBMITTED' })] });
    const actioned = caseOf({ status: 'ACTIONED', members: [member(1, { actionNotifiedAtMs: NOW - 10 * DAY })] });
    const frozenInvestigating = freeze(investigating);
    const cleared = domain.clearanceCase({ case: frozenInvestigating, nowMs: NOW, reason: '근거 없음', outcomeLabel: 'HUMAN' });
    expect(cleared.next).not.toBe(frozenInvestigating);
    expect(() => domain.decideObjections({ case: freeze(objected), decisions: [{ accountId: id(1), decision: 'ACCEPTED', reason: '정상' }], nowMs: NOW, reversalComplete: false })).not.toThrow();
    expect(() => domain.actionRequestDecision({
      case: freeze(appealed),
      nowMs: NOW,
      action: 'CANCEL_TICKETS',
      accountIds: [id(1)],
      openApproval: false,
      priorActionDone: false,
      tickets: [{ ticketId: id(0x501), payerAccountId: id(1), holderAccountId: id(1), status: 'ISSUED', entryRecorded: false }],
    })).not.toThrow();
    expect(() => domain.receiveObjection({ case: freeze(actioned), accountId: id(1), party: 'PAYER', appealId: id(0x600), nowMs: NOW })).not.toThrow();
    expect(() => domain.closeActionedCaseIfDue({ case: freeze(actioned), nowMs: NOW, openApproval: false })).not.toThrow();
    const decision = Object.freeze({ action: 'RESTRICT', requesterId: id(0x400), approverId: id(0x401), role: 'commander', designations: [], recentlyRevoked: [], reason: '근거', viewedAtMs: NOW, requestedAccountIds: [id(1)], requestedTicketIds: [] });
    expect(() => domain.approvalDecisionCheck(decision)).not.toThrow();
    expect(() => domain.approvalExecutionGuard({ action: 'RESTRICT', nowMs: NOW, cancelDeadlineAtMs: CANCEL, status: 'PENDING_APPROVAL' })).not.toThrow();
    expect(investigating.status).toBe('INVESTIGATING');
    expect(objected.members[0]!.objectionResult).toBe('SUBMITTED');
    expect(actioned.members[0]!.objectionResult).toBe('NONE');
    expect(investigating.version).toBe(1);
  });

  test('FX-T12 64 [ASVS v5.0.0-2.1.2] 승인 이유·요약 열람·범위 줄이기 판정은 경계값에서 갈린다', () => {
    const base = {
      action: 'CANCEL_TICKETS',
      requesterId: id(0x400),
      approverId: id(0x401),
      role: 'commander',
      designations: [],
      recentlyRevoked: [],
      reason: '근거',
      viewedAtMs: NOW,
      requestedAccountIds: [id(1), id(2)],
      requestedTicketIds: [id(0x501), id(0x502)],
    };
    expect(domain.approvalDecisionCheck(base)).toEqual({ excludedAccounts: [], excludedTickets: [] });
    expect(problemOf(() => domain.approvalDecisionCheck({ ...base, reason: '' }))?.type).toBe('approval-reason-required');
    expect(problemOf(() => domain.approvalDecisionCheck({ ...base, viewedAtMs: null }))?.type).toBe('fraud-summary-not-viewed');
    expect(problemOf(() => domain.approvalDecisionCheck({ ...base, excludeAccountIds: [id(9)] }))?.type).toBe('approval-scope-invalid');
    expect(problemOf(() => domain.approvalDecisionCheck({ ...base, excludeAccountIds: [id(1), id(2)] }))?.type).toBe('approval-scope-invalid');
    expect(problemOf(() => domain.approvalDecisionCheck({ ...base, approverId: base.requesterId }))?.type).toBe('fraud-approver-ineligible');
    expect(problemOf(() => domain.approvalDecisionCheck({ ...base, designations: ['PSEUDONYM_HANDLER'] }))?.type).toBe('fraud-approver-ineligible');
    expect(problemOf(() => domain.approvalDecisionCheck({ ...base, recentlyRevoked: ['PSEUDONYM_HANDLER'] }))?.type).toBe('fraud-approver-ineligible');
    expect(domain.approvalDecisionCheck({ ...base, excludeAccountIds: [id(2)], excludeTicketIds: [id(0x502)] })).toEqual({ excludedAccounts: [id(2)], excludedTickets: [id(0x502)] });
    expect(problemOf(() => domain.approvalDecisionCheck({ ...base, reason: '가'.repeat(1001) }))?.type).toBe('approval-reason-required');
    expect(() => domain.approvalDecisionCheck({ ...base, reason: '가'.repeat(1000) })).not.toThrow();
    expect(problemOf(() => domain.approvalDecisionCheck({ ...base, role: 'cs_lead' }))?.type).toBe('fraud-approver-ineligible');
    expect(problemOf(() => domain.approvalDecisionCheck({ ...base, excludeTicketIds: [id(0x999)] }))?.type).toBe('approval-scope-invalid');
    expect(problemOf(() => domain.approvalDecisionCheck({ ...base, excludeTicketIds: [id(0x501), id(0x502)] }))?.type).toBe('approval-scope-invalid');
  });

  test('FX-T12 65 [ASVS v5.0.0-2.1.3] 이의 창·취소 마감·이용 제한 1년은 같은 순간을 만료로 본다', () => {
    expect(domain.OBJECTION_WINDOW_MS).toBe(30 * DAY);
    expect(domain.RESTRICTION_MAX_MS).toBe(365 * DAY);
    expect(domain.ACTION_APPROVAL_BUSINESS_DAYS).toBe(5);
    expect(domain.CANCEL_NOTICE_LEADS_MS).toEqual([12 * HOUR, 2 * HOUR]);
    const c = caseOf({ status: 'ACTIONED', members: [member(1, { actionNotifiedAtMs: NOW - 30 * DAY })] });
    expect(domain.receiveObjection({ case: c, accountId: id(1), party: 'PAYER', appealId: id(0x600), nowMs: NOW }).result).toBe('EXPIRED');
    const before = caseOf({ status: 'ACTIONED', members: [member(1, { actionNotifiedAtMs: NOW - 30 * DAY + 1 })] });
    expect(domain.receiveObjection({ case: before, accountId: id(1), party: 'PAYER', appealId: id(0x601), nowMs: NOW }).result).toBe('ACCEPTED');
    expect(problemOf(() => domain.approvalExecutionGuard({ action: 'CANCEL_TICKETS', nowMs: CANCEL, cancelDeadlineAtMs: CANCEL, status: 'PENDING_APPROVAL' }))?.type).toBe('cancel-deadline-passed');
    expect(problemOf(() => domain.approvalExecutionGuard({ action: 'CANCEL_TICKETS', nowMs: CANCEL - 1, cancelDeadlineAtMs: CANCEL, status: 'PENDING_APPROVAL' }))).toBeNull();
    const restrictCase = caseOf({ status: 'APPEAL_PENDING', members: [member(1)] });
    expect(problemOf(() => domain.actionRequestDecision({ case: restrictCase, nowMs: NOW, action: 'RESTRICT', accountIds: [id(1)], restrictionEndsAtMs: NOW + 365 * DAY + 1, openApproval: false, priorActionDone: true, tickets: [] }))?.type).toBe('restriction-too-long');
    expect(() => domain.actionRequestDecision({ case: restrictCase, nowMs: NOW, action: 'RESTRICT', accountIds: [id(1)], restrictionEndsAtMs: NOW + 365 * DAY, openApproval: false, priorActionDone: true, tickets: [] })).not.toThrow();
  });

  test('FX-T12 66 [ASVS v5.0.0-2.1.2] C7·C8·C11·C12의 상태 전이는 표에 없는 전이를 409로 거절한다', () => {
    const investigating = caseOf({ status: 'INVESTIGATING' });
    expect(problemOf(() => domain.clearanceCase({ case: investigating, nowMs: NOW, reason: '', outcomeLabel: 'HUMAN' }))?.type).toBe('invalid-body');
    expect(problemOf(() => domain.clearanceCase({ case: caseOf({ status: 'ACTIONED' }), nowMs: NOW, reason: 'x', outcomeLabel: 'HUMAN' }))?.type).toBe('fraud-case-state');
    const objected = caseOf({ status: 'OBJECTED', members: [member(1, { objectionResult: 'SUBMITTED' })] });
    expect(problemOf(() => domain.decideObjections({ case: objected, decisions: [{ accountId: id(2), decision: 'ACCEPTED', reason: 'x' }], nowMs: NOW, reversalComplete: true }))?.type).toBe('objection-decision-invalid');
    const notSubmitted = caseOf({ status: 'OBJECTED', members: [member(1, { objectionResult: 'NONE' })] });
    expect(problemOf(() => domain.decideObjections({ case: notSubmitted, decisions: [{ accountId: id(1), decision: 'ACCEPTED', reason: 'x' }], nowMs: NOW, reversalComplete: true }))?.type).toBe('objection-decision-invalid');
    const closed = caseOf({ status: 'ACTIONED', members: [member(1, { actionNotifiedAtMs: NOW - 31 * DAY })] });
    expect(domain.closeActionedCaseIfDue({ case: closed, nowMs: NOW, openApproval: false }).close).toBe(true);
    expect(domain.closeActionedCaseIfDue({ case: closed, nowMs: NOW, openApproval: true }).close).toBe(false);
  });
});
