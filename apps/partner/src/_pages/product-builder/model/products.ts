// SCR-023 상품 빌더 목업. 이름·숫자는 캔버스 보드 SCR-023-m·t·d와 d5 §6.6 예시 5줄 그대로다(합성 데이터).
// 받는 분 이름·연락처·주소는 보드처럼 가린 값만 둔다(동의 범위 항목만 가려서 보임, POL-037).

export type ProductKind = '굿즈' | '티켓 연동 부가 상품';
export type ProductStatus = '판매 중' | '판매 전' | '품절' | '숨김';

export const PRODUCT_STATUS_BADGE: Record<ProductStatus, string> = {
  '판매 중': 'badge badge-success',
  '판매 전': 'badge badge-outline',
  품절: 'badge',
  숨김: 'badge',
};

export interface PartnerProduct {
  id: string;
  name: string;
  kind: ProductKind;
  status: ProductStatus;
  /** 자리 그림 아이콘 */
  icon: 'ic-box' | 'ic-bag';
  /** 굿즈 스토어 목록의 표시 가격(총금액 규칙, d5 §5.15 ⑬) */
  price: { main: string; sub?: string };
  stock: string;
  saleFrom: string;
  saleTo: string;
  /** 연결 공연(없으면 '연결하지 않음') */
  event: string;
  /** 휴대폰 카드의 둘째 줄에 쓰는 짧은 연결 공연 */
  eventShort?: string;
}

export const partnerProducts: readonly PartnerProduct[] = [
  {
    id: 'prd-lightstick',
    name: 'LUMEN 공식 응원봉',
    kind: '굿즈',
    status: '판매 중',
    icon: 'ic-box',
    price: { main: '₩45,000', sub: '택배 배송비 ₩3,000 별도(현장 수령 무료)' },
    stock: '120 / 680',
    saleFrom: '10/7(수) 12:00',
    saleTo: '10/24(토) 23:59',
    event: 'LUMEN 콘서트 2026 서울',
  },
  {
    id: 'prd-tshirt',
    name: 'LUMEN 투어 티셔츠',
    kind: '굿즈',
    status: '판매 중',
    icon: 'ic-bag',
    price: { main: '₩39,000', sub: '택배 배송비 ₩3,000 별도(현장 수령 무료)' },
    stock: '220 / 800',
    saleFrom: '10/7(수) 12:00',
    saleTo: '10/24(토) 23:59',
    event: 'LUMEN 콘서트 2026 서울',
  },
  {
    id: 'prd-photocard',
    name: 'LUMEN 포토카드 세트',
    kind: '굿즈',
    status: '품절',
    icon: 'ic-box',
    price: { main: '배송비 포함 ₩18,000', sub: '상품 ₩15,000 + 배송비 ₩3,000' },
    stock: '0 / 600',
    saleFrom: '10/7(수) 12:00',
    saleTo: '10/24(토) 23:59',
    event: '연결하지 않음',
  },
  {
    id: 'prd-hoodie',
    name: 'LUMEN 투어 후드',
    kind: '굿즈',
    status: '판매 중',
    icon: 'ic-bag',
    price: { main: '배송비 포함 ₩[총액]', sub: '상품 ₩[가격] + 배송비 ₩3,000' },
    stock: '150 / 300',
    saleFrom: '10/7(수) 12:00',
    saleTo: '10/24(토) 23:59',
    event: 'LUMEN 콘서트 2026 서울',
  },
  {
    id: 'prd-parking',
    name: 'LUMEN 콘서트 주차권',
    kind: '티켓 연동 부가 상품',
    status: '판매 전',
    icon: 'ic-box',
    price: { main: '₩20,000' },
    stock: '300 / 300',
    saleFrom: '10/14(수) 20:00',
    saleTo: '10/25(일) 16:30',
    event: 'LUMEN 콘서트 2026 서울 · 10/25(일) 18:00 회차',
  },
];

export function getPartnerProduct(id: string): PartnerProduct | undefined {
  return partnerProducts.find((p) => p.id === id);
}

/* ---------- 굿즈 주문 현황(개인정보 없는 집계) ---------- */

