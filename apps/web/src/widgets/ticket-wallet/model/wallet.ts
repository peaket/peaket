// SCR-013 마이 티켓(월렛) 목업과 상태 → 보이는 것. 보드 SCR-013-m의 renderVals() 분기를 그대로 옮겼다.
// 표시 글(좌석·게이트·예매번호·QR 티켓 ID·남은 시간)은 보드 글 그대로다. 티켓 id는 entities/ticket과 맞췄고,
// 보드의 받은 티켓(10/26 S구역 4열 11번)은 entities에 없어 이 파일에 둔다. 시각은 KST 표기.
import type { Scr013DetailState } from '@/shared/config/screens.booking';

export type WalletState = Scr013DetailState | '빈 화면';

/** 펼친 첫 티켓(E-1 LUMEN 10/25, 보드 t1) */
export const T1 = {
  id: 'tkt-lumen-r1-0312',
  orderId: 'ord-20261014-0001',
  performanceId: 'evt-lumen-1025',
  title: 'LUMEN 콘서트 2026 서울',
  whenText: '10/25(일) 18:00',
  venueName: '피켓 아레나',
  seat: 'R구역 12열 7번',
  gate: '동문',
  gateOpenText: '16:30',
  bookingNo: '2026101400123',
  /** QR 대체 텍스트의 티켓 식별자 */
  qrTicketId: 'T-48213-01',
  addon: '주차권 1매',
  transferDeadlineText: '10/25(일) 16:00',
  /** 일정 변경 뒤 새 일정 */
  postponedText: '10/31 18:00',
  enteredText: '19:02',
} as const;

/** 같은 주문의 12열 8번(보드 t2, 양도 요청 중) */
export const T2 = {
  id: 'tkt-lumen-r1-0313',
  seat: 'R구역 12열 8번',
  /** 받는 사람(가린 이름) */
  toMasked: '하*',
  remainingText: '47시간 12분',
  acceptDeadlineText: '10/24(토) 15:20',
} as const;

/** 받은 티켓(보드 t3). 보낸 분 '하늘' */
export const T3 = {
  id: 'tkt-lumen-s4-0411',
  performanceId: 'evt-lumen-1026',
  whenText: '10/26(월) 17:00',
  seat: 'S구역 4열 11번',
  gate: '서문',
  from: '하늘',
  // 추천안: 보드의 '[티켓 ID]' 자리 표시를 목업 식별자로 채웠다
  qrTicketId: 'T-48317-04',
} as const;

/** 지난 공연(보드 t9) */
export const PAST = {
  id: 'tkt-old-0001',
  title: '소극장 뮤지컬',
  // 추천안: 보드의 '[지난 회차 일시]' 자리 표시를 목업 일시로 채웠다
  whenText: '10/11(일) 19:30',
  venueName: '피켓 아레나',
  gate: '동문',
  enteredText: '19:02',
} as const;

export const WALLET = {
  lastSyncOffline: '10/25 09:12',
  /** QR 아래 '지금 시:분:초'(보드 값). 미리보기에서는 이 시각부터 센다 */
  nowText: '15:42:08',
  nowStaleText: '15:42:31',
  /** 부스 코드(10분). 추천안: 보드의 '[부스 코드 8자]'를 목업 코드로 채웠다 */
  boothCode: 'K7QD-2M9X',
  boothRemainText: '9:41',
  boothRemainLabel: '9분 41초',
} as const;

/** 지갑 안 티켓 id(펼침 경로가 받는 id) */
export const WALLET_TICKET_IDS: readonly string[] = [T1.id, T2.id, T3.id, PAST.id];

