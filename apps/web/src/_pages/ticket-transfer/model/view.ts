// SCR-014 티켓 양도: 상태별로 보이는 구역(캔버스 보드 SCR-014-m renderVals를 그대로 옮겼다)과 보드 고정 글.
// '부정 예매 조사로 잠김'은 보드에 없고 d5 §5.14 상태 표에서 더했다: ③④⑤(받는 분 확인·재인증·확인)와 ⑦ 법정 고지를 숨기고 ①②는 둔다(ADR-0173 결정 3).
import type { Scr014State } from '@/shared/config/screens.booking';

export type TransferSheet = 'reauth' | 'confirm' | 'expired';

export interface TransferView {
  /** 양도 정책·받는 분 확인 구역 */
  form: boolean;
  /** ② 이 티켓의 양도 정책(받는 분 확인 구역과 함께, 그리고 부정 예매 잠김에서도) */
  policy: boolean;
  /** 부정 예매 조사로 잠긴 구성(티켓의 transferLocked 참, d5 §5.14. 409 transfer-locked 뒤도 같다): ③④⑤를 숨긴다 */
  fraudLocked: boolean;
  /** 양도 요청 409 transfer-locked(d5 §9.2): 잠김 구성에 상태 글 대신 §9.2 오류 띠를 보인다 */
  transferLockedError: boolean;
  /** 받는 분 확인 성공(닉네임 일부 카드) */
  rcOk: boolean;
  /** 비회원·본인확인 전 오류 */
  rcNoMember: boolean;
  /** 확인 시도 초과(429) 오류 */
  rcTooMany: boolean;
  /** 법정 고지·보내기 전 확인·[양도 요청 보내기](받는 분을 확인했을 때만) */
  sendSec: boolean;
  /** 요청 보냄 띠·[요청 철회] */
  sent: boolean;
  /** 진행 중인 요청 카드 */
  sentSec: boolean;
  /** 철회 409 */
  wdFail: boolean;
  blockDeadline: boolean;
  blockRecv: boolean;
  blockProduct: boolean;
  /** 양도할 티켓 카드(받은 티켓 상태에서는 받은 티켓 카드가 대신 보인다) */
  ticketCard: boolean;
  /** 티켓 카드의 <사용 가능> 배지 */
  badgeOk: boolean;
  /** 양도 마감 안내 띠 */
  showDeadline: boolean;
  /** 열린 시트 */
  sheet: TransferSheet | null;
}

export function transferView(st: Scr014State): TransferView {
  const reauth = st === '재인증 시트';
  const confirm = st === '양도 확인 시트';
  const expired = st === '재인증 만료';
  const sent = st === '요청 보냄';
  const dead = st === '양도 불가 · 마감 지남';
  const recv = st === '양도 불가 · 받은 티켓';
  const noMem = st === '비회원·본인확인 전';
  const many = st === '확인 시도 초과';
  const wdFail = st === '철회 불가';
  const prod = st === '양도 불가 상품';
  // 409 뒤에는 표가 이미 잠겼으므로 잠김 상태처럼 받는 분 확인·보내기·법정 고지를 숨긴다(FRN-090 재리뷰 결함 B)
  const transferLockedError = st === '오류 · transfer-locked';
  const fraudLocked = st === '부정 예매 조사로 잠김' || transferLockedError;
  const form = st === '받는 사람 확인' || reauth || confirm || expired || noMem || many;
  return {
    form,
    policy: form || fraudLocked,
    fraudLocked,
    transferLockedError,
    rcOk: form && !noMem && !many,
    rcNoMember: noMem,
    rcTooMany: many,
    sendSec: form && !noMem && !many,
    sent,
    sentSec: sent || wdFail,
    wdFail,
    blockDeadline: dead,
    blockRecv: recv,
    blockProduct: prod,
    ticketCard: !recv,
    badgeOk: form || dead,
    showDeadline: form || sent || wdFail || fraudLocked,
    sheet: reauth ? 'reauth' : confirm ? 'confirm' : expired ? 'expired' : null,
  };
}

/** 양도할 티켓의 좌석·게이트(보드 값. 예시 경로 티켓의 seatLabel(7번)과 좌석 번호가 다르다 — 보드를 따른다) */
export const TRANSFER_SEAT = { seat: 'R구역 12열 8번', gate: '게이트 동문' } as const;

/** '양도 불가 · 받은 티켓' 상태의 받은 티켓(보드 값: 10/26 회차 · 보낸 분 '하늘') */
export const RECEIVED_TICKET = { performanceId: 'evt-lumen-1026', seat: 'S구역 4열 11번', from: '하늘' } as const;

/** 받는 분 확인 칸의 예시 값(합성) */
export const RECIPIENT_INPUT_EXAMPLE = '010-0000-0000';
