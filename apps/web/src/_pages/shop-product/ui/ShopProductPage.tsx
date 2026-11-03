// SCR-015 굿즈 상세(d5 §5.15 '상세', 캔버스 보드 SCR-015-m·t·d isDetail·isNoTicket을 한 페이지 반응형으로 합쳤다).
// 휴대폰: 돌아가기 → 사진 → 이름·가격·판매자 → 옵션·수량 → 수령 방식 → 취소·반품 → 판매자 정보 → 아래 고정 [장바구니 담기][바로 구매].
// 태블릿(md): 사진 280 + 오른쪽 고르기 칸, 판매자 정보 표는 네 칸 카드. 데스크톱(lg): 12열 — 사진 5 · 고르기 칸 7(버튼 한 줄),
// 그 아래 취소·반품 6 | 판매자 정보 6. 판매자 정보와 상품용 중개자 고지(POL-037)·취소·반품 사전 고지(POL-016 §1.4)는 본문에 늘 보인다.
// 상태: 상품 상세(기본) · 티켓 미소지(보드: 티켓 보유자 전용 상품은 차단 안내, 일반 굿즈는 티켓 소지자 전용 수령 시간대가 빠진다) ·
// 품절(d5 상태 표: 토스트 '방금 품절되었습니다'와 구매 버튼 비활성, 보드에는 카탈로그 토스트만 있어 상세 모양은 추천안).
// 인기 MD 대기열(보드 상태)은 대기실 경량 페이지(포트 3004)의 /shop/[productId]/queue가 그린다.
import Link from 'next/link';
import { Fragment } from 'react';
import { notFound } from 'next/navigation';
import type { RadioOption } from '@peaket/ds/RadioGroup';
import { resolvePreviewState, resolvePreviewTheme } from '@peaket/ds/Preview';
import { getProduct, productBrokerNotice, productHref, TICKET_PICKUP_SLOT, won, type Product } from '@/entities/product';
import { getProduction } from '@/entities/production';
import { getSeller, type Seller } from '@/entities/seller';
import { TICKETS } from '@/entities/ticket';
import { getVenue } from '@/entities/venue';
import { SCR015_PRODUCT_STATES } from '@/shared/config/screens.booking';
import { cx } from '@/shared/lib/cx';
import type { PageProps } from '@/shared/lib/page-props';
import { PreviewSwitcher } from '@/shared/ui/PreviewSwitcher';
import { AppShell } from '@/widgets/app-shell';
import { ProductActions } from './ProductActions';
import { PurchaseForm } from './PurchaseForm';

type Props = PageProps<{ productId: string }>;

const GONE = new Set(['취소 접수', '공연 취소됨', '지난 공연']);
const HELD = TICKETS.filter((t) => !GONE.has(t.status));

function pickupOptions(p: Product, ownsProduction: boolean, productionTitle: string, venueName: string): RadioOption[] {
  if (p.delivery === 'pass') return [];
  const opts: RadioOption[] = [{ value: 'ship', label: '택배 배송', description: '배송지는 주문서에서 입력합니다' }];
  if (p.delivery === 'ship-or-site') {
    opts.push({ value: 'site', label: '현장 수령', description: `공연 당일 ${venueName}` });
    if (ownsProduction) {
      opts.push({
        value: 'ticket-slot',
        label: '티켓 소지자 전용 수령 시간대',
        description: `${TICKET_PICKUP_SLOT.dateText} ${TICKET_PICKUP_SLOT.slotText} · ${productionTitle} 티켓이 있어 고를 수 있습니다`,
      });
    }
  }
  return opts;
}

const H2 = 't-md fw-b lg:text-xl lg:leading-[27px]';