export interface ProductOrderRow {
  name: string;
  soldOut?: boolean;
  orders: number;
  qty: number;
  parcel: number;
  /** 그 상품에 없는 수령 방식은 null('—') */
  pickup: number | null;
  cancels: number;
  returns: number;
}

export const productOrderRows: readonly ProductOrderRow[] = [
  { name: 'LUMEN 공식 응원봉', orders: 360, qty: 560, parcel: 200, pickup: 360, cancels: 9, returns: 2 },
  { name: 'LUMEN 투어 티셔츠', orders: 410, qty: 580, parcel: 222, pickup: 358, cancels: 12, returns: 3 },
  { name: 'LUMEN 포토카드 세트', soldOut: true, orders: 330, qty: 600, parcel: 600, pickup: null, cancels: 8, returns: 3 },
  { name: 'LUMEN 투어 후드', orders: 104, qty: 150, parcel: 150, pickup: null, cancels: 3, returns: 1 },
];

export const productOrderTotals = { orders: 1204, qty: 1890, parcel: 1172, pickup: 718, cancels: 32, returns: 9 };

/** 일자별 주문 건수(10/14는 19:30 KST까지) — 보드 막대 높이에서 읽은 값, 합계 1,204건 */
export const dailyOrders: readonly { date: string; short: string; count: number }[] = [
  { date: '10/7(수)', short: '10/7', count: 420 },
  { date: '10/8(목)', short: '10/8', count: 180 },
  { date: '10/9(금)', short: '10/9', count: 120 },
  { date: '10/10(토)', short: '10/10', count: 140 },
  { date: '10/11(일)', short: '10/11', count: 110 },
  { date: '10/12(월)', short: '10/12', count: 90 },
  { date: '10/13(화)', short: '10/13', count: 64 },
  { date: '10/14(수)', short: '10/14', count: 80 },
];

/* ---------- 배송·반품 처리(택배 주문, 가린 값) ---------- */

export interface ShipOrder {
  no: string;
  item: string;
  recipient: string;
  phone: string;
  address: string;
  status: '배송 준비' | '배송 중' | '배송 완료' | '반품 요청' | '반품 확인 중(분쟁)';
  /** 상태 아래 작은 글 */
  statusNote?: string;
  escrow?: boolean;
  invoice?: string;
  returnInvoice?: string;
  /** 휴대폰 카드 목록에 보이는 줄(보드 SCR-023-m) */
  mobile?: boolean;
}

export const SHIP_STATUS_BADGE: Record<ShipOrder['status'], string> = {
  '배송 준비': 'badge',
  '배송 중': 'badge badge-primary',
  '배송 완료': 'badge badge-success',
  '반품 요청': 'badge badge-warning',
  '반품 확인 중(분쟁)': 'badge badge-warning',
};

export const shipOrders: readonly ShipOrder[] = [
  { no: '2026101400412', item: 'LUMEN 투어 티셔츠 · L · 1개', recipient: '김*수', phone: '010-****-2841', address: '서울특별시 마포구 ****', status: '배송 준비', escrow: true, mobile: true },
  { no: '2026101300298', item: 'LUMEN 포토카드 세트 · 2개', recipient: '이*영', phone: '010-****-7730', address: '경기도 성남시 ****', status: '배송 준비' },
  { no: '2026101200175', item: 'LUMEN 포토카드 세트 · 1개', recipient: '박*준', phone: '010-****-0412', address: '부산광역시 해운대구 ****', status: '배송 중', invoice: '[택배사] 601233457781', mobile: true },
  { no: '2026100900156', item: 'LUMEN 투어 티셔츠 · M · 1개', recipient: '한*결', phone: '010-****-6623', address: '대전광역시 유성구 ****', status: '배송 완료', statusNote: '10/10(토) 받음', invoice: '[택배사] 601233451204' },
  {
    no: '2026100800231',
    item: 'LUMEN 포토카드 세트 · 1개',
    recipient: '최*아',
    phone: '010-****-5568',
    address: '서울특별시 송파구 ****',
    status: '반품 요청',
    statusNote: '단순 변심 · 10/12(월) 요청',
    invoice: '[택배사] 601233449981',
    returnInvoice: '[택배사] 702145530018',
    mobile: true,
  },
  { no: '2026100700087', item: 'LUMEN 투어 티셔츠 · L · 1개', recipient: '정*호', phone: '010-****-1906', address: '인천광역시 연수구 ****', status: '반품 확인 중(분쟁)', statusNote: 'CS 처리함 분쟁 접수', invoice: '[택배사] 601233440126', mobile: true },
];

