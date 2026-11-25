// F-07-9 판매자 정보·중개자 고지 한 곳(I-04). 정본은 transfer-refund §2.2·§4, settlement §3·§6,
// POL-037·POL-039다. 법정 고지 원문은 바꾸지 않고, 상호가 비면 접두사를 빼 `판매자: .`가 생기지 않게 한다.

/** POL-037 공연용 중개자 고지. 판매자 상호만 앞에 붙는다. */
const PERFORMANCE_NOTICE =
  'PEAKET은 통신판매중개자로서 이 공연의 당사자가 아닙니다. 공연의 개최·변경·취소에 따른 책임은 판매자에게 있고, 예매 취소와 환불은 PEAKET이 처리합니다';

/** POL-037 상품용 중개자 고지. */
const PRODUCT_NOTICE =
  'PEAKET은 통신판매중개자로서 이 상품 거래의 당사자가 아닙니다. 상품의 제공(배송·이용)과 품질에 따른 책임은 판매자에게 있고, 주문 취소·반품과 환불은 PEAKET이 처리합니다';

export function performanceSellerNotice(sellerName: string): string {
  const name = sellerName.trim();
  return name ? `판매자: ${name}. ${PERFORMANCE_NOTICE}` : PERFORMANCE_NOTICE;
}

export function productSellerNotice(sellerName: string): string {
  const name = sellerName.trim();
  return name ? `판매자: ${name}. ${PRODUCT_NOTICE}` : PRODUCT_NOTICE;
}

export interface SellerDisclosureRow {
  label: string;
  value: string;
}

/** 판매자 정보 화면의 '중개자 지위와 정산' 표. 값이 없으면 빈칸 대신 '확인 필요'로 보인다. */
export function settlementDisclosure(input: { sellerName: string; payoutHolder: string; commissionRate: string }): readonly SellerDisclosureRow[] {
  const sellerName = input.sellerName.trim() || '확인 필요';
  const payoutHolder = input.payoutHolder.trim();
  const commissionRate = input.commissionRate.trim() || '확인 필요';
  return [
    { label: '판매자(정산 받는 곳)', value: sellerName },
    { label: '정산 계좌 예금주', value: `${payoutHolder || '확인 필요'} · 판매자 상호나 대표자와 같아야 합니다` },
    { label: '중개수수료율', value: commissionRate },
    { label: '예매 취소·환불', value: 'PEAKET이 처리하고, 환불은 결제자에게 갑니다' },
    { label: '양도·재판매', value: '양도는 PEAKET이 처리하고, 티켓값 정산은 당사자끼리 합니다. 부정판매는 처벌·과징금 대상입니다' },
  ];
}
