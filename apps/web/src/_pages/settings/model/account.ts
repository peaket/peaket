// SCR-017 계정 설정 목업(캔버스 보드 SCR-017-m·t·d의 글을 옮겼다. 연락처 끝자리 등 보드의 [자리 표시]는 합성 값으로 채웠다).
// 탈퇴 환급 예상(CMP-054 RefundQuote 자리)은 ticket·performance·production 목업에서 계산한다. 실제 사람·계좌·연락처가 아니다.
import type { DeviceSession } from '@peaket/ds/DeviceSessionList';
import { ME, type MeSummary } from '@/entities/me';
import { getPerformance } from '@/entities/performance';
import { getProduction } from '@/entities/production';
import { TICKETS } from '@/entities/ticket';

/** 소셜 로그인 제공자 이름과 키트 버튼·로고 클래스 */
export const PROVIDER_INFO: Record<MeSummary['provider'], { label: string; btn: string; prov: string }> = {
  kakao: { label: '카카오', btn: 'btn-kakao', prov: 'prov-kakao' },
  naver: { label: '네이버', btn: 'btn-naver', prov: 'prov-naver' },
  google: { label: '구글', btn: 'btn-google', prov: 'prov-google' },
};

export const PROFILE = {
  nickname: ME.name,
  /** 양도받을 때 보내는 분에게 알려 주는 코드 */
  memberCode: 'PK7-42Q9',
  /** 가운데를 가린 연락처(합성 값) */
  phoneMasked: '010-****-5678',
  /** 휴대폰 본인확인 날 */
  verifiedAt: '2026-10-02',
} as const;

/** 이 계정에 연결된 로그인 수단(보드 '카카오 · 구글 연결됨') */
export const LINKED_PROVIDERS: readonly MeSummary['provider'][] = ['kakao', 'google'];

/** 예매 제한 중 표본(소명 기한, SCR-042로 간다) */
export const RESTRICTION = { appealDeadlineText: '10/27', appealHref: '/my/appeals/apl-0001' } as const;

/** 로그인한 기기(최대 5대). 스태프 세션은 현장 스캐너다(ADR-0051) */
export const DEVICE_SESSIONS: readonly DeviceSession[] = [
  { id: 'ses-chrome-win', name: 'Chrome · Windows', icon: 'globe', current: true },
  { id: 'ses-safari-iphone', name: 'Safari · iPhone', icon: 'phone' },
  { id: 'ses-scanner-dm03', name: '현장 스캐너 동문-03', icon: 'scan', tag: '스태프 세션' },
];

/** '원격 로그아웃 완료' 상태에서 이미 로그아웃한 기기 */
export const REMOTE_LOGGED_OUT_ID = 'ses-safari-iphone';

/** 탈퇴하면 취소되는 미사용 티켓(보드 표본 '미사용 티켓 2장', LUMEN 10/25 R석 두 장) */
const UNUSED_TICKET_IDS = ['tkt-lumen-r1-0312', 'tkt-lumen-r1-0313'];

export interface WithdrawQuote {
  ticketCount: number;
  paid: number;
  /** 관람일 10일 전까지는 0(공정거래위원회 소비자분쟁해결기준) */
  fee: number;
  refund: number;
  /** 'LUMEN 콘서트 2026 서울 · 10/25(일) 18:00 · R1구역 3열 12번·13번' */
  summary: string;
  /** 받은 티켓 장수(결제한 분에게 돌아간다) */
  receivedCount: number;
  /** 양도 요청 중인 티켓 장수(요청을 철회하고 취소) */
  transferPendingCount: number;
  /** 양도 요청 중인 티켓 상세(요청 보기) */
  transferPendingHref: string;
}

/** 'R석 · R1구역 3열 12번'들 → 'R1구역 3열 12번·13번' */
function seatsText(labels: readonly string[]): string {
  const parts = labels.map((l) => l.split(' · ').pop() ?? l);
  const first = parts[0] ?? '';
  const cut = first.lastIndexOf(' ');
  const prefix = cut > 0 ? first.slice(0, cut) : '';
  if (prefix && parts.every((p) => p.startsWith(`${prefix} `))) return `${prefix} ${parts.map((p) => p.slice(prefix.length + 1)).join('·')}`;
  return parts.join(', ');
}

export function withdrawQuote(): WithdrawQuote {
  const tickets = TICKETS.filter((t) => UNUSED_TICKET_IDS.includes(t.id));
  const first = tickets[0];
  const perf = first ? getPerformance(first.performanceId) : undefined;
  const prod = first ? getProduction(first.productionId) : undefined;
  const paid = tickets.reduce((sum, t) => sum + t.price, 0);
  const fee = 0;
  const pending = TICKETS.filter((t) => t.status === '양도 요청 중');
  return {
    ticketCount: tickets.length,
    paid,
    fee,
    refund: paid - fee,
    summary: [prod?.title, perf?.label, seatsText(tickets.map((t) => t.seatLabel))].filter(Boolean).join(' · '),
    receivedCount: TICKETS.filter((t) => t.status === '받은 티켓').length,
    transferPendingCount: pending.length,
    transferPendingHref: pending[0] ? `/my/tickets/${pending[0].id}` : '/my/tickets',
  };
}
