// SCR-055 목록 경로 상태별로 무엇을 보일지(캔버스 보드 SCR-055 renderVals의 isList·isGoodsTab·isEmpty를 옮겼다).
// '로딩'(줄 스켈레톤)은 보드에 없어 d5 §5.29 상태 표에서 더했다.
import type { Scr055State } from '@/shared/config/screens.account';
import type { OrderTab } from '@/widgets/order-history';

export interface OrdersView {
  loading: boolean;
  empty: boolean;
  /** 처음 고른 탭 */
  tab: OrderTab;
}

export function ordersView(st: Scr055State): OrdersView {
  return {
    loading: st === '로딩',
    empty: st === '빈 화면',
    tab: st === '굿즈 탭' ? 'goods' : 'all',
  };
}
