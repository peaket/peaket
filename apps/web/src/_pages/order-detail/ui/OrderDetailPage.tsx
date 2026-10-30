// SCR-055 예매·주문 상세(d5 §5.29, d3 SCR-055 행, 캔버스 보드 SCR-055-m·t·d의 상세 상태를 한 페이지 반응형으로 합쳤다).
// 휴대폰: ← 예매·주문 내역 → 확인서. 태블릿(md): 같은 한 단, 최대 폭 640. 데스크톱(lg): 위에 '예매·주문 내역', 왼쪽 7열 표(이 주문 줄을 고름),
// 오른쪽 5열 카드 패널에 확인서. 읽는 순서는 확인서(h1)가 먼저이고, 표는 격자 자리로 왼쪽에 놓는다.
// 주소의 id는 목업 entities/account ORDER_HISTORY(entities/order ORDERS의 일곱 id 포함)에서 찾고, 없으면 404다.
// 상태는 ?state=(보드 state 값). 처음 상태는 주문 종류로 정한다(굿즈·부가 상품은 '굿즈 주문 상세'). 다크는 ?theme=dark.
import { notFound } from 'next/navigation';
import { resolvePreviewState, resolvePreviewTheme } from '@peaket/ds/Preview';
import { getOrderHistory, ORDER_HISTORY } from '@/entities/account';
import { SCR055_DETAIL_STATES } from '@/shared/config/screens.account';
import type { PageProps } from '@/shared/lib/page-props';
import { PreviewSwitcher } from '@/shared/ui/PreviewSwitcher';
import { AppShell } from '@/widgets/app-shell';
import { OrderHistoryTabs, ORDERS_GRID, ORDERS_WRAP, toRow } from '@/widgets/order-history';
import { defaultDetailState, detailView } from '../model/view';
import { DETAIL_TITLE_ID } from './DetailParts';
import { GoodsDetail } from './GoodsDetail';
import { TicketDetail } from './TicketDetail';

/** 확인서: 휴대폰 간격 16 · 태블릿 20(최대 640) · 데스크톱 카드 패널(안쪽 24, 간격 16) */
const PANEL =
  'col gap-4 md:max-w-[640px] md:gap-5 lg:col-span-5 lg:col-start-8 lg:row-start-2 lg:max-w-none lg:gap-4 lg:rounded-(--r-xl) lg:border lg:border-(--border) lg:bg-(--surface) lg:p-6';

export async function OrderDetailPage({ params, searchParams }: PageProps<{ orderId: string }>) {
  const { orderId } = await params;
  const entry = getOrderHistory(orderId);
  if (!entry) notFound();
  const sp = await searchParams;
  const state = resolvePreviewState(sp, SCR055_DETAIL_STATES, defaultDetailState(entry));
  const dark = resolvePreviewTheme(sp) === 'dark';
  const v = detailView(state, entry);
  // 데스크톱 표: 상태가 바꾼 주문(굿즈 주문 취소 확인의 '배송 준비')도 표에 같이 보인다
  const rows = ORDER_HISTORY.map((e) => (e.id === v.subject.id ? v.subject : e)).map(toRow);

  return (
    <AppShell dark={dark}>
      <main className="page-main" id="main" tabIndex={-1}>
        <div className={ORDERS_WRAP}>
          <div className={ORDERS_GRID}>
            <article key={`${state}-${orderId}`} className={PANEL} aria-labelledby={DETAIL_TITLE_ID}>
              {v.kind === 'ticket' ? (
                <TicketDetail t={v.subject} depositError={v.depositError} />
              ) : (
                <GoodsDetail g={v.subject} action={v.action} cancelReason={v.cancelReason} dialog={v.dialog} />
              )}
            </article>
            <h2 className="t-xl hidden lg:col-span-12 lg:row-start-1 lg:block" id="ol-title">
              예매·주문 내역
            </h2>
            <section className="col hidden gap-4 lg:col-span-7 lg:col-start-1 lg:row-start-2 lg:flex" aria-labelledby="ol-title">
              <OrderHistoryTabs
                key={`${state}-${orderId}`}
                rows={rows}
                defaultTab={v.kind === 'ticket' ? 'all' : 'goods'}
                view="table"
                selectedId={v.subject.id}
              />
            </section>
          </div>
        </div>
      </main>
      <PreviewSwitcher path={`/my/orders/${orderId}`} states={SCR055_DETAIL_STATES} current={state} keep={{ theme: dark ? 'dark' : undefined }} />
    </AppShell>
  );
}
