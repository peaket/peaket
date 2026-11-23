// R-T47 ③ payment-svc 배상 송금 결과 확정(F-07-8 계획 I-06, transfer-refund §6 '송금 결과 확정', settlement §4.1 '회차 취소 배상 지급의 막힘', J-T28).
// REQUESTED로 끝난 송금을 조회 바퀴(refreshRequested)가 지급대행 포트로 다시 보고: PAID면 상태와 COMPENSATION_ADVANCE 미수금 한 행·receivable_id를 한 번에,
// FAILED면 상태만(미수금 0), 여전히 REQUESTED·조회 실패면 그대로 둔다. 같은 행을 두 바퀴·두 인스턴스가 겹쳐 봐도 미수금은 한 행이다.
// 가짜 어댑터(FakeCompensationTransfer)는 접수 때 결과를 송금 ID에 담는다(`fake-{uuid}-p`·`-f`, 계좌 끝 4자리 0000이면 -f [가정 모양]).
// 실제 은행·지급대행은 부르지 않는다. 지급대행 포트는 시험 대역(포트 CompensationTransferPort를 implements), 미수금은 진짜 Settlements(메모리 저장소)다.
// 기준 트리: refreshRequested가 없고 가짜 어댑터가 늘 REQUESTED·결과 없는 ID라 실패한다(계획 §7).
import { fakeClock } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { CompensationTransfers } from '../src/modules/compensation/application/compensation-transfers.js';
import { FakeCompensationTransfer } from '../src/modules/compensation/adapters/fake-compensation-transfer.js';
import type { CompensationReceivables, CompensationTransferPort, CompensationTransferRecord, CompensationTransferRequest, CompensationTransferStore } from '../src/modules/compensation/domain/ports.js';
import { ManualPortonePayoutGateway, MemoryReauthVerifier, MemorySettlementPaymentSource, MemorySettlementStore, Settlements, UnavailableTossPayoutGateway } from '../src/modules/settlement/index.js';
import { noApprovals, noSaleSuspensions } from './settlement-support.js';

const NOW = Date.parse('2026-11-23T01:00:00.000Z');
const PROMOTER = '0194f078-0000-7000-8000-000000000001';
const EVENT = '0194f078-0000-7000-8000-000000000002';
const ACCOUNT_NO = '110-987-654321';
const ACCOUNT_DIGITS = '110987654321';

const input = (o: Partial<CompensationTransferRequest> = {}): CompensationTransferRequest => ({
  compensationId: randomUUID(),
  orderId: randomUUID(),
  accountId: randomUUID(),
  amount: 4_750,
  bankCode: '88',
  accountNumber: ACCOUNT_NO,
  holderName: '김배상',
  requestedBy: 'ops-f078',
  promoterId: PROMOTER,
  eventId: EVENT,
  ...o,
});

/** 지급대행 포트 대역: 접수는 늘 REQUESTED, 조회는 시험이 정한 결과(없으면 REQUESTED), 조회 실패 주입 */
class ScriptedPort implements CompensationTransferPort {
  readonly results = new Map<string, 'PAID' | 'FAILED' | 'REQUESTED'>();
  readonly gets: string[] = [];
  failGet = false;
  #seq = 0;
  async request(i: CompensationTransferRequest): Promise<CompensationTransferRecord> {
    this.#seq += 1;
    return { transferId: `tr-f078-${this.#seq}`, compensationId: i.compensationId, orderId: i.orderId, accountId: i.accountId, amount: i.amount, status: 'REQUESTED' };
  }
  async get(transferId: string): Promise<CompensationTransferRecord | undefined> {
    this.gets.push(transferId);
    if (this.failGet) throw Object.assign(new Error('transfer get timeout'), { code: 'ETIMEDOUT' });
    const status = this.results.get(transferId) ?? 'REQUESTED';
    return { transferId, compensationId: '', orderId: '', accountId: '', amount: 0, status, ...(status === 'FAILED' ? { failureReason: 'bank-rejected' } : {}) };
  }
}

function world() {
  const store = new MemorySettlementStore();
  const settlements = new Settlements({
    store,
    payments: new MemorySettlementPaymentSource(),
    eventCommission: { rateBp: async () => 850 },
    approvals: noApprovals,
    saleSuspensions: noSaleSuspensions,
    gateways: [new ManualPortonePayoutGateway(), new UnavailableTossPayoutGateway()],
    reauth: new MemoryReauthVerifier(),
    clock: fakeClock({ now: NOW }),
  });
  const receivables: CompensationReceivables = { recordCompensationAdvance: (i) => settlements.recordCompensationAdvance(i) };
  return { store, settlements, receivables };
}

