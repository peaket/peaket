// 파트너 조직(테넌트)·판매자 정보·정산 계좌 목업. 합성 데이터이고 실제 회사·계좌가 아니다(d5 §6.1 그림 예).
// 판매자 정보 7항목은 보드처럼 '[예시]' 자리 표시로 둔다(전자상거래법 §20② 항목 이름만 정본).

export interface SellerProfile {
  companyName: string;
  representative: string;
  address: string;
  phone: string;
  email: string;
  businessNo: string;
  /** 통신판매업 신고번호(또는 면제 근거) */
  mailOrderNo: string;
  /** '10/1' — 마지막 확인일 */
  lastVerifiedAt: string;
}

export interface PayoutAccount {
  bank: string;
  accountMasked: string;
  holder: string;
  holderVerified: boolean;
  /** 지급 보류 요약 */
  hold: string;
}

export interface PartnerOrg {
  id: string;
  name: string;
  seller: SellerProfile;
  payout: PayoutAccount;
  /** 중개수수료율(판매 승인 때 공연에 고정, ADR-0060) */
  commissionRate: string;
  /** 토스페이먼츠 셀러 상태 */
  tossSellerStatus: '승인 필요' | '승인' | '검토 중';
}

export const stellaOrg: PartnerOrg = {
  id: 'org-stella',
  name: '(주)스텔라엔터테인먼트',
  seller: {
    companyName: '(주)스텔라엔터테인먼트',
    representative: '[예시]',
    address: '[예시]',
    phone: '[예시]',
    email: '[예시]',
    businessNo: '[예시]',
    mailOrderNo: '[예시]',
    lastVerifiedAt: '10/1',
  },
  payout: {
    bank: '○○은행',
    accountMasked: '****1234',
    holder: '(주)스텔라엔터테인먼트',
    holderVerified: true,
    hold: '없음',
  },
  commissionRate: '10.00%',
  tossSellerStatus: '승인 필요',
};

/** 판매자 정보 7항목의 표시 순서와 이름 */
export const SELLER_FIELDS: readonly { key: keyof Omit<SellerProfile, 'lastVerifiedAt'>; label: string }[] = [
  { key: 'companyName', label: '상호' },
  { key: 'representative', label: '대표자' },
  { key: 'address', label: '주소' },
  { key: 'phone', label: '전화' },
  { key: 'email', label: '전자우편' },
  { key: 'businessNo', label: '사업자등록번호' },
  { key: 'mailOrderNo', label: '통신판매업 신고번호' },
];
