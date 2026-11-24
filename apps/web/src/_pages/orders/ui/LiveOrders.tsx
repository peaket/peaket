'use client';
// SCR-055 예매·주문 내역 목록의 실제 API 연결(F-07-2). 브라우저 API 주소가 없으면(퍼블리싱 미리보기) 지금 목업을 그대로 그린다.
// 티켓 목록(purchase-svc GET /v1/orders)과 굿즈 목록(core-svc GET /v1/shop/orders)은 한 커서로 묶지 않는다(openapi 설명).
// 그래서 두 목록을 받아 createdAt으로 섞고, 한쪽이 실패하면 다른 쪽만 그리고 부분 실패를 알린다.
import { useCallback, useEffect, useState } from 'react';
import { fanApiAvailable } from '@/shared/api';
import { OrderHistoryTabs } from '@/widgets/order-history';
import type { OrderRow } from '@/widgets/order-history/model/rows';
import type { OrderSummary, ShopOrderSummary } from '@peaket/api-client/model';
import { liveRows, partialFailureNotice } from '../model/live';

type Load =
  | { kind: 'fixture' }
  | { kind: 'loading' }
  | { kind: 'ready'; ticket: readonly OrderSummary[]; goods: readonly ShopOrderSummary[]; notice: string | null }
  | { kind: 'error'; message: string };

const FAN_COPY = '주문 내역을 불러오지 못했습니다. 잠시 뒤 다시 시도해 주세요.';

/** 브라우저에서만 부른다. 401이면 목업으로 돌아가지 않고 '다시 시도'를 보인다 */
async function loadFirstPage(): Promise<Extract<Load, { kind: 'ready' }>> {
  const [{ listOrders }, { listShopOrders }] = await Promise.all([import('@peaket/api-client/endpoints/orders'), import('@peaket/api-client/endpoints/shop')]);
  const [ticket, goods] = await Promise.allSettled([listOrders({ limit: 100 }), listShopOrders({ limit: 100 })]);
  const ticketOk = ticket.status === 'fulfilled';
  const goodsOk = goods.status === 'fulfilled';
  if (!ticketOk && !goodsOk) throw (ticket as PromiseRejectedResult).reason ?? (goods as PromiseRejectedResult).reason;
  return {
    kind: 'ready',
    ticket: ticketOk ? (ticket.value.data.items ?? []) : [],
    goods: goodsOk ? (goods.value.data.items ?? []) : [],
    notice: partialFailureNotice(ticketOk, goodsOk),
  };
}

export function LiveOrders({
  fixtureRows,
  fixtureTab = 'all',
  fixtureLoading = false,
  fixtureEmpty = false,
}: {
  fixtureRows: readonly OrderRow[];
  fixtureTab?: 'all' | 'ticket' | 'goods';
  fixtureLoading?: boolean;
  fixtureEmpty?: boolean;
}) {
  const [load, setLoad] = useState<Load>(() => (fanApiAvailable() ? { kind: 'loading' } : { kind: 'fixture' }));

  const run = useCallback(async () => {
    if (!fanApiAvailable()) {
      setLoad({ kind: 'fixture' });
      return;
    }
    setLoad({ kind: 'loading' });
    try {
      setLoad(await loadFirstPage());
    } catch (e) {
      const status = (e as { status?: number } | undefined)?.status;
      setLoad({ kind: 'error', message: status === 401 ? '로그인한 뒤 다시 확인해 주세요.' : FAN_COPY });
    }
  }, []);

  useEffect(() => {
    void run();
  }, [run]);

  if (load.kind === 'fixture') {
    return <OrderHistoryTabs rows={[...fixtureRows]} defaultTab={fixtureTab} view="cards" loading={fixtureLoading} empty={fixtureEmpty} />;
  }
  if (load.kind === 'loading') {
    return <OrderHistoryTabs rows={[]} defaultTab="all" view="cards" loading />;
  }
  if (load.kind === 'error') {
    return (
      <div className="card state col" role="status" style={{ gap: 12 }}>
        <p className="t-md muted">{load.message}</p>
        <button className="btn btn-outline" type="button" onClick={() => void run()}>
          다시 시도
        </button>
      </div>
    );
  }
  const rows = liveRows({ ticket: load.ticket, goods: load.goods });
  return (
    <div className="col" style={{ gap: 12 }}>
      {load.notice ? (
        <div className="banner banner-warning" role="status">
          <div className="banner-body">{load.notice}</div>
        </div>
      ) : null}
      <OrderHistoryTabs rows={rows} defaultTab="all" view="cards" empty={rows.length === 0} />
    </div>
  );
}
