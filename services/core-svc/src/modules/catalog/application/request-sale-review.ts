// 유스케이스: 파트너 판매 승인 요청·변경 취소(BAT-616 LCH-080, openapi POST/DELETE /v1/partner/productions/{productionId}/sale-review, ADR-0327).
// 공연 행 잠금 안에서 판매자 정보를 promoter에 쓰고 production을 SUBMITTED로 바꾼다. 같은 요청을 다시 보내도 행·시각을 새로 만들지 않는다.
// 변경 취소는 승인 이력이 있으면서 SUBMITTED·REJECTED일 때만 허용하고 마지막 승인 내용(APPROVED)으로 돌아간다.
// 공연 상태를 바꾸기 전에 payment-svc 지급대행 등록을 부른다(F-07-7, settlement §3, ADR-0370 결정 1·3). 422·502·503은 그대로 파트너에게 주고
// 공연은 SUBMITTED가 되지 않는다. 계좌번호 원문은 이 요청 안에서 payment로만 넘기고 core의 저장 행·감사·로그·Outbox에 넣지 않는다.
import { Inject, Injectable, Optional } from '@nestjs/common';
import { CLOCK, type Clock, PLATFORM_LOGGER, type PlatformLogger, ProblemError } from '@peaket/platform';
import { OPS_SALE_STORE, SALE_STORE, type SaleStore } from '../domain/sale-ports.js';
import { businessTypeOf, PAYOUT_REGISTRATION, type PayoutRegistrationPort } from '../domain/payout-registration-port.js';
import { payoutRegistrationOf } from './payout-registration-view.js';
import { decodeSaleReviewCursor, isSaleReviewFilterStatus, type OpsSaleReviewDetail, type OpsSaleReviewPage, type OpsSaleReviewQuery, type PartnerSaleReviewView, SaleReviewProblem, validateSaleReviewRequest } from '../domain/sale-review.js';
import { notFound, productionSuspended } from './problems.js';

export interface RequestSaleReviewInput {
  productionId: string;
  tenantId: string;
  body: Parameters<typeof validateSaleReviewRequest>[0];
}

const digitsOf = (s: string): string => s.replaceAll(/\D/g, '');

const notCancellable = () => new ProblemError({ type: 'sale-review-not-cancellable', status: 409, title: '거둘 판매 승인 변경 요청이 없습니다' });

@Injectable()
export class RequestSaleReview {
  constructor(
    @Inject(SALE_STORE) private readonly store: SaleStore,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PAYOUT_REGISTRATION) private readonly payout: PayoutRegistrationPort,
    @Optional() @Inject(PLATFORM_LOGGER) private readonly logger?: Pick<PlatformLogger, 'info'>,
  ) {}

  /** 잠금 밖·안에서 같은 차례로 보는 요청 가능 검사. 이미 SUBMITTED면 true(같은 답) */
  private static check(st: { production: { saleReview: string; hasPlace?: boolean }; events: { status: string }[] }): boolean {
    if (st.production.saleReview === 'SUSPENDED') throw productionSuspended();
    if (st.production.saleReview === 'SUBMITTED') return true;
    if (!st.production.hasPlace) throw new SaleReviewProblem('sale-review-request-invalid', 422, '등록 공연장이나 새 공연장 요청이 필요합니다');
    if (!st.events.some((e) => e.status !== 'CANCELLED')) throw new SaleReviewProblem('sale-review-request-invalid', 422, '판매 승인을 요청하려면 회차가 하나 이상 필요합니다');
    return false;
  }

  /** 지급대행 등록(payment). 포트원 플랫폼이 꺼져 있으면 payment가 모양만 보고 holderChecked false를 답한다 */
  private async register(q: RequestSaleReviewInput): Promise<void> {
    const seller = q.body.seller;
    const businessRegistrationNumber = digitsOf(seller.businessRegNo);
    await this.payout.register({
      promoterId: q.tenantId,
      businessType: businessTypeOf(businessRegistrationNumber),
      company: { name: seller.legalName, representativeName: seller.representative, businessRegistrationNumber, email: seller.email, phone: digitsOf(seller.phone) },
      account: { bankCode: q.body.payoutAccount.bankCode, accountNumber: digitsOf(q.body.payoutAccount.accountNumber), holderName: q.body.payoutAccount.holderName },
    });
  }

  /** 요청(202). DRAFT·REJECTED·APPROVED에서 SUBMITTED로 가고, 이미 SUBMITTED면 같은 답이다(B1) */
  async request(q: RequestSaleReviewInput): Promise<{ status: 'SUBMITTED' }> {
    try {
      validateSaleReviewRequest(q.body);
      // 잠금 밖에서 먼저 보고(없는 공연·판매 중지·이미 요청함은 등록을 부르지 않는다), 등록이 끝난 뒤 잠금 안에서 다시 본다
      const before = await this.store.read(q.productionId, q.tenantId);
      if (!before) throw notFound();
      if (RequestSaleReview.check(before)) return { status: 'SUBMITTED' };
      await this.register(q);
      const out = await this.store.withLockedProduction(q.productionId, q.tenantId, async (tx) => {
        const st = await tx.state();
        if (RequestSaleReview.check(st)) return { status: 'SUBMITTED' as const };
        await tx.requestReview(q.body, new Date(this.clock.now()));
        return { status: 'SUBMITTED' as const };
      });
      if (out === 'not-found') throw notFound();
      this.logger?.info({ event: 'sale_review_requested', productionId: q.productionId }, '파트너가 판매 승인을 요청했다');
      return out;
    } catch (err) {
      // 도메인 오류는 openapi problem type으로 바꾼다(도메인 층은 플랫폼 형을 모른다)
      if (err instanceof SaleReviewProblem) throw new ProblemError({ type: err.type, status: err.status, title: err.title });
      throw err;
    }
  }

  /** 변경 취소(204). 승인 이력이 있고 SUBMITTED·REJECTED일 때만이다(B4) */
  async cancel(q: { productionId: string; tenantId: string }): Promise<void> {
    const out = await this.store.withLockedProduction(q.productionId, q.tenantId, async (tx) => {
      const st = await tx.state();
      if (st.production.saleApprovedAt === null) throw notCancellable();
      if (st.production.saleReview !== 'SUBMITTED' && st.production.saleReview !== 'REJECTED') throw notCancellable();
      await tx.cancelReview();
      return true;
    });
    if (out === 'not-found') throw notFound();
    this.logger?.info({ event: 'sale_review_withdrawn', productionId: q.productionId }, '파트너가 판매 승인 변경 요청을 거뒀다');
  }

  /** 파트너 판매 승인 현황(얇은 읽기). 없거나 남의 공연이면 404 */
  async status(q: { productionId: string; tenantId: string }): Promise<PartnerSaleReviewView> {
    const found = await this.store.partnerReview(q.productionId, q.tenantId);
    if (!found) throw notFound();
    return found;
  }
}

