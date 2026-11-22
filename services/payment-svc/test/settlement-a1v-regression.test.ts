// A1V 정산 감사(R-620) 회귀 시험. 구현 세부가 아니라 정본의 금액·상태·에러·감사 계약을 고정한다.
// 대상: A1V-01(이중 상계), A1V-02(지급일), A1V-03(이의 결과 없는 재확정), A1V-04(HELD 증빙),
//       A1V-10(스케줄러 첫 tick·06시 게이트·confirmDue 독립), A1V-12(상태 전이 감사).
import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { createService, fakeClock } from '@peaket/platform';
import { Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import {
  calculateEventStatement,
  MemoryReauthVerifier,
  MemorySettlementPaymentSource,
  MemorySettlementStore,
  ManualPortonePayoutGateway,
  SettlementDueWorker,
  SettlementModule,
  Settlements,
  DenyAllAdminAuthz,
  UnavailableTossPayoutGateway,
  type HoldReason,
  type KycRecord,
  type PaymentFact,
  type SettlementDueLog,
  type SettlementDueTimer,
  type StatementStatus,
} from '../src/modules/settlement/index.js';
import { noApprovals, noSaleSuspensions } from './settlement-support.js';

const NOW = new Date('2026-11-14T00:00:00.000Z');
const quiet = () => new Writable({ write(_c, _e, cb) { cb(); } });

const fact = (o: Partial<PaymentFact> = {}): PaymentFact => ({ paymentId: randomUUID(), amount: 10_000, cancelledAmount: 0, status: 'APPROVED', failureCategory: null, ...o });

const kyc = (promoterId: string): KycRecord => ({
  promoterId,
  status: 'VERIFIED',
  businessVerified: true,
  representativeVerified: true,
  verifiedAt: NOW,
  source: 'MANUAL',
  updatedAt: NOW,
});

const settlementsFor = (store: MemorySettlementStore, payments = new MemorySettlementPaymentSource()): Settlements =>
  new Settlements({
    store,
    payments,
    eventCommission: { rateBp: async () => 1000 },
    approvals: noApprovals,
    saleSuspensions: noSaleSuspensions,
    gateways: [new ManualPortonePayoutGateway(), new UnavailableTossPayoutGateway()],
    reauth: new MemoryReauthVerifier(),
    clock: fakeClock({ now: NOW.getTime() }),
  });

const eventStatement = (o: {
  promoterId: string;
  eventId?: string;
  amount?: number;
  status?: StatementStatus;
  holdReason?: HoldReason | null;
  disputeDueAt?: Date;
  now?: Date;
  kyc?: KycRecord | undefined;
}) => {
  const { record, sources } = calculateEventStatement({
    promoterId: o.promoterId,
    eventId: o.eventId ?? randomUUID(),
    pg: 'TOSS',
    pgStore: 'STANDARD',
    commissionRateBp: 1000,
    payments: [fact({ amount: o.amount ?? 100_000 })],
    kyc: 'kyc' in o ? o.kyc : kyc(o.promoterId),
    account: undefined,
    now: o.now ?? NOW,
    statementId: randomUUID(),
  });
  return {
    record: {
      ...record,
      ...(o.status ? { status: o.status } : {}),
      ...(o.holdReason !== undefined ? { holdReason: o.holdReason } : {}),
      ...(o.disputeDueAt ? { disputeDueAt: o.disputeDueAt } : {}),
    },
    sources,
  };
};

const insertEventStatement = async (store: MemorySettlementStore, o: Parameters<typeof eventStatement>[0]) => {
  const built = eventStatement(o);
  expect(await store.insertStatement(built.record, built.sources)).toBe(true);
  return built;
};

describe('A1V-01 한 지급 묶음의 미수금 상계', () => {
  test('정산서 2개(각 89,000)와 미수금 50,000이면 총액 128,000·이동 기록 한 줄이다', async () => {
    const promoterId = randomUUID();
    const store = new MemorySettlementStore();
    store.kycs.set(promoterId, kyc(promoterId));
    const first = await insertEventStatement(store, { promoterId, amount: 100_000, status: 'CONFIRMED' });
    const second = await insertEventStatement(store, { promoterId, amount: 100_000, status: 'CONFIRMED' });
    expect(first.record.payoutAmount).toBe(89_000);
    expect(second.record.payoutAmount).toBe(89_000);

    const settlements = settlementsFor(store);
    const receivable = await settlements.recordReceivable({ promoterId, pg: 'TOSS', cause: 'REFUND_AFTER_PAYOUT', amount: 50_000 });
    const batch = await settlements.createPayoutBatch({ pg: 'TOSS', pgStore: 'STANDARD', payoutDate: first.record.payoutDate!, actor: randomUUID() });

    expect(batch.totalAmount).toBe(128_000);
    expect(batch.statementCount).toBe(2);
    expect(store.receivableMoves).toHaveLength(1);
    expect(store.receivableMoves[0]).toMatchObject({ receivableId: receivable.receivableId, amount: 50_000 });
    expect(store.receivableMoves.reduce((sum, move) => sum + move.amount, 0)).toBe(50_000);
    expect(store.receivables.get(receivable.receivableId)).toMatchObject({ remaining: 0, status: 'CLOSED' });

    const after = [await store.findStatementById(first.record.statementId), await store.findStatementById(second.record.statementId)];
    expect(after.map((s) => s!.offsetAmount).reduce((sum, amount) => sum + amount, 0)).toBe(50_000);
    expect(after.map((s) => s!.payoutAmount).reduce((sum, amount) => sum + amount, 0)).toBe(128_000);
  });
});

describe('A1V-02 회차 종료 다음 영업일 계산과 종료일 +5영업일 지급일', () => {
  test('2026-11-08 종료·2026-11-14 실행이면 through 2026-11-13, payoutDate 2026-11-13이다', async () => {
    const promoterId = randomUUID();
    const eventId = randomUUID();
    const store = new MemorySettlementStore();
    store.kycs.set(promoterId, kyc(promoterId));
    const payments = new MemorySettlementPaymentSource();
    payments.set(eventId, 'TOSS', [fact({ amount: 10_000_000 })]);
    const seen: string[] = [];
    const settlements = new Settlements({
      store,
      payments,
      events: {
        async listDue(through) {
          seen.push(through);
          // R-620 이전 워커는 through=2026-11-09를 보내 이 회차를 놓친다.
          return through >= '2026-11-13' ? [{ promoterId, eventId, endsAt: '2026-11-08T00:00:00.000Z' }] : [];
        },
      },
      eventCommission: { rateBp: async () => 1000 },
      approvals: noApprovals,
      saleSuspensions: noSaleSuspensions,
      gateways: [new ManualPortonePayoutGateway(), new UnavailableTossPayoutGateway()],
      reauth: new MemoryReauthVerifier(),
      clock: fakeClock({ now: NOW.getTime() }),
    });
    const worker = new SettlementDueWorker({ settlements, leader: { isLeader: () => true }, clock: fakeClock({ now: NOW.getTime() }) });

    await worker.tick();

    expect(seen).toEqual(['2026-11-13']);
    const statements = [...store.statements.values()];
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatchObject({ grossAmount: 10_000_000, payoutDate: '2026-11-13', status: 'NOTIFIED' });
  });

  test('금요일 종료·월요일 06시 실행 경계: 2026-11-06 종료, 2026-11-09 실행 → payoutDate 2026-11-13이다', async () => {
    const promoterId = randomUUID();
    const eventId = randomUUID();
    const store = new MemorySettlementStore();
    store.kycs.set(promoterId, kyc(promoterId));
    const payments = new MemorySettlementPaymentSource();
    payments.set(eventId, 'TOSS', [fact({ amount: 10_000_000 })]);
    const seen: string[] = [];
    const monday = new Date('2026-11-09T00:00:00.000Z'); // 2026-11-09 09:00 KST
    const settlements = new Settlements({
      store,
      payments,
      events: {
        async listDue(through) {
          seen.push(through);
          // R-620 이전 워커는 through=2026-11-02를 보내 금요일 종료 회차를 놓친다.
          return through >= '2026-11-08' ? [{ promoterId, eventId, endsAt: '2026-11-06T00:00:00.000Z' }] : [];
        },
      },
      eventCommission: { rateBp: async () => 1000 },
      approvals: noApprovals,
      saleSuspensions: noSaleSuspensions,
      gateways: [new ManualPortonePayoutGateway(), new UnavailableTossPayoutGateway()],
      reauth: new MemoryReauthVerifier(),
      clock: fakeClock({ now: monday.getTime() }),
    });
    const worker = new SettlementDueWorker({ settlements, leader: { isLeader: () => true }, clock: fakeClock({ now: monday.getTime() }) });

    await worker.tick();

    expect(seen).toEqual(['2026-11-08']);
    const statements = [...store.statements.values()];
    expect(statements).toHaveLength(1);
    // 2026-11-06(금) + 월·화·수·목·금 = 2026-11-13(금). 공휴일은 아직 주말만 건너뛴다.
    expect(statements[0]).toMatchObject({ payoutDate: '2026-11-13' });
  });

  test('지급일은 계산일이 아니라 회차 종료일 +5영업일이다(공휴일은 아직 주말만 건너뛴다)', () => {
    const promoterId = randomUUID();
    const { record } = calculateEventStatement({
      promoterId,
      eventId: randomUUID(),
      pg: 'TOSS',
      pgStore: 'STANDARD',
      commissionRateBp: 1000,
      payments: [fact({ amount: 10_000_000 })],
      kyc: kyc(promoterId),
      account: undefined,
      now: NOW,
      eventEndsAt: '2026-11-08T00:00:00.000Z',
      statementId: randomUUID(),
    });
    // 2026-11-08(일) + 월·화·수·목·금 = 2026-11-13(금). 공휴일 달력은 아직 쓰지 않는다(settlement §5.1 한계).
    expect(record.payoutDate).toBe('2026-11-13');
    // F-07-5(정본 §4.2, ADR-0368 결정 1): 이의 기한은 계산 함수가 아니라 같은 트랜잭션의 통지가 KST 공휴일 달력으로 정한다(J-T35 ⑦)
    expect(record.disputeDueAt).toBeNull();
  });
});

describe('A1V-03 이의 결과 없는 재확정과 새 이의 기간', () => {
  const store = new MemorySettlementStore();
  const payments = new MemorySettlementPaymentSource();
  let svc: Awaited<ReturnType<typeof createService>>;
  let settlements: Settlements;

  @Module({
    imports: [
      SettlementModule.register({
        store,
        payments,
        eventCommission: { rateBp: async () => 1000 },
        approvals: noApprovals,
        saleSuspensions: noSaleSuspensions,
        gateways: [new ManualPortonePayoutGateway(), new UnavailableTossPayoutGateway()],
        reauth: new MemoryReauthVerifier(),
      }),
    ],
  })
  class TestModule {}

  beforeAll(async () => {
    svc = await createService({ name: 'payment-svc', module: TestModule, env: { PEAKET_ENV: 'ci' }, clock: fakeClock({ now: NOW.getTime() }), logDestination: quiet(), adminAuthz: new DenyAllAdminAuthz() });
    settlements = svc.app.get(Settlements);
  });

  afterAll(async () => {
    await svc?.close();
  });

  // F-07-5 시험 담당(2026-11-23): 정본 §4.2(ADR-0368 결정 6)가 옛 이의 결과 경로(…/disputes/{disputeId}/resolution)를 없애고
  // 기각 경로(dispute-dismissal, 사유·처리자 필수)로 바꿨다. 재확정이 이의를 풀지 않는 것(409)과 기각 뒤 NOTIFIED·1영업일은 그대로 본다.
  test('DISPUTED는 재확정이 409이고 옛 결과 경로는 404이며, 기각 뒤 NOTIFIED·1영업일 이의 기간이다', async () => {
    const promoterId = randomUUID();
    const eventId = randomUUID();
    store.kycs.set(promoterId, kyc(promoterId));
    payments.set(eventId, 'TOSS', [fact({ amount: 100_000 })]);
    const calculated = await settlements.calculateEvent({ promoterId, eventId, pg: 'TOSS', pgStore: 'STANDARD' });
    await settlements.dispute(promoterId, randomUUID(), calculated.statementId, { reasonCode: 'GROSS_AMOUNT' });
    const dispute = (await store.listDisputes(calculated.statementId))[0]!;
    expect(dispute.result).toBeNull();

    const blocked = await svc.http.inject({ method: 'POST', url: `/internal/v1/settlements/statements/${calculated.statementId}/reconfirm` });
    expect(blocked.statusCode).toBe(409);
    expect((await store.findStatementById(calculated.statementId))?.status).toBe('DISPUTED');

    const legacy = await svc.http.inject({
      method: 'POST',
      url: `/internal/v1/settlements/statements/${calculated.statementId}/disputes/${dispute.disputeId}/resolution`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ result: 'DISMISSED', actor: 'ops-a1v' }),
    });
    expect(legacy.statusCode).toBe(404);

    const actorId = randomUUID();
    const resolved = await svc.http.inject({
      method: 'POST',
      url: `/internal/v1/settlements/statements/${calculated.statementId}/dispute-dismissal`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ reason: '원장과 같다', actorId }),
    });
    expect(resolved.statusCode).toBe(200);
    // 2026-11-14(토) 09:00 KST + 1영업일 = 2026-11-16(월) 09:00 KST
    expect(JSON.parse(resolved.payload)).toMatchObject({ status: 'NOTIFIED', disputeDueAt: '2026-11-16T00:00:00.000Z' });
    expect((await store.listDisputes(calculated.statementId))[0]).toMatchObject({ result: 'DISMISSED', resolvedAt: NOW, resolvedBy: actorId, resolutionNote: '원장과 같다' });
  });
});

