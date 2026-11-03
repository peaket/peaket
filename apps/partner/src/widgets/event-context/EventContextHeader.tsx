// 공연 문맥 머리(d5 §3.2·§6.3, 보드 SCR-063·022·024·026·037): 위치(데스크톱은 빵부스러기, 휴대폰·태블릿은 ‹ 공연 관리) · h1 공연명 · 배지 · 요약 줄 · 문맥 탭.
// 공연 문맥 화면(/events/[id]/…)은 맨 위에 이것을 한 번 부른다. 배지는 화면·상태마다 달라 페이지가 넘긴다(없으면 판매 승인 상태로).
import Link from 'next/link';
import type { ReactNode } from 'react';
import { SALE_REVIEW_BADGE, type Production } from '@/entities/production';
import { routes, type EventTab } from '@/shared/config/routes';
import { EventTabs } from './EventTabs';

export interface EventContextHeaderProps {
  production: Production;
  current: EventTab;
  /** h1 옆 배지(예: <span className="badge badge-success">판매 승인됨</span>) */
  badges?: ReactNode;
  /** h1 아래 요약 줄 */
  meta?: ReactNode;
  /** 탭 링크에 남길 검색 문자열(예: 'theme=dark') */
  keep?: string;
}

export function defaultReviewBadge(p: Production): ReactNode {
  const label =
    p.review === 'APPROVED' ? '판매 승인됨' : p.review === 'SUBMITTED' ? '판매 승인 대기' : p.review === 'DRAFT' ? '초안' : null;
  const text = label ?? (p.review === 'REJECTED' ? '반려' : p.review === 'CHANGE_REJECTED' ? '변경 반려' : p.review === 'RESUBMITTED' ? '재승인 대기' : '판매 중지');
  return <span className={SALE_REVIEW_BADGE[p.review]}>{text}</span>;
}

export function EventContextHeader({ production, current, badges, meta, keep }: EventContextHeaderProps) {
  const home = keep ? `${routes.events()}?${keep}` : routes.events();
  return (
    <>
      <div className="col" style={{ gap: 8 }}>
        <nav className="breadcrumb max-lg:hidden" aria-label="위치">
          <Link href={home}>공연 관리</Link>
          <i className="ic ic-chevron-right" aria-hidden="true" />
          <span>{production.name}</span>
        </nav>
        <Link className="link-more lg:hidden" href={home} style={{ alignSelf: 'flex-start' }}>
          <i className="ic ic-chevron-left ic-16" aria-hidden="true" />
          공연 관리
        </Link>
        <div className="page-head max-md:gap-2">
          <h1>{production.name}</h1>
          <div className="row wrap" style={{ gap: 6 }}>
            {badges ?? defaultReviewBadge(production)}
          </div>
        </div>
        {meta ? <p className="t-sm muted">{meta}</p> : null}
      </div>
      <EventTabs eventId={production.id} current={current} keep={keep} />
    </>
  );
}
