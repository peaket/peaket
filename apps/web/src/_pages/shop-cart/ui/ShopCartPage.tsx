// SCR-015 장바구니(/shop/cart, d5 §5.15 경로 표). 휴대폰·태블릿에서 카탈로그의 장바구니 버튼이 오는 페이지다(데스크톱은 오른쪽 드로어).
// 보드에는 장바구니 페이지가 따로 없어, 데스크톱 '장바구니 드로어'의 본문(판매자·수령 방식별 묶음 · 수량 고르기 · 합계 · [주문서로 가기])을
// 한 단 640px 페이지에 그대로 옮겼다(추천안). 상태: 기본 · 빈 화면(문구 '장바구니가 비어 있습니다'는 추천안).
import Link from 'next/link';
import { resolvePreviewState, resolvePreviewTheme } from '@peaket/ds/Preview';
import { CART_GROUPS, CartEmpty, CartGroups } from '@/entities/cart';
import { SCR015_CART_STATES } from '@/shared/config/screens.booking';
import type { PageProps } from '@/shared/lib/page-props';
import { PreviewSwitcher } from '@/shared/ui/PreviewSwitcher';
import { AppShell } from '@/widgets/app-shell';

export async function ShopCartPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const state = resolvePreviewState(sp, SCR015_CART_STATES, '기본');
  const dark = resolvePreviewTheme(sp) === 'dark';
  return (
    <AppShell dark={dark} current="shop">
      <main className="page-main" id="main" tabIndex={-1}>
        <div className="mx-auto col w-full max-w-[704px] gap-4 px-4 pt-3 pb-10 md:px-8 md:pt-6 md:pb-12 lg:pb-16">
          <Link className="row t-sm muted" href="/shop" style={{ gap: 2, alignSelf: 'flex-start' }}>
            <i className="ic ic-chevron-left ic-16" aria-hidden="true" />
            굿즈 스토어
          </Link>
          <h1 className="t-xl md:text-[32px] md:leading-[42px] md:tracking-[-0.01em]">장바구니</h1>
          {state === '빈 화면' ? <CartEmpty /> : <CartGroups groups={CART_GROUPS} headingLevel={2} />}
        </div>
      </main>
      <PreviewSwitcher path="/shop/cart" states={SCR015_CART_STATES} current={state} keep={{ theme: dark ? 'dark' : undefined }} />
    </AppShell>
  );
}
