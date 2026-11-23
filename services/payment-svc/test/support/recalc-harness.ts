// F-07-8(GAT-120·GAT-130) 정산 다시 계산·계산 뒤 환급 미수금·대사 미완 결제 풀림 시험의 공용 조립.
// 진짜 Settlements·MemorySettlementStore·MemorySettlementPaymentSource에 경계(시계·토스 전송·포트원 플랫폼 전송·회차 수수료율 원천)만 짝 대역으로 끼운다
// (mock-policy: 업무 로직은 진짜). 모양은 F-07-8 계획 §5.1과 F-07-6·F-07-7 계획 §5.1(Settlements 의존 `toss`·`tossConfig`·`portone`·`portoneConfig`)을 따른다.
// 기준 트리(F-07-6·F-07-7·F-07-8 구현 전)에서는 그 의존·레코드 칸이 없어 타입 검사가 실패하고, 새 메서드가 없어 시험이 실패한다(계획 §7).
import { fakeClock, type FakeClock } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import {
  ManualPortonePayoutGateway,
  MemoryReauthVerifier,
  MemorySettlementPaymentSource,
  MemorySettlementStore,
  Settlements,
  UnavailableTossPayoutGateway,
  type PaymentFact,
} from '../../src/modules/settlement/index.js';
import type { PortonePayoutConfig, TossPayoutConfig } from '../../src/modules/settlement/domain/payout-adapters.js';
import type { KycRecord, PayoutBatchRecord, PayoutRecord, Pg, PgStore, ReceivableRecord, StatementRecord } from '../../src/modules/settlement/domain/settlement.js';
import { noApprovals, noSaleSuspensions } from '../settlement-support.js';
import { RecalcPortonePlatform } from './recalc-portone-double.js';
import { RecalcTossPayout } from './recalc-toss-double.js';

export const DAY = 86_400_000;
export const APPROVED_AT = new Date('2026-11-01T00:00:00.000Z');

/**
 * 결제 원장 사실(F-07-8 계획 §5.1(다) 끝: 메모리 결제 원천의 결제마다 `peaketBorneRefund`(기본 0)와 `refundedAt`).
 * 칸이 생기기 전·후 모두 타입이 맞게 교차 타입으로 둔다(구현이 PaymentFact에 칸을 더하면 같은 이름이다)
 */
export type FactPlus = PaymentFact & { approvedAt?: Date | null; peaketBorneRefund?: number; refundedAt?: Date | null };
export const fact = (o: Partial<FactPlus> = {}): FactPlus => ({ paymentId: randomUUID(), amount: 30_000_000, cancelledAmount: 0, status: 'APPROVED', failureCategory: null, approvedAt: APPROVED_AT, ...o });

/** 토스 지급대행 두 상점 설정(F-07-6 계획 §5.1(가) 모양. 시험 값) */
export const TOSS_CONFIG: TossPayoutConfig = {
  stores: {
    STANDARD: { secretKey: 'test_sk_f078_standard', securityKeys: [Buffer.from('33'.repeat(32), 'hex')] },
    ESCROW: { secretKey: 'test_sk_f078_escrow', securityKeys: [Buffer.from('44'.repeat(32), 'hex')] },
  },
};
/** 포트원 지급대행 설정(F-07-7 계획 §5.1(가) 모양. 대역 주소라 실제로 부르지 않는다) */
export const PORTONE_CONFIG: PortonePayoutConfig = { baseUrl: 'http://127.0.0.1:9', secret: 'sim_sk_f078', contractId: 'contract-f078' };

export interface RecalcHarnessOptions {
  now: number;
  /** 회차 수수료율 원천의 답(시험 중 바꿀 수 있다). 코드 기본값 1000과 다르게 850을 기본으로 둔다 */
  rateBp?: number;
  /** 토스 지급대행 켜짐(전송 짝 대역) */
  toss?: boolean;
  /** 포트원 지급대행 켜짐(플랫폼 짝 대역). 끄면 지금의 수기 포트원 길(ManualPortonePayoutGateway)이다 */
  portone?: boolean;
  store?: MemorySettlementStore;
  holidays?: ReadonlySet<string>;
}

