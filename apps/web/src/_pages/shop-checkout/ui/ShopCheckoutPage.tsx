// SCR-015 굿즈 주문·결제(/shop/checkout, d5 §5.15 '주문서', 캔버스 보드 SCR-015-m·t·d isCart/isOrder·isExpired를 한 페이지 반응형으로 합쳤다).
// 휴대폰·태블릿: 한 단(돌아가기 → 주문서 → 재고 예약 안내 → 담은 상품 n개 → 택배 묶음 카드 → 현장 수령 묶음 카드).
// 데스크톱(lg): 폭 1040(키트 .container) 안에서 묶음 카드마다 7:5 두 칸.
// 상태: 주문서(기본) · 배송 정보 동의 없음(d5 상태 표에서 더함: 택배 묶음의 결제 버튼 비활성, 이유 글은 추천안) · 재고 예약 만료 · 주문 완료(토스트 '주문했습니다').
import Link from 'next/link';
import { resolvePreviewState, resolvePreviewTheme } from '@peaket/ds/Preview';
import { CART_GROUPS, STOCK_HOLD_UNTIL_TEXT } from '@/entities/cart';
import { ME } from '@/entities/me';
import { SCR015_CHECKOUT_STATES } from '@/shared/config/screens.booking';
import type { PageProps } from '@/shared/lib/page-props';
import { PreviewSwitcher } from '@/shared/ui/PreviewSwitcher';
import { AppShell } from '@/widgets/app-shell';
import { CheckoutGroups } from './CheckoutGroups';

export async function ShopCheckoutPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const state = resolvePreviewState(sp, SCR015_CHECKOUT_STATES, '주문서');
  const dark = resolvePreviewTheme(sp) === 'dark';
  return (
    <AppShell dark={dark} current="shop">
      <main className="page-main" id="main" tabIndex={-1}>
        <div className="mx-auto col w-full max-w-[1040px] gap-6 px-4 pt-3 pb-8 md:px-6 md:pt-6 md:pb-12 lg:px-8 lg:pb-16">
          <Link className="row t-sm muted" href="/shop" style={{ gap: 2, alignSelf: 'flex-start' }}>
            <i className="ic ic-chevron-left ic-16" aria-hidden="true" />
            굿즈 스토어
          </Link>
          <h1 className="t-xl lg:text-[32px] lg:leading-[42px] lg:tracking-[-0.01em]">주문서</h1>
          {state === '재고 예약 만료' ? (
            <div className="card-flat state px-5 py-9 md:px-6 md:py-12 lg:py-14" role="alert">
              <span className="state-icon is-warning">
                <i className="ic ic-clock" aria-hidden="true" />
              </span>
              <h2 className="t-lg">결제 시간이 지나 주문이 끝났습니다</h2>
              <p className="t-sm muted">재고가 남아 있으면 다시 주문할 수 있습니다</p>
              <Link className="btn btn-primary btn-lg" href="/shop/cart">
                다시 주문하기
              </Link>
            </div>
          ) : (
            <>
              <div className="banner banner-info">
                <i className="ic ic-clock" aria-hidden="true" />
                <div className="banner-body">한정 재고를 {STOCK_HOLD_UNTIL_TEXT}까지 잡아 두었습니다</div>
              </div>
              <CheckoutGroups
                groups={CART_GROUPS}
                recipientName={ME.name}
                initialShipConsent={state !== '배송 정보 동의 없음'}
                initialToast={state === '주문 완료' ? { kind: 'ordered' } : null}
              />
            </>
          )}
        </div>
      </main>
      <PreviewSwitcher path="/shop/checkout" states={SCR015_CHECKOUT_STATES} current={state} keep={{ theme: dark ? 'dark' : undefined }} />
    </AppShell>
  );
}
