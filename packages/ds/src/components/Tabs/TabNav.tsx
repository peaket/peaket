// CMP-030 anchor 변형: 같은 페이지 섹션 바로가기(공연 정보·상세정보·판매 조건·장소·후기). 탭이 아니라 링크 목록이다.
// 보드 마크업: <nav class="tabs" aria-label="섹션 바로가기"><a class="tab is-active" href="#sec-info" aria-current="true">…
// 지금 보는 섹션은 current로 준다(스크롤 따라가기는 화면이 정한다). 서버 컴포넌트에서도 쓴다.
import type { CSSProperties, ElementType, ReactNode } from 'react';
import { cx } from '../../lib/cx';

export interface TabNavItem {
  href: string;
  label: ReactNode;
}

export interface TabNavProps {
  items: readonly TabNavItem[];
  /** 지금 보는 항목의 href */
  current?: string;
  /** nav 이름. 기본 "섹션 바로가기" */
  label?: string;
  size?: 'md' | 'sm';
  scroll?: boolean;
  /** 위에 붙기(position:sticky; top:0) */
  sticky?: boolean;
  /** 링크 요소(Next.js Link 등). 기본 a */
  linkAs?: ElementType;
  /** aria-current 값. 섹션 바로가기는 "true"(보드), 페이지 이동 탭은 "page" */
  currentValue?: 'true' | 'page' | 'location';
  className?: string;
  style?: CSSProperties;
}

export function TabNav({
  items,
  current,
  label = '섹션 바로가기',
  size = 'md',
  scroll = false,
  sticky = false,
  linkAs: A = 'a',
  currentValue = 'true',
  className,
  style,
}: TabNavProps) {
  return (
    <nav
      className={cx('tabs', size === 'sm' && 'tabs-sm', scroll && 'tabs-scroll', className)}
      aria-label={label}
      style={sticky ? { background: 'var(--surface)', position: 'sticky', top: 0, zIndex: 5, ...style } : style}
    >
      {items.map((item) => {
        const on = item.href === current;
        return (
          <A key={item.href} className={cx('tab', on && 'is-active')} href={item.href} aria-current={on ? currentValue : undefined}>
            {item.label}
          </A>
        );
      })}
    </nav>
  );
}
