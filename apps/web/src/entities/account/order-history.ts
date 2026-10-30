// SCR-055 예매·주문 내역 목업. 캔버스 보드 SCR-055-m·t·d의 주문 19건(전체 탭 10건 + 굿즈 탭 10건, 응원봉은 겹친다)과 상세 셋
// (예매 확인서 2026101400123 · 주문 확인서 2026102100056 · 입금 오류 2026102200118)을 옮겼다. 보드의 [금액]·[회차]·[은행]·[주소]는 합성 값이다.
// 공연 이름·회차 글은 페이지가 entities(production·performance)에서 읽는다(entities끼리는 가져오지 않는다). 금액은 원 단위 정수.
// 경로 id: entities/order ORDERS의 일곱 id는 상태가 같은 줄에 붙였다(표시 값은 보드 값). 나머지는 주문번호로 만든 id다.
import { BANKS } from './model';

export type HistoryKind = 'ticket' | 'goods' | 'addon';
/** 배지 색(키트 .badge 변형). 상태는 늘 글자로도 보인다 */
export type HistoryTone = 'neutral' | 'primary' | 'success' | 'warning' | 'outline';

export interface HistoryBadge {
  text: string;
  tone: HistoryTone;
}

/** 카드·표의 링크 종류. 페이지가 이름과 주소로 바꾼다 */
export type HistoryLinkKind = 'deposit' | 'tracking' | 'voucher' | 'refund-account' | 'compensation';

/** 취소·환불 이력 한 건(CMP-054 RefundQuote ticket 이력) */
export interface HistoryRefund {
  /** 'R구역 12열 8번' */
  target: string;
  badge: HistoryBadge;
  receivedText: string;
  paid: number;
  /** 공제율(%). 0이면 공제 없음 */
  feeRate: number;
  refund: number;
  /** '환급 예정' · '환급함' */
  dueLabel: string;
  dueText: string;
  methodText: string;
  note: string;
}

interface HistoryBase {
  /** 경로 id(/my/orders/[orderId]) */
  id: string;
  /** 화면에 보이는 주문번호 13자리 */
  number: string;
  /** 주문일 '10/22(목)' */
  orderedText: string;
  badges: readonly HistoryBadge[];
  amount: number;
  quantity: number;
  /** 둘째 줄 아래 안내 문장 */
  note?: string;
  /** 카드 아래·상태 칸의 링크 */
  link?: HistoryLinkKind;
  /** 경고 줄(⚠ 환불 계좌 입력 필요)과 그 링크. amount가 있으면 '배상금 ₩15,400 · 계좌 입력 필요'처럼 앞에 붙인다 */
  alert?: { text: string; link: HistoryLinkKind; amount?: { label: string; value: number } };
  /** 결제 수단(카드는 끝 4자리) */
  methodText: string;
}

export interface TicketHistory extends HistoryBase {
  kind: 'ticket';
  productionId: string;
  performanceId: string;
  /** 'A석'(스탠딩처럼 보드가 등급을 보이지 않으면 없음) */
  grade?: string;
  /** 둘째 줄 끝에 붙는 글(입금 기한·환급 예정) */
  extra?: { text: string; amount?: number };
  /** 좌석이 확정되어 '예매 확인서'로 보이는 주문 */
  confirmed: boolean;
  seats?: string;
  /** 매수 칸 글(없으면 'N매') */
  quantityText?: string;
  /** 입장 게이트 */
  gate?: string;
  /** 티켓 보기·예매 취소가 가는 티켓(entities/ticket) */
  ticketId?: string;
  cancellable?: boolean;
  refunds?: readonly HistoryRefund[];
  /** 가상계좌 입금 안내. 계좌는 끝 4자리만 보인다 */
  vbank?: { bank: string; last4: string; deadlineText: string; errorDeadlineText: string };
}

export interface GoodsHistory extends HistoryBase {
  kind: 'goods' | 'addon';
  itemTitle: string;
  sellerId: string;
  /** 'L' */
  option?: string;
  /** 부가 상품이 딸린 회차(entities/performance) */
  performanceId?: string;
  /** 지난 회차처럼 목업 회차가 없을 때의 글 */
  roundText?: string;
  delivery: '택배' | '현장 수령' | '월렛 이용권' | '현장';
  /** 결제대금예치(POL-014) */
  escrow?: boolean;
  /** 받는 분 휴대폰 끝 4자리와 배송지(합성) */
  shipping?: { phoneLast4: string; address: string };
  pickup?: { place: string; slot: string };
  /** 반품 기한 줄과 단순 변심 반품 배송비 */
  returnInfo?: { dueText: string; fee: number };
}

export type OrderHistoryEntry = TicketHistory | GoodsHistory;