/** 반품 요청 행(보드에서 고른 행, 반품 거절 대화상자의 대상) */
export const RETURN_ORDER_NO = '2026100800231';

/* ---------- 상품 정산 ---------- */

export interface ProductStatement {
  store: string;
  sales: string;
  refund: string;
  fee: string;
  offset: string;
  payout: string;
  payDate: string;
  disputeBy: string;
}

export const productStatements: readonly ProductStatement[] = [
  { store: '토스페이먼츠 에스크로', sales: '₩3,120,000', refund: '₩0', fee: '₩343,200', offset: '₩0', payout: '₩2,776,800', payDate: '10/16(금)', disputeBy: '10/14(수)' },
  { store: '토스페이먼츠 일반', sales: '₩1,284,000', refund: '₩42,000', fee: '₩136,620', offset: '₩0', payout: '₩1,105,380', payDate: '10/16(금)', disputeBy: '10/14(수)' },
];

/** 정산 기준일(settlement §4.5) */
export const SETTLE_BASIS: readonly { dt: string; dd: string }[] = [
  { dt: '굿즈 택배, 에스크로 주문', dd: '구매 확정일' },
  { dt: '굿즈 택배, 그 밖의 결제', dd: '받은 날부터 7일이 지난 다음 날' },
  { dt: '굿즈 현장 수령', dd: '받은 날부터 7일이 지난 다음 날' },
  { dt: '티켓 연동 부가 상품', dd: '연결 회차가 끝난 다음 날' },
];

/** 지급이 멈추거나 늦어질 때 */
export const PAYOUT_HOLDS: readonly { badge: string; label: string; text: string }[] = [
  {
    badge: 'badge badge-warning',
    label: '이의 처리 중',
    text: '그 정산서만 지급을 멈추고 PEAKET이 확인합니다. 3영업일 안에 진행 상황을, 10영업일 안에 결과를 알립니다. 조정하거나 받아들이지 않아 다시 알릴 때 이의 기간은 1영업일입니다.',
  },
  { badge: 'badge badge-warning', label: '보류', text: 'KYC 필요, 정산 계좌 변경 뒤 3영업일, 결제사 잔액 부족이면 지급을 멈춥니다. 사유가 풀리면 다음 지급 묶음으로 지급합니다.' },
  { badge: 'badge badge-warning', label: '지급일 연기', text: '지급 승인이 늦어지거나 결제사 잔액이 모자라면 지급일을 다음 영업일로 미루고 알립니다.' },
  { badge: 'badge badge-danger', label: '지급 실패', text: '계좌를 확인해 주세요. 확인되면 새 지급 건으로 다시 보냅니다.' },
];

/* ---------- 취소·반품 기준(PEAKET 공통, POL-016 — 판매자가 바꿀 수 없음. 문구는 보드 그대로) ---------- */

export const GOODS_REFUND_RULE =
  '발송 전 취소는 전액 환급 · 받은 날부터 7일 안 반품(단순 변심은 반품 배송비 구매자 부담) · 상품 이상·설명과 다름은 받은 날부터 3개월 안 반품(배송비 판매자 부담) · 현장 수령 미수령은 다음 영업일 자동 취소·전액 환급 · 반품 도착 확인 뒤 3영업일 안 환급';

export const ADDON_REFUND_RULE =
  '연결 회차 입장 시작 전에는 언제든 전액 환급 · 입장 시작 뒤에는 이용이 시작된 것으로 보아 취소 불가 · 연결 티켓이 취소되거나 회차가 취소되면 함께 전액 환급';
