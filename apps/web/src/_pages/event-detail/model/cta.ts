// SCR-002 예매 버튼(⑦) 모양 고르기(d5 §5.2 상태 표, ADR-0272 결정 2·3 '차례'). ui/Booking.tsx의 ctaModel을 옮겨 왔다.
// 순수 함수만 둔다(node --test가 바로 불러 본다). 시계·난수는 부르지 않고 받은 값으로만 고른다.
// 차례: 판매 종료·취소(상태 파일 ENDED 포함) > 매진 > 개인 상태 받는 중 > 로그인 > 예매 제한 > 가입 마무리 > 본인확인 > 판매 자격 없음 > 시각 상태.
// 매진이면 살 수 있는 때가 없어 개인 상태·예매 제한·판매 자격을 보이지 않는다(ADR-0213 결정 2와 같은 까닭).
// 가입·본인확인은 일반 예매에도 필요하므로 자격 없음보다 먼저 보여 미리 끝내게 한다(일반 예매 시작 순간에 본인확인 창을 열지 않게).
import { VERIFY_PURPOSE } from './content.ts';
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

const SAME_ORDER = '로비 안에서는 언제 들어와도 순번이 같습니다';
/** 판매 자격 없음을 오픈 전 모양(오픈 알림 토글 + 비활성 버튼)으로 그리는 상태 */
const BEFORE_OPEN = new Set<BookingPhase>(['closed', 'pending', 'notYet', 'lobby', 'fifo']);

/** ( 다른 회차 › ): 다음 판매 중 회차(이 회차·취소·판매 종료 회차는 건너뜀), 없으면 대신 갈 곳 */
function otherRoundHref(data: CtaData, now: number | undefined): string {
  const next = data.rounds.find((r) => !r.current && r.status !== 'CANCELLED' && (now === undefined || r.saleEndsAtMs === undefined || r.saleEndsAtMs > now));
  return next?.href ?? data.otherRoundFallbackHref;
}

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
  const { phase, data, now, personal, restricted, eligibility, live } = i;
  const load: CtaModel = { special: 'load', meta: data.roundLabel };
  const endedLine = (text: string): CtaModel => ({ special: 'ended', endedText: text, meta: `${data.roundLabel} · ${text}`, more: { label: '다른 회차', href: otherRoundHref(data, now) } });

  // 판매 종료·취소가 모든 덮기보다 먼저다. 상태 파일 ENDED는 시각 판정보다 앞서는 판매 종료 줄이다(ADR-0272 결정 1)
  if (phase === 'cancelled') return endedLine('취소된 회차입니다');
  if (phase === 'ended') return endedLine('판매가 끝난 회차입니다');
  if (phase === 'queue' && live.status === 'known') {
    if (live.saleStatus === 'ENDED') return endedLine('판매가 끝난 회차입니다');
    // 회차 매진(d5 §5.2 '매진'): [ 취소표 알림 받기 ] · ( 다른 회차 › ). 대기열 버튼·오픈 알림·제한 글·자격 없음은 없다(결정 2)
    if (live.saleStatus === 'SOLD_OUT') return { special: 'soldOut', meta: `${data.roundLabel} · 매진`, more: { label: '다른 회차', href: otherRoundHref(data, now) } };
  }

  const lobbyMeta = `${data.roundLabel}${data.lobbyText && phase !== 'queue' ? ` · 로비 ${data.lobbyText}부터` : ''}`;
  // 개인 상태가 먼저다(d5 §5.2 '비로그인'·'본인확인 필요'). 오픈 알림 토글은 오픈 전에만 둔다(오픈 뒤 진입 버튼에는 없다)
  const openAlert = phase === 'queue' ? undefined : {};
  if (personal === 'loading') return load;
  if (personal === 'login') return { meta: lobbyMeta, alert: openAlert, primary: { type: 'link', label: '로그인하고 입장', href: data.loginHref }, minW: 200 };
  // 예매 제한은 가입 마무리·본인확인보다 먼저다(d5 §5.2 '예매 제한 중', 판매 종료 줄과 같은 모양: 글 + ( 소명하기 › ))
  if (restricted === 'loading') return load;
  if (restricted) {
    return {
      special: 'ended',
      endedText: restricted.text,
      meta: `${data.roundLabel} · ${restricted.text}`,
      ...(restricted.appealHref ? { more: { label: '소명하기', href: restricted.appealHref } } : {}),
    };
  }
  if (personal === 'signup') return { meta: lobbyMeta, alert: openAlert, primary: { type: 'link', label: '가입을 마치고 입장', href: data.signupHref }, minW: 200 };
  if (personal === 'verify') return { desc: VERIFY_PURPOSE, alert: openAlert && { iconOnlyBelowMd: true }, primary: { type: 'verify', label: '휴대폰 본인확인' }, minW: 200 };

  // 판매 자격(ADR-0272 결정 3): 받는 동안은 뼈대, 자격 없음은 그 시각 상태의 버튼을 이유 있는 비활성으로(d2 §3.6)
  if (eligibility === 'loading') return load;
  if (eligibility && phase !== undefined) {
    if (phase === 'queue') return { desc: eligibility.reason, primary: { type: 'disabled', label: '대기열 들어가기' }, minW: 240 };
    if (BEFORE_OPEN.has(phase)) return { desc: eligibility.reason, alert: {}, primary: { type: 'disabled', label: data.hasLobby ? '로비 입장' : '대기열 들어가기' }, minW: 200 };
  }

  switch (phase) {
    case 'closed':
      return { desc: `로비는 ${data.lobbyText ?? ''}에 열립니다`, alert: {}, primary: { type: 'disabled', label: '로비 입장' }, minW: 200 };
    case 'notYet':
      return { desc: SAME_ORDER, alert: { iconOnlyBelowMd: true }, primary: { type: 'countdown' }, minW: 240 };
    case 'lobby':
      return { desc: SAME_ORDER, alert: {}, primary: { type: 'link', label: '로비 입장', href: i.queueHref }, minW: 200 };
    case 'fifo':
      return { desc: `대기열은 ${data.openTimeText}에 열립니다`, alert: {}, primary: { type: 'disabled', label: '대기열 들어가기' }, minW: 200 };
    case 'queue':
      return { meta: `${data.roundLabel} · 판매 중`, primary: { type: 'enter', label: '대기열 들어가기' }, minW: 240 };
    default:
      return load;
  }
}
