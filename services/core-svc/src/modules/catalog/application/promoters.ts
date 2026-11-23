// 유스케이스: 파트너사 목록·등록·상세·계약 이력·변경 요청(openapi /v1/ops/promoters*, BAT-615 LCH-070, ADR-0320).
// 첫 계약은 등록이 승인 업무 없이 만들고, 이후 변경은 ops의 CONTRACT_TERMS_CHANGE 2인 승인을 거친다.
// 변경 요청은 core DB에 승인 ID를 먼저 예약한 뒤 ops에 승인 업무를 만든다(두 겹 가드, ADR-0086).
import { Inject, Injectable, Optional } from '@nestjs/common';
import { CLOCK, type Clock, PLATFORM_LOGGER, type PlatformLogger, ProblemError, RequestValidationError, uuidv7, type IdempotencyRequest } from '@peaket/platform';
import {
  ContractTermsProblem,
  formatBp,
  requestedTerms,
  validateChange,
  validateBp,
  isGuaranteeKind,
  type ContractTermsChange,
  type PromoterContractPeriod,
  type PromoterDetail,
  type PromoterPage,
} from '../domain/promoter-contract.js';
import { PAYOUT_REGISTRATION, type PayoutRegistrationPort } from '../domain/payout-registration-port.js';
import { payoutRegistrationOf } from './payout-registration-view.js';
import { OPS_APPROVAL_CLIENT, PROMOTER_STORE, type OpsApprovalClient, type OpsPromoterActor, type PromoterCreateInput, type PromoterStore, type ReservedContractChange } from '../domain/promoter-ports.js';

export interface PromoterListQuery {
  q?: string | undefined;
  cursor?: string | undefined;
  limit?: number | undefined;
}

export interface PromoterCreateBody extends PromoterCreateInput {}

export interface PromoterChangeBody extends ContractTermsChange {}

export interface ContractApprovalApplyInput {
  commissionRateBp?: number | undefined;
  guaranteeRateBp?: number | undefined;
  guaranteeKind?: string | undefined;
  approvedAt: string;
  approverId: string;
}

const notFound = () => new ProblemError({ type: 'not-found', status: 404, title: '찾을 수 없습니다' });
/** 도메인 오류를 플랫폼 Problem으로 바꾼다(도메인 층은 바깥 의존을 모른다) */
const guard = async <T>(fn: () => Promise<T>): Promise<T> => {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ContractTermsProblem) throw new ProblemError({ type: e.type, status: e.status, title: e.title });
    throw e;
  }
};
const limitOf = (limit: number | undefined): number => {
  const n = limit ?? 20;
  if (!Number.isSafeInteger(n) || n < 1 || n > 100) throw new RequestValidationError('limit이 맞지 않습니다');
  return n;
};

/** 관제 응답의 승인 업무 모양(openapi ApprovalRequest). ops가 만든 업무를 core가 같은 ID로 답한다 */
function approvalView(input: { approvalId: string; promoterId: string; actor: OpsPromoterActor; reasonText: string; current: PromoterContractPeriod; requested: { commissionRateBp: number; guaranteeRateBp: number; guaranteeKind: string }; now: Date }) {
  return {
    approvalId: input.approvalId,
    kind: 'CONTRACT_TERMS_CHANGE' as const,
    targetRef: input.promoterId,
    reasonCode: 'CONTRACT_TERMS_CHANGE',
    reasonText: input.reasonText,
    requiredApprovals: 2 as const,
    approvals: [] as string[],
    status: 'PENDING_APPROVAL' as const,
    requestedBy: { adminAccountId: input.actor.accountId, displayName: null, role: input.actor.role },
    requestedAt: input.now.toISOString(),
    canApprove: false,
    dueAt: null,
    closeReason: null,
    contractTerms: {
      current: periodView(input.current),
      requestedCommissionRateBp: input.requested.commissionRateBp,
      requestedGuaranteeRateBp: input.requested.guaranteeRateBp,
      requestedGuaranteeKind: input.requested.guaranteeKind,
    },
  };
}

const periodView = (p: PromoterContractPeriod) => ({
  commissionRateBp: p.commissionRateBp,
  guaranteeRateBp: p.guaranteeRateBp,
  guaranteeKind: p.guaranteeKind,
  validFrom: p.validFrom.toISOString(),
  validUntil: p.validUntil ? p.validUntil.toISOString() : null,
  approvalId: p.approvalId,
});

