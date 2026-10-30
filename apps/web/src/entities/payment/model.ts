// 결제 목업(주문·결제 SCR-011, 결제 복귀, 결제 결과 SCR-012가 읽는다). 값은 캔버스 보드 SCR-011·012의 글 그대로다.
// 금액은 원 단위 정수, 시각은 KST 표기. 데이터 연결 단계에서 주문 생성·결제 시도·결제 결과 응답으로 바뀐다(payment §4).

/** 결제 대행사(ADR-0044): E-1은 토스페이먼츠, 결제사 전환 때 포트원 */
export type PaymentPgKey = 'toss' | 'portone';

export interface CheckoutSeatLine {
  /** 'R구역 12열 7번' */
  seat: string;
  grade: string;
  price: number;
  /** 입장 게이트(결제 결과 티켓 줄) */
  gate: string;
}

export interface CheckoutDemo {
  /** 좌석 요약 한 줄 'R구역 12열 7번, 8번' */
  seatText: string;
  grade: string;
  quantity: number;
  unitPrice: number;
  /** 합계(서버 계산) */
  total: number;
  seats: CheckoutSeatLine[];
  /** 저장된 예매자 정보(합성 값) */
  buyer: { name: string; phone: string };
  /** 입력 오류 상태의 휴대폰 번호(자릿수 모자람) */
  invalidPhone: string;
  /** 홀드 남은 시간(초) — 보드 '5:12' */
  holdRemainingSeconds: number;
  pg: PaymentPgKey;
}

export const CHECKOUT_DEMO: CheckoutDemo = {
  seatText: 'R구역 12열 7번, 8번',
  grade: 'R석',
  quantity: 2,
  unitPrice: 154000,
  total: 308000,
  seats: [
    { seat: 'R구역 12열 7번', grade: 'R석', price: 154000, gate: '입장 게이트 동문' },
    { seat: 'R구역 12열 8번', grade: 'R석', price: 154000, gate: '입장 게이트 동문' },
  ],
  buyer: { name: '지민', phone: '010-1234-5678' },
  invalidPhone: '010-1234-56',
  holdRemainingSeconds: 312,
  pg: 'toss',
};

/** 포트원 결제창에서 고르는 결제수단(d5 §5.11 ⑤. 가상계좌는 고수요 공연에서 숨긴다) */
export const PORTONE_METHODS: readonly { value: string; label: string }[] = [
  { value: 'card', label: '카드' },
  { value: 'easy', label: '간편결제' },
  { value: 'bank', label: '계좌이체' },
];

/** 취소 시점별 공제율(POL-032, 소비자분쟁해결기준 공연업). short는 데스크톱 가로 표의 열 이름 */
export const CANCEL_FEE_ROWS: readonly { when: string; short: string; fee: string }[] = [
  { when: '예매 후 24시간 안', short: '예매 후 24시간', fee: '없음' },
  { when: '관람일 10일 전까지', short: '10일 전까지', fee: '없음' },
  { when: '관람일 9~7일 전', short: '9~7일 전', fee: '10%' },
  { when: '관람일 6~3일 전', short: '6~3일 전', fee: '20%' },
  { when: '관람일 2~1일 전', short: '2~1일 전', fee: '30%' },
  { when: '공연 당일 시작 전까지', short: '당일', fee: '90%' },
];

/** 판매자에게 개인정보 제공 동의(d5 §5.11 ③, 문안은 planning/04 SCR-011 ③). bold는 굵게 보이는 항목(받는 자·목적·보유 기간) */
export function thirdPartyRows(sellerName: string): readonly { term: string; value: string; bold: boolean }[] {
  return [
    { term: '받는 자', value: `${sellerName}(이 공연의 판매자)`, bold: true },
    { term: '목적', value: '공연 당일 현장 운영(예매 확인·좌석 안내)과 공연 진행 안내(일정 지연·현장 변경). 광고·홍보에는 쓰지 않습니다', bold: true },
    { term: '항목', value: '예매자 이름, 휴대폰 번호, 예매번호, 회차·좌석·매수', bold: false },
    { term: '보유 기간', value: '공연(회차)이 끝나고 1개월까지. 회차가 연기되면 바뀐 회차가 끝나고 1개월까지', bold: true },
    {
      term: '거부권과 불이익',
      value: '동의를 거부할 수 있습니다. 판매자가 공연 당일 예매를 확인하는 데 필요해, 동의하지 않으면 이 공연을 예매할 수 없습니다',
      bold: false,
    },
  ];
}

/** 결제 결과(SCR-012)의 확정 주문 */
export const RESULT_DEMO = {
  bookingNo: '2026101400123',
  amount: 308000,
  /** 이 공연 부가 상품 줄(→ SCR-015 티켓 연동) */
  addonText: '주차권 · 응원봉',
} as const;

/** 가상계좌 입금 대기(SCR-012 '입금 대기'·'입금 오류'). d5 §10.3 E-3 소극장 뮤지컬 1매 */
export const VBANK_DEMO = {
  productionTitle: '소극장 뮤지컬',
  /** 보드 머리 둘째 줄 그대로('[회차]'는 보드의 자리 글) */
  subtitle: '[회차] · 1매',
  account: '○○은행 123-45-678',
  amount: 66000,
  dueText: '10/15(목) 23:59',
  /** 입금 오류 문장 안의 짧은 기한 표기 */
  dueShortText: '10/15 23:59',
  bookingNo: '2026101400298',
} as const;

/** 홀드 남은 시간 표시 '5:12'와 낭독 이름 '홀드 남은 시간 5분 12초' */
export function holdTimeText(seconds: number): { text: string; aria: string } {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return { text: `${m}:${String(s).padStart(2, '0')}`, aria: `홀드 남은 시간 ${m}분 ${s}초` };
}
