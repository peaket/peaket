// 양도 요청(transfer offer) 목업(티켓 양도 SCR-014·양도 받기 SCR-041이 읽는다). 값은 캔버스 보드 SCR-014·041 그대로다.
// 받는 분에게는 결제 금액·결제자 연락처를 주지 않는다(d2 CMP-059). 받는 분 이름은 닉네임 일부('하*')만 보낸 분에게 보인다.
// 좌석 글은 보드 값('R구역 12열 8번')이다. entities/ticket의 seatLabel(표본 상태용)과 다르다 — 보드를 따른다.
export type TransferOfferStatus = 'offered' | 'accepted' | 'rejected' | 'withdrawn' | 'expired' | 'reclaimed';

export interface TransferOffer {
  id: string;
  /** 보낸 분(결제자)의 티켓 */
  ticketId: string;
  performanceId: string;
  productionId: string;
  /** 보낸 분 표시 이름(받는 분 화면) */
  senderName: string;
  senderInitial: string;
  /** 받는 분 닉네임 일부(보낸 분 화면) */
  recipientMasked: string;
  recipientInitial: string;
  /** 'R구역 12열 8번' */
  seatText: string;
  /** '동문' */
  gateText: string;
  /** 수락 기한(48시간과 양도 마감 중 이른 때) '10/24(토) 15:20' */
  deadlineText: string;
  /** 받는 분이 열었을 때 남은 시간 '46시간 10분' */
  remainingText: string;
  /** 보낸 직후 보낸 분 화면의 남은 시간 '47시간 12분' */
  sentRemainingText: string;
  status: TransferOfferStatus;
}

export const TRANSFER_OFFERS: readonly TransferOffer[] = [
  {
    id: 'ofr-0001',
    ticketId: 'tkt-lumen-r1-0312',
    performanceId: 'evt-lumen-1025',
    productionId: 'prd-lumen',
    senderName: '지민',
    senderInitial: '지',
    recipientMasked: '하*',
    recipientInitial: '하',
    seatText: 'R구역 12열 8번',
    gateText: '동문',
    deadlineText: '10/24(토) 15:20',
    remainingText: '46시간 10분',
    sentRemainingText: '47시간 12분',
    status: 'offered',
  },
];

/** 대표 양도 요청 id(양도 받기 경로 예시) */
export const DEMO_OFFER_ID = 'ofr-0001';

export function getTransferOffer(id: string): TransferOffer | undefined {
  return TRANSFER_OFFERS.find((o) => o.id === id);
}

/** 이 티켓으로 보낸(진행 중인) 양도 요청 */
export function findOfferByTicket(ticketId: string): TransferOffer | undefined {
  return TRANSFER_OFFERS.find((o) => o.ticketId === ticketId);
}

/** 양도 받기(SCR-041) 주소 */
export function transferOfferHref(id: string): string {
  return `/my/transfers/${encodeURIComponent(id)}`;
}