describe('A1V-04 HELD 사유별 증빙', () => {
  test('BALANCE·ACCOUNT_MISMATCH·SALE_SUSPENDED는 증빙 없이 CONFIRMED가 되지 않는다', async () => {
    const store = new MemorySettlementStore();
    const settlements = settlementsFor(store);
    const cases = [
      { reason: 'BALANCE' as const, type: 'payout-balance-unconfirmed', evidence: { balanceConfirmed: true } },
      { reason: 'ACCOUNT_MISMATCH' as const, type: 'payout-account-mismatch', evidence: { accountReconciled: true } },
      { reason: 'SALE_SUSPENDED' as const, type: 'settlement-sale-not-resumed', evidence: { saleResumed: true } },
    ];

    for (const c of cases) {
      const promoterId = randomUUID();
      store.kycs.set(promoterId, kyc(promoterId));
      const held = await insertEventStatement(store, { promoterId, status: 'HELD', holdReason: c.reason });
      await expect(settlements.reconfirmStatement(held.record.statementId)).rejects.toMatchObject({ status: 409, type: expect.stringContaining(c.type) });
      expect((await store.findStatementById(held.record.statementId))?.status).toBe('HELD');

      const confirmed = await settlements.reconfirmStatement(held.record.statementId, { actor: 'ops-a1v', reason: `${c.reason}-cleared`, evidence: c.evidence });
      expect(confirmed.status).toBe('CONFIRMED');
      expect(store.statementAudits.at(-1)).toMatchObject({ statementId: held.record.statementId, fromStatus: 'HELD', toStatus: 'CONFIRMED', reason: `${c.reason}-cleared`, actor: 'ops-a1v' });
    }
  });
});