function RefundSection({ p }: { p: Product }) {
  const fee = won(p.returnShippingFee ?? 0);
  return (
    <section className="col gap-2.5 lg:col-span-6 lg:gap-3" aria-labelledby="h-refund">
      <h2 className={H2} id="h-refund">
        취소·반품
      </h2>
      {p.delivery === 'pass' ? (
        <p className="t-sm">
          연결된 공연의 입장 시작 전까지는 언제든 취소하고 전액 환급합니다. 입장이 시작되면 이용이 시작된 것으로 보아 취소할 수 없습니다. 연결된 티켓을 취소하거나 공연이 취소되면 함께 전액 환급합니다.
        </p>
      ) : (
        <dl className="col gap-2.5 lg:gap-3">
          <div className="col" style={{ gap: 2 }}>
            <dt className="t-xs fw-b muted">택배 배송</dt>
            <dd className="t-sm">
              발송 전에는 예매·주문 내역에서 바로 취소하고 전액 환급합니다. 받은 날부터 7일 안에 반품할 수 있습니다(단순 변심이면 반품 배송비 {fee}를 빼고 환급). 상품이
              설명과 다르면 받은 날부터 3개월 안(안 날부터 30일 안)에 배송비 없이 반품할 수 있습니다. 환급은 판매자가 반품을 받은 날부터 3영업일 안에 결제한 수단으로
              돌려드립니다.
            </dd>
          </div>
          {p.delivery === 'ship-or-site' ? (
            <div className="col" style={{ gap: 2 }}>
              <dt className="t-xs fw-b muted">현장 수령</dt>
              <dd className="t-sm">
                수령 시간 안에 받지 않으면 다음 영업일에 주문을 취소하고 전액 환급합니다. 받은 뒤 7일 안에는 택배로 반품할 수 있습니다(반품 배송비 구매자 부담).
              </dd>
            </div>
          ) : null}
        </dl>
      )}
    </section>
  );
}

function SellerSection({ seller }: { seller: Seller }) {
  const rows: [string, string][] = [
    ['상호', seller.name],
    ['대표자', seller.representative],
    ['주소', seller.address],
    ['전화', seller.phone],
    ['전자우편', seller.email],
    ['사업자등록번호', seller.businessNo],
    ['통신판매업 신고번호', seller.mailOrderNo],
  ];
  return (
    <section className="col gap-2.5 lg:col-span-6 lg:gap-3" aria-labelledby="h-seller">
      <h2 className={H2} id="h-seller">
        판매자 정보
      </h2>
      <div className="banner banner-legal">
        <i className="ic ic-scale" aria-hidden="true" />
        <div className="banner-body">
          <span className="legal-tag">법정 고지</span>
          {productBrokerNotice(seller.name)}
        </div>
      </div>
      <dl className="kv md:grid-cols-[auto_minmax(0,1fr)_auto_minmax(0,1fr)] md:gap-x-4 md:rounded-(--r-xl) md:border md:border-(--border) md:bg-(--surface) md:px-[18px] md:py-4 lg:gap-x-5 lg:px-5">
        {rows.map(([k, v]) => (
          <Fragment key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </Fragment>
        ))}
      </dl>
    </section>
  );
}

