// F-07-5 정산서 통지·이의·조정 시험의 공용 조립(LCH-100, ADR-0368). 진짜 Settlements·SettlementModule·메모리 저장소에
// 경계(시계·CS 처리함·조정 승인 기록·로그 목적지)만 짝 가짜로 끼운다(mock-policy: 업무 로직은 진짜).
import 'reflect-metadata';
import { createPlatformLogger, createService, fakeClock, type AdminAuthz, type AdminAuthzPort } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import {
  ManualPortonePayoutGateway,
  MemoryReauthVerifier,
  MemorySettlementPaymentSource,
  MemorySettlementStore,
  SettlementModule,
  SettlementProblem,
  Settlements,
  UnavailableTossPayoutGateway,
  settlementApprovalLog,
  type AdjustmentApprovalVerifier,
  type DueEventSettlementSource,
  type PaymentFact,
  type ProductSettlementItem,
  type ProductSettlementSource,
  type SaleSuspensionSource,
  type SettlementCaseNotice,
  type VerifiedAdjustmentApproval,
} from '../src/modules/settlement/index.js';
import { noApprovals, noSaleSuspensions } from './settlement-support.js';

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const quiet = (): Writable => new Writable({ write: (_c, _e, cb) => cb() });

/** 결제 원장의 승인 시각(정본 §4.1 RV-01: 판매 대금은 승인된 결제만). 펼침으로 실어 칸이 생기기 전·후 모두 타입이 맞는다. null은 승인된 적 없는 결제 */
export const APPROVED_AT = new Date('2026-11-01T00:00:00.000Z');
export type FactInput = Partial<PaymentFact> & { approvedAt?: Date | null };
export const fact = (o: FactInput = {}): PaymentFact => ({ paymentId: randomUUID(), amount: 10_000_000, cancelledAmount: 0, status: 'APPROVED', failureCategory: null, ...{ approvedAt: APPROVED_AT as Date | null }, ...o });

export class FakeIdentity implements AdminAuthzPort {
  readonly answers = new Map<string, AdminAuthz>();
  async getAdminAuthz(q: { adminAccountId: string; sessionId: string }): Promise<AdminAuthz> {
    return this.answers.get(`${q.adminAccountId}/${q.sessionId}`) ?? { valid: false, role: '' };
  }
  partner(tenantId: string, role: 'partner_admin' | 'partner_member' = 'partner_admin'): Record<string, string> {
    const accountId = randomUUID();
    const sessionId = randomUUID();
    this.answers.set(`${accountId}/${sessionId}`, { valid: true, role, tenantId });
    return { 'x-user-id': accountId, 'x-session-id': sessionId, 'x-user-aud': 'partner', 'x-user-scope': '' };
  }
}

/** ops-svc CS 처리함 경계의 짝 가짜(포트 SettlementCaseNotice). 진짜 어댑터 HttpSettlementCaseNotice는 같은 파일 시험이 따로 본다 */
export class RecordingCaseNotice implements SettlementCaseNotice {
  readonly opened: { disputeId: string; statementId: string; createdAt: Date }[] = [];
  /** 지급 쪽 CS 건(F-07-6 ADR-0369 결정 10, openCase). ops는 같은 사건 키를 한 건으로 받는다 */
  readonly cases: { eventKey: string; kind: string; sourceId: string; createdAt: Date }[] = [];
  failing = false;
  async openDispute(o: { disputeId: string; statementId: string; createdAt: Date }): Promise<void> {
    if (this.failing) throw new SettlementProblem('dependency-unavailable', 503, 'ops-svc가 503이다');
    this.opened.push({ ...o });
  }
  async openCase(o: { eventKey: string; kind: string; sourceId: string; createdAt: Date }): Promise<void> {
    if (this.failing) throw new SettlementProblem('dependency-unavailable', 503, 'ops-svc가 503이다');
    this.cases.push({ ...o });
  }
}

/** ops-svc 조정 승인 기록 경계의 짝 가짜(포트 AdjustmentApprovalVerifier). 진짜 응답 모양은 ops 시험(settlement-adjustment-approval)이 본다 */
export class FakeAdjustmentApprovals implements AdjustmentApprovalVerifier {
  readonly rows = new Map<string, VerifiedAdjustmentApproval>();
  failing = false;
  calls = 0;
  async verify(approvalId: string): Promise<VerifiedAdjustmentApproval | undefined> {
    this.calls += 1;
    if (this.failing) throw new SettlementProblem('dependency-unavailable', 503, 'ops-svc가 답하지 않는다');
    return this.rows.get(approvalId);
  }
}

export class CountingProducts implements ProductSettlementSource {
  rows: ProductSettlementItem[] = [];
  readonly calls: { from: string; to: string }[] = [];
  async listProductItems(from: string, to: string): Promise<ProductSettlementItem[]> {
    this.calls.push({ from, to });
    return this.rows.filter((r) => r.basisDate >= from && r.basisDate <= to);
  }
}

export const productItem = (o: Partial<ProductSettlementItem> = {}): ProductSettlementItem => ({
  itemId: randomUUID(),
  orderId: randomUUID(),
  promoterId: randomUUID(),
  eventId: null,
  pg: 'TOSS',
  pgStore: 'STANDARD',
  productId: randomUUID(),
  productName: '응원봉',
  quantity: 1,
  grossAmount: 40_000,
  refundedAmount: 0,
  commissionRateBp: 1000,
  basisDate: '2026-11-18',
  returnStatus: 'DELIVERED',
  eventEndsAt: null,
  ...o,
});