describe('A1V-10 회차 정산 스케줄러', () => {
  // F-07-5 시험 담당(lane5-f075-test, 2026-11-23): 정본 §4.2·ADR-0368 결정 12로 정산 일꾼은 30분 [가정]마다 자동 확정·CS 건 다시 보내기·오래된 조정 닫기를 하고
  // 회차 계산만 평일 06시(KST)에 한다. 옛 대역(필요한 메서드 둘만 가진 타입 탈출 객체)은 새 일을 부르지 못해 깨졌으므로,
  // 진짜 Settlements(메모리 저장소)에 계산·확정 두 메서드만 감시를 단다. 확정은 06시와 무관하게 tick마다 도는 것이 새 정본이다.
  class ManualTimer implements SettlementDueTimer {
    #fn: (() => void) | undefined;
    setInterval(fn: () => void): unknown {
      this.#fn = fn;
      return 1;
    }
    clearInterval(): void {
      this.#fn = undefined;
    }
    fire(): void {
      this.#fn?.();
    }
  }

  const flush = async () => {
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  };
  const until = async (predicate: () => boolean) => {
    for (let i = 0; i < 200; i += 1) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    throw new Error('기다린 조건이 참이 되지 않았다');
  };
  const spied = () => {
    const settlements = settlementsFor(new MemorySettlementStore());
    const calculate = vi.spyOn(settlements, 'calculateDueEvents').mockResolvedValue({ calculated: 0, items: [] });
    const confirm = vi.spyOn(settlements, 'confirmDueStatements').mockResolvedValue({ confirmed: 0, items: [] });
    return { settlements, calculate, confirm };
  };

  test('start()는 스스로 tick하지 않고 리더 전환 콜백의 tick(true)가 첫 tick을 맡는다', async () => {
    const timer = new ManualTimer();
    const { settlements, calculate, confirm } = spied();
    const worker = new SettlementDueWorker({ settlements, leader: { isLeader: () => true }, clock: fakeClock({ now: NOW.getTime() }), timer });

    worker.start();
    await flush();
    expect(calculate).not.toHaveBeenCalled();

    await worker.tick(true);
    expect(calculate).toHaveBeenCalledWith('2026-11-13', 100);
    expect(confirm).toHaveBeenCalledTimes(1);
    await worker.stop();
  });

  test('calculateDueEvents가 실패해도 confirmDueStatements는 돈다', async () => {
    const { settlements, calculate, confirm } = spied();
    calculate.mockRejectedValue(new Error('core-svc 503'));
    confirm.mockResolvedValue({ confirmed: 1, items: [] });
    const failed = vi.fn<NonNullable<SettlementDueLog['failed']>>();
    const ticked = vi.fn<NonNullable<SettlementDueLog['ticked']>>();
    const worker = new SettlementDueWorker({ settlements, leader: { isLeader: () => true }, clock: fakeClock({ now: NOW.getTime() }), log: { failed, ticked } });

    await worker.tick();

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(failed).toHaveBeenCalledTimes(1);
    expect(ticked).toHaveBeenCalledWith({ through: '2026-11-13', calculated: 1 });
  });

  test('정기 실행은 KST 평일 06:00에만 하고, force tick과 실패는 그날 정기 실행을 소비하지 않는다', async () => {
    // ① force tick은 즉시 돌지만 같은 날 정기 06:00 tick을 소비하지 않고, 주말 06:00에는 회차 계산을 하지 않는다(자동 확정은 tick마다).
    const timer = new ManualTimer();
    const clock = fakeClock({ now: Date.parse('2026-11-15T20:30:00.000Z') }); // 2026-11-16(월) 05:30 KST
    const { settlements, calculate, confirm } = spied();
    const ticked = vi.fn<NonNullable<SettlementDueLog['ticked']>>();
    const worker = new SettlementDueWorker({ settlements, leader: { isLeader: () => true }, clock, timer, log: { ticked } });

    worker.start();
    await worker.tick(true);
    expect(calculate).toHaveBeenCalledTimes(1);
    expect(calculate).toHaveBeenLastCalledWith('2026-11-15', 100);

    clock.advance(30 * 60 * 1_000); // 월요일 06:00 KST
    timer.fire();
    await until(() => ticked.mock.calls.length === 2);
    expect(calculate).toHaveBeenCalledTimes(2);
    expect(confirm).toHaveBeenCalledTimes(2);

    timer.fire();
    await until(() => ticked.mock.calls.length === 3);
    expect(calculate).toHaveBeenCalledTimes(2);
    expect(confirm).toHaveBeenCalledTimes(3);

    clock.advance(5 * 24 * 60 * 60 * 1_000); // 토요일 06:00 KST
    timer.fire();
    await until(() => ticked.mock.calls.length === 4);
    expect(calculate).toHaveBeenCalledTimes(2);
    expect(confirm).toHaveBeenCalledTimes(4);

    clock.advance(2 * 24 * 60 * 60 * 1_000); // 다음 월요일 06:00 KST
    timer.fire();
    await until(() => ticked.mock.calls.length === 5);
    expect(calculate).toHaveBeenCalledTimes(3);
    expect(calculate).toHaveBeenLastCalledWith('2026-11-22', 100);
    await worker.stop();

    // ② 두 작업 중 하나가 실패한 정기 tick은 그날 회차 계산을 소비하지 않아 06:30에 다시 돈다.
    for (const failing of ['calculate', 'confirm'] as const) {
      const retryTimer = new ManualTimer();
      const retryClock = fakeClock({ now: Date.parse('2026-11-15T21:00:00.000Z') }); // 2026-11-16(월) 06:00 KST
      const retry = spied();
      if (failing === 'calculate') retry.calculate.mockRejectedValueOnce(new Error('core-svc 503'));
      else retry.confirm.mockRejectedValueOnce(new Error('db down'));
      const retryTicked = vi.fn<NonNullable<SettlementDueLog['ticked']>>();
      const retryWorker = new SettlementDueWorker({ settlements: retry.settlements, leader: { isLeader: () => true }, clock: retryClock, timer: retryTimer, log: { ticked: retryTicked } });

      retryWorker.start();
      retryTimer.fire();
      await until(() => retryTicked.mock.calls.length === 1);
      expect(retry.calculate).toHaveBeenCalledTimes(1);
      expect(retry.confirm).toHaveBeenCalledTimes(1);

      retryClock.advance(30 * 60 * 1_000); // 같은 날 06:30 KST
      retryTimer.fire();
      await until(() => retryTicked.mock.calls.length === 2);
      expect(retry.calculate).toHaveBeenCalledTimes(failing === 'calculate' ? 2 : 1);
      expect(retry.confirm).toHaveBeenCalledTimes(2);

      retryClock.advance(30 * 60 * 1_000); // 07:00 KST부터는 그날 정기 회차 계산이 끝났다(자동 확정은 30분마다 계속)
      retryTimer.fire();
      await until(() => retryTicked.mock.calls.length === 3);
      expect(retry.calculate).toHaveBeenCalledTimes(failing === 'calculate' ? 2 : 1);
      expect(retry.confirm).toHaveBeenCalledTimes(3);
      await retryWorker.stop();
    }
  });
});

