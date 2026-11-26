// J-T11 ⑤: ops에서 미수금 청구·회수·손실을 commander만 재인증·멱등 키로 부르고 감사에 남긴다(F-07-15 I-01).
// HTTP는 역할·머리·재인증 전달을 본다. 기준 트리에는 새 메서드·경로가 없어 각 시험이 실행 중 실패한다.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { createService, fakeClock, ProblemError } from '@peaket/platform';
import { AppModule } from '../src/app.module.js';
import { MemoryAuditChain } from '../src/modules/audit/index.js';
import { MemoryPayoutApprovalStore, PayoutApprovals, type PayoutPaymentClient } from '../src/modules/payouts/index.js';
import type { ApprovalReauthVerifier } from '../src/modules/payouts/domain/ports.js';
import { FakeIdentity, quiet } from './support.js';

const NOW = Date.parse('2026-11-27T03:00:00.000Z');
const audit = new MemoryAuditChain();
const store = new MemoryPayoutApprovalStore(audit);

class FakePayments {
  readonly calls: Array<{ method: string; id: string; input: Record<string, unknown> }> = [];
  fail = false;
  #result(kind: string, id: string, input: Record<string, unknown>, amount: number, remainingAfter: number) {
    this.calls.push({ method: kind, id, input });
    return { actionId: randomUUID(), kind, amount, remainingAfter, createdAt: new Date(NOW).toISOString(), receivable: { receivableId: id, status: kind === 'WRITE_OFF' ? 'WRITTEN_OFF' : 'BILLED', remaining: remainingAfter } };
  }
  async billReceivable(id: string, input: Record<string, unknown>) {
    if (this.fail) throw new ProblemError({ type: 'settlement-unavailable', status: 503, title: '정산을 쓸 수 없습니다' });
    return this.#result('BILLED', id, input, 445_000, 445_000);
  }
  async collectReceivable(id: string, input: Record<string, unknown>) {
    return this.#result('COLLECTED', id, input, Number(input.amount), 245_000);
  }
  async writeOffReceivable(id: string, input: Record<string, unknown>) {
    return this.#result('WRITE_OFF', id, input, 245_000, 0);
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

interface OpsActions {
  billReceivable(id: string, input: { actor: { accountId: string; sessionId: string; role: string }; reason: string; idempotencyKey: string; reauthToken: string | undefined }): Promise<{ actionId: string }>;
  collectReceivable(id: string, input: { actor: { accountId: string; sessionId: string; role: string }; amount: number; reason: string; idempotencyKey: string; reauthToken: string | undefined }): Promise<{ actionId: string }>;
  writeOffReceivable(id: string, input: { actor: { accountId: string; sessionId: string; role: string }; reason: string; idempotencyKey: string; reauthToken: string | undefined }): Promise<{ actionId: string }>;
}
const actions = approvals as unknown as OpsActions;
const actor = (role: 'commander' | 'operator' | 'viewer' | 'cs_agent' | 'cs_lead' = 'commander', accountId = randomUUID()) => ({ accountId, sessionId: 'session-a', role });
const token = (a: ReturnType<typeof actor>) => `APPROVAL:${a.accountId}`;

const identity = new FakeIdentity();
let svc: Awaited<ReturnType<typeof createService>>;
beforeAll(async () => {
  svc = await createService({
    name: 'ops-svc',
    module: AppModule.register({ memory: true, payouts: { payments: payments as unknown as PayoutPaymentClient, reauth } }),
    env: { PEAKET_ENV: 'ci' },
    clock: fakeClock({ now: NOW }),
    logDestination: quiet(),
    adminAuthz: identity,
  });
});
afterAll(async () => {
  await svc?.close();
});
const post = (url: string, who: Record<string, string>, body: unknown, extra: Record<string, string> = {}) =>
  svc.http.inject({ method: 'POST', url, headers: { ...who, ...extra, 'content-type': 'application/json' }, payload: JSON.stringify(body) });

beforeEach(() => {
  payments.calls.length = 0;
  payments.fail = false;
  audit.entries.length = 0;
});

describe('J-T11 ⑤ ops 수동 전이', () => {
  test('J-T11 ⑤ commander가 청구하면 payment에 멱등 키·사유·재인증 토큰을 넘기고 감사에 남긴다', async () => {
    const who = actor();
    const receivableId = randomUUID();
    const key = randomUUID();
    const out = await actions.billReceivable(receivableId, { actor: who, reason: '보증 뒤 남은 금액 청구', idempotencyKey: key, reauthToken: token(who) });
    expect(out.actionId).toEqual(expect.any(String));
    expect(payments.calls).toHaveLength(1);
    expect(payments.calls[0]).toMatchObject({ method: 'BILLED', id: receivableId, input: { actor: who.accountId, sessionId: who.sessionId, idempotencyKey: key, reason: '보증 뒤 남은 금액 청구', reauthToken: token(who) } });
    expect(audit.entries.at(-1)?.recordType).toBe('RECEIVABLE_BILLED');
    expect(audit.entries.at(-1)?.record.payload).toMatchObject({ receivableId, actorRef: who.accountId, idempotencyKey: key, amount: 445_000, reason: '보증 뒤 남은 금액 청구' });
  });

  test('J-T11 ⑤ commander가 아니면 역할마다 403이고 payment 호출·감사가 0이다', async () => {
    for (const role of ['operator', 'viewer', 'cs_agent', 'cs_lead'] as const) {
      const who = actor(role);
      await expect(actions.billReceivable(randomUUID(), { actor: who, reason: '청구', idempotencyKey: randomUUID(), reauthToken: token(who) })).rejects.toMatchObject({ type: 'approval-role-required', status: 403 });
      await expect(actions.collectReceivable(randomUUID(), { actor: who, amount: 1, reason: '회수', idempotencyKey: randomUUID(), reauthToken: token(who) })).rejects.toMatchObject({ type: 'approval-role-required', status: 403 });
      await expect(actions.writeOffReceivable(randomUUID(), { actor: who, reason: '손실', idempotencyKey: randomUUID(), reauthToken: token(who) })).rejects.toMatchObject({ type: 'approval-role-required', status: 403 });
    }
    expect(payments.calls).toEqual([]);
    expect(audit.entries).toEqual([]);
  });

  test('J-T11 ⑤ 재인증이 없거나 다른 계정이면 403이고 payment 호출·감사가 0이다', async () => {
    const who = actor();
    await expect(actions.billReceivable(randomUUID(), { actor: who, reason: '청구', idempotencyKey: randomUUID(), reauthToken: undefined })).rejects.toMatchObject({ type: 'reauth-required', status: 403 });
    await expect(actions.billReceivable(randomUUID(), { actor: who, reason: '청구', idempotencyKey: randomUUID(), reauthToken: `APPROVAL:${randomUUID()}` })).rejects.toMatchObject({ type: 'reauth-required', status: 403 });
    expect(payments.calls).toEqual([]);
    expect(audit.entries).toEqual([]);
  });

  test('J-T11 ⑤ 회수 금액과 손실을 payment에 그대로 넘기고 감사 종류·금액이 다르다', async () => {
    const who = actor();
    const receivableId = randomUUID();
    await actions.collectReceivable(receivableId, { actor: who, amount: 200_000, reason: '입금 확인', idempotencyKey: randomUUID(), reauthToken: token(who) });
    expect(payments.calls.at(-1)).toMatchObject({ method: 'COLLECTED', input: { amount: 200_000 } });
    expect(audit.entries.at(-1)?.recordType).toBe('RECEIVABLE_COLLECTED');
    expect(audit.entries.at(-1)?.record.payload).toMatchObject({ amount: 200_000, reason: '입금 확인' });
    await actions.writeOffReceivable(receivableId, { actor: who, reason: '회수 불가', idempotencyKey: randomUUID(), reauthToken: token(who) });
    expect(payments.calls.at(-1)).toMatchObject({ method: 'WRITE_OFF' });
    expect(audit.entries.at(-1)?.recordType).toBe('RECEIVABLE_WRITTEN_OFF');
    expect(audit.entries.at(-1)?.record.payload).toMatchObject({ receivableId, amount: 245_000, reason: '회수 불가' });
  });

  test('J-T11 ⑤ HTTP는 역할·Idempotency-Key·X-Reauth-Token을 보고 503을 그대로 준다', async () => {
    const id = randomUUID();
    const url = `/v1/ops/receivables/${id}/billing`;
    const body = { reason: '보증 뒤 청구' };
    for (const role of ['viewer', 'cs_agent', 'cs_lead'] as const) {
      const r = await post(url, identity.ops(role), body, { 'idempotency-key': randomUUID(), 'x-reauth-token': 'APPROVAL:x' });
      expect(r.statusCode).toBe(403);
    }
    const noKey = identity.ops('commander');
    expect((await post(url, noKey, body)).statusCode).toBe(400);
    const noReauth = identity.ops('commander');
    expect((await post(url, noReauth, body, { 'idempotency-key': randomUUID() })).statusCode).toBe(403);
    const who = identity.ops('commander');
    const key = randomUUID();
    const ok = await post(url, who, body, { 'idempotency-key': key, 'x-reauth-token': `APPROVAL:${who['x-user-id']}` });
    expect(ok.statusCode).toBe(200);
    expect(payments.calls.at(-1)).toMatchObject({ method: 'BILLED', input: { actor: who['x-user-id'], idempotencyKey: key, reason: '보증 뒤 청구' } });
    payments.fail = true;
    expect((await post(url, identity.ops('commander'), body, { 'idempotency-key': randomUUID(), 'x-reauth-token': `APPROVAL:${who['x-user-id']}` })).statusCode).toBe(503);
    expect(audit.entries.filter((e) => e.recordType === 'RECEIVABLE_BILLED')).toHaveLength(1);
  });
});
