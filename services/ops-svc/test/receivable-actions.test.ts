// J-T11 ⑤: ops에서 미수금 청구·회수·손실을 commander만 재인증·멱등 키로 부르고 감사에 남긴다(F-07-15 I-01).
// 기준 트리에는 PayoutApprovals의 새 메서드와 PayoutPaymentClient의 새 메서드가 없어 실패한다.
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, test } from 'vitest';
import { MemoryAuditChain } from '../src/modules/audit/index.js';
import { MemoryPayoutApprovalStore, PayoutApprovals, type PayoutPaymentClient } from '../src/modules/payouts/index.js';
import type { ApprovalReauthVerifier } from '../src/modules/payouts/domain/ports.js';
import { ProblemError } from '@peaket/platform';

const NOW = Date.parse('2026-11-27T03:00:00.000Z');
const audit = new MemoryAuditChain();
const store = new MemoryPayoutApprovalStore(audit);

class FakePayments {
  readonly calls: Array<{ method: string; id: string; input: Record<string, unknown> }> = [];
  fail = false;
  async billReceivable(id: string, input: Record<string, unknown>) {
    if (this.fail) throw new ProblemError({ type: 'settlement-unavailable', status: 503, title: '정산을 쓸 수 없습니다' });
    this.calls.push({ method: 'bill', id, input });
    return { actionId: randomUUID(), kind: 'BILLED', amount: 445_000, remainingAfter: 445_000, createdAt: new Date(NOW).toISOString(), receivable: { receivableId: id, status: 'BILLED', remaining: 445_000 } };
  }
  async collectReceivable(id: string, input: Record<string, unknown>) {
    this.calls.push({ method: 'collect', id, input });
    return { actionId: randomUUID(), kind: 'COLLECTED', amount: input.amount, remainingAfter: 245_000, createdAt: new Date(NOW).toISOString(), receivable: { receivableId: id, status: 'BILLED', remaining: 245_000 } };
  }
  async writeOffReceivable(id: string, input: Record<string, unknown>) {
    this.calls.push({ method: 'writeOff', id, input });
    return { actionId: randomUUID(), kind: 'WRITE_OFF', amount: 245_000, remainingAfter: 0, createdAt: new Date(NOW).toISOString(), receivable: { receivableId: id, status: 'WRITTEN_OFF', remaining: 0 } };
  }
}

const payments = new FakePayments();
const reauth: ApprovalReauthVerifier = {
  async verify(token, o) {
    if (!token) throw new ProblemError({ type: 'reauth-required', status: 403, title: '다시 인증해 주세요' });
    const [act, accountId] = token.split(':');
    if (act !== o.act) throw new ProblemError({ type: 'reauth-required', status: 403, title: '다시 인증해 주세요' });
    return { accountId: accountId ?? '', factors: ['password', 'totp', 'passkey'] };
  },
};
const approvals = new PayoutApprovals({
  store,
  payments: payments as unknown as PayoutPaymentClient,
  reauth,
  clock: { now: () => NOW, monotonicMs: () => 0 },
  audit,
});
const actor = (role: 'commander' | 'operator' = 'commander', accountId = randomUUID()) => ({ accountId, sessionId: 'session-a', role });
const token = (a: ReturnType<typeof actor>) => `APPROVAL:${a.accountId}`;

beforeEach(() => {
  payments.calls.length = 0;
  payments.fail = false;
  audit.entries.length = 0;
});

describe('J-T11 ⑤ ops 수동 전이', () => {
  test('J-T11 ⑤ commander가 청구하면 payment에 멱등 키·사유를 넘기고 감사에 남긴다', async () => {
    const who = actor();
    const receivableId = randomUUID();
    const key = randomUUID();
    const out = (await approvals.billReceivable(receivableId, { actor: who, reason: '보증 뒤 남은 금액 청구', idempotencyKey: key, reauthToken: token(who) })) as { actionId: string };
    expect(out.actionId).toEqual(expect.any(String));
    expect(payments.calls).toHaveLength(1);
    expect(payments.calls[0]).toMatchObject({ method: 'bill', id: receivableId, input: { actor: who.accountId, sessionId: who.sessionId, idempotencyKey: key, reason: '보증 뒤 남은 금액 청구' } });
    expect(audit.entries.at(-1)?.recordType).toBe('RECEIVABLE_BILLED');
    expect(audit.entries.at(-1)?.record.payload).toMatchObject({ receivableId, actorRef: who.accountId, idempotencyKey: key });
  });

  test('J-T11 ⑤ operator는 청구·회수·손실을 부를 수 없다', async () => {
    const who = actor('operator');
    await expect(approvals.billReceivable(randomUUID(), { actor: who, reason: '청구', idempotencyKey: randomUUID(), reauthToken: token(who) })).rejects.toMatchObject({ type: 'approval-role-required', status: 403 });
    await expect(approvals.collectReceivable(randomUUID(), { actor: who, amount: 1, reason: '회수', idempotencyKey: randomUUID(), reauthToken: token(who) })).rejects.toMatchObject({ type: 'approval-role-required', status: 403 });
    await expect(approvals.writeOffReceivable(randomUUID(), { actor: who, reason: '손실', idempotencyKey: randomUUID(), reauthToken: token(who) })).rejects.toMatchObject({ type: 'approval-role-required', status: 403 });
    expect(payments.calls).toEqual([]);
    expect(audit.entries).toEqual([]);
  });

  test('J-T11 ⑤ 재인증이 없거나 다른 계정이면 403이고 payment 호출·감사가 0이다', async () => {
    const who = actor();
    await expect(approvals.billReceivable(randomUUID(), { actor: who, reason: '청구', idempotencyKey: randomUUID(), reauthToken: undefined })).rejects.toMatchObject({ type: 'reauth-required', status: 403 });
    await expect(approvals.billReceivable(randomUUID(), { actor: who, reason: '청구', idempotencyKey: randomUUID(), reauthToken: `APPROVAL:${randomUUID()}` })).rejects.toMatchObject({ type: 'reauth-required', status: 403 });
    expect(payments.calls).toEqual([]);
    expect(audit.entries).toEqual([]);
  });

  test('J-T11 ⑤ 회수 금액과 손실을 payment에 그대로 넘기고 감사 종류가 다르다', async () => {
    const who = actor();
    const receivableId = randomUUID();
    await approvals.collectReceivable(receivableId, { actor: who, amount: 200_000, reason: '입금 확인', idempotencyKey: randomUUID(), reauthToken: token(who) });
    expect(payments.calls.at(-1)).toMatchObject({ method: 'collect', input: { amount: 200_000 } });
    expect(audit.entries.at(-1)?.recordType).toBe('RECEIVABLE_COLLECTED');
    await approvals.writeOffReceivable(receivableId, { actor: who, reason: '회수 불가', idempotencyKey: randomUUID(), reauthToken: token(who) });
    expect(payments.calls.at(-1)).toMatchObject({ method: 'writeOff' });
    expect(audit.entries.at(-1)?.recordType).toBe('RECEIVABLE_WRITTEN_OFF');
    expect(audit.entries.at(-1)?.record.payload).toMatchObject({ receivableId, amount: 245_000 });
  });

  test('J-T11 ⑤ payment가 503이면 감사를 남기지 않는다', async () => {
    const who = actor();
    payments.fail = true;
    await expect(approvals.billReceivable(randomUUID(), { actor: who, reason: '청구', idempotencyKey: randomUUID(), reauthToken: token(who) })).rejects.toMatchObject({ status: 503 });
    expect(audit.entries).toEqual([]);
  });
});