/** 상세 응답의 계약 기간을 문자열 시각으로 바꾼다(openapi date-time). 지급대행 등록 값은 payment 등록 읽기에서 온다(F-07-7, ADR-0370 결정 4) */
const detailView = (d: PromoterDetail, registration: Awaited<ReturnType<typeof payoutRegistrationOf>>) => ({
  promoterId: d.promoterId,
  legalName: d.legalName,
  contract: periodView(d.contract),
  pendingContractApprovalId: d.pendingContractApprovalId,
  seller: d.seller,
  verifiedAt: d.verifiedAt ? d.verifiedAt.toISOString() : null,
  payoutAccount: registration.payoutAccount,
  pgRegistration: registration.pgRegistration,
});

@Injectable()
export class Promoters {
  constructor(
    @Inject(PROMOTER_STORE) private readonly store: PromoterStore,
    @Inject(OPS_APPROVAL_CLIENT) private readonly approvals: OpsApprovalClient,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PAYOUT_REGISTRATION) private readonly payout: PayoutRegistrationPort,
    @Optional() @Inject(PLATFORM_LOGGER) private readonly logger?: Pick<PlatformLogger, 'info' | 'warn'>,
  ) {}

  async list(q: PromoterListQuery): Promise<PromoterPage> {
    if (q.q !== undefined && (q.q.length < 1 || q.q.length > 100)) throw new RequestValidationError('검색어 길이가 맞지 않습니다');
    return this.store.list({ ...(q.q !== undefined ? { q: q.q } : {}), ...(q.cursor !== undefined ? { cursor: q.cursor } : {}), limit: limitOf(q.limit) });
  }

  async create(input: PromoterCreateInput, actor: OpsPromoterActor, once?: IdempotencyRequest | undefined) {
    return guard(async () => {
      if (input.legalName.trim().length < 1 || input.legalName.length > 100) throw new ContractTermsProblem('contract-terms-invalid', 422, '상호는 1~100자여야 합니다');
      validateBp('수수료율', input.commissionRateBp);
      validateBp('보증 비율', input.guaranteeRateBp);
      if (!isGuaranteeKind(input.guaranteeKind)) throw new ContractTermsProblem('contract-terms-invalid', 422, '보증 종류가 맞지 않습니다');
      const now = new Date(this.clock.now());
      const detail = await this.store.create({ ...input, legalName: input.legalName.trim() }, actor, now, once);
      this.logger?.info({ event: 'ops_promoter_created', promoterId: detail.promoterId, commissionRateBp: detail.contract.commissionRateBp }, '파트너사를 등록했다');
      return detailView(detail, await payoutRegistrationOf(this.payout, detail.promoterId, actor.role, this.logger));
    });
  }

  /** role이 cs_agent·cs_lead면 정산 계좌는 null이다(authz-matrix §4.1) */
  async detail(promoterId: string, role?: string) {
    const d = await this.store.detail(promoterId);
    if (!d) throw notFound();
    return detailView(d, await payoutRegistrationOf(this.payout, d.promoterId, role, this.logger));
  }

  async terms(promoterId: string, q: { cursor?: string | undefined; limit?: number | undefined }): Promise<{ items: ReturnType<typeof periodView>[]; nextCursor: string | null }> {
    const page = await this.store.terms(promoterId, { ...(q.cursor !== undefined ? { cursor: q.cursor } : {}), limit: limitOf(q.limit) });
    if (!page) throw notFound();
    return { items: page.items.map(periodView), nextCursor: page.nextCursor };
  }

  /**
   * 변경 요청: 지금 계약을 읽어 바꿀 칸을 검사하고, 승인 ID를 먼저 예약한 뒤 ops에 승인 업무를 만든다.
   * 같은 Idempotency-Key·같은 본문 재요청은 예약과 함께 저장한 처음 202 응답을 그대로 돌려준다(RV-03).
   * ops 호출이 실패하면 예약과 멱등 기록을 풀고 503을 낸다(임의로 성공한 척하지 않는다).
   */
  async requestChange(promoterId: string, body: PromoterChangeBody, actor: OpsPromoterActor, once?: IdempotencyRequest | undefined) {
    return guard(async () => {
      const d = await this.store.detail(promoterId);
      if (!d) throw notFound();
      const change: ContractTermsChange = {
        ...(body.commissionRateBp !== undefined ? { commissionRateBp: body.commissionRateBp } : {}),
        ...(body.guaranteeRateBp !== undefined ? { guaranteeRateBp: body.guaranteeRateBp } : {}),
        ...(body.guaranteeKind !== undefined ? { guaranteeKind: body.guaranteeKind } : {}),
        reason: body.reason,
      };
      validateChange(d.contract, change);
      const requested = requestedTerms(d.contract, change);
      const approvalId = uuidv7(this.clock);
      const now = new Date(this.clock.now());
      const reasonText = change.reason.trim();
      const render = (r: ReservedContractChange) => JSON.stringify(approvalView({ approvalId, promoterId, actor, reasonText, current: r.current, requested: r.requested, now }));
      const reserved = await this.store.reserveChange(promoterId, approvalId, requested, now, once, render);
      if (typeof reserved === 'object' && 'replay' in reserved) return JSON.parse(reserved.replay) as unknown;
      if (reserved === 'not-found') throw notFound();
      if (reserved === 'pending') throw new ProblemError({ type: 'contract-change-pending', status: 409, title: '이미 승인 대기 중인 계약 변경이 있습니다' });
      if (reserved === 'no-contract') throw new ProblemError({ type: 'contract-terms-missing', status: 409, title: '지금 계약 조건이 없습니다' });
      try {
        await this.approvals.createContractTermsChange({
          approvalId,
          promoterId,
          requestedBy: actor,
          reasonText,
          current: { commissionRateBp: reserved.current.commissionRateBp, guaranteeRateBp: reserved.current.guaranteeRateBp, guaranteeKind: reserved.current.guaranteeKind, validFrom: reserved.current.validFrom.toISOString() },
          requested,
        });
      } catch (err) {
        await this.store.clearPending(promoterId, approvalId, once);
        this.logger?.warn({ event: 'contract_change_request_failed', promoterId, err: (err as Error).name }, 'ops 승인 업무를 만들지 못해 예약을 풀었다');
        throw new ProblemError({ type: 'dependency-unavailable', status: 503, title: '의존 서비스를 잠시 쓸 수 없습니다' });
      }
      this.logger?.info({ event: 'contract_change_requested', promoterId, approvalId, fromBp: reserved.current.commissionRateBp, toBp: requested.commissionRateBp, rate: formatBp(requested.commissionRateBp) }, '계약 조건 변경을 요청했다');
      return approvalView({ approvalId, promoterId, actor, reasonText, current: reserved.current, requested, now });
    });
  }
}

