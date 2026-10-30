// SCR-055 주문 줄의 표시 값(카드·표가 함께 쓴다). 목업 entities/account ORDER_HISTORY에 공연 이름·회차 글(production·performance)을 붙인다.
// 목록 경로(_pages/orders)와 상세 경로(_pages/order-detail, 데스크톱 왼쪽 표)가 위젯 index.ts로 같이 쓴다.
import { type HistoryBadge, type HistoryLinkKind, type HistoryTone, type OrderHistoryEntry } from '@/entities/account';
import { getPerformance } from '@/entities/performance';
import { formatWon, getProduction } from '@/entities/production';

/** 탭 값: 전체 · 예매 · 굿즈(부가 상품 포함) */
export type OrderTab = 'all' | 'ticket' | 'goods';
export const ORDER_TABS: readonly { value: OrderTab; label: string }[] = [
  { value: 'all', label: '전체' },
  { value: 'ticket', label: '예매' },
  { value: 'goods', label: '굿즈' },
];

/** 둘째 줄 조각. amount가 있으면 글 뒤에 숫자 글꼴(.num)로 붙인다 */
export interface RowPart {
  text?: string;
  amount?: number;
}

export interface RowLink {
  label: string;
  href: string;
}

export interface OrderRow {
  id: string;
  href: string;
  kind: OrderHistoryEntry['kind'];
  kindLabel: string;
  number: string;
  orderedText: string;
  title: string;
  /** 카드 둘째 줄(금액 포함) */
  cardParts: RowPart[];
  /** 표 둘째 줄(종류 먼저, 금액은 따로 칸) */
  tableParts: RowPart[];
  amount: number;
  badges: readonly HistoryBadge[];
  note?: string;
  link?: RowLink;
  alert?: { text: string; link: RowLink };
}

export const orderHref = (id: string) => `/my/orders/${id}`;

const KIND_LABEL: Record<OrderHistoryEntry['kind'], string> = { ticket: '예매', goods: '굿즈', addon: '부가 상품' };

export function badgeClass(tone: HistoryTone, large = false): string {
  const t = tone === 'neutral' ? '' : ` badge-${tone}`;
  return `badge${t}${large ? ' badge-lg' : ''}`;
}

function linkFor(kind: HistoryLinkKind, id: string): RowLink {
  switch (kind) {
    case 'deposit':
      return { label: '입금 안내 보기', href: orderHref(id) };
    case 'tracking':
      return { label: '배송 조회', href: `${orderHref(id)}#ship` };
    case 'voucher':
      return { label: '교환권', href: `${orderHref(id)}#pickup` };
    case 'refund-account':
      return { label: '환불 계좌 입력', href: '/my/refunds/rfd-0001/account' };
    case 'compensation':
      return { label: '배상금 계좌 입력', href: '/my/compensations/cmp-0001' };
  }
}

/** 공연(티켓·부가 상품) 회차 글 */
function roundLabel(performanceId?: string, fallback?: string): string | undefined {
  return (performanceId ? getPerformance(performanceId)?.label : undefined) ?? fallback;
}

export function toRow(e: OrderHistoryEntry): OrderRow {
  const kindLabel = KIND_LABEL[e.kind];
  let title: string;
  let middle: RowPart[];
  let tail: RowPart[] = [];
  if (e.kind === 'ticket') {
    title = getProduction(e.productionId)?.title ?? '공연';
    middle = [{ text: roundLabel(e.performanceId) }, { text: `${e.grade ? `${e.grade} ` : ''}${e.quantity}매` }];
    tail = e.extra ? [e.extra] : [];
  } else {
    title = e.itemTitle;
    middle = [{ text: roundLabel(e.performanceId, e.roundText) }, { text: e.option }, { text: `${e.quantity}${e.kind === 'addon' ? '매' : '개'}` }];
    tail = [{ text: e.delivery }];
  }
  const keep = (parts: RowPart[]) => parts.filter((p) => p.text || p.amount !== undefined);
  // 보드: 굿즈 카드는 '1개 · ₩39,000 · 택배'(금액이 수량 뒤), 티켓 카드는 '회차 · 1매 · ₩110,000 · 환급 예정 ₩6,600'
  const cardParts = keep([...middle, { amount: e.amount }, ...tail]);
  const tableParts = keep([{ text: kindLabel }, ...middle, ...tail]);
  const alert = e.alert
    ? {
        text: e.alert.amount ? `${e.alert.amount.label} ${formatWon(e.alert.amount.value)} · ${e.alert.text}` : e.alert.text,
        link: linkFor(e.alert.link, e.id),
      }
    : undefined;
  return {
    id: e.id,
    href: orderHref(e.id),
    kind: e.kind,
    kindLabel,
    number: e.number,
    orderedText: e.orderedText,
    title,
    cardParts,
    tableParts,
    amount: e.amount,
    badges: e.badges,
    note: e.note,
    link: e.link ? linkFor(e.link, e.id) : undefined,
    alert,
  };
}

export function inTab(tab: OrderTab, e: { kind: OrderHistoryEntry['kind'] }): boolean {
  if (tab === 'all') return true;
  return tab === 'ticket' ? e.kind === 'ticket' : e.kind !== 'ticket';
}

export function tabCounts(entries: readonly { kind: OrderHistoryEntry['kind'] }[]): Record<OrderTab, number> {
  return {
    all: entries.length,
    ticket: entries.filter((e) => inTab('ticket', e)).length,
    goods: entries.filter((e) => inTab('goods', e)).length,
  };
}
