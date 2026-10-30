// 칩(캔버스 키트 8절 .chip). 서버 컴포넌트에서도 쓴다.
// - href가 있으면 링크 칩이다(회차 고르기처럼 주소가 바뀌는 칩). 고른 칩은 aria-current="page"(보드).
// - href가 없으면 버튼 칩이다. selected를 주면 켜고 끄는 칩(aria-pressed), 주지 않으면 그냥 버튼(필터 열기 '장르 ▾').
// - 여럿 중 하나를 고르는 칩 탭(홈 장르별 랭킹)은 ChipTabs를 쓴다.
import type { ButtonHTMLAttributes, ElementType, ReactNode } from 'react';
import { cx } from '../../lib/cx';
import { Icon, type IconName } from '../../icons';

export interface ChipProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  selected?: boolean;
  size?: 'md' | 'sm';
  icon?: IconName;
  /** 글자 뒤 아이콘(chevron-down 등) */
  iconEnd?: IconName;
  /** 링크 칩 */
  href?: string;
  /** 링크 요소(Next.js Link 등). href가 있을 때만 */
  linkAs?: ElementType;
  children: ReactNode;
}

export function chipClass(selected = false, size: 'md' | 'sm' = 'md'): string {
  return cx('chip', size === 'sm' && 'chip-sm', selected && 'is-selected');
}

export function Chip({ selected, size = 'md', icon, iconEnd, href, linkAs: A = 'a', className, children, type = 'button', ...rest }: ChipProps) {
  const content = (
    <>
      {icon ? <Icon name={icon} /> : null}
      {children}
      {iconEnd ? <Icon name={iconEnd} /> : null}
    </>
  );
  if (href !== undefined) {
    return (
      <A className={cx(chipClass(selected, size), className)} href={href} aria-current={selected ? 'page' : undefined}>
        {content}
      </A>
    );
  }
  return (
    <button type={type} className={cx(chipClass(selected, size), className)} aria-pressed={selected} {...rest}>
      {content}
    </button>
  );
}
