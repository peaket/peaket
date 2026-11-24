// SCR-055 예매·주문 내역의 실제 API 연결 표시 규칙(F-07-2, docs/frontend.md §5.29, openapi GET /v1/orders·GET /v1/shop/orders).
// 정본이 "티켓 주문은 purchase-svc, 굿즈 주문은 core-svc가 맡아 한 커서로 묶지 않는다 [가정]"이라 했다.
// 그래서 화면이 두 목록을 createdAt으로 섞고, 한쪽이 실패하면 다른 쪽은 그대로 그린다.
import type { OrderSummary, ShopOrderSummary } from '@peaket/api-client/model';
import type { HistoryBadge, HistoryTone } from '@/entities/account';
import type { OrderRow } from '@/widgets/order-history/model/rows';

/** 목록 API의 두 응답. 목록은 한 커서로 묶지 않는다(openapi GET /v1/orders 설명) */
export interface LiveOrderSource {
  ticket: readonly OrderSummary[];
  goods: readonly ShopOrderSummary[];
}

/** 한쪽 API만 실패했을 때의 안내(둘 다 실패하면 한 줄로 합친다). 둘 다 성공이면 null */
export function partialFailureNotice(ticketOk: boolean, goodsOk: boolean): string | null {
  if (ticketOk && goodsOk) return null;
  if (!ticketOk && !goodsOk) return '주문 내역을 불러오지 못했습니다. 잠시 뒤 다시 시도해 주세요.';
  return !ticketOk ? '예매 주문을 불러오지 못했습니다. 굿즈 주문만 보입니다.' : '굿즈 주문을 불러오지 못했습니다. 예매 주문만 보입니다.';
}

const at = (iso: string | null | undefined): number => {
  const ms = iso ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(ms) ? ms : 0;
};

const orderHref = (id: string): string => `/my/orders/${id}`;

const TICKET_STATUS: Record<string, { label: string; tone: HistoryTone }> = {
  CREATED: { label: '결제 확인 중', tone: 'neutral' },
  AUTHENTICATED: { label: '결제 확인 중', tone: 'neutral' },
  ACCEPTED: { label: '결제 확인 중', tone: 'neutral' },
  RESERVED: { label: '결제 확인 중', tone: 'neutral' },
  AWAITING_DEPOSIT: { label: '입금 대기', tone: 'warning' },
  APPROVED: { label: '결제 완료', tone: 'success' },
  UNKNOWN: { label: '결제 결과 확인 중', tone: 'warning' },
  CONFIRMED: { label: '결제 완료', tone: 'success' },
  FAILED: { label: '주문 취소됨', tone: 'outline' },
  COMPENSATED: { label: '보상 완료', tone: 'success' },
  PARTIALLY_REFUNDED: { label: '부분 환불', tone: 'warning' },
  REFUNDED: { label: '환불 완료', tone: 'neutral' },
  EXPIRED: { label: '주문 취소됨', tone: 'outline' },
};

const GOODS_STATUS: Record<string, { label: string; tone: HistoryTone }> = {
  CREATED: { label: '결제 확인 중', tone: 'neutral' },
  AWAITING_DEPOSIT: { label: '입금 대기', tone: 'warning' },
  PAID: { label: '결제 완료', tone: 'success' },
  EXPIRED: { label: '주문 취소됨', tone: 'outline' },
  FAILED: { label: '결제 취소', tone: 'outline' },
};

/** 티켓 주문의 배지. 발권 지연이면 결제 완료 문구를 '티켓 발급 중'으로 바꾼다(ADR-0106) */
export function ticketBadges(o: OrderSummary): readonly HistoryBadge[] {
  const base = TICKET_STATUS[o.status] ?? { label: '결제 확인 중', tone: 'neutral' as HistoryTone };
  const badges: HistoryBadge[] = [{ text: o.issueDelayed && o.status === 'APPROVED' ? '결제 완료 · 티켓 발급 중' : base.label, tone: base.tone }];
  if (o.refundPending) badges.push({ text: '환급 보류', tone: 'warning' });
  if (o.status === 'FAILED' && o.failureReason) badges.push({ text: '입금 오류', tone: 'warning' });
  return badges;
}

/** 굿즈 주문의 배지. 항목별 배지는 상세가 맡는다 */
export function goodsBadges(o: ShopOrderSummary): readonly HistoryBadge[] {
  const base = GOODS_STATUS[o.status] ?? { label: '결제 확인 중', tone: 'neutral' as HistoryTone };
  const badges: HistoryBadge[] = [{ text: base.label, tone: base.tone }];
  if (o.escrow) badges.push({ text: '결제대금예치', tone: 'neutral' });
  return badges;
}

const tierText = (tiers: OrderSummary['tiers']): string => (tiers ?? []).map((t) => `${t.tierName ?? '좌석'} ${t.quantity ?? 0}매`).join(' · ');
const goodsItemText = (items: ShopOrderSummary['items']): string => (items ?? []).map((i) => `${i.name} ${i.quantity}개`).join(' · ');

const orderedText = (iso: string): string => {
  const ms = at(iso);
  return ms === 0 ? '' : `${new Date(ms).toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul' })} 주문`;
};

/** 티켓 주문 한 줄. 금액은 서버가 계산한 값을 그대로 쓴다 */
export function ticketRow(o: OrderSummary): OrderRow {
  const tiers = tierText(o.tiers);
  return {
    id: o.orderId,
    href: orderHref(o.orderId),
    kind: 'ticket',
    kindLabel: '예매',
    number: o.bookingNumber,
    orderedText: orderedText(o.createdAt),
    title: o.eventTitle ?? '공연',
    cardParts: [{ text: tiers || '좌석' }, { amount: o.amount }],
    tableParts: [{ text: '예매' }, { text: tiers }],
    amount: o.amount,
    badges: ticketBadges(o),
  };
}

/** 굿즈 주문 한 줄. 수령 방식·배지 글자는 d5 §5.29를 따른다 */
export function goodsRow(o: ShopOrderSummary): OrderRow {
  const items = goodsItemText(o.items);
  const fulfillment = o.fulfillment === 'PICKUP' ? '현장 수령' : o.fulfillment === 'WALLET' ? '월렛' : '택배';
  return {
    id: o.orderId,
    href: orderHref(o.orderId),
    kind: 'goods',
    kindLabel: '굿즈',
    number: o.orderNumber,
    orderedText: orderedText(o.createdAt),
    title: items || '굿즈 주문',
    cardParts: [{ text: `${fulfillment} · ${o.items?.length ?? 0}건` }, { amount: o.totalAmount }],
    tableParts: [{ text: '굿즈' }, { text: fulfillment }],
    amount: o.totalAmount,
    badges: goodsBadges(o),
  };
}

/** 두 목록을 createdAt 내림차순으로 섞어 한 줄 목록으로 만든다. 같은 시각이면 주문 ID 내림차순 */
export function liveRows(src: LiveOrderSource): OrderRow[] {
  const rows = [...src.ticket.map((o) => ({ row: ticketRow(o), at: at(o.createdAt) })), ...src.goods.map((o) => ({ row: goodsRow(o), at: at(o.createdAt) }))];
  return rows.sort((a, b) => b.at - a.at || (a.row.id < b.row.id ? 1 : -1)).map((r) => r.row);
}
