// SCR-015 티켓 연동 부가 상품(/my/tickets/[ticketId]/addons, d5 §5.15 · 04 §2 '티켓 연동 부가 상품 모드'). 마이 티켓(SCR-013 ③)에서 온다.
// 보드에 이 경로가 따로 없어, 굿즈 스토어 카탈로그의 틀(제목 줄 · 안내 배너 · 카드 격자)에 이 티켓의 회차에 붙은 부가 상품만 담았다(추천안).
// 휴대폰 2열 · 태블릿 3열 · 데스크톱 4열. 상태: 기본 · 장바구니에 담음(토스트, 보드 상태 이름) · 빈 화면(문구는 추천안).
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { resolvePreviewState, resolvePreviewTheme } from '@peaket/ds/Preview';
import { CART_GROUPS, cartLineCount } from '@/entities/cart';
import { getPerformance } from '@/entities/performance';
import { getProduction } from '@/entities/production';
import { listAddonsForPerformance } from '@/entities/product';
import { getTicket } from '@/entities/ticket';
import { SCR015_ADDON_STATES } from '@/shared/config/screens.booking';
import type { PageProps } from '@/shared/lib/page-props';
import { PreviewSwitcher } from '@/shared/ui/PreviewSwitcher';
import { AppShell } from '@/widgets/app-shell';
import { AddonsGrid } from './AddonsGrid';

type Props = PageProps<{ ticketId: string }>;

export async function TicketAddonsPage({ params, searchParams }: Props) {
  const { ticketId } = await params;
  const ticket = getTicket(ticketId);
  const perf = ticket ? getPerformance(ticket.performanceId) : undefined;
  const production = ticket ? getProduction(ticket.productionId) : undefined;
  if (!ticket || !perf || !production) notFound();
  const sp = await searchParams;
  const state = resolvePreviewState(sp, SCR015_ADDON_STATES, '기본');
  const dark = resolvePreviewTheme(sp) === 'dark';
  const addons = state === '빈 화면' ? [] : listAddonsForPerformance(perf.id);
  const ticketHref = `/my/tickets/${encodeURIComponent(ticket.id)}`;
  const lineCount = cartLineCount(CART_GROUPS);
  const cartLabel = `장바구니, 담은 상품 ${lineCount}개`;

  return (
    <AppShell dark={dark}>
      <main className="page-main" id="main" tabIndex={-1}>
        <div className="mx-auto col w-full max-w-[1280px] gap-4 px-4 pt-3 pb-10 md:px-6 md:pt-6 md:pb-12 lg:gap-6 lg:px-8 lg:pb-16">
          <Link className="row t-sm muted" href={ticketHref} style={{ gap: 2, alignSelf: 'flex-start' }}>
            <i className="ic ic-chevron-left ic-16" aria-hidden="true" />
            티켓 상세
          </Link>
          <div className="row between items-start gap-2 md:items-end md:gap-4">
            <div className="col" style={{ gap: 4 }}>
              <h1 className="t-xl md:text-[32px] md:leading-[42px] md:tracking-[-0.01em]">티켓 연동 부가 상품</h1>
              <p className="t-sm muted lg:text-base lg:leading-[22px]">
                {production.title} · <span className="num">{perf.label}</span> · {ticket.seatLabel}
              </p>
            </div>
            <Link className="icon-btn icon-btn-outline md:hidden" href="/shop/cart" aria-label={cartLabel}>
              <i className="ic ic-cart" aria-hidden="true" />
              <span className="count-dot" aria-hidden="true">
                {lineCount}
              </span>
            </Link>
            <Link className="btn btn-outline hidden md:inline-flex" href="/shop/cart" aria-label={cartLabel}>
              <i className="ic ic-cart" aria-hidden="true" />
              장바구니
              <span className="badge badge-primary" aria-hidden="true">
                {lineCount}
              </span>
            </Link>
          </div>

          {addons.length > 0 ? (
            <>
              <div className="banner banner-info">
                <i className="ic ic-ticket" aria-hidden="true" />
                <div className="banner-body">
                  <span className="banner-title">이 티켓의 회차에서 쓰는 상품입니다</span>
                  택배로 보내지 않고 현장·월렛 이용권으로 씁니다. 연결된 티켓을 취소하거나 공연이 취소되면 함께 전액 환급합니다.
                </div>
              </div>
              <section className="pt-1 md:pt-2 lg:pt-0" aria-labelledby="h-addons">
                <h2 className="sr-only" id="h-addons">
                  부가 상품 목록
                </h2>
                <AddonsGrid products={addons} initialToast={state === '장바구니에 담음' ? { kind: 'added' } : null} />
              </section>
            </>
          ) : (
            <div className="card-flat state px-5 py-12 md:px-6 md:py-16 lg:py-20">
              <span className="state-icon">
                <i className="ic ic-box" aria-hidden="true" />
              </span>
              <h2 className="t-lg">이 회차에 판매 중인 부가 상품이 없습니다</h2>
            </div>
          )}
          <Link className="link-more" href="/shop" style={{ alignSelf: 'flex-start' }}>
            굿즈 스토어 전체 보기
            <i className="ic ic-chevron-right" aria-hidden="true" />
          </Link>
        </div>
      </main>
      <PreviewSwitcher path={`${ticketHref}/addons`} states={SCR015_ADDON_STATES} current={state} keep={{ theme: dark ? 'dark' : undefined }} />
    </AppShell>
  );
}
