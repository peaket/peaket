// F-07-6(LCH-110, ADR-0369) 토스 지급대행 시험의 공용 조립. 진짜 Settlements·MemorySettlementStore·HttpTossPayoutTransport·
// TossPayoutGateway·HttpPgBalanceSource·PromSettlementSignals·settlementApprovalLog에, 경계만 짝 가짜로 끼운다
// (결제사 = 시험 안 대역 서버, ops CS 처리함 = RecordingCaseNotice, ops 승인 기록 = 아래 FakePayoutApprovals, 시계 = fakeClock).
// 업무 로직(묶음·전송·결과 반영·재요청·대사)은 가짜로 바꾸지 않는다(mock-policy).
import { fakeClock, PlatformMetrics } from '@peaket/platform';
import { randomBytes, randomUUID } from 'node:crypto';
import { HttpTossPayoutTransport } from '../../src/modules/settlement/adapters/http-toss-payout-transport.js';
import { PromSettlementSignals } from '../../src/modules/settlement/adapters/prom-settlement-signals.js';
import {
  HttpPgBalanceSource,
  ManualPortonePayoutGateway,
  MemoryReauthVerifier,
  MemorySettlementPaymentSource,
  MemorySettlementStore,
  Settlements,
  settlementApprovalLog,
  TossPayoutGateway,
  type PayoutApprovalVerifier,
  type SaleSuspensionSource,
  type VerifiedPayoutApproval,
} from '../../src/modules/settlement/index.js';
import type { PgLedgerSource } from '../../src/modules/settlement/domain/ports.js';
import type { TossPayoutConfig } from '../../src/modules/settlement/domain/payout-adapters.js';
import type { PgStore, StatementRecord, TossSellerStatus } from '../../src/modules/settlement/domain/settlement.js';
import { collectingLogger, RecordingCaseNotice } from '../settlement-flow-support.js';
import { noSaleSuspensions, seedTossSeller } from '../settlement-support.js';
import { startTossPayoutFake, type TossPayoutFake } from './toss-payout-fake.js';

export const KST = 9 * 60 * 60 * 1_000;
/** KST 벽시계 글('2026-12-04T10:00:00.000')을 UTC 밀리초로 */
export const kst = (local: string): number => Date.parse(`${local}+09:00`);

/** ops-svc 지급 승인 기록의 짝 가짜(포트 PayoutApprovalVerifier). 진짜 응답 모양은 BAT-625 시험(settlement-approval-verification)이 본다 */
export class FakePayoutApprovals implements PayoutApprovalVerifier {
  readonly rows = new Map<string, VerifiedPayoutApproval>();
  async verify(approvalId: string): Promise<VerifiedPayoutApproval | undefined> {
    return this.rows.get(approvalId);
  }
}

export interface StoreKeys {
  secretKey: string;
  /** 지금 보안 키(64자 hex) */
  current: string;
  /** 교체 중의 옛 보안 키(64자 hex) */
  old: string;
}

export const newKeys = (store: PgStore): StoreKeys => ({ secretKey: `test_sk_${store.toLowerCase()}_${randomBytes(6).toString('hex')}`, current: randomBytes(32).toString('hex'), old: randomBytes(32).toString('hex') });

export const configOf = (keys: Record<PgStore, StoreKeys>, stores: readonly PgStore[] = ['STANDARD', 'ESCROW']): TossPayoutConfig => {
  const out: { [K in PgStore]?: { secretKey: string; securityKeys: readonly Buffer[] } } = {};
  for (const s of stores) out[s] = { secretKey: keys[s].secretKey, securityKeys: [Buffer.from(keys[s].current, 'hex'), Buffer.from(keys[s].old, 'hex')] };
  return { stores: out };
};

