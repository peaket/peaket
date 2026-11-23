// 유스케이스: 판매 승인 실행(openapi POST /v1/ops/sale-reviews/{productionId}/approvals, 판매 승인 LCH-080).
// 공연 행 잠금 안에서 pending_revision의 규칙·회차 고침·더한 회차를 공개본으로 옮기고, 규모·결제사 칸을 정한다.
// 커밋 뒤 회차 판매 설정 사본을 쓴다. 사본 쓰기가 실패해도 승인은 남고, 정비 일 sale-config-publish가 다시 쓴다.
// 승인 쓰기 전에 payment 등록 읽기로 켜진 결제사의 지급대행 조건을 보고(모자라면 409 sale-review-payout-registration-incomplete·missing),
// 참이면 payment에 판매자 확인을 쓴 뒤 승인한다. 읽기·쓰기가 실패하면 503 payout-dependency-unavailable이고 승인하지 않는다(fail-closed, F-07-7 ADR-0370 결정 4).
// 판매자 확인은 같은 값이면 멱등이라, 그 뒤 승인 쓰기가 실패해 다시 승인해도 안전하다.
import { Inject, Injectable, Optional } from '@nestjs/common';
import { CLOCK, type Clock, PLATFORM_LOGGER, type PlatformLogger, ProblemError } from '@peaket/platform';
import type { SaleApprovalInput, ShowScale } from '../domain/sale-approval.js';
import { eligibleListKeys } from '../domain/event-sale-config.js';
import { CDN_INVALIDATION, type CdnInvalidation } from '../domain/media-ports.js';
import { missingPayoutConditions, PAYOUT_REGISTRATION, PAYOUT_REGISTRATION_UNWIRED, type PayoutRegistrationPort } from '../domain/payout-registration-port.js';
import { OPS_SALE_STORE, type SaleStore } from '../domain/sale-ports.js';
import { PublishSaleConfigs } from './publish-sale-configs.js';
import { notFound, productionSuspended } from './problems.js';

export interface ApproveSaleReviewInput {
  productionId: string;
  scales: { eventId: string; scale: ShowScale }[];
  placeId?: string;
  accessibleSeatingCheck?: boolean;
}

@Injectable()
export class ApproveSaleReview {
  constructor(
    @Inject(OPS_SALE_STORE) private readonly store: SaleStore,
    private readonly publish: PublishSaleConfigs,
    @Inject(CLOCK) private readonly clock: Clock,
    @Optional() @Inject(CDN_INVALIDATION) private readonly cdn?: Pick<CdnInvalidation, 'invalidate'>,
    @Optional() @Inject(PLATFORM_LOGGER) private readonly logger?: Pick<PlatformLogger, 'info' | 'warn'>,
    /** 없으면(직접 조립한 시험) 둘 다 꺼짐 */
    @Optional() @Inject(PAYOUT_REGISTRATION) private readonly payout: PayoutRegistrationPort = PAYOUT_REGISTRATION_UNWIRED,
  ) {}