const bank = (value: string) => BANKS.find((b) => b.value === value)?.label ?? '은행';

const B = {
  checking: { text: '결제 확인 중', tone: 'warning' },
  issuing: { text: '결제 완료 · 티켓 발급 중', tone: 'primary' },
  deposit: { text: '입금 대기', tone: 'neutral' },
  delivered: { text: '배송 완료', tone: 'success' },
  escrow: { text: '결제대금예치', tone: 'outline' },
  expired: { text: '주문 취소됨', tone: 'neutral' },
  held: { text: '환급 보류', tone: 'warning' },
  refunded: { text: '취소·환불 완료', tone: 'neutral' },
  paid: { text: '결제 완료', tone: 'success' },
  voided: { text: '결제 취소(발권 불가)', tone: 'neutral' },
  partial: { text: '일부 취소', tone: 'neutral' },
} as const satisfies Record<string, HistoryBadge>;

/** 배송 준비(발송 전) 배지. 굿즈 주문 취소 확인 상태에서 대표 굿즈 주문이 이 배지로 바뀐다 */
export const GOODS_READY_BADGE: HistoryBadge = { text: '배송 준비', tone: 'neutral' };

const ADDRESS = '서울특별시 가상구 예시로 10, 101동 1001호 (예시)';
const RETURN_DUE = '반품은 10/30까지(받은 날부터 7일). 상품이 설명과 다르면 받은 날부터 3개월 안에 요청할 수 있습니다.';

