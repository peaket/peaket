// 판매자(파트너) 신원정보 7항목 목업(d5 §5.2 ⑯ 판매자 정보, §10.3 "판매자 신원정보 7항목은 '예시' 값").
export interface Seller {
  id: string;
  /** 상호 */
  name: string;
  representative: string;
  address: string;
  phone: string;
  email: string;
  businessNo: string;
  /** 통신판매업 신고번호 */
  mailOrderNo: string;
}

export const SELLERS: readonly Seller[] = [
  {
    id: 'sel-stella',
    name: '(주)스텔라엔터테인먼트',
    representative: '예시 대표',
    address: '서울특별시 가상구 예시로 1 (예시)',
    phone: '02-0000-0000 (예시)',
    email: 'seller@example.com',
    businessNo: '000-00-00000 (예시)',
    mailOrderNo: '제2026-서울가상-0000호 (예시)',
  },
  {
    id: 'sel-starlight',
    name: '(주)별빛문화',
    representative: '예시 대표',
    address: '서울특별시 가상구 예시로 2 (예시)',
    phone: '02-0000-0001 (예시)',
    email: 'seller2@example.com',
    businessNo: '000-00-00001 (예시)',
    mailOrderNo: '제2026-서울가상-0001호 (예시)',
  },
];

export function getSeller(id: string): Seller | undefined {
  return SELLERS.find((s) => s.id === id);
}
