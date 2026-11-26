'use client';
// SCR-063 라이브 경로(F-07-12). UUID 공연+?state= 없음에서 개요·판매자 정보를 부르고 OverviewLiveView에 넘긴다.
// 판매자 정보가 실패해도 개요는 그린다(Promise.allSettled). 404는 없는 공연 안내로 닫는다.
import { useEffect, useState } from 'react';
import { SALE_REVIEW_BADGE, SALE_REVIEW_LABEL } from '@/shared/lib/sale-review';
import { performanceSellerNotice } from '@/shared/lib/seller-notice';
import { getPartnerProduction, getPartnerSellerProfile, type PartnerProductionOverview, type PartnerSellerProfile } from '@/shared/api/partner-live';
import { eventRowsOf, overviewModeOf, productionOfDetail, progressOf } from '../model/live';
import { OverviewLiveView, type OverviewViewMode } from './live-view';

interface Loaded {
  mode: OverviewViewMode;
  detail?: PartnerProductionOverview;
  seller?: PartnerSellerProfile | null;
  message?: string | null;
}

const NOT_FOUND = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function LiveEventOverview({ productionId }: { productionId: string }) {
  const [loaded, setLoaded] = useState<Loaded>({ mode: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    setLoaded({ mode: 'loading' });
    void Promise.allSettled([getPartnerProduction(productionId, controller.signal), getPartnerSellerProfile(controller.signal)]).then(([detail, seller]) => {
      if (controller.signal.aborted) return;
      if (detail.status === 'rejected') {
        const status = (detail.reason as { status?: number } | undefined)?.status;
        setLoaded({ mode: status === 404 || !NOT_FOUND.test(productionId) ? 'notFound' : 'error', seller: seller.status === 'fulfilled' ? seller.value : null });
        return;
      }
      setLoaded({ mode: 'ready', detail: detail.value, seller: seller.status === 'fulfilled' ? seller.value : null });
    });
    return () => controller.abort();
  }, [productionId]);

  if (loaded.mode === 'loading') return <OverviewLiveView mode="loading" />;
  if (loaded.mode === 'notFound') return <OverviewLiveView mode="notFound" />;
  if (loaded.mode === 'error') return <OverviewLiveView mode="error" message={null} />;
  const detail = loaded.detail!;
  const p = productionOfDetail(detail);
  const seller = loaded.seller;
  return (
    <OverviewLiveView
      mode="ready"
      production={{
        id: p.id,
        name: p.name,
        reviewLabel: SALE_REVIEW_LABEL[p.review],
        reviewBadge: SALE_REVIEW_BADGE[p.review],
        firstOpenText: p.firstOpenAt ?? '—',
        meta: `${p.placeName ?? '공연장 미정'} · 회차 ${p.roundCount}개`,
        roundCount: p.roundCount,
      }}
      progress={progressOf(detail)}
      rounds={eventRowsOf(detail.events)}
      seller={
        seller
          ? {
              notice: performanceSellerNotice(seller.seller.legalName),
              fields: [
                { label: '상호', value: seller.seller.legalName },
                { label: '대표자', value: seller.seller.representative ?? '—' },
                { label: '주소', value: seller.seller.address ?? '—' },
                { label: '연락처', value: seller.seller.phone ?? '—' },
                { label: '이메일', value: seller.seller.email ?? '—' },
                { label: '사업자등록번호', value: seller.seller.businessRegNo ?? '—' },
                { label: '통신판매업 신고번호', value: seller.seller.mailOrderReportNo ?? '—' },
              ],
            }
          : null
      }
    />
  );
}

/** 페이지가 목업 분기 전에 쓰는 값(테스트가 순수 함수로 본다). */
export const eventOverviewMode = overviewModeOf;