/** 실제 플랫폼 로거(pino)에 줄을 모은다. 정산 보안 로그 어댑터(settlementApprovalLog)를 진짜로 지난다 */
export function collectingLogger(now: () => number) {
  const lines: Record<string, unknown>[] = [];
  const destination = new Writable({
    write(chunk, _e, cb) {
      for (const line of String(chunk).split('\n')) if (line.trim() !== '') lines.push(JSON.parse(line) as Record<string, unknown>);
      cb();
    },
  });
  const logger = createPlatformLogger({ service: 'payment-svc', env: 'test', version: 't', pod: 'p', clock: { now, monotonicMs: () => 0 }, level: 'info', destination });
  return { lines, logger };
}

export interface FlowOptions {
  now: number;
  holidays?: ReadonlySet<string>;
  products?: ProductSettlementSource;
  events?: DueEventSettlementSource;
  saleSuspensions?: SaleSuspensionSource;
  commissionRateBp?: number;
  /** 저장소를 바꿔 끼울 때(장애 주입용 MemorySettlementStore 하위 클래스) */
  store?: MemorySettlementStore;
}

/** 커밋 뒤 'CS 건을 열었다' 표시 쓰기를 실패시키는 메모리 저장소(리뷰 RV-05 장애 주입). 나머지는 진짜 메모리 저장소다 */
export class FlakyMarkStore extends MemorySettlementStore {
  /** 다음 표시 쓰기 몇 번을 실패시킬지 */
  failNextMarks = 0;
  /** 이 이의의 표시 쓰기는 늘 실패 */
  readonly failMarkFor = new Set<string>();
  override async markDisputeCaseRequested(disputeId: string, at: Date): Promise<void> {
    if (this.failMarkFor.has(disputeId)) throw new Error('표시 쓰기 실패(시험 주입)');
    if (this.failNextMarks > 0) {
      this.failNextMarks -= 1;
      throw new Error('표시 쓰기 실패(시험 주입)');
    }
    return super.markDisputeCaseRequested(disputeId, at);
  }
}

/** HTTP까지 띄운 정산 모듈 한 벌. 시험마다 새로 만들고 close()로 닫는다 */
export async function settlementFlow(o: FlowOptions) {
  const clock = fakeClock({ now: o.now });
  const store = o.store ?? new MemorySettlementStore();
  const payments = new MemorySettlementPaymentSource();
  const caseNotice = new RecordingCaseNotice();
  const adjustmentApprovals = new FakeAdjustmentApprovals();
  const identity = new FakeIdentity();
  const { lines, logger } = collectingLogger(() => clock.now());
  const rate = o.commissionRateBp ?? 1000;
  const svc = await createService({
    name: 'payment-svc',
    module: SettlementModule.register({
      store,
      payments,
      approvals: noApprovals,
      saleSuspensions: o.saleSuspensions ?? noSaleSuspensions,
      eventCommission: { rateBp: async () => rate },
      gateways: [new ManualPortonePayoutGateway(), new UnavailableTossPayoutGateway()],
      reauth: new MemoryReauthVerifier(),
      caseNotice,
      adjustmentApprovals,
      log: settlementApprovalLog(logger),
      ...(o.holidays ? { holidays: o.holidays } : {}),
      ...(o.products ? { products: o.products } : {}),
      ...(o.events ? { events: o.events } : {}),
    }),
    env: { PEAKET_ENV: 'ci' },
    clock,
    logDestination: quiet(),
    adminAuthz: identity,
  });
  const settlements = svc.app.get(Settlements);
  const at = (t: number): void => clock.advance(t - clock.now());
  const partnerHeaders = (tenant: string, role: 'partner_admin' | 'partner_member' = 'partner_admin'): Record<string, string> => ({ ...identity.partner(tenant, role), 'content-type': 'application/json', 'idempotency-key': randomUUID() });
  const dispute = (tenant: string, statementId: string, body: unknown, headers = partnerHeaders(tenant)) =>
    svc.http.inject({ method: 'POST', url: `/v1/partner/settlements/${statementId}/disputes`, headers, payload: JSON.stringify(body) });
  const internal = (url: string, body?: unknown) =>
    svc.http.inject({ method: 'POST', url, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, payload: JSON.stringify(body) }) });
  return { clock, at, store, payments, caseNotice, adjustmentApprovals, identity, lines, svc, settlements, partnerHeaders, dispute, internal, close: () => svc.close() };
}

export type SettlementFlow = Awaited<ReturnType<typeof settlementFlow>>;

/** 승인된 조정 승인 기록(ops 사실). 요청자와 다른 commander 한 명이 승인했다 */
export const approvedFacts = (o: { approvalId: string; statementId: string; amount: number; reasonCode: string; requestedBy: string; at: number }): VerifiedAdjustmentApproval => ({
  approvalId: o.approvalId,
  kind: 'SETTLEMENT_ADJUSTMENT',
  targetRef: o.statementId,
  amount: o.amount,
  reasonCode: o.reasonCode,
  status: 'EXECUTING',
  requiredApprovals: 2,
  requestedBy: o.requestedBy,
  approvals: [randomUUID()],
  approvedAt: new Date(o.at).toISOString(),
});
