// 고객 문의 목업(SCR-056 문의하기·내 문의 내역·문의 상세, d5 §5.30). 글은 캔버스 보드 SCR-056 예시 그대로이고 모두 지어낸 것이다.
// 답한 사람은 개인 이름 대신 '피켓 고객센터'로 보인다(ADR-0066). 시각은 KST 표기.

/** 답변 기한 한 줄(d5 §5.30, [가정: 일반 3영업일]). 고객센터와 문의하기가 함께 쓴다 */
export const ANSWER_DUE_TEXT = '답변은 보통 3영업일 안에 드립니다. 분쟁 문의는 진행 경과를 3영업일, 결과를 10영업일 안에 알려 드립니다.';

/** 문의 상태 배지(d5 §5.30 내 문의 내역) */
export type InquiryStatus = '접수됨' | '처리 중' | '답변 완료' | '닫힘';

/** 문의 유형 12개(planning/04 SCR-056 ③, d5 §5.30). '외부 되팔이 게시물 신고'는 2026-10-31에 더했다(FR-069, ADR-0173 결정 9) */
export const INQUIRY_TYPES = [
  '예매·결제',
  '취소·환불(사정이 있어 공제 면제를 요청)',
  '양도',
  '입장·현장',
  '계정',
  '자동화된 결정(추가 검증) 설명·재검토',
  '공연(판매자) 관련 분쟁',
  '미성년자 계약 취소',
  '굿즈·상품',
  '게시물 조치 이의',
  '외부 되팔이 게시물 신고',
  '기타',
] as const;
export type InquiryType = (typeof INQUIRY_TYPES)[number];

/** 유형 → openapi InquiryCategory 값(접수 본문 category에 싣는 값) */
export const INQUIRY_CATEGORY_OF: Readonly<Record<InquiryType, string>> = {
  '예매·결제': 'BOOKING_PAYMENT',
  '취소·환불(사정이 있어 공제 면제를 요청)': 'CANCEL_REFUND',
  양도: 'TRANSFER',
  '입장·현장': 'ENTRY',
  계정: 'ACCOUNT',
  '자동화된 결정(추가 검증) 설명·재검토': 'AUTOMATED_DECISION',
  '공연(판매자) 관련 분쟁': 'SELLER_DISPUTE',
  '미성년자 계약 취소': 'MINOR_CONTRACT_CANCEL',
  '굿즈·상품': 'MERCH',
  '게시물 조치 이의': 'MODERATION_APPEAL',
  '외부 되팔이 게시물 신고': 'RESALE_POST_REPORT',
  기타: 'OTHER',
};

/**
 * '외부 되팔이 게시물 신고'를 고르면 내용 칸 위에 보이는 안내(d5 §5.30, 추천 적용 2026-10-31, ADR-0173 결정 9).
 * 공개 게시물만 받고, 접수만 확인하며 다른 사람의 조사 결과는 알리지 않는다.
 */
export const RESALE_POST_NOTICE =
  'PEAKET 밖 사이트에서 이 공연 표를 웃돈으로 파는 공개 게시물의 주소와 설명을 적어 주세요. 로그인해야 보이는 비공개 모임의 글이나 받은 메시지는 받지 않습니다. 접수만 확인해 드리고, 조사 결과는 알려 드리지 않습니다';

/** 고른 유형의 내용 칸 위 안내(없으면 undefined). 빈 값은 아직 고르지 않음 */
export function inquiryTypeNotice(type: InquiryType | ''): string | undefined {
  return type === '외부 되팔이 게시물 신고' ? RESALE_POST_NOTICE : undefined;
}

/** 목록에 보이는 짧은 유형 이름(괄호 설명을 뺀다) */
export function inquiryTypeShort(t: InquiryType): string {
  return t.replace(/\(.*\)$/, '');
}

/** 문의하기의 '관련 주문' 선택지(값은 주문 id, '' = 선택 안 함) */
export const INQUIRY_ORDER_OPTIONS: readonly { value: string; label: string }[] = [
  { value: '', label: '선택 안 함' },
  { value: 'ord-20261014-0001', label: 'LUMEN 콘서트 2026 서울 · 10/25(일) 18:00 · R석 2매 · 예매번호 2026101400123' },
  { value: 'ord-20261018-0010', label: '굿즈 · LUMEN 공식 응원봉 외 1건 · 주문번호 [예시]' },
];

export interface InquiryMessage {
  kind: '내 문의' | '진행 경과' | '답변';
  /** '10/14(수) 20:31' */
  at: string;
  body: string;
}

export interface Inquiry {
  id: string;
  /** 접수 번호 */
  no: string;
  status: InquiryStatus;
  type: InquiryType;
  title: string;
  /** 접수 날짜(목록) '10/14(수)' */
  submittedDate: string;
  /** 접수 일시(상세) '10/14(수) 20:31' */
  submittedAt: string;
  /** 답변 날짜(목록) */
  answeredDate?: string;
  /** 새 답변(아직 열어 보지 않음) */
  newAnswer?: boolean;
  /** 관련 주문 */
  order?: { id: string; kind: 'ticket' | 'goods'; label: string; short: string; bookingNo?: string };
  /** 분쟁 유형의 두 기한(진행 경과 3영업일·결과 10영업일) */
  dispute?: { progressDue: string; resultDue: string };
  /** 닫힌 날 '10/29(목)' */
  closedDate?: string;
  messages: readonly InquiryMessage[];
}

