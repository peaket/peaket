// SCR-058 외부 브라우저 전환 안내가 끼어드는 자리(d5 §5.32 '로비·대기열 진입과 입장용 휴대폰 등록 직전').
// 공연 상세 ⑦(로비 입장·대기열 들어가기)과 마이 티켓 ⑨(입장용 휴대폰 등록)이 인앱 브라우저를 알아내면
// `/open-in-browser?next=<가려던 경로>`로 보낸다(추천안: d5에 경로가 없어 이 화면의 주소를 정했다).
// next는 열린 이동(open redirect)이 되지 않게 이 앱의 두 경로 모양만 받는다. 나머지는 대표 회차의 대기실로 본다.
import { getPerformance, DEMO_EVENT_ID } from '@/entities/performance';
import { getProduction } from '@/entities/production';
import { getTicket } from '@/entities/ticket';
import { getVenue } from '@/entities/venue';
import { queueRoomHref } from '@/shared/config/origins';

export interface OpenInBrowserTarget {
  kind: 'queue' | 'ticket';
  /** 외부 브라우저에서 열 주소(복사·Android 바로 열기). 대기실은 개발에서 포트 3004의 절대 주소·운영에서 같은 출처 경로(복사·intent 때 절대 주소로 바꾼다), 티켓은 이 앱 경로 */
  href: string;
  /** 집중 셸 머리 */
  title: string;
  subtitle: string;
  closeHref: string;
  closeLabel: string;
}

const QUEUE = /^\/queue\/([a-z0-9-]{1,64})$/;
const TICKET = /^\/my\/tickets\/([a-z0-9-]{1,64})$/;

export function resolveTarget(next: string | undefined): OpenInBrowserTarget {
  const ticketId = next?.match(TICKET)?.[1];
  const ticket = ticketId ? getTicket(ticketId) : undefined;
  if (ticket) {
    const facts = describe(ticket.performanceId);
    return {
      kind: 'ticket',
      href: `/my/tickets/${ticket.id}`,
      title: facts.title,
      subtitle: `${facts.subtitle} · 입장용 휴대폰 등록`,
      closeHref: `/my/tickets/${ticket.id}`,
      closeLabel: '닫고 티켓으로 가기',
    };
  }
  const eventId = next?.match(QUEUE)?.[1];
  const id = eventId && getPerformance(eventId) ? eventId : DEMO_EVENT_ID;
  const facts = describe(id);
  return {
    kind: 'queue',
    href: queueRoomHref(id),
    title: facts.title,
    subtitle: facts.subtitle,
    closeHref: `/events/${id}`,
    closeLabel: '닫고 공연 상세로 가기',
  };
}

function describe(performanceId: string): { title: string; subtitle: string } {
  const perf = getPerformance(performanceId);
  const production = perf ? getProduction(perf.productionId) : undefined;
  const venue = production ? getVenue(production.venueId) : undefined;
  return {
    title: production?.title ?? '공연',
    subtitle: [perf?.label, venue?.name].filter(Boolean).join(' · '),
  };
}
