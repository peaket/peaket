'use client';
// 공연 문맥 탭(d5 §3.2). 휴대폰·태블릿에서는 가로로 밀어 보고, 지금 탭이 보이게 처음 위치를 맞춘다(키트 20b절 .tabs-scroll).
import Link from 'next/link';
import { useEffect, useRef } from 'react';
import { EVENT_TABS, routes, type EventTab } from '@/shared/config/routes';

export function EventTabs({ eventId, current, keep }: { eventId: string; current: EventTab; keep?: string }) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const nav = ref.current;
    const active = nav?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!nav || !active) return;
    const left = active.offsetLeft - nav.offsetLeft;
    if (left + active.offsetWidth > nav.scrollLeft + nav.clientWidth || left < nav.scrollLeft) nav.scrollLeft = Math.max(0, left - 16);
  }, [current]);
  return (
    <nav ref={ref} className="tabs tabs-scroll" aria-label="공연 메뉴">
      {EVENT_TABS.map((t) => {
        const href = routes.eventTab(eventId, t.key);
        return (
          <Link
            key={t.key}
            className={t.key === current ? 'tab is-active' : 'tab'}
            href={keep ? `${href}?${keep}` : href}
            aria-current={t.key === current ? 'page' : undefined}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
