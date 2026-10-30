// SCR-055 예매·주문 내역의 주문 목록(카드·표)과 줄 값. 목록 경로(_pages/orders)와 상세 경로(_pages/order-detail)가 같이 쓴다
// (페이지끼리 가져오지 않게 위젯으로 뺐다, docs/frontend.md §2.2 '층 의존').
export { OrderHistoryTabs } from './ui/OrderHistoryList';
export { ORDERS_WRAP, ORDERS_GRID } from './ui/layout';
export { toRow, badgeClass, orderHref, inTab, tabCounts, ORDER_TABS, type OrderRow, type OrderTab, type RowPart } from './model/rows';