export function recalcHarness(o: RecalcHarnessOptions) {
  const clock: FakeClock = fakeClock({ now: o.now });
  const store = o.store ?? new MemorySettlementStore();
  const payments = new MemorySettlementPaymentSource();
  const rate = { value: o.rateBp ?? 850 };
  const toss = o.toss ? new RecalcTossPayout() : undefined;
  const portone = o.portone ? new RecalcPortonePlatform() : undefined;
  const settlements = new Settlements({
    store,
    payments,
    eventCommission: { rateBp: async () => rate.value },
    approvals: noApprovals,
    saleSuspensions: noSaleSuspensions,
    gateways: [new ManualPortonePayoutGateway(), new UnavailableTossPayoutGateway()],
    reauth: new MemoryReauthVerifier(),
    clock,
    ...(o.holidays ? { holidays: o.holidays } : {}),
    ...(toss ? { toss, tossConfig: TOSS_CONFIG } : {}),
    ...(portone ? { portone, portoneConfig: PORTONE_CONFIG } : {}),
  });
  const at = (t: number): void => clock.advance(t - clock.now());
  return { clock, at, store, payments, settlements, toss, portone, rate };
}

export type RecalcHarness = ReturnType<typeof recalcHarness>;

export const verifiedKyc = (promoterId: string, at: Date): KycRecord => ({
  promoterId,
  status: 'VERIFIED',
  businessVerified: true,
  representativeVerified: true,
  legalName: '주식회사 피켓엔터',
  representative: '김대표',
  verifiedAt: at,
  source: 'MANUAL',
  updatedAt: at,
});

/** 토스 상점 셀러 한 행(F-07-6 계획 §5.1(바) `tossSellers` 키 `${promoterId}:${pgStore}`, ADR-0369 결정 4: 셀러가 묶을 수 있는 상태여야 토스 정산서가 묶인다) */
export function approvedTossSeller(store: MemorySettlementStore, promoterId: string, pgStore: PgStore, at: Date): void {
  store.tossSellers.set(`${promoterId}:${pgStore}`, {
    promoterId,
    pgStore,
    tossSellerId: `seller-${pgStore.toLowerCase()}-${promoterId.slice(0, 8)}`,
    refSellerId: `peaket-${promoterId}`,
    status: 'APPROVED',
    businessType: 'CORPORATE',
    registeredAt: at,
    statusCheckedAt: at,
    updatedAt: at,
  });
}

/** 정산서 한 판을 저장소에 바로 심는다(상태별 시작점을 만들 때). 금액 칸은 지급액 식과 맞춰 준다 */
export function seedStatement(store: MemorySettlementStore, o: Partial<StatementRecord> & { promoterId: string; eventId: string; pg: Pg; at: Date }): StatementRecord {
  const { at, ...rest } = o;
  const s: StatementRecord = {
    statementId: randomUUID(),
    kind: 'EVENT',
    pgStore: 'STANDARD',
    periodStart: null,
    periodEnd: null,
    grossAmount: 10_000_000,
    refundAmount: 0,
    commissionAmount: 850_000,
    commissionVat: 85_000,
    offsetAmount: 0,
    payoutAmount: 9_065_000,
    revision: 1,
    supersedesId: null,
    excludedPayments: [],
    status: 'CONFIRMED',
    holdReason: null,
    disputeDueAt: null,
    payoutDate: '2026-12-04',
    payoutBankCode: '88',
    payoutAccountLast4: '4321',
    payoutBatchId: null,
    adjustmentAmount: 0,
    commissionRateBp: 850,
    createdAt: at,
    updatedAt: at,
    ...rest,
  };
  store.statements.set(s.statementId, s);
  return s;
}