const LUMEN_ORDER = {
  id: 'ord-20261014-0001',
  kind: 'ticket' as const,
  label: 'LUMEN 콘서트 2026 서울 · 10/25(일) 18:00 · R석 2매 · 예매번호',
  short: 'LUMEN 콘서트 2026 서울',
  bookingNo: '2026101400123',
};

export const INQUIRIES: readonly Inquiry[] = [
  {
    id: 'inq-0001',
    no: 'Q-2610-0042',
    status: '답변 완료',
    type: '취소·환불(사정이 있어 공제 면제를 요청)',
    title: '아이가 아파서 공연 3일 전 취소 수수료를 면제받을 수 있을까요',
    submittedDate: '10/14(수)',
    submittedAt: '10/14(수) 20:31',
    answeredDate: '10/15(목)',
    newAnswer: true,
    order: LUMEN_ORDER,
    messages: [
      {
        kind: '내 문의',
        at: '10/14(수) 20:31',
        body: '10/25(일) 18:00 공연을 예매했는데 아이가 아파서 공연에 가기 어려울 것 같습니다. 공연 3일 전에 취소하면 취소 수수료가 생기는데, 이런 사정이면 면제받을 수 있는지 궁금합니다.',
      },
      { kind: '진행 경과', at: '10/15(목) 11:02', body: '판매자에게 사실 확인을 요청했습니다. 10/27까지 결과를 알려 드립니다.' },
      {
        kind: '답변',
        at: '10/15(목) 15:40',
        body: '확인 결과 공연 3일 전 질병으로 인한 취소는 증빙을 확인한 뒤 수수료를 면제할 수 있습니다. 진단서는 사본을 받지 않고 상담 중 화면으로 확인합니다.',
      },
    ],
  },
  {
    id: 'inq-0002',
    no: 'Q-2610-[예시]',
    status: '처리 중',
    type: '공연(판매자) 관련 분쟁',
    title: '공연 시간이 바뀌었는데 안내를 못 받았습니다',
    submittedDate: '10/14(수)',
    submittedAt: '10/14(수)',
    dispute: { progressDue: '10/16', resultDue: '10/27' },
    messages: [
      {
        kind: '내 문의',
        at: '10/14(수)',
        body: '예매한 공연의 시작 시간이 바뀌었다는 이야기를 들었는데, 문자나 알림으로 안내를 받지 못했습니다. 바뀐 시간과 안내를 받지 못한 이유를 알려 주세요.',
      },
      { kind: '진행 경과', at: '10/15(목) 11:02', body: '판매자에게 사실 확인을 요청했습니다. 10/27까지 결과를 알려 드립니다.' },
    ],
  },
  {
    id: 'inq-0003',
    no: 'Q-2610-0040',
    status: '접수됨',
    type: '굿즈·상품',
    title: '응원봉 배송 예정일이 궁금합니다',
    submittedDate: '10/14(수)',
    submittedAt: '10/14(수) 18:12',
    order: { id: 'ord-20261018-0010', kind: 'goods', label: '굿즈 · LUMEN 공식 응원봉 외 1건', short: '굿즈 · LUMEN 공식 응원봉 외 1건' },
    messages: [{ kind: '내 문의', at: '10/14(수) 18:12', body: '응원봉을 주문했는데 배송 예정일이 언제인지 알고 싶습니다. 공연 전에 받을 수 있을까요?' }],
  },
  {
    id: 'inq-0004',
    no: 'Q-2609-0311',
    status: '닫힘',
    type: '계정',
    title: '카카오와 구글 계정을 합치고 싶어요',
    submittedDate: '9/30(수)',
    submittedAt: '9/30(수) 21:05',
    answeredDate: '10/1(목)',
    closedDate: '10/15(목)',
    messages: [
      { kind: '내 문의', at: '9/30(수) 21:05', body: '카카오로 가입한 계정과 구글로 가입한 계정이 따로 있습니다. 하나로 합칠 수 있나요?' },
      {
        kind: '답변',
        at: '10/1(목) 10:20',
        body: '계정 설정의 로그인 수단에서 다른 계정을 합칠 수 있습니다. 합치기 전에 확인할 항목이 화면에 나오니 순서대로 진행해 주세요.',
      },
    ],
  },
];

/** 대표 문의 id(문의 상세 경로 예시)와 분쟁 문의 id */
export const DEMO_INQUIRY_ID = 'inq-0001';
export const DEMO_DISPUTE_INQUIRY_ID = 'inq-0002';

/** 없는 문의와 남의 문의는 똑같이 undefined(있는지 여부를 알리지 않는다, d5 §5.30) */
export function getInquiry(id: string): Inquiry | undefined {
  return INQUIRIES.find((q) => q.id === id);
}

export function inquiryHref(id: string): string {
  return `/help/inquiries/${encodeURIComponent(id)}`;
}
