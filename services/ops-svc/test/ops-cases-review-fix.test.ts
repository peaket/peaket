// F-06-3 구현 재리뷰 3 IR-11·30 재현 시험(시험 담당, 2026-11-26).
// FLAGGED 건의 대상은 취소 ID다. 처리 행동이 취소 ID를 주문 ID로 풀고, VOID는 입장 기록이 있을 때만
// 티켓을 무효로 하며, 계산서에는 실제 발권 세대를 싣는지 본다.
import { randomUUID } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { OpsCasesController } from '../src/modules/cases/inbound/ops-cases.controller.js';

const ORDER = randomUUID();
const CANCELLATION = randomUUID();
const CASE = randomUUID();
const NOW = Date.parse('2026-11-26T10:00:00+09:00');
const me = { accountId: randomUUID(), role: 'cs_lead', sessionId: 'session' };

const state = {
  kind: 'FLAGGED' as string,
  targetRef: CANCELLATION,
  basis: { orderId: ORDER, refundableAmount: 33_333, entryRecorded: true, issueGeneration: 4, eventId: randomUUID() } as
    | { orderId: string; refundableAmount: number; entryRecorded: boolean; issueGeneration?: number; eventId?: string }
    | undefined,
  requests: [] as Record<string, unknown>[],
  voidCalls: [] as Record<string, unknown>[],
  cancellationVoids: [] as string[],
  resolved: [] as string[],
  voidResult: { voided: 2, alreadyEntered: 1 },
};

const lifecycle = {
  async refundBasis() {
    return state.basis;
  },
  async refundableAmount() {
    return state.basis?.refundableAmount ?? 0;
  },
  async request(input: Record<string, unknown>) {
    state.requests.push(input);
    return { approvalId: randomUUID(), status: 'PENDING_APPROVAL' };
  },
  async voidOrder(orderId: string, reason: string, o: Record<string, unknown> = {}) {
    state.voidCalls.push({ orderId, reason, ...o });
    return state.voidResult;
  },
  async voidCancellation(cancellationId: string) {
    state.cancellationVoids.push(cancellationId);
  },
};

const cases = {
  async get() {
    return { view: { caseId: CASE, kind: state.kind, targetRef: state.targetRef, status: 'IN_PROGRESS', category: 'ENTRY_AFTER_CANCEL' }, version: 1 };
  },
  async resolveAsSystem(_caseId: string, reason: string) {
    state.resolved.push(reason);
    return { caseId: CASE };
  },
};

const controller = new OpsCasesController(cases as never, {} as never, lifecycle as never);

const reset = () => {
  state.kind = 'FLAGGED';
  state.targetRef = CANCELLATION;
  state.basis = { orderId: ORDER, refundableAmount: 33_333, entryRecorded: true, issueGeneration: 4, eventId: randomUUID() };
  state.requests.length = 0;
  state.voidCalls.length = 0;
  state.cancellationVoids.length = 0;
  state.resolved.length = 0;
  state.voidResult = { voided: 2, alreadyEntered: 1 };
};

describe('IR-11 FLAGGED REFUND는 취소 ID를 주문 ID로 풀어 실제 남은 환급액으로 승인한다', () => {
  test('IR-11 REFUND 승인의 targetRef는 주문 ID이고 금액은 0이 아니다', async () => {
    reset();
    await controller.cancellationDecision(CASE, { decision: 'REFUND', reason: '기록 오류' }, me as never);
    expect(state.requests).toHaveLength(1);
    expect(state.requests[0]).toMatchObject({ kind: 'SYSTEM_FAULT_REFUND', targetRef: ORDER, amount: 33_333, reasonCode: 'FLAGGED_REFUND' });
    expect(state.resolved).toHaveLength(1);
  });

  test('IR-11 basis가 없으면 0원 승인을 만들지 않고 404다', async () => {
    reset();
    state.basis = undefined;
    await expect(controller.cancellationDecision(CASE, { decision: 'REFUND', reason: '기록 오류' }, me as never)).rejects.toMatchObject({ status: 404 });
    expect(state.requests).toHaveLength(0);
    expect(state.resolved).toHaveLength(0);
  });
});

describe('IR-30 FLAGGED VOID는 입장 기록이 있을 때만 티켓을 무효로 한다', () => {
  test('IR-30 입장 기록이 없으면 409이고 ticket-svc를 부르지 않는다', async () => {
    reset();
    state.basis = { orderId: ORDER, refundableAmount: 33_333, entryRecorded: false, issueGeneration: 4 };
    await expect(controller.cancellationDecision(CASE, { decision: 'VOID', reason: '무효' }, me as never)).rejects.toMatchObject({ status: 409 });
    expect(state.voidCalls).toHaveLength(0);
    expect(state.cancellationVoids).toHaveLength(0);
    expect(state.resolved).toHaveLength(0);
  });

  test('IR-30 입장 기록이 있으면 주문 ID·발권 세대로 무효화하고 취소 행도 무효로 끝낸다', async () => {
    reset();
    await controller.cancellationDecision(CASE, { decision: 'VOID', reason: '무효' }, me as never);
    expect(state.voidCalls).toEqual([{ orderId: ORDER, reason: 'FLAGGED_VOID', issueGeneration: 4, eventId: expect.any(String) }]);
    expect(state.cancellationVoids).toEqual([CANCELLATION]);
    expect(state.resolved).toHaveLength(1);
  });

  test('IR-30 ticket-svc가 입장 기록을 0으로 답하면 409이고 CS 건을 닫지 않는다', async () => {
    reset();
    state.voidResult = { voided: 0, alreadyEntered: 0 };
    await expect(controller.cancellationDecision(CASE, { decision: 'VOID', reason: '무효' }, me as never)).rejects.toMatchObject({ status: 409 });
    expect(state.cancellationVoids).toHaveLength(0);
    expect(state.resolved).toHaveLength(0);
  });
});

describe('IR-11 TICKET_NOT_ISSUED 시스템 잘못 환불', () => {
  test('IR-11 system-refund도 주문 ID와 남은 환급액으로 승인을 만든다', async () => {
    reset();
    state.kind = 'TICKET_NOT_ISSUED';
    state.targetRef = ORDER;
    state.basis = { orderId: ORDER, refundableAmount: 45_000, entryRecorded: false };
    const approval = await controller.systemRefund(CASE, { reason: '발권 불가' }, me as never);
    expect(approval).toMatchObject({ status: 'PENDING_APPROVAL' });
    expect(state.requests[0]).toMatchObject({ kind: 'SYSTEM_FAULT_REFUND', targetRef: ORDER, amount: 45_000, reasonCode: 'TICKET_NOT_ISSUED' });
    expect(state.resolved).toHaveLength(1);
  });

  test('IR-11 basis가 없으면 404이고 승인을 만들지 않는다', async () => {
    reset();
    state.kind = 'TICKET_NOT_ISSUED';
    state.targetRef = ORDER;
    state.basis = undefined;
    await expect(controller.systemRefund(CASE, { reason: '발권 불가' }, me as never)).rejects.toMatchObject({ status: 404 });
    expect(state.requests).toHaveLength(0);
    expect(state.resolved).toHaveLength(0);
  });
});

// 시각 상수는 이 파일의 기준 시각을 한 곳에 둔다(다른 시험이 참조하지 않는다).
void NOW;