export interface TossHarnessOptions {
  /** 처음 시각(UTC 밀리초) */
  now: number;
  saleSuspensions?: SaleSuspensionSource;
  terms?: { feeMonthlyKrw: number; feeFreeCount: number; feePerItemKrw: number };
  ledger?: PgLedgerSource;
  /** 결제사 잔액 원천을 끼우지 않는다(묶음 때 잔액 확인 생략) */
  noBalance?: boolean;
  /** 같은 저장소를 보는 둘째 파드를 만들 때 */
  store?: MemorySettlementStore;
}

export async function tossHarness(o: TossHarnessOptions) {
  const keys: Record<PgStore, StoreKeys> = { STANDARD: newKeys('STANDARD'), ESCROW: newKeys('ESCROW') };
  const fake: TossPayoutFake = await startTossPayoutFake({
    STANDARD: { secretKey: keys.STANDARD.secretKey, securityKey: Buffer.from(keys.STANDARD.current, 'hex') },
    ESCROW: { secretKey: keys.ESCROW.secretKey, securityKey: Buffer.from(keys.ESCROW.current, 'hex') },
  });
  const config = configOf(keys);
  const clock = fakeClock({ now: o.now });
  const store = o.store ?? new MemorySettlementStore();
  const payments = new MemorySettlementPaymentSource();
  const caseNotice = new RecordingCaseNotice();
  const approvals = new FakePayoutApprovals();
  const metrics = new PlatformMetrics('payment-svc');
  const signals = new PromSettlementSignals().register(metrics.registry);
  const { lines, logger } = collectingLogger(() => clock.now());
  const log = settlementApprovalLog(logger);
  const transport = new HttpTossPayoutTransport(config, { baseUrl: fake.url, clock, log });
  const make = () =>
    new Settlements({
      store,
      payments,
      approvals,
      saleSuspensions: o.saleSuspensions ?? noSaleSuspensions,
      ...(o.noBalance ? {} : { pgBalance: new HttpPgBalanceSource(transport) }),
      gateways: [new ManualPortonePayoutGateway(), new TossPayoutGateway(transport)],
      reauth: new MemoryReauthVerifier(),
      clock,
      log,
      caseNotice,
      tossTransport: transport,
      signals,
      ...(o.terms ? { tossTerms: o.terms } : {}),
      ...(o.ledger ? { pgLedger: o.ledger } : {}),
    });
  const settlements = make();

  /** 판매자 확인 VERIFIED·정산 계좌(보류 끝·예금주 확인)·토스 셀러(상점별 상태) */
  const partner = async (promoterId: string, sellers: Partial<Record<PgStore, TossSellerStatus | null>> = { STANDARD: 'APPROVED', ESCROW: 'APPROVED' }) => {
    await settlements.recordKyc(promoterId, 'VERIFIED', { legalName: '주식회사 피켓엔터', representative: '김대표' });
    await store.savePayoutAccount({ promoterId, bankCode: '004', accountLast4: '1234', version: 1, changedAt: new Date(o.now - 30 * 86_400_000), holdUntil: new Date(o.now - 20 * 86_400_000), holderVerified: true });
    const ids: Partial<Record<PgStore, string>> = {};
    for (const s of ['STANDARD', 'ESCROW'] as const) {
      const status = sellers[s];
      if (status) ids[s] = (await seedTossSeller(store, promoterId, { pgStore: s, status, tossSellerId: `FSEL-${s}-${promoterId.slice(0, 8)}` })).tossSellerId;
    }
    return ids;
  };

  /** 확정(CONFIRMED) 정산서 한 장. 지급액 = 판매 대금(수수료 0) */
  const confirmed = async (x: { promoterId: string; amount: number; payoutDate: string; pgStore?: PgStore; pg?: 'TOSS' | 'PORTONE'; statementId?: string; eventId?: string }): Promise<StatementRecord> => {
    const at = new Date(clock.now());
    const record: StatementRecord = {
      statementId: x.statementId ?? randomUUID(),
      promoterId: x.promoterId,
      kind: 'EVENT',
      eventId: x.eventId ?? randomUUID(),
      pg: x.pg ?? 'TOSS',
      pgStore: x.pgStore ?? 'STANDARD',
      periodStart: null,
      periodEnd: null,
      grossAmount: x.amount,
      refundAmount: 0,
      commissionAmount: 0,
      commissionVat: 0,
      offsetAmount: 0,
      payoutAmount: x.amount,
      revision: 1,
      supersedesId: null,
      excludedPayments: [],
      status: 'CONFIRMED',
      holdReason: null,
      disputeDueAt: null,
      payoutDate: x.payoutDate,
      payoutBankCode: '004',
      payoutAccountLast4: '1234',
      payoutBatchId: null,
      adjustmentAmount: 0,
      createdAt: at,
      updatedAt: at,
    };
    await store.insertStatement(record, []);
    return record;
  };

  /** operator 확인 요청 → commander 2인 승인(ops 승인 기록 대조)까지. 묶음 ID */
  const approvedBatch = async (x: { pgStore?: PgStore; payoutDate: string }): Promise<string> => {
    const batch = await settlements.createPayoutBatch({ pg: 'TOSS', pgStore: x.pgStore ?? 'STANDARD', payoutDate: x.payoutDate, actor: randomUUID() });
    const approvalId = randomUUID();
    approvals.rows.set(approvalId, {
      approvalId,
      kind: 'PAYOUT_BATCH',
      targetRef: batch.batchId,
      batchId: batch.batchId,
      pg: 'TOSS',
      pgStore: batch.pgStore,
      payoutDate: batch.payoutDate,
      currency: 'KRW',
      amount: batch.totalAmount,
      statementCount: batch.statementCount,
      status: 'EXECUTING',
      requiredApprovals: 2,
      requestedBy: randomUUID(),
      approvals: [randomUUID()],
      approvedAt: new Date(clock.now()).toISOString(),
    });
    await settlements.approveBatch(batch.batchId, approvalId);
    return batch.batchId;
  };

  /** 지표 줄(이름{…} 값)만 */
  const metric = async (name: string): Promise<{ labels: Record<string, string>; value: number }[]> =>
    (await metrics.registry.metrics())
      .split('\n')
      .filter((l) => l.startsWith(`${name}{`) || l.startsWith(`${name} `))
      .map((l) => {
        const m = /^[^{ ]+(?:\{([^}]*)\})? (\S+)$/.exec(l)!;
        const labels = Object.fromEntries([...(m[1] ?? '').matchAll(/(\w+)="([^"]*)"/g)].map((x) => [x[1]!, x[2]!]));
        return { labels, value: Number(m[2]) };
      });
  /** 이름표가 같은 표본 하나의 값(없으면 undefined). 이름표 차례에 기대지 않는다 */
  const metricValue = async (name: string, labels: Record<string, string> = {}): Promise<number | undefined> =>
    (await metric(name)).find((s) => Object.keys(labels).length === Object.keys(s.labels).length && Object.entries(labels).every(([k, v]) => s.labels[k] === v))?.value;
  const events = (type?: string) => store.outbox.map((e) => e.value).filter((v) => type === undefined || v.type === type);
  const cases = (kind?: string) => [...store.caseRequests.values()].filter((c) => kind === undefined || c.kind === kind);
  const payoutsOf = (statementId: string) => [...store.payouts.values()].filter((p) => p.statementId === statementId).sort((a, b) => a.seq - b.seq);
  const payoutPosts = () => fake.calls('POST', /^\/v2\/payouts$/);
  const at = (t: number): void => clock.advance(t - clock.now());

  return { keys, config, fake, clock, at, store, payments, caseNotice, approvals, metrics, signals, lines, logger, log, transport, settlements, make, partner, confirmed, approvedBatch, metric, metricValue, events, cases, payoutsOf, payoutPosts, close: () => fake.close() };
}

export type TossHarness = Awaited<ReturnType<typeof tossHarness>>;