/** F-07-6 계획 §5.1(바)가 묶음에 더한 칸까지 채운 지급 묶음 */
export function seedBatch(store: MemorySettlementStore, o: Partial<PayoutBatchRecord> & { pg: Pg; payoutDate: string; totalAmount: number; statementCount: number; at: Date }): PayoutBatchRecord {
  const { at, ...rest } = o;
  const b: PayoutBatchRecord = {
    batchId: randomUUID(),
    pgStore: 'STANDARD',
    approvalId: randomUUID(),
    portoneBulkPayoutId: null,
    pgBalanceKrw: null,
    pgBalanceSource: null,
    pgBalanceObservedAt: null,
    pgBalanceObservedBy: null,
    pgBalanceLedgerKrw: null,
    status: 'SUBMITTED',
    submitAttempts: 0,
    nextSubmitAt: null,
    submitDeadlineAt: null,
    lastSubmitError: null,
    dateRetryUsed: false,
    createdAt: at,
    updatedAt: at,
    ...rest,
  };
  store.batches.set(b.batchId, b);
  return b;
}

/** F-07-6 계획 §5.1(바)가 지급 건에 더한 칸까지 채운 지급 건(조각) */
export function seedPayout(store: MemorySettlementStore, o: Partial<PayoutRecord> & { batchId: string; statementId: string; amount: number; payoutDate: string; at: Date }): PayoutRecord {
  const { at, ...rest } = o;
  const seq = rest.seq ?? 1;
  const p: PayoutRecord = {
    payoutId: randomUUID(),
    seq,
    refPayoutId: `${rest.statementId}-${seq}`,
    pgPayoutId: `tp-${rest.statementId.slice(0, 8)}-${seq}`,
    status: 'REQUESTED',
    errorCode: null,
    pgTransferId: null,
    transferCheck: null,
    transferCheckedAt: null,
    failureClass: null,
    retryOfPayoutId: null,
    autoRetryCount: 0,
    createdAt: at,
    updatedAt: at,
    ...rest,
  };
  store.payouts.set(p.payoutId, p);
  return p;
}

export function seedReceivable(store: MemorySettlementStore, o: Partial<ReceivableRecord> & { promoterId: string; amount: number; at: Date }): ReceivableRecord {
  const { at, ...rest } = o;
  const r: ReceivableRecord = { receivableId: randomUUID(), pg: 'TOSS', cause: 'COMPENSATION_ADVANCE', remaining: rest.amount, status: 'OPEN', createdAt: at, updatedAt: at, ...rest };
  store.receivables.set(r.receivableId, r);
  return r;
}

/** 정산서 하나가 미수금을 상계한 이동 한 줄(OFFSET). 미수금 남은 금액도 같이 줄인다(이동 합 불변식) */
export function seedOffset(store: MemorySettlementStore, o: { receivableId: string; statementId: string; amount: number; at: Date }): string {
  const moveId = randomUUID();
  store.receivableMoves.push({ moveId, receivableId: o.receivableId, statementId: o.statementId, amount: o.amount, kind: 'OFFSET', movedAt: o.at });
  const r = store.receivables.get(o.receivableId)!;
  const remaining = r.remaining - o.amount;
  store.receivables.set(r.receivableId, { ...r, remaining, status: remaining === 0 ? 'CLOSED' : 'OPEN', updatedAt: o.at });
  return moveId;
}

/**
 * 미수금 이동 기록 불변식(settlement §7 '미수금 이동 기록', J-T24): 남은 금액 = 금액 − 이동 합. 되돌림(REVERSAL)은 그 금액만큼 되살린다
 * (data.md receivable_movement: 금액은 양수이고 REVERSAL은 되돌린 금액)
 */
export function remainingByMoves(store: MemorySettlementStore, receivableId: string): number {
  const r = store.receivables.get(receivableId)!;
  const moves = store.receivableMoves.filter((m) => m.receivableId === receivableId);
  const out = moves.filter((m) => m.kind !== 'REVERSAL').reduce((n, m) => n + m.amount, 0);
  const back = moves.filter((m) => m.kind === 'REVERSAL').reduce((n, m) => n + m.amount, 0);
  return r.amount - out + back;
}

export const liveStatementsOf = (store: MemorySettlementStore, eventId: string) => [...store.statements.values()].filter((s) => s.eventId === eventId && s.status !== 'SUPERSEDED');
export const eventsOf = (store: MemorySettlementStore, statementId: string, type: string) => store.outbox.filter((e) => e.value.statementId === statementId && e.value.type === type);
export const auditsOf = (store: MemorySettlementStore, statementId: string) => store.statementAudits.filter((a) => a.statementId === statementId);
export type { PgStore };