const advances = (store: MemorySettlementStore) => [...store.receivables.values()].filter((r) => r.cause === 'COMPENSATION_ADVANCE');

describe('R-T47 ③ 배상 송금 조회 바퀴(payment)', () => {
  test('R-T47 ③ REQUESTED → 조회 PAID면 PAID·COMPENSATION_ADVANCE 미수금 1행·receivable_id이고, 두 바퀴 돌아도 1행이다 [ASVS v5.0.0-2.3.4]', async () => {
    const w = world();
    const port = new ScriptedPort();
    const app = new CompensationTransfers(port, undefined, w.receivables);
    const req = input();
    const sent = await app.request(req);
    expect(sent).toMatchObject({ status: 'REQUESTED', accountLast4: '4321' });
    expect(advances(w.store)).toEqual([]);
    port.results.set(sent.transferId, 'PAID');
    await expect(app.refreshRequested()).resolves.toEqual({ paid: 1, failed: 0, pending: 0 });
    const after = await app.get(sent.transferId);
    expect(after).toMatchObject({ compensationId: req.compensationId, status: 'PAID', amount: 4_750 });
    expect(advances(w.store)).toEqual([expect.objectContaining({ receivableId: after.receivableId, promoterId: PROMOTER, eventId: EVENT, pg: null, amount: 4_750, remaining: 4_750, status: 'OPEN', sourceRef: `compensation:${req.compensationId}` })]);
    await expect(app.refreshRequested()).resolves.toEqual({ paid: 0, failed: 0, pending: 0 });
    expect(advances(w.store)).toHaveLength(1);
  });

  test('R-T47 ③ 조회 FAILED면 FAILED이고 미수금 0행이다', async () => {
    const w = world();
    const port = new ScriptedPort();
    const app = new CompensationTransfers(port, undefined, w.receivables);
    const sent = await app.request(input());
    port.results.set(sent.transferId, 'FAILED');
    await expect(app.refreshRequested()).resolves.toEqual({ paid: 0, failed: 1, pending: 0 });
    expect(await app.get(sent.transferId)).toMatchObject({ status: 'FAILED' });
    expect(advances(w.store)).toEqual([]);
  });

  // F-16: 배상 송금 조회 실패 → 그대로, 다음 바퀴에 다시 본다
  test('R-T47 ③ 여전히 REQUESTED·조회 실패면 그대로이고 다음 바퀴에 다시 본다', async () => {
    const w = world();
    const port = new ScriptedPort();
    const app = new CompensationTransfers(port, undefined, w.receivables);
    const sent = await app.request(input());
    await expect(app.refreshRequested()).resolves.toEqual({ paid: 0, failed: 0, pending: 1 });
    port.failGet = true;
    await expect(app.refreshRequested()).resolves.toMatchObject({ paid: 0, failed: 0 });
    expect(await app.get(sent.transferId)).toMatchObject({ status: 'REQUESTED' });
    expect(advances(w.store)).toEqual([]);
    port.failGet = false;
    port.results.set(sent.transferId, 'PAID');
    await expect(app.refreshRequested()).resolves.toMatchObject({ paid: 1 });
    expect(port.gets.filter((g) => g === sent.transferId).length).toBeGreaterThanOrEqual(3);
  });

  // F-12: 송금 PAID와 미수금 한 행이 한 번에(미수금 넣기 실패면 REQUESTED 그대로)
  test('R-T47 ③ 미수금 쓰기가 실패하면 상태는 REQUESTED 그대로이고 다음 바퀴가 PAID·미수금 1행으로 마저 한다 [ASVS v5.0.0-2.3.3]', async () => {
    const w = world();
    let fail = true;
    const receivables: CompensationReceivables = {
      recordCompensationAdvance: async (i) => {
        if (fail) throw new Error('미수금 쓰기 실패(시험 주입)');
        return w.settlements.recordCompensationAdvance(i);
      },
    };
    const port = new ScriptedPort();
    const app = new CompensationTransfers(port, undefined, receivables);
    const sent = await app.request(input());
    port.results.set(sent.transferId, 'PAID');
    await app.refreshRequested().catch(() => undefined);
    expect(await app.get(sent.transferId)).toMatchObject({ status: 'REQUESTED' });
    expect(advances(w.store)).toEqual([]);
    fail = false;
    await expect(app.refreshRequested()).resolves.toMatchObject({ paid: 1 });
    expect(await app.get(sent.transferId)).toMatchObject({ status: 'PAID', receivableId: advances(w.store)[0]!.receivableId });
  });

  // F-21: 두 인스턴스(다른 파드)가 같은 저장소의 같은 REQUESTED를 겹쳐 확정해도 상태 쓰기·미수금이 하나씩
  test('R-T47 ③ 같은 저장소를 보는 두 인스턴스가 겹쳐 조회 바퀴를 돌려도 PAID 쓰기와 미수금은 하나다 [ASVS v5.0.0-2.3.4]', async () => {
    const w = world();
    const port = new ScriptedPort();
    const first = new CompensationTransfers(port, undefined, w.receivables);
    // type-escape: 첫 인스턴스의 기본 메모리 저장소를 둘째 인스턴스에 꽂는다(같은 DB를 보는 두 파드의 꼴, 기존 RV-23 시험과 같은 방법) F-07-8
    const store = (first as unknown as { store: CompensationTransferStore }).store;
    const second = new CompensationTransfers(port, store, w.receivables);
    const sent = await first.request(input());
    port.results.set(sent.transferId, 'PAID');
    const [a, b] = await Promise.all([first.refreshRequested(), second.refreshRequested()]);
    expect(a.paid + b.paid).toBe(1);
    expect(advances(w.store)).toHaveLength(1);
    expect(await first.get(sent.transferId)).toMatchObject({ status: 'PAID', receivableId: advances(w.store)[0]!.receivableId });
  });

  test('R-T47 ③ 계좌 원문은 송금 기록·미수금 어디에도 없다 [ASVS v5.0.0-16.2.5]', async () => {
    const w = world();
    const port = new ScriptedPort();
    const app = new CompensationTransfers(port, undefined, w.receivables);
    const sent = await app.request(input());
    port.results.set(sent.transferId, 'PAID');
    await app.refreshRequested();
    const text = JSON.stringify([await app.get(sent.transferId), ...w.store.receivables.values(), w.store.receivableMoves]);
    expect(text).not.toContain(ACCOUNT_DIGITS);
    expect(text).not.toContain(ACCOUNT_NO);
    expect(text).not.toContain('김배상');
  });
});

