'use client';
// SCR-023 [상품 고치기] 실제 API 판(openapi getPartnerProduct·updatePartnerProduct).
import Link from 'next/link';
import { getProduct } from '@/shared/api/partner-live';
import { ErrorCard, LoadingCard, useAsync } from '@/shared/ui/Async';
import { LiveProductForm } from './ProductFormLive';

export function ProductEditLive({ productId, listHref }: { productId: string; listHref: string }) {
  const page = useAsync(`product:${productId}`, (signal) => getProduct(productId, signal));
  if (page.status === 'loading') return <LoadingCard label="상품을 불러오는 중입니다" />;
  if (page.status === 'error')
    return (
      <div className="col" style={{ gap: 12 }}>
        <ErrorCard error={page.error} onRetry={page.reload} fallback="상품을 불러오지 못했습니다" />
        <Link className="btn btn-outline" href={listHref} style={{ alignSelf: 'flex-start' }}>
          상품 목록으로
        </Link>
      </div>
    );
  return <LiveProductForm listHref={listHref} editing={page.data} />;
}
