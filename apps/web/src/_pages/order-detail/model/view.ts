// SCR-055 상세 경로 상태별로 무엇을 보일지(캔버스 보드 SCR-055 renderVals의 isDetail·isGoods·gShip·gReady·showReturn·showOrderCancel·isVerr를 옮겼다).
// 상태가 먼저다: 상태가 그리는 주문 종류와 주소의 주문이 맞으면 주소의 주문을, 다르면 보드가 그린 대표 주문(ORDER_HISTORY_DEMO)을 보인다.
// '굿즈 주문 취소 확인'·'반품 요청'은 보드가 대표 굿즈 주문(응원봉)으로만 그려 늘 그 주문이다.
import {
  getOrderHistory,
  GOODS_READY_BADGE,
  ORDER_HISTORY_DEMO,
  type GoodsHistory,
  type OrderHistoryEntry,
  type TicketHistory,
} from '@/entities/account';
import type { Scr055DetailState } from '@/shared/config/screens.account';

export type GoodsAction = 'return' | 'cancel' | null;

export type DetailView =
  | { kind: 'ticket'; subject: TicketHistory; depositError: boolean }
  | { kind: 'goods'; subject: GoodsHistory; action: GoodsAction; cancelReason: string; dialog: GoodsAction };

/** 주소의 주문으로 처음 보일 상태: 굿즈·부가 상품 주문은 '굿즈 주문 상세' */
export function defaultDetailState(e: OrderHistoryEntry): Scr055DetailState {
  return e.kind === 'ticket' ? '주문 상세' : '굿즈 주문 상세';
}

function demoTicket(id: string): TicketHistory {
  const e = getOrderHistory(id);
  if (!e || e.kind !== 'ticket') throw new Error(`대표 예매 주문 목업이 없습니다: ${id}`);
  return e;
}

function demoGoods(): GoodsHistory {
  const e = getOrderHistory(ORDER_HISTORY_DEMO.goods);
  if (!e || e.kind === 'ticket') throw new Error(`대표 굿즈 주문 목업이 없습니다: ${ORDER_HISTORY_DEMO.goods}`);
  return e;
}

/** 첫 배지(상태)로 고르는 굿즈 행동(POL-016 §1.4: 주문 취소는 발송·수령 전, 부가 상품은 입장 시작 전 / 반품 요청은 받은 뒤 기한 안) */
function goodsAction(g: GoodsHistory): { action: GoodsAction; cancelReason: string } {
  const s = g.badges[0]?.text ?? '';
  if (s === GOODS_READY_BADGE.text) return { action: 'cancel', cancelReason: '발송 전이라' };
  if (s.startsWith('수령 대기')) return { action: 'cancel', cancelReason: '수령 전이라' };
  if (s === '사용 가능') return { action: 'cancel', cancelReason: '입장 시작 전이라' };
  if (g.returnInfo && (s === '배송 중' || s === '배송 완료' || s === '수령함')) return { action: 'return', cancelReason: '' };
  return { action: null, cancelReason: '' };
}

export function detailView(st: Scr055DetailState, entry: OrderHistoryEntry): DetailView {
  if (st === '주문 상세') {
    return { kind: 'ticket', subject: entry.kind === 'ticket' ? entry : demoTicket(ORDER_HISTORY_DEMO.ticket), depositError: false };
  }
  if (st === '입금 오류') {
    return { kind: 'ticket', subject: entry.kind === 'ticket' && entry.vbank ? entry : demoTicket(ORDER_HISTORY_DEMO.vbank), depositError: true };
  }
  if (st === '굿즈 주문 상세') {
    const g = entry.kind === 'ticket' ? demoGoods() : entry;
    return { kind: 'goods', subject: g, ...goodsAction(g), dialog: null };
  }
  const demo = demoGoods();
  if (st === '굿즈 주문 취소 확인') {
    // 보드 gReady: 발송 전(배송 준비)이라 배송 조회가 없다
    const ready: GoodsHistory = { ...demo, badges: [GOODS_READY_BADGE, ...demo.badges.slice(1)], link: undefined };
    return { kind: 'goods', subject: ready, ...goodsAction(ready), dialog: 'cancel' };
  }
  return { kind: 'goods', subject: demo, ...goodsAction(demo), dialog: 'return' };
}