describe('A1V-12 정산서 상태 전이 감사', () => {
  // F-07-5 시험 담당(2026-11-23): 이의는 기각(dismissDispute)이나 이의 인정 조정으로만 푼다(정본 §4.2, ADR-0368 결정 6).
  // 옛 resolveDispute(…, 'ADJUSTED')는 조정 없이 ADJUSTED를 적는 길이라 정본에서 없앴으므로 기각으로 바꾼다.
  test('재확정·이의 기각·자동 확정은 이전/이후 상태·사유·행위자를 남긴다', async () => {
    const store = new MemorySettlementStore();
    const settlements = settlementsFor(store);
    const promoterId = randomUUID();
    store.kycs.set(promoterId, kyc(promoterId));

    const held = await insertEventStatement(store, { promoterId, status: 'HELD', holdReason: 'KYC' });
    await settlements.reconfirmStatement(held.record.statementId, { actor: 'ops-a1v', reason: 'kyc-cleared' });

    const disputed = await insertEventStatement(store, { promoterId, status: 'NOTIFIED', disputeDueAt: new Date(NOW.getTime() + 60_000) });
    await settlements.dispute(promoterId, randomUUID(), disputed.record.statementId, { reasonCode: 'COMMISSION' });
    const csLead = randomUUID();
    await settlements.dismissDispute(disputed.record.statementId, { reason: '수수료율은 계약과 같다', actorId: csLead });

    const auto = await insertEventStatement(store, { promoterId, status: 'NOTIFIED', disputeDueAt: new Date(NOW.getTime() - 1) });
    expect((await settlements.confirmDueStatements()).confirmed).toBe(1);

    expect(store.statementAudits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ statementId: held.record.statementId, fromStatus: 'HELD', toStatus: 'CONFIRMED', reason: 'kyc-cleared', actor: 'ops-a1v' }),
        expect.objectContaining({ statementId: disputed.record.statementId, fromStatus: 'DISPUTED', toStatus: 'NOTIFIED', reason: expect.stringMatching(/\S/), actor: csLead }),
        expect.objectContaining({ statementId: auto.record.statementId, fromStatus: 'NOTIFIED', toStatus: 'CONFIRMED', reason: 'dispute-window-ended', actor: 'system' }),
      ]),
    );
  });
});
