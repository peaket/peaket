// app/ 경로 파일이 다시 내보내는 상품 빌더 페이지 넷
import { notFound } from 'next/navigation';
import { routes } from '@/shared/config/routes';
import type { RouteProps } from '@/shared/lib/preview';
import { getPartnerProduct } from '../model/products';
import { ProductBuilderPage } from './ProductBuilderPage';

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
  const product = getPartnerProduct(id);
  if (!product) notFound();
  // 부가 상품을 고칠 때는 부가 상품 입력 칸이 기본(보드에 고치기 화면이 따로 없어 만들기 칸을 다시 쓴다)
  const fallback = product.kind === '티켓 연동 부가 상품' ? '티켓 연동 부가 상품' : '굿즈';
  return <ProductBuilderPage path={routes.product(id)} fallback={fallback} editingName={product.name} searchParams={await searchParams} />;
}