describe('R-T47 ③ 가짜 송금 어댑터의 결과 확정(FakeCompensationTransfer)', () => {
  const env = { PEAKET_ENV: 'ci', PEAKET_COMPENSATION_TRANSFER_MODE: 'fake' };

  test('R-T47 ③ 접수는 REQUESTED이고 송금 ID에 결과를 담는다: 보통 계좌는 -p(PAID), 끝 4자리 0000은 -f(FAILED)', async () => {
    const fake = new FakeCompensationTransfer(env);
    const paid = await fake.request(input({ accountNumber: '110987654321' }));
    const failed = await fake.request(input({ accountNumber: '110-987-650000' }));
    expect(paid.status).toBe('REQUESTED');
    expect(failed.status).toBe('REQUESTED');
    expect(paid.transferId).toMatch(/^fake-[0-9a-f-]{36}-p$/);
    expect(failed.transferId).toMatch(/^fake-[0-9a-f-]{36}-f$/);
    expect(await fake.get(paid.transferId)).toMatchObject({ transferId: paid.transferId, status: 'PAID' });
    expect(await fake.get(failed.transferId)).toMatchObject({ transferId: failed.transferId, status: 'FAILED' });
    expect(JSON.stringify([paid, failed])).not.toContain('110987654321');
  });

  test('R-T47 ③ 다시 띄운 가짜 어댑터도 같은 송금 ID에 같은 결과를 주고, 모르는 ID는 undefined다', async () => {
    const first = new FakeCompensationTransfer(env);
    const paid = await first.request(input());
    const failed = await first.request(input({ accountNumber: '3330000' }));
    const restarted = new FakeCompensationTransfer(env);
    expect(await restarted.get(paid.transferId)).toMatchObject({ status: 'PAID' });
    expect(await restarted.get(failed.transferId)).toMatchObject({ status: 'FAILED' });
    expect(await restarted.get('tr-unknown')).toBeUndefined();
    expect(await restarted.get(`fake-${randomUUID()}-x`)).toBeUndefined();
  });

  test('R-T47 ③ 가짜 어댑터 + 조회 바퀴: -p는 PAID·미수금 1행, -f는 FAILED·미수금 0행', async () => {
    const w = world();
    const app = new CompensationTransfers(new FakeCompensationTransfer(env), undefined, w.receivables);
    const p = await app.request(input());
    const f = await app.request(input({ accountNumber: '1100000' }));
    await expect(app.refreshRequested()).resolves.toEqual({ paid: 1, failed: 1, pending: 0 });
    expect(await app.get(p.transferId)).toMatchObject({ status: 'PAID' });
    expect(await app.get(f.transferId)).toMatchObject({ status: 'FAILED' });
    expect(advances(w.store)).toHaveLength(1);
  });
});
