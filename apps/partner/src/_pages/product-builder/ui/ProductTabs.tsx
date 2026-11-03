'use client';
// [상품 목록][상품 만들기][굿즈 주문 현황][배송·반품 처리][상품 정산] 탭(d5 §6.6). 휴대폰은 작은 탭(.tabs-sm 값)으로 가로로 밀어 보고,
// 지금 탭이 보이게 처음 위치를 맞춘다(보드 SCR-023-m이 탭 줄을 왼쪽으로 민 모양).
import Link from 'next/link';
import { useEffect, useRef } from 'react';

export interface ProductTab {
  key: string;
  label: string;
  href: string;
  active: boolean;
  badge?: string;
}

export function ProductTabs({ tabs }: { tabs: readonly ProductTab[] }) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const nav = ref.current;
    const active = nav?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!nav || !active) return;
    const left = active.offsetLeft - nav.offsetLeft;
    if (left + active.offsetWidth > nav.scrollLeft + nav.clientWidth || left < nav.scrollLeft) nav.scrollLeft = Math.max(0, left - 16);
  }, [tabs]);
  return (
    <nav
      ref={ref}
      className="tabs tabs-scroll max-md:[&_.tab]:min-h-[38px] max-md:[&_.tab]:px-2.5 max-md:[&_.tab]:text-[14px]"
      aria-label="상품 메뉴"
    >
      {tabs.map((t) => (
        <Link key={t.key} className={t.active ? 'tab is-active' : 'tab'} href={t.href} aria-current={t.active ? 'page' : undefined}>
          {t.label}
          {t.badge ? <span className="badge">{t.badge}</span> : null}
        </Link>
      ))}
    </nav>
  );
}
