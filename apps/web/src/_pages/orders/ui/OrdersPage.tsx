// SCR-055 예매·주문 내역 목록(d5 §5.29, d3 SCR-055 행, 캔버스 보드 SCR-055-m·t·d를 한 페이지 반응형으로 합쳤다).
// 휴대폰: 제목 → 탭(전체·예매·굿즈) → 주문 카드. 태블릿(md): 카드 두 줄. 데스크톱(lg, 본문 1040): 표 7열 + 오른쪽 5열 패널.
// 데스크톱 보드는 줄을 고른 상세만 그렸다. 목록 경로의 오른쪽은 '줄을 고르면 확인서가 열린다'는 안내 패널로 정했다(추천안).
// 상태는 ?state=(보드 state 값, '로딩'은 d5 상태 표에서 더함), 다크는 ?theme=dark.
import { resolvePreviewState, resolvePreviewTheme } from '@peaket/ds/Preview';
import { ORDER_HISTORY } from '@/entities/account';
import { SCR055_STATES } from '@/shared/config/screens.account';
import { cx } from '@/shared/lib/cx';
import type { PageProps } from '@/shared/lib/page-props';
import { PreviewSwitcher } from '@/shared/ui/PreviewSwitcher';
import { AppShell } from '@/widgets/app-shell';
import { OrderHistoryTabs, ORDERS_GRID, ORDERS_WRAP, toRow } from '@/widgets/order-history';
import { ordersView } from '../model/state';

export async function OrdersPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const state = resolvePreviewState(sp, SCR055_STATES, '목록');
  const dark = resolvePreviewTheme(sp) === 'dark';
  const v = ordersView(state);
  const rows = ORDER_HISTORY.map(toRow);

  return (
    <AppShell dark={dark}>
      <main className="page-main" id="main" tabIndex={-1}>
        <div className={ORDERS_WRAP}>
          <h1 className="t-xl">예매·주문 내역</h1>
          <div className={ORDERS_GRID}>
            <div className={cx('col gap-5 lg:gap-4', v.empty ? 'lg:col-span-12' : 'lg:col-span-7')}>
              <OrderHistoryTabs key={state} rows={rows} defaultTab={v.tab} view="cards" loading={v.loading} empty={v.empty} />
            </div>
            {v.empty ? null : (
              <div className="card state hidden lg:col-span-5 lg:flex">
                <span className="state-icon">
                  <i className="ic ic-receipt" aria-hidden="true" />
                </span>
                <p className="t-md muted" style={{ maxWidth: 320 }}>
                  표에서 주문을 고르면 예매 확인서나 주문 확인서가 여기에 열립니다
                </p>
              </div>
            )}
          </div>
        </div>
      </main>
      <PreviewSwitcher path="/my/orders" states={SCR055_STATES} current={state} keep={{ theme: dark ? 'dark' : undefined }} />
    </AppShell>
  );
}