export async function ShopProductPage({ params, searchParams }: Props) {
  const { productId } = await params;
  const p = getProduct(productId);
  const seller = p ? getSeller(p.sellerId) : undefined;
  if (!p || !seller) notFound();
  const sp = await searchParams;
  const state = resolvePreviewState(sp, SCR015_PRODUCT_STATES, '상품 상세');
  const dark = resolvePreviewTheme(sp) === 'dark';

  const noTicket = state === '티켓 미소지';
  const ownsProduction = !noTicket && HELD.some((t) => t.productionId === p.productionId);
  const ownsRound = !noTicket && HELD.some((t) => t.performanceId === p.performanceId);
  const blocked = Boolean(p.ticketOnly && !ownsRound);
  const soldOut = Boolean(p.soldOut) || state === '품절';
  const reasonId = blocked ? 'nt-alert' : soldOut ? 'so-note' : undefined;
  const addon = p.kind === 'addon';
  const production = getProduction(p.productionId);
  const productionTitle = production?.title ?? '';
  const venueName = (production && getVenue(production.venueId)?.name) ?? '';
  const eventHref = `/events/${p.performanceId ?? production?.performanceIds[0] ?? ''}`;
  const toast = state === '품절' ? ({ kind: 'soldout' } as const) : null;

  return (
    <AppShell dark={dark} current="shop" bottomBar={<ProductActions placement="bar" blockedReasonId={reasonId} initialToast={toast} />}>
      <main className="page-main" id="main" tabIndex={-1}>
        <div className="mx-auto col w-full max-w-[1280px] gap-5 px-4 pt-3 pb-8 md:gap-6 md:px-6 md:pt-6 md:pb-12 lg:gap-8 lg:px-8 lg:pb-16">
          <Link className="row t-sm muted" href="/shop" style={{ gap: 2, alignSelf: 'flex-start' }}>
            <i className="ic ic-chevron-left ic-16" aria-hidden="true" />
            굿즈 스토어
          </Link>

          <div className="col gap-5 md:grid md:grid-cols-[280px_minmax(0,1fr)] md:items-start md:gap-7 lg:grid-cols-12 lg:gap-x-6 lg:gap-y-8">
            <span
              className={cx('card-flat center muted lg:col-span-5', addon ? 'aspect-[4/3] md:aspect-square' : 'aspect-square')}
              role="img"
              aria-label={`${p.title} 상품 사진`}
            >
              <i className={`ic ic-${p.icon} ic-64`} aria-hidden="true" />
            </span>

            <div className="col gap-5 md:gap-[18px] lg:col-span-7 lg:gap-6 lg:pl-4">
              <div className="col" style={{ gap: 6 }}>
                {p.ticketOnly || soldOut ? (
                  <span className="row" style={{ gap: 4 }}>
                    {p.ticketOnly ? <span className="badge badge-primary">티켓 보유자 전용</span> : null}
                    {soldOut ? (
                      <span className="badge badge-danger" id="so-note">
                        품절
                      </span>
                    ) : null}
                  </span>
                ) : null}
                <h1 className="t-xl lg:text-[32px] lg:leading-[42px] lg:tracking-[-0.01em]">{p.title}</h1>
                {p.roundText ? <p className="t-sm muted">{p.roundText}</p> : null}
                <p className="t-xl num">{won(p.price)}</p>
                <p className="t-sm muted">판매자 {p.sellerName}</p>
              </div>
              <div className="divider hidden lg:block" />

              {blocked ? (
                <>
                  <div className="banner banner-warning" role="alert" id="nt-alert">
                    <i className="ic ic-lock" aria-hidden="true" />
                    <div className="banner-body">이 상품은 티켓 보유자만 구매할 수 있습니다</div>
                  </div>
                  <div className="col" style={{ gap: 12 }}>
                    <Link className="link-more" href={eventHref}>
                      {productionTitle} 공연 보기
                      <i className="ic ic-chevron-right" aria-hidden="true" />
                    </Link>
                    <Link className="link-more" href="/shop">
                      굿즈 스토어로 돌아가기
                      <i className="ic ic-chevron-right" aria-hidden="true" />
                    </Link>
                  </div>
                </>
              ) : (
                <PurchaseForm product={p} pickupOptions={pickupOptions(p, ownsProduction, productionTitle, venueName)} />
              )}
              <ProductActions placement="inline" blockedReasonId={reasonId} initialToast={toast} />
            </div>
          </div>

          <div className="divider hidden lg:block" />
          <div className="col gap-5 md:gap-6 lg:grid lg:grid-cols-12 lg:items-start lg:gap-x-6 lg:gap-y-8">
            <RefundSection p={p} />
            <SellerSection seller={seller} />
          </div>
        </div>
      </main>
      <PreviewSwitcher path={productHref(p.id)} states={SCR015_PRODUCT_STATES} current={state} keep={{ theme: dark ? 'dark' : undefined }} />
    </AppShell>
  );
}
