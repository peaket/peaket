// SCR-011 주문·결제 보드(SCR-011-m·t·d)의 renderVals()를 옮긴 상태 → 화면 조각 표.
import type { PaymentReturnKind } from '@/entities/payment';
import type { SortMode } from '@/entities/production';
import type { Scr011State } from '@/shared/config/screens.booking';

/** 결제 버튼 자리: consent(필수 동의 둘이 다 체크돼야 켜짐) · 그 밖은 이유 있는 비활성이거나 본인확인 버튼 */
export type PayMode = 'consent' | 'sale-paused' | 'pay-paused' | 'no-id' | 'exceeded' | 'expired';
/** 머리·패널의 홀드 타이머 모양 */
export type HoldLook = 'live' | 'paused' | 'expired' | 'none';
/** 결제 프레임: 토스 위젯(준비됨·준비 중) · 포트원 결제창(결제사 전환) */
export type FrameLook = 'toss-ready' | 'toss-loading' | 'portone';

export interface CheckoutView {
  /** 결제창 복귀 뒤 상태면 본문 대신 상태 카드 하나 */
  returnKind: PaymentReturnKind | null;
  hold: HoldLook;
  inputError: boolean;
  salePaused: boolean;
  switchFail: boolean;
  /** 필수 동의 두 개가 처음부터 체크돼 있는지(입력·위젯 준비만 빈 칸) */
  agreed: boolean;
  frame: FrameLook;
  pay: PayMode;
  /** 홀드 만료(결제창 열기 전) 대화상자 */
  expiredDialog: boolean;
  /**
   * ④ 위 warning 상자 '부정 예매 조사로 양도가 잠기는 회차'(d5 §5.11, ADR-0173 결정 3). 이 계정에 이 회차의 PAYER 소명 요청이 있고 lockActive가 참일 때.
   * 결제 버튼은 그대로 쓸 수 있다(주문·결제 API에는 칸을 더하지 않는다)
   */
  fraudLock: boolean;
}

const RETURN_KIND: Partial<Record<Scr011State, PaymentReturnKind>> = {
  '결제창 복귀 · 접수 중': 'accepting',
  '복귀 뒤 새로고침': 'reload',
  '금액 불일치': 'mismatch',
  '이미 진행 중': 'other-tab',
  '예매 제한(주문 생성 403)': 'restricted',
};

export function checkoutView(state: Scr011State): CheckoutView {
  const fresh = state === '입력' || state === '위젯 준비';
  const switched = state === '결제사 전환' || state === '전환 뒤 원래 결제창 실패';
  const pay: PayMode =
    state === '판매 일시정지'
      ? 'sale-paused'
      : state === '결제 일시 정지'
        ? 'pay-paused'
        : state === '본인확인 정보 없음'
          ? 'no-id'
          : state === '결제 시도 초과'
            ? 'exceeded'
            : state === '홀드 만료(결제창 열기 전)'
              ? 'expired'
              : 'consent';
  const returnKind = RETURN_KIND[state] ?? null;
  return {
    returnKind,
    // 예매 제한(주문 생성 403)은 서버가 홀드를 풀었으므로 머리에 타이머를 두지 않는다(추천 적용 2026-10-30)
    hold: returnKind === 'restricted' ? 'none' : pay === 'expired' ? 'expired' : pay === 'pay-paused' ? 'paused' : 'live',
    inputError: state === '입력 오류',
    salePaused: state === '판매 일시정지',
    switchFail: state === '전환 뒤 원래 결제창 실패',
    agreed: !fresh,
    frame: switched ? 'portone' : state === '위젯 준비' ? 'toss-loading' : 'toss-ready',
    pay,
    expiredDialog: pay === 'expired',
    fraudLock: state === '부정 예매 조사로 양도가 잠기는 회차',
  };
}

/** 정렬 방식 고지(POL-004, 세 번째 고지 자리). 공연 상세(SCR-002)와 같은 문구 */
export const SORT_NOTICE: Record<SortMode, { title: string; body: string }> = {
  HYBRID: {
    title: '정렬 방식 · 하이브리드',
    body: '오픈 전에 들어온 분은 오픈 시각에 무작위로 순번을 받습니다. 일찍 들어와도 유리하지 않습니다. 오픈 후에 오신 분은 그 뒤에 도착 순으로 섭니다.',
  },
  PREQUEUE_SHUFFLE: {
    title: '정렬 방식 · 사전 셔플',
    body: '오픈 전에 들어온 분은 오픈 시각에 무작위로 순번을 받습니다. 일찍 들어와도 유리하지 않습니다. 오픈 후에 오신 분은 대기실 참가자 모두의 뒤에 도착 순으로 섭니다.',
  },
  FIFO: {
    title: '정렬 방식 · 선착순',
    body: '오픈 직후 2초 안에 도착한 분들은 같은 시각에 온 것으로 보고 무작위로 순서를 정합니다. 그 뒤에 오신 분은 도착 순으로 섭니다. 순서를 정하는 동안에는 순번이 보이지 않습니다. 오픈 직후 약 20초 안에 순번이 정해지고, 그 뒤 차례대로 입장합니다.',
  },
};

/** 판매자·중개자 법정 고지(POL-037, 공연 상세·결제 결과와 같은 문구) */
export function brokerNotice(sellerName: string): string {
  return `판매자: ${sellerName}. PEAKET은 통신판매중개자로서 이 공연의 당사자가 아닙니다. 공연의 개최·변경·취소에 따른 책임은 판매자에게 있고, 예매 취소와 환불은 PEAKET이 처리합니다`;
}

/** 미성년자 계약 취소 고지(전자상거래법 §13③, d5 §5.11 ⑨) */
export const MINOR_NOTICE =
  '만 19세 미만 미성년자가 법정대리인(부모 등)의 동의 없이 결제하면, 미성년자 본인이나 법정대리인이 이 계약을 취소할 수 있습니다.';