/** 주문일 최신순 */
export const ORDER_HISTORY: readonly OrderHistoryEntry[] = [
  {
    id: 'ord-20261016-0003',
    number: '2026102200231',
    kind: 'ticket',
    orderedText: '10/22(목)',
    productionId: 'prd-lumen',
    performanceId: 'evt-lumen-1025',
    grade: 'A석',
    quantity: 1,
    amount: 110000,
    badges: [B.checking],
    note: '결과가 확정되면 알림으로 보내 드립니다. 중복 청구는 없습니다',
    methodText: '카드(끝 1234)',
    confirmed: false,
  },
  {
    id: 'ord-20261014-0002',
    number: '2026102200207',
    kind: 'ticket',
    orderedText: '10/22(목)',
    productionId: 'prd-lumen',
    performanceId: 'evt-lumen-1025',
    grade: 'S석',
    quantity: 1,
    amount: 132000,
    badges: [B.issuing],
    note: '발급되면 알림으로 알려 드립니다',
    methodText: '카드(끝 1234)',
    confirmed: false,
    seats: 'S구역 3열 15번',
  },
  {
    id: 'ord-20261020-0008',
    number: '2026102200118',
    kind: 'ticket',
    orderedText: '10/22(목)',
    productionId: 'prd-fest',
    performanceId: 'evt-fest-1107',
    quantity: 2,
    amount: 198000,
    badges: [B.deposit],
    note: `가상계좌 ${bank('woori')} · 입금 기한 10/23(금) 23:59`,
    link: 'deposit',
    methodText: '가상계좌',
    confirmed: false,
    vbank: { bank: 'woori', last4: '4321', deadlineText: '10/23(금) 23:59', errorDeadlineText: '10/23 23:59' },
  },
  {
    id: 'ord-20261018-0010',
    number: '2026102100056',
    kind: 'goods',
    orderedText: '10/21(수)',
    itemTitle: 'LUMEN 공식 응원봉',
    sellerId: 'sel-stella',
    quantity: 1,
    amount: 39000,
    delivery: '택배',
    badges: [B.delivered, B.escrow],
    link: 'tracking',
    methodText: '계좌이체',
    escrow: true,
    shipping: { phoneLast4: '5678', address: ADDRESS },
    returnInfo: { dueText: RETURN_DUE, fee: 3000 },
  },
  {
    id: 'ord-20261019-0031',
    number: '2026101900031',
    kind: 'goods',
    orderedText: '10/19(월)',
    itemTitle: 'LUMEN 투어 티셔츠',
    sellerId: 'sel-stella',
    option: 'L',
    quantity: 1,
    amount: 45000,
    delivery: '현장 수령',
    badges: [{ text: '수령 대기 10/25 16:00~17:00', tone: 'primary' }],
    link: 'voucher',
    methodText: '카드(끝 1234)',
    pickup: { place: '피켓 아레나 굿즈 부스', slot: '10/25(일) 16:00~17:00' },
  },
  {
    id: 'ord-20261019-0032',
    number: '2026101900032',
    kind: 'addon',
    orderedText: '10/19(월)',
    itemTitle: 'LUMEN 콘서트 주차권 · 10/25(일)',
    sellerId: 'sel-stella',
    quantity: 1,
    amount: 15000,
    delivery: '월렛 이용권',
    badges: [{ text: '사용 가능', tone: 'success' }],
    methodText: '카드(끝 1234)',
  },
  {
    id: 'ord-20261018-0064',
    number: '2026101800064',
    kind: 'ticket',
    orderedText: '10/18(일)',
    productionId: 'prd-fest',
    performanceId: 'evt-fest-1107',
    quantity: 2,
    amount: 198000,
    extra: { text: '입금 기한 10/19(월) 23:59' },
    badges: [B.expired],
    note: '입금 기한이 지나 주문이 취소되고 좌석이 풀렸습니다',
    methodText: '가상계좌',
    confirmed: false,
  },
  {
    id: 'ord-20261012-0004',
    number: '2026101600077',
    kind: 'ticket',
    orderedText: '10/16(금)',
    productionId: 'prd-musical',
    performanceId: 'evt-musical-1101',
    quantity: 1,
    amount: 66000,
    extra: { text: '환급 예정', amount: 6600 },
    badges: [B.held],
    alert: { text: '환불 계좌 입력 필요', link: 'refund-account' },
    methodText: '가상계좌',
    confirmed: true,
    seats: '2열 7번',
    ticketId: 'tkt-musical-0207',
    refunds: [
      {
        target: '2열 7번',
        badge: B.held,
        receivedText: '11/1(일) 14:20',
        paid: 66000,
        feeRate: 90,
        refund: 6600,
        dueLabel: '환급 예정',
        dueText: '환불 계좌를 입력하면 3영업일 안에',
        methodText: '입력한 환불 계좌',
        note: '공연 당일 취소라 입장료의 90%를 공제하고 환급합니다(소비자분쟁해결기준). 가상계좌로 결제해 환불 계좌가 필요합니다',
      },
    ],
  },
  {
    id: 'ord-20261016-0081',
    number: '2026101600081',
    kind: 'addon',
    orderedText: '10/16(금)',
    itemTitle: '패스트 트랙 · 소극장 뮤지컬',
    sellerId: 'sel-stella',
    performanceId: 'evt-musical-1101',
    quantity: 1,
    amount: 20000,
    delivery: '현장',
    badges: [{ text: '입장 시작, 취소 불가', tone: 'neutral' }],
    methodText: '카드(끝 1234)',
  },
  {
    id: 'ord-20261015-0044',
    number: '2026101500044',
    kind: 'goods',
    orderedText: '10/15(목)',
    itemTitle: 'LUMEN 포토카드 세트',
    sellerId: 'sel-stella',
    quantity: 1,
    amount: 18000,
    delivery: '택배',
    badges: [{ text: '반품 요청', tone: 'warning' }],
    methodText: '카드(끝 1234)',
    shipping: { phoneLast4: '5678', address: ADDRESS },
  },
  {
    id: 'ord-20261014-0342',
    number: '2026101400342',
    kind: 'ticket',
    orderedText: '10/14(수)',
    productionId: 'prd-lumen',
    performanceId: 'evt-lumen-1026',
    grade: 'R석',
    quantity: 1,
    amount: 154000,
    badges: [B.refunded],
    note: '주최 측 사정으로 공연이 취소되었습니다',
    alert: { text: '계좌 입력 필요', link: 'compensation', amount: { label: '배상금', value: 15400 } },
    methodText: '카드(끝 1234)',
    confirmed: true,
    seats: 'R구역 3열 5번',
    refunds: [
      {
        target: 'R구역 3열 5번',
        badge: { text: '환급 완료', tone: 'success' },
        receivedText: '10/24(토) 10:00',
        paid: 154000,
        feeRate: 0,
        refund: 154000,
        dueLabel: '환급함',
        dueText: '10/27(화)',
        methodText: '결제한 카드(끝 1234)',
        note: '주최 측 사정으로 공연이 취소되어 공제 없이 전액 환급했습니다',
      },
    ],
  },
  {
    id: 'ord-20261014-0205',
    number: '2026101400205',
    kind: 'ticket',
    orderedText: '10/14(수)',
    productionId: 'prd-lumen',
    performanceId: 'evt-lumen-1025',
    grade: 'S석',
    quantity: 1,
    amount: 132000,
    badges: [B.paid],
    methodText: '카드(끝 5678)',
    confirmed: true,
    seats: 'S구역 5열 21번',
    gate: '동문',
  },
  {
    id: 'ord-20261008-0009',
    number: '2026101400187',
    kind: 'ticket',
    orderedText: '10/14(수)',
    productionId: 'prd-lumen',
    performanceId: 'evt-lumen-1025',
    grade: 'S석',
    quantity: 1,
    amount: 132000,
    badges: [B.voided],
    note: '티켓을 발급하지 못해 결제를 취소(환불)했습니다',
    methodText: '카드(끝 1234)',
    confirmed: false,
  },
  {
    id: 'ord-20261014-0001',
    number: '2026101400123',
    kind: 'ticket',
    orderedText: '10/14(수)',
    productionId: 'prd-lumen',
    performanceId: 'evt-lumen-1025',
    grade: 'R석',
    quantity: 2,
    amount: 308000,
    badges: [B.partial],
    note: '12열 8번 취소 · 환급 ₩123,200 진행 중',
    methodText: '카드(끝 1234)',
    confirmed: true,
    seats: 'R구역 12열 7번 · 8번(취소)',
    quantityText: '2매(1매 취소)',
    gate: '동문',
    ticketId: 'tkt-lumen-r1-0312',
    cancellable: true,
    refunds: [
      {
        target: 'R구역 12열 8번',
        badge: { text: '환급 진행 중', tone: 'primary' },
        receivedText: '10/20(화) 14:12',
        paid: 154000,
        feeRate: 20,
        refund: 123200,
        dueLabel: '환급 예정',
        dueText: '10/23(금)까지(3영업일)',
        methodText: '결제한 카드(끝 1234)',
        note: '공연 5일 전이라 입장료의 20%를 공제하고 환급합니다(소비자분쟁해결기준)',
      },
    ],
  },
  {
    id: 'ord-20261012-0019',
    number: '2026101200019',
    kind: 'goods',
    orderedText: '10/12(월)',
    itemTitle: 'LUMEN 투어 후드',
    sellerId: 'sel-stella',
    quantity: 1,
    amount: 69000,
    delivery: '택배',
    badges: [{ text: '반품 도착 확인 중', tone: 'warning' }],
    methodText: '카드(끝 1234)',
    shipping: { phoneLast4: '5678', address: ADDRESS },
  },
  {
    id: 'ord-20261008-0027',
    number: '2026100800027',
    kind: 'goods',
    orderedText: '10/8(목)',
    itemTitle: 'LUMEN 공식 응원봉',
    sellerId: 'sel-stella',
    roundText: '9/27(일) 18:00',
    quantity: 1,
    amount: 39000,
    delivery: '현장 수령',
    badges: [{ text: '미수령 취소', tone: 'neutral' }],
    methodText: '카드(끝 1234)',
    pickup: { place: '피켓 아레나 굿즈 부스', slot: '9/27(일) 16:00~17:00' },
  },
  {
    id: 'ord-20261008-0026',
    number: '2026100800026',
    kind: 'goods',
    orderedText: '10/8(목)',
    itemTitle: 'LUMEN 투어 티셔츠',
    sellerId: 'sel-stella',
    roundText: '9/27(일) 18:00',
    option: 'S',
    quantity: 1,
    amount: 45000,
    delivery: '현장 수령',
    badges: [{ text: '수령함', tone: 'success' }],
    methodText: '카드(끝 1234)',
    pickup: { place: '피켓 아레나 굿즈 부스', slot: '9/27(일) 16:00~17:00' },
  },
  {
    id: 'ord-20261007-0021',
    number: '2026100700021',
    kind: 'goods',
    orderedText: '10/7(수)',
    itemTitle: 'LUMEN 포토카드 세트',
    sellerId: 'sel-stella',
    quantity: 1,
    amount: 18000,
    delivery: '택배',
    badges: [{ text: '반품 확인 중(분쟁)', tone: 'warning' }],
    methodText: '카드(끝 1234)',
    shipping: { phoneLast4: '5678', address: ADDRESS },
  },
  {
    id: 'ord-20261005-0012',
    number: '2026100500012',
    kind: 'goods',
    orderedText: '10/5(월)',
    itemTitle: 'LUMEN 투어 티셔츠',
    sellerId: 'sel-stella',
    option: 'M',
    quantity: 1,
    amount: 45000,
    delivery: '택배',
    badges: [B.refunded],
    methodText: '카드(끝 1234)',
    shipping: { phoneLast4: '5678', address: ADDRESS },
  },
];

/** 상세 상태마다 보드가 그린 대표 주문 */
export const ORDER_HISTORY_DEMO = {
  /** 예매 확인서(일부 취소) = DEMO_ORDER_ID */
  ticket: 'ord-20261014-0001',
  /** 주문 확인서(굿즈 택배·결제대금예치) */
  goods: 'ord-20261018-0010',
  /** 입금 오류(가상계좌 입금 대기) */
  vbank: 'ord-20261020-0008',
} as const;

export function getOrderHistory(id: string): OrderHistoryEntry | undefined {
  return ORDER_HISTORY.find((o) => o.id === id);
}