/** 관제 목록·상세(BAT-616). 목록 기본은 SUBMITTED이고 상태·커서·limit을 그대로 저장소에 넘긴다 */
@Injectable()
export class OpsSaleReviews {
  constructor(
    @Inject(OPS_SALE_STORE) private readonly store: SaleStore,
    @Inject(PAYOUT_REGISTRATION) private readonly payout: PayoutRegistrationPort,
    @Optional() @Inject(PLATFORM_LOGGER) private readonly logger?: Pick<PlatformLogger, 'warn'>,
  ) {}

  /** statuses는 쿼리 스키마가 쉼표 목록을 나눠 넘긴다. 저장소에 닿기 전에 상태 이름과 커서 모양을 다시 본다(직접 부르는 길도 있다) */
  async list(q: { statuses?: readonly string[] | undefined; cursor?: string | undefined; limit?: number | undefined }): Promise<OpsSaleReviewPage> {
    const asked = q.statuses !== undefined && q.statuses.length > 0 ? q.statuses : ['SUBMITTED'];
    const statuses: OpsSaleReviewQuery['statuses'] = [];
    for (const s of asked) {
      if (!isSaleReviewFilterStatus(s)) throw new ProblemError({ type: 'invalid-query', status: 400, title: '목록 조건이 올바르지 않습니다', detail: '모르는 판매 승인 상태입니다' });
      statuses.push(s);
    }
    const limit = q.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ProblemError({ type: 'invalid-query', status: 400, title: '목록 조건이 올바르지 않습니다', detail: 'limit은 1~100 사이 정수여야 합니다' });
    if (q.cursor !== undefined && decodeSaleReviewCursor(q.cursor) === undefined) throw new ProblemError({ type: 'invalid-query', status: 400, title: '목록 조건이 올바르지 않습니다', detail: '커서가 올바르지 않습니다' });
    const page = await this.store.opsReviews({ statuses, ...(q.cursor !== undefined ? { cursor: q.cursor } : {}), limit });
    return page;
  }

  async detail(productionId: string, role?: string): Promise<OpsSaleReviewDetail & Awaited<ReturnType<typeof payoutRegistrationOf>>> {
    const found = await this.store.opsReviewDetail(productionId);
    if (!found) throw notFound();
    return { ...found, ...(await payoutRegistrationOf(this.payout, found.promoterId, role, this.logger)) };
  }
}
