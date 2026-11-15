// SCR-002 예매 버튼(⑦) 모양 고르기(d5 §5.2 상태 표, ADR-0272 결정 2·3 '차례'). ui/Booking.tsx의 ctaModel을 옮겨 올 자리다.
// 순수 함수만 둔다(node --test가 바로 불러 본다). 시험 담당이 만든 빈 뼈대이고, 동작은 구현 담당이 채운다(ADR-0270 결정 1).
import type { BookingPhase, EventDetail } from './detail.ts';
import type { LiveSale } from './live-sale.ts';
import type { EligibilityGate } from './sale.ts';

export type Primary = { type: 'link'; label: string; href: string } | { type: 'enter'; label: string } | { type: 'disabled'; label: string } | { type: 'countdown' } | { type: 'verify'; label: string };

export interface CtaModel {
  desc?: string;
  meta?: string;
  alert?: { iconOnlyBelowMd?: boolean };
  primary?: Primary;
  minW?: 160 | 200 | 240;
  more?: { label: string; href: string };
  special?: 'ended' | 'load' | 'soldOut';
  endedText?: string;
}

/** 버튼을 고르는 데 쓰는 회차 값(ui/Booking.tsx BookingData의 일부와 로비 여부) */
export type CtaData = Pick<EventDetail, 'eventId' | 'roundLabel' | 'lobbyText' | 'openTimeText' | 'rounds'> & {
  loginHref: string;
  signupHref: string;
  otherRoundFallbackHref: string;
  hasLobby: boolean;
};

export function bookingCta(i: {
  phase: BookingPhase | undefined;
  data: CtaData;
  now: number | undefined;
  personal: 'login' | 'verify' | 'signup' | 'loading' | null;
  restricted: 'loading' | { text: string; appealHref?: string } | null;
  eligibility: EligibilityGate;
  live: LiveSale;
  queueHref: string;
}): CtaModel {
  void i;
  throw new Error('아직 없음');
}