  async run(q: ApproveSaleReviewInput): Promise<{ applied: true; events: number }> {
    const tenantId = await this.store.promoterOf(q.productionId);
    if (!tenantId) throw notFound();
    await this.checkPayout(q.productionId, tenantId);
    const input: SaleApprovalInput = { now: new Date(this.clock.now()), scales: q.scales, ...(q.placeId !== undefined ? { placeId: q.placeId } : {}), ...(q.accessibleSeatingCheck !== undefined ? { accessibleSeatingCheck: q.accessibleSeatingCheck } : {}) };
    const out = await this.store.withScaleChangeLock(tenantId, () =>
      this.store.withLockedProduction(q.productionId, tenantId, async (tx) => {
        const st = await tx.state();
        if (st.production.saleReview === 'SUSPENDED') throw productionSuspended();
        if (st.production.saleReview !== 'SUBMITTED' && st.production.saleReview !== 'REJECTED') {
          throw new ProblemError({ type: 'sale-review-not-submitted', status: 409, title: '판매 승인 대기 중인 공연이 아닙니다' });
        }
        // 같은 잠금·같은 트랜잭션에서 지금 계약 수수료율을 읽어 회차에 고정한다(ADR-0060·0320).
        // 계약이 없으면 비워 두고, payment-svc 회차 정산이 503으로 닫는 쪽을 유지한다(임의 10% 금지).
        const commissionRateBp = await tx.currentCommissionRateBp(tenantId);
        const withRate: SaleApprovalInput = { ...input, ...(commissionRateBp !== undefined ? { commissionRateBp } : {}) };
        const targets = new Set([...st.events.map((e) => e.eventId), ...st.addedEvents.map((e) => e.eventId)]);
        const given = new Set(q.scales.map((s) => s.eventId));
        if (given.size !== targets.size || [...targets].some((id) => !given.has(id))) {
          throw new ProblemError({ type: 'sale-review-scales-missing', status: 422, title: '모든 회차의 공연 규모를 정해 주세요' });
        }
        const rules = st.production.pendingRules ?? st.production.rules;
        const available = new Set(st.lists.map((l) => l.key));
        for (const e of targets) {
          for (const key of eligibleListKeys(rules, e)) {
            if (!available.has(key)) throw new ProblemError({ type: 'sale-review-list-missing', status: 422, title: '판매 정책이 쓰는 명단이 없습니다' });
          }
        }
        return tx.approve(withRate);
      }),
    );
    if (out === 'not-found') throw notFound();
    try {
      await this.publish.publishState(out, tenantId);
    } catch (err) {
      // 승인은 커밋됐다. 사본은 정비 일이 다시 쓰므로 응답을 실패로 바꾸지 않는다(로그만 남긴다)
      this.logger?.warn({ event: 'sale_config_publish_failed', productionId: q.productionId, err: (err as Error).name }, '판매 승인 뒤 회차 판매 설정 사본을 쓰지 못했다(정비 일이 다시 쓴다)');
    }
    // 승인 커밋 뒤 공개 요약의 CDN 태그를 무효화한다(ADR-0200 결정 5). 실패는 로그만 남기고 승인은 성공이다
    try {
      const tags = [...new Set(out.events.flatMap((e) => [`event:${e.eventId.toLowerCase()}`, `production:${out.production.id.toLowerCase()}`]))];
      if (tags.length > 0) await this.cdn?.invalidate(tags);
    } catch (err) {
      this.logger?.warn({ event: 'cdn_invalidate_failed', productionId: q.productionId, err: (err as Error).name }, '판매 승인 뒤 CDN 태그를 무효화하지 못했다(승인은 그대로다)');
    }
    this.logger?.info({ event: 'sale_review_approved', productionId: q.productionId, events: out.events.length }, '판매 승인을 적용했다');
    return { applied: true, events: out.events.length };
  }

  /** 지급대행 조건을 보고 판매자 확인을 쓴다. 실패면 던지고 승인 트랜잭션을 열지 않는다 */
  private async checkPayout(productionId: string, tenantId: string): Promise<void> {
    const unavailable = () => new ProblemError({ type: 'payout-dependency-unavailable', status: 503, title: '지급 서비스에 연결하지 못했습니다' });
    let view;
    try {
      view = await this.payout.read(tenantId);
    } catch (err) {
      this.logger?.warn({ event: 'sale_review_payout_read_failed', productionId, err: err instanceof ProblemError ? err.slug : (err as Error).name }, '판매 승인 전에 지급대행 등록을 읽지 못해 승인하지 않았다');
      throw unavailable();
    }
    const missing = missingPayoutConditions(view);
    if (missing.length > 0) {
      throw new ProblemError({ type: 'sale-review-payout-registration-incomplete', status: 409, title: '지급대행 등록이 끝나지 않아 승인할 수 없습니다', extensions: { missing } });
    }
    const detail = await this.store.opsReviewDetail(productionId);
    if (!detail) throw notFound();
    // 승인 대기·반려 공연만 승인한다. 그 밖은 아래 잠금 안의 상태 검사가 409로 닫으므로 판매자 확인을 쓰지 않는다
    if (detail.status !== 'SUBMITTED' && detail.status !== 'REJECTED') return;
    const representative = detail.seller?.representative;
    if (!detail.seller || !representative) {
      // 판매자 정보가 없으면 판매 승인 요청 전이다. 아래 상태 검사가 409로 닫는다
      this.logger?.warn({ event: 'sale_review_seller_missing', productionId }, '판매자 정보가 없어 판매자 확인을 payment에 쓰지 않았다');
      return;
    }
    try {
      await this.payout.verifySeller(tenantId, { legalName: detail.seller.legalName, representative, verifiedAt: detail.verifiedAt ?? new Date(this.clock.now()) });
    } catch (err) {
      this.logger?.warn({ event: 'sale_review_seller_verify_failed', productionId, err: err instanceof ProblemError ? err.slug : (err as Error).name }, '판매자 확인을 payment에 쓰지 못해 승인하지 않았다');
      throw unavailable();
    }
  }
}