/** ops-svc가 부르는 계약 승인 적용 내부 경로의 유스케이스(승인 ID 멱등) */
@Injectable()
export class ApplyContractApproval {
  constructor(@Inject(PROMOTER_STORE) private readonly store: PromoterStore) {}

  async run(promoterId: string, approvalId: string, input: ContractApprovalApplyInput): Promise<{ applied: true; validFrom: string }> {
    return guard(async () => {
      if (input.commissionRateBp !== undefined) validateBp('수수료율', input.commissionRateBp);
      if (input.guaranteeRateBp !== undefined) validateBp('보증 비율', input.guaranteeRateBp);
      if (input.guaranteeKind !== undefined && !isGuaranteeKind(input.guaranteeKind)) throw new ContractTermsProblem('contract-terms-invalid', 422, '보증 종류가 맞지 않습니다');
      const approvedAt = new Date(input.approvedAt);
      if (Number.isNaN(approvedAt.getTime())) throw new ContractTermsProblem('contract-terms-invalid', 422, '승인 시각이 맞지 않습니다');
      const out = await this.store.applyChange(
        promoterId,
        approvalId,
        {
          ...(input.commissionRateBp !== undefined ? { commissionRateBp: input.commissionRateBp } : {}),
          ...(input.guaranteeRateBp !== undefined ? { guaranteeRateBp: input.guaranteeRateBp } : {}),
          ...(input.guaranteeKind !== undefined ? { guaranteeKind: input.guaranteeKind as 'DEPOSIT' | 'PERFORMANCE_BOND' } : {}),
        },
        approvedAt,
        input.approverId,
      );
      if (out === 'not-found') throw notFound();
      if (out === 'conflict') throw new ProblemError({ type: 'contract-terms-changed', status: 409, title: '그 사이 지금 계약이 바뀌었습니다' });
      return { applied: true as const, validFrom: out.validFrom.toISOString() };
    });
  }

  /** 반려·철회로 예약을 푼다. 같은 승인 ID를 다시 보내도 성공한다 */
  async cancel(promoterId: string, approvalId: string): Promise<{ cancelled: true }> {
    const d = await this.store.detail(promoterId);
    if (!d) throw notFound();
    await this.store.clearPending(promoterId, approvalId);
    return { cancelled: true };
  }
}
