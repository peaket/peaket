// SCR-023 상품 빌더(/products · /products/new · /products/orders · /products/[id]). 보드 SCR-023-m·t·d를 한 페이지 반응형으로 합쳤다(d5 §6.6, §3.9).
// 탭 다섯: [상품 목록] /products · [상품 만들기] /products/new · [굿즈 주문 현황] /products/orders · [배송·반품 처리]·[상품 정산]은 /products?state=…
// 상태(?state=): 굿즈 · 티켓 연동 부가 상품 · 저장 중 · 상품 목록 · 굿즈 주문 현황 · 배송·반품 처리 · 배송 명단 내려받기 · 반품 거절 · 상품 정산 · 메뉴 열림(셸이 서랍을 연다).
// 실무자 보기는 ?role=member(배송 명단 내려받기·이의 제기가 이유 있는 비활성).
import { previewHref } from '@peaket/ds/Preview';
import { routes } from '@/shared/config/routes';
import { PRODUCT_STATES } from '@/shared/config/states/scr023';
import { readParam, readPreview, type SearchParams } from '@/shared/lib/preview';
import { PreviewStateSwitcher } from '@/shared/ui/PreviewStateSwitcher';
import { partnerProducts } from '../model/products';
import { OrdersSection } from './OrdersSection';
import { ProductForm } from './ProductForm';
import { ProductListSection } from './ProductListSection';
import { ProductTabs, type ProductTab } from './ProductTabs';
import { SettlementSection } from './SettlementSection';
import { ShippingSection } from './ShippingSection';
import { LiveOrdersSection } from './live/OrdersLive';
import { LiveProductForm } from './live/ProductFormLive';
import { LiveProductListSection } from './live/ProductListLive';
import { LiveSettlementSection } from './live/SettlementLive';
import { LiveShippingSection } from './live/ShippingLive';

export type ProductState = (typeof PRODUCT_STATES)[number];

export interface ProductBuilderPageProps {
  path: string;
  /** 경로마다 기본 상태: /products '상품 목록', /products/new·[id] '굿즈'(보드 기본), /products/orders '굿즈 주문 현황' */
  fallback: ProductState;
  /** 고치는 상품(/products/[id]) */
  editingName?: string;
  searchParams: SearchParams;
}

type Tab = 'list' | 'new' | 'orders' | 'ship' | 'settle';

function tabOf(st: ProductState): Tab {
  switch (st) {
    case '굿즈':
    case '티켓 연동 부가 상품':
    case '저장 중':
      return 'new';
    case '굿즈 주문 현황':
      return 'orders';
    case '배송·반품 처리':
    case '배송 명단 내려받기':
    case '반품 거절':
      return 'ship';
    case '상품 정산':
      return 'settle';
    default:
      return 'list';
  }
}

export function ProductBuilderPage({ path, fallback, editingName, searchParams }: ProductBuilderPageProps) {
  const pv = readPreview(searchParams, PRODUCT_STATES, fallback);
  const live = readParam(searchParams, 'state') === undefined;
  const st = pv.state;
  const view = readParam(searchParams, 'tab');
  const tab: Tab = view === 'ship' ? 'ship' : view === 'settle' ? 'settle' : tabOf(st);
  const keep = pv.keep;
  const listHref = previewHref(routes.products(), undefined, keep);
  const newHref = previewHref(routes.productNew(), undefined, keep);
  const liveTabHref = (next: 'ship' | 'settle') => {
    const p = new URLSearchParams({ tab: next });
    for (const [k, v] of Object.entries(keep)) if (v !== undefined) p.set(k, v);
    return `${routes.products()}?${p.toString()}`;
  };

  const tabs: ProductTab[] = [
    { key: 'list', label: '상품 목록', href: listHref, active: tab === 'list', badge: live ? undefined : String(partnerProducts.length) },
    { key: 'new', label: '상품 만들기', href: newHref, active: tab === 'new' },
    { key: 'orders', label: '굿즈 주문 현황', href: previewHref(routes.productOrders(), undefined, keep), active: tab === 'orders' },
    { key: 'ship', label: '배송·반품 처리', href: live ? liveTabHref('ship') : previewHref(routes.products(), '배송·반품 처리', keep), active: tab === 'ship' },
    { key: 'settle', label: '상품 정산', href: live ? liveTabHref('settle') : previewHref(routes.products(), '상품 정산', keep), active: tab === 'settle' },
  ];

  return (
    <>
      <div className="page-head">
        <div className="col" style={{ gap: 4 }}>
          <h1>상품</h1>
          <p className="t-sm muted">공식 굿즈와 티켓 연동 부가 상품을 만들고 게시합니다. 시각은 모두 KST입니다.</p>
        </div>
      </div>
      <ProductTabs tabs={tabs} />

      {tab === 'new' ? (
        live ? (
          <LiveProductForm listHref={listHref} />
        ) : (
          <ProductForm kind={st === '티켓 연동 부가 상품' ? '티켓 연동 부가 상품' : '굿즈'} saving={st === '저장 중'} editingName={editingName} listHref={listHref} />
        )
      ) : tab === 'orders' ? (
        live ? <LiveOrdersSection /> : <OrdersSection />
      ) : tab === 'ship' ? (
        live ? (
          <LiveShippingSection isMember={pv.isMember} />
        ) : (
          <ShippingSection isMember={pv.isMember} openDownload={st === '배송 명단 내려받기'} openReject={st === '반품 거절'} />
        )
      ) : tab === 'settle' ? (
        live ? <LiveSettlementSection isMember={pv.isMember} /> : <SettlementSection isMember={pv.isMember} />
      ) : live ? (
        <LiveProductListSection newHref={newHref} />
      ) : (
        <ProductListSection newHref={newHref} />
      )}

      <PreviewStateSwitcher path={path} states={PRODUCT_STATES} current={st} keep={keep} />
    </>
  );
}