export interface WalletView {
  empty: boolean;
  offline: boolean;
  /** 첫 티켓 펼침 카드 */
  t1Open: boolean;
  /** 첫 티켓이 접힌 카드로 바뀐 상태(받은 티켓을 펼쳤을 때) */
  t1Closed: boolean;
  t1CancelReq: boolean;
  t1EvtCancel: boolean;
  t1Postponed: boolean;
  t1Entered: boolean;
  t1CancelVoid: boolean;
  t1Refunded: boolean;
  t1BadgeOk: boolean;
  showQr: boolean;
  qrStale: boolean;
  noKey: boolean;
  keyBtn: boolean;
  keyIos: boolean;
  keyRevoked: boolean;
  lostAfter: boolean;
  boothBtn: boolean;
  boothLimit: boolean;
  boothMismatch: boolean;
  lostBefore: boolean;
  reissueBtn: boolean;
  reissueLimit: boolean;
  boothCode: boolean;
  actNormal: boolean;
  actOffline: boolean;
  actAfter: boolean;
  /** 12열 8번 양도 요청 카드 */
  show8: boolean;
  recvClosed: boolean;
  recvOpen: boolean;
  recvReclaimed: boolean;
  /** 부스 재발급 대조 동의 시트·대화상자를 연 채로 그린다 */
  consentOpen: boolean;
  /**
   * 데스크톱(lg)에서 QR 자리에 '입장 QR은 휴대폰에서 등록하세요'를 보일지(d3 SCR-013 '데스크톱으로 보이면 휴대폰 등록 안내를 먼저').
   * 추천안: 보드 d의 기본이 이 모양이라 기본·키 없음·키 폐기 뒤에만 쓴다. 15초 지남·오프라인처럼 QR이 있다는 상태는 lg에서도 QR을 그린다.
   */
  desktopGuide: boolean;
}

export function walletView(st: WalletState): WalletView {
  const base = st === '기본(QR 펼침)';
  const nokey = st === '키 없음';
  const off = st === '오프라인';
  const recv = st === '받은 티켓';
  const lost = st === '저장소 유실 · 입장 시작 뒤';
  const lostB = st === '저장소 유실 · 입장 시작 전';
  const booth = st === '부스 코드(10분)';
  const creq = st === '취소 접수됨';
  const ecan = st === '공연 취소됨';
  const empty = st === '빈 화면';
  const stale = st === 'QR 15초 지남';
  const ios = st === '키 없음 · iOS 브라우저 탭';
  const revk = st === '키 없음 · 키 폐기 뒤';
  const rLimit = st === '재발급 한도';
  const bLimit = st === '부스 요청 한도';
  const bMis = st === '부스 대조 불일치';
  const post = st === '일정 변경';
  const entered = st === '입장함·퇴장함';
  const cvoid = st === '취소 무효·회수됨';
  const refd = st === '환급됨';
  const anyKeyless = nokey || ios || revk;
  const anyLost = lost || bLimit || bMis;
  const other = recv || creq || ecan || post || entered || cvoid || refd;
  return {
    empty,
    offline: off,
    t1Open: !empty && !other,
    t1Closed: recv,
    t1CancelReq: creq,
    t1EvtCancel: ecan,
    t1Postponed: post,
    t1Entered: entered,
    t1CancelVoid: cvoid,
    t1Refunded: refd,
    t1BadgeOk: base || off || stale,
    showQr: base || off || stale,
    qrStale: stale,
    noKey: anyKeyless,
    keyBtn: nokey || revk,
    keyIos: ios,
    keyRevoked: revk,
    lostAfter: anyLost,
    boothBtn: lost,
    boothLimit: bLimit,
    boothMismatch: bMis,
    lostBefore: lostB || rLimit,
    reissueBtn: lostB,
    reissueLimit: rLimit,
    boothCode: booth,
    actNormal: base || anyKeyless || lostB || rLimit || stale,
    actOffline: off,
    actAfter: anyLost || booth,
    show8: base || anyKeyless || recv || lostB || rLimit || stale,
    recvClosed: !empty && !recv && !cvoid,
    recvOpen: recv,
    recvReclaimed: cvoid,
    consentOpen: lost,
    desktopGuide: base || nokey || revk,
  };
}
