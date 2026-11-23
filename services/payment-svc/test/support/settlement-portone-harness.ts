// F-07-7 정산 시험의 공용 조립(포트원 플랫폼·토스 지급대행·ops 받기 대역을 끼운 Settlements, 시험 자료 만들기).
// 계획 §5.1과 F-07-6 계획 §5.1·§7 보충(고정된 F-07-6 시험 4659b6623의 test/support/toss-harness.ts와 같은 칸)의 이름만 쓴다. 두 계획이 정하지 않은 자리(포트원 플랫폼·ops 받기를 Settlements에 넣는 칸 이름,
// assembleOpsSettlementSinks의 둘째 인자)는 이 파일 한 곳에만 두었다(계획 '실패 확인' 절의 '인터페이스 빈칸').
// 이름이 바뀌면 이 파일만 고친다.
import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { type AdminAuthz, type AdminAuthzPort, createPlatformLogger, createService, fakeClock, type FakeClock, PlatformMetrics, type Registry } from '@peaket/platform';
import type { Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { HttpSettlementCaseNotice, ManualPortonePayoutGateway, MemoryReauthVerifier, MemorySettlementPaymentSource, MemorySettlementStore, settlementApprovalLog, SettlementModule, Settlements, UnavailableTossPayoutGateway } from '../../src/modules/settlement/index.js';
import type { PayoutApprovalVerifier, PayoutGateway, PgLedgerSource, ReauthVerifier, SaleSuspensionSource, SettlementPaymentSource, SettlementStore, VerifiedPayoutApproval } from '../../src/modules/settlement/domain/ports.js';
import { portonePayoutConfigured, type PortonePayoutConfig } from '../../src/modules/settlement/domain/payout-adapters.js';
import { PromSettlementSignals } from '../../src/modules/settlement/adapters/prom-settlement-signals.js';
import { assembleOpsSettlementSinks, assemblePortonePlatform } from '../../src/start.js';
import type { KycRecord, PayoutBatchRecord, PayoutRecord, PgStore, StatementRecord, TossSellerStatus } from '../../src/modules/settlement/domain/settlement.js';
import { RecordingTossPayout } from './settlement-payout-toss-double.js';
import type { PortonePlatformFake } from './portone-platform-fake.js';
import type { OpsIntakeFake } from './ops-intake-fake.js';

export { INTERNAL_TOKEN, leaks, logSink, PORTONE_CONTRACT_ID, PORTONE_SECRET, portoneEnv } from './settlement-portone-env.js';
import { INTERNAL_TOKEN, logSink, PORTONE_CONTRACT_ID, portoneEnv } from './settlement-portone-env.js';

export const noApprovals: PayoutApprovalVerifier = { verify: async () => undefined };
export const noSaleSuspensions: SaleSuspensionSource = { listSuspended: async () => new Set() };

/** 승인 기록을 시험이 정하는 대역(지급 묶음 2인 승인, approveBatch의 대조 값) */
export class ApprovalRows implements PayoutApprovalVerifier {
  readonly rows = new Map<string, VerifiedPayoutApproval>();
  async verify(id: string): Promise<VerifiedPayoutApproval | undefined> {
    return this.rows.get(id);
  }
  approve(batch: { batchId: string; pg: 'TOSS' | 'PORTONE'; pgStore: PgStore; payoutDate: string; totalAmount: number; statementCount: number }, at: Date): string {
    const approvalId = randomUUID();
    this.rows.set(approvalId, {
      approvalId,
      kind: 'PAYOUT_BATCH',
      targetRef: batch.batchId,
      batchId: batch.batchId,
      pg: batch.pg,
      pgStore: batch.pgStore,
      payoutDate: batch.payoutDate,
      currency: 'KRW',
      amount: batch.totalAmount,
      statementCount: batch.statementCount,
      status: 'EXECUTING',
      requiredApprovals: 2,
      requestedBy: randomUUID(),
      approvals: [randomUUID()],
      approvedAt: at.toISOString(),
    });
    return approvalId;
  }
}

/** 판매 중지 회차를 시험이 정하는 대역 */
export class SuspendedEvents implements SaleSuspensionSource {
  readonly ids = new Set<string>();
  async listSuspended(eventIds: readonly string[]): Promise<ReadonlySet<string>> {
    return new Set(eventIds.filter((id) => this.ids.has(id)));
  }
}

export interface HarnessOptions {
  now: number;
  /** 포트원 플랫폼 대역. 없으면 포트원 지급대행 꺼짐 */
  portone?: PortonePlatformFake;
  /** 토스 지급대행 켜짐 */
  toss?: boolean | RecordingTossPayout;
  ops?: OpsIntakeFake;
  store?: MemorySettlementStore;
  clock?: FakeClock;
  reauth?: ReauthVerifier;
  approvals?: PayoutApprovalVerifier;
  saleSuspensions?: SaleSuspensionSource;
  /** 시험이 주는 지급 게이트웨이(기본: assemblePortonePlatform의 포트원 갈래 + 토스 꺼짐) */
  gateways?: readonly PayoutGateway[];
  /** 결제사 잔액 대사의 장부 원천(F-07-6 PgLedgerSource) */
  pgLedger?: PgLedgerSource;
}

export interface BuiltSettlements<S extends SettlementStore> {
  store: S;
  clock: FakeClock;
  settlements: Settlements;
  toss: RecordingTossPayout | undefined;
  portoneConfig: PortonePayoutConfig | undefined;
  registry: Registry;
  log: ReturnType<typeof logSink>;
  /** Settlements에 넣은 의존(HTTP 조립 시험이 SettlementModule.register에 같은 값을 넣는다) */
  deps: ConstructorParameters<typeof Settlements>[0];
}

export interface Harness extends BuiltSettlements<MemorySettlementStore> {
  payments: MemorySettlementPaymentSource;
}

/** 저장소·결제 원장을 받아 F-07-7 의존을 끼운 Settlements를 만든다(메모리·Drizzle 공용) */
export function buildSettlements<S extends SettlementStore>(store: S, payments: SettlementPaymentSource, o: Omit<HarnessOptions, 'store'>): BuiltSettlements<S> {
  const clock = o.clock ?? fakeClock({ now: o.now });
  const log = logSink();
  const logger = createPlatformLogger({ service: 'payment-svc', env: 'ci', version: 't', clock, level: 'debug', destination: log.stream });
  const env = o.portone ? portoneEnv(o.portone.url) : { PEAKET_ENV: 'ci' };
  const portoneConfig = portonePayoutConfigured(env);
  const platform = assemblePortonePlatform(env, { ...(o.portone ? { baseUrl: o.portone.url } : {}), clock, log: logger });
  const sinks = assembleOpsSettlementSinks(o.ops ? { PEAKET_ENV: 'ci', PEAKET_OPS_HTTP_URL: o.ops.url, PEAKET_INTERNAL_TOKEN: INTERNAL_TOKEN } : { PEAKET_ENV: 'ci' }, { clock, log: logger });
  const toss = o.toss instanceof RecordingTossPayout ? o.toss : o.toss ? new RecordingTossPayout() : undefined;
  const registry = new PlatformMetrics('payment-svc').registry;
  const signals = new PromSettlementSignals();
  signals.register(registry);
  const deps: ConstructorParameters<typeof Settlements>[0] = {
    store,
    payments,
    eventCommission: { rateBp: async () => 1000 },
    approvals: o.approvals ?? noApprovals,
    saleSuspensions: o.saleSuspensions ?? noSaleSuspensions,
    gateways: o.gateways ?? [platform.gateway, new UnavailableTossPayoutGateway()],
    reauth: o.reauth ?? new MemoryReauthVerifier(),
    clock,
    log: settlementApprovalLog(logger),
    ...(o.ops ? { caseNotice: new HttpSettlementCaseNotice(o.ops.url, INTERNAL_TOKEN) } : {}),
    // 토스 전송·지표·장부 원천은 F-07-6 계획 §7 보충의 칸 이름(tossTransport·signals·pgLedger, test/support/toss-harness.ts와 같음)
    ...(toss ? { tossTransport: toss } : {}),
    ...(o.pgLedger ? { pgLedger: o.pgLedger } : {}),
    // ↓ 인터페이스 빈칸(계획 §5.1에 칸 이름이 없음): 포트원 플랫폼은 PayoutAgencies 생성자와 같은 이름을 Settlements 의존에도 쓴다고 가정
    ...(platform.transport ? { portone: platform.transport } : {}),
    ...(portoneConfig ? { portoneConfig } : {}),
    payoutAccountAudit: sinks.audit,
    alerts: sinks.alerts,
    signals,
  };
  return { store, clock, settlements: new Settlements(deps), toss, portoneConfig, registry, log, deps };
}

export function harness(o: HarnessOptions): Harness {
  const payments = new MemorySettlementPaymentSource();
  return { ...buildSettlements(o.store ?? new MemorySettlementStore(), payments, o), payments };
}

/** 포트원 플랫폼이 꺼진 조립(지금의 수기 포트원 기록 동작) */
export const manualGateways = (): readonly PayoutGateway[] => [new ManualPortonePayoutGateway(), new UnavailableTossPayoutGateway()];

// ---- 시험 자료 ----

export function kyc(promoterId: string, at: Date, o: { legalName?: string; representative?: string; status?: KycRecord['status'] } = {}): KycRecord {
  const status = o.status ?? 'VERIFIED';
  return {
    promoterId,
    status,
    businessVerified: status === 'VERIFIED',
    representativeVerified: status === 'VERIFIED',
    legalName: o.legalName ?? '주식회사 피켓엔터',
    representative: o.representative ?? '김대표',
    verifiedAt: status === 'VERIFIED' ? at : null,
    source: 'MANUAL',
    updatedAt: at,
  };
}

export function statement(o: Partial<StatementRecord> & { promoterId: string; pg: StatementRecord['pg']; payoutDate: string; at: Date }): StatementRecord {
  const { at, ...rest } = o;
  return {
    statementId: randomUUID(),
    kind: 'EVENT',
    eventId: randomUUID(),
    pgStore: 'STANDARD',
    periodStart: null,
    periodEnd: null,
    grossAmount: 13_700_000,
    refundAmount: 0,
    commissionAmount: 1_370_000,
    commissionVat: 137_000,
    offsetAmount: 0,
    payoutAmount: 12_193_000,
    revision: 1,
    supersedesId: null,
    excludedPayments: [],
    status: 'CONFIRMED',
    holdReason: null,
    disputeDueAt: null,
    payoutBankCode: '88',
    payoutAccountLast4: '4321',
    payoutBatchId: null,
    adjustmentAmount: 0,
    createdAt: at,
    updatedAt: at,
    ...rest,
  };
}

/** F-07-6 계획 §5.1(바)가 지급 건에 더한 칸(payoutDate·failureClass·retryOfPayoutId·autoRetryCount)까지 채운다 */
export function payout(o: Partial<PayoutRecord> & { batchId: string; statementId: string; amount: number; at: Date; payoutDate: string }): PayoutRecord {
  const { at, ...rest } = o;
  const seq = rest.seq ?? 1;
  return {
    payoutId: randomUUID(),
    seq,
    refPayoutId: `${rest.statementId}-${seq}`,
    pgPayoutId: null,
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
}

/** F-07-6 계획 §5.1(바)가 묶음에 더한 칸(submitAttempts·nextSubmitAt·submitDeadlineAt·lastSubmitError·dateRetryUsed)까지 채운다 */
export function batch(o: Partial<PayoutBatchRecord> & { pg: PayoutBatchRecord['pg']; payoutDate: string; totalAmount: number; statementCount: number; at: Date }): PayoutBatchRecord {
  const { at, ...rest } = o;
  return {
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
}

/** F-07-6 toss_seller 한 행의 레코드(TossSellerRecord) */
export function tossSellerRecord(promoterId: string, pgStore: PgStore, status: TossSellerStatus, at: Date) {
  return {
    promoterId,
    pgStore,
    tossSellerId: `seller-${pgStore.toLowerCase()}-${promoterId.slice(0, 8)}`,
    refSellerId: `${promoterId}-${pgStore}`,
    status,
    businessType: 'CORPORATE' as const,
    registeredAt: at,
    statusCheckedAt: at,
    updatedAt: at,
  };
}

/** 메모리 저장소에 toss_seller 한 행(키 `${promoterId}:${pgStore}`)을 넣고 셀러 ID를 돌려준다 */
export function tossSeller(store: MemorySettlementStore, promoterId: string, pgStore: PgStore, status: TossSellerStatus, at: Date): string {
  const r = tossSellerRecord(promoterId, pgStore, status, at);
  store.tossSellers.set(`${promoterId}:${pgStore}`, r);
  return r.tossSellerId;
}

/** 포트원 파트너 한 행의 레코드(portone_partner, 계획 §5.1(바)) */
export function portonePartnerRecord(promoterId: string, at: Date, o: { lastAccountCheck?: 'MATCHED' | 'MISMATCH' | null; lastAccountCheckedAt?: Date | null } = {}) {
  return {
    promoterId,
    portonePartnerId: `peaket-${promoterId}`,
    contractId: PORTONE_CONTRACT_ID,
    registeredAt: at,
    accountUpdatedAt: at,
    lastAccountCheck: o.lastAccountCheck ?? null,
    lastAccountCheckedAt: o.lastAccountCheckedAt ?? null,
    updatedAt: at,
  };
}

/** 메모리 저장소에 포트원 파트너 한 행을 넣고 파트너 ID를 돌려준다 */
export function portonePartner(store: MemorySettlementStore, promoterId: string, at: Date, o: { lastAccountCheck?: 'MATCHED' | 'MISMATCH' | null; lastAccountCheckedAt?: Date | null } = {}): string {
  const r = portonePartnerRecord(promoterId, at, o);
  store.portonePartners.set(promoterId, r);
  return r.portonePartnerId;
}

/** 메모리 저장소의 모든 칸을 한 글로(원문 0건 단언용) */
export function dumpStore(store: MemorySettlementStore): string {
  return JSON.stringify(store, (_k, v: unknown) => (v instanceof Map ? [...v.entries()] : v instanceof Set ? [...v] : v));
}

// ---- HTTP 조립(Fastify 주입) ----

/** identity 관리 권한 대역(파트너 관리자·실무자 세션). settlement.test.ts의 FakeIdentity와 같은 모양 */
export class PartnerSessions implements AdminAuthzPort {
  readonly answers = new Map<string, AdminAuthz>();
  async getAdminAuthz(q: { adminAccountId: string; sessionId: string }): Promise<AdminAuthz> {
    return this.answers.get(`${q.adminAccountId}/${q.sessionId}`) ?? { valid: false, role: '' };
  }
  /** 머리와 계정·세션 ID */
  partner(tenantId: string, role: 'partner_admin' | 'partner_member' = 'partner_admin'): { headers: Record<string, string>; accountId: string; sessionId: string } {
    const accountId = randomUUID();
    const sessionId = randomUUID();
    this.answers.set(`${accountId}/${sessionId}`, { valid: true, role, tenantId });
    return { headers: { 'x-user-id': accountId, 'x-session-id': sessionId, 'x-user-aud': 'partner', 'x-user-scope': '', 'content-type': 'application/json' }, accountId, sessionId };
  }
}

/** Settlements와 같은 의존으로 payment-svc HTTP를 띄운다(createService, 같은 가짜 시계) */
export async function httpService(h: Harness, o: { sessions?: PartnerSessions; logDestination?: Writable } = {}): Promise<{ http: Awaited<ReturnType<typeof createService>>['http']; settlements: Settlements; close: () => Promise<void> }> {
  const { clock: _clock, ...moduleDeps } = h.deps;
  @Module({ imports: [SettlementModule.register(moduleDeps)] })
  class HttpTestModule {}
  const svc = await createService({
    name: 'payment-svc',
    module: HttpTestModule,
    env: { PEAKET_ENV: 'ci' },
    clock: h.clock,
    logDestination: o.logDestination ?? h.log.stream,
    adminAuthz: o.sessions ?? new PartnerSessions(),
  });
  return { http: svc.http, settlements: svc.app.get(Settlements), close: () => svc.close() };
}
