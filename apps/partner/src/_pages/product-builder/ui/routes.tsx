// app/ 경로 파일이 다시 내보내는 상품 빌더 페이지 넷
import { notFound } from 'next/navigation';
import { routes } from '@/shared/config/routes';
import { readParam, type RouteProps } from '@/shared/lib/preview';
import { getPartnerProduct } from '../model/products';
import { ProductBuilderPage } from './ProductBuilderPage';
import { ProductEditLive } from './live/ProductEditLive';

export async function ProductsPage({ searchParams }: RouteProps) {
  return <ProductBuilderPage path={routes.products()} fallback="상품 목록" searchParams={await searchParams} />;
}

export async function ProductNewPage({ searchParams }: RouteProps) {
  return <ProductBuilderPage path={routes.productNew()} fallback="굿즈" searchParams={await searchParams} />;
}

export async function ProductOrdersPage({ searchParams }: RouteProps) {
  return <ProductBuilderPage path={routes.productOrders()} fallback="굿즈 주문 현황" searchParams={await searchParams} />;
}

export async function ProductEditPage({ params, searchParams }: RouteProps<{ id: string }>) {
  const { id } = await params;
  const sp = await searchParams;
  if (readParam(sp, 'state') === undefined) {
    return (
      <>
        <div className="page-head">
          <div className="col" style={{ gap: 4 }}>
            <h1>상품 고치기</h1>
            <p className="t-sm muted">저장한 상품을 불러와 고칩니다. 시각은 모두 KST입니다.</p>
          </div>
        </div>
        <ProductEditLive productId={id} listHref={routes.products()} />
      </>
    );
  }
  const product = getPartnerProduct(id);
  if (!product) notFound();
  // 부가 상품을 고칠 때는 부가 상품 입력 칸이 기본(보드에 고치기 화면이 따로 없어 만들기 칸을 다시 쓴다)
  const fallback = product.kind === '티켓 연동 부가 상품' ? '티켓 연동 부가 상품' : '굿즈';
  return <ProductBuilderPage path={routes.product(id)} fallback={fallback} editingName={product.name} searchParams={sp} />;
}
