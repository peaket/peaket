// SCR-058 외부 브라우저 전환 안내가 끼어드는 자리(d5 §5.32 '로비·대기열 진입과 입장용 휴대폰 등록 직전').
// 공연 상세 ⑦(로비 입장·대기열 들어가기)과 마이 티켓 ⑨(입장용 휴대폰 등록)이 인앱 브라우저를 알아내면
// `/open-in-browser?next=<가려던 경로>`로 보낸다(추천안: d5에 경로가 없어 이 화면의 주소를 정했다).
// 열 주소는 open-href.ts의 규칙이다: 두 꼴(대기실·티켓)의 같은 출처 경로는 그대로, 나머지는 첫 화면(/).
// 고정 자료는 머리 글(공연명·회차)을 채울 때만 읽고, 고정 자료에 없는 공연·티켓이어도 열 주소는 바꾸지 않는다
// (d5 §5.32 '나감: 외부 브라우저의 같은 주소', BAT-170 시험 뒤 정함 계획 §11 3).
import { getPerformance } from '@/entities/performance';
import { getProduction } from '@/entities/production';
import { getTicket } from '@/entities/ticket';
import { getVenue } from '@/entities/venue';
import { queueRoomHref } from '@/shared/config/origins';
import { openTargetPath, QUEUE_PATH, TICKET_PATH } from './open-href';

export interface OpenInBrowserTarget {
  kind: 'queue' | 'ticket' | 'home';
  /** 외부 브라우저에서 열 주소(복사·Android 바로 열기). 같은 출처 경로이고, 복사·intent 때 절대 주소로 바꾼다 */
  href: string;
  /** 집중 셸 머리 */
  title: string;
  subtitle: string;
  closeHref: string;
  closeLabel: string;
}

export function resolveTarget(next: string | undefined): OpenInBrowserTarget {
  const path = openTargetPath(next);

  const ticketId = path.match(TICKET_PATH)?.[1];
  if (ticketId) {
    const ticket = getTicket(ticketId);
    const facts = ticket ? describe(ticket.performanceId) : { title: '마이 티켓', subtitle: '' };
    return {
      kind: 'ticket',
      href: path,
      title: facts.title,
      subtitle: facts.subtitle ? `${facts.subtitle} · 입장용 휴대폰 등록` : '입장용 휴대폰 등록',
      closeHref: path,
      closeLabel: '닫고 티켓으로 가기',
    };
  }

  const eventId = path.match(QUEUE_PATH)?.[1];
  if (eventId) {
    const facts = describe(eventId);
    return {
      kind: 'queue',
      href: queueRoomHref(eventId),
      title: facts.title,
      subtitle: facts.subtitle,
      closeHref: `/events/${encodeURIComponent(eventId)}`,
      closeLabel: '닫고 공연 상세로 가기',
    };
  }

  return { kind: 'home', href: path, title: 'PEAKET', subtitle: '', closeHref: '/', closeLabel: '닫고 첫 화면으로 가기' };
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
