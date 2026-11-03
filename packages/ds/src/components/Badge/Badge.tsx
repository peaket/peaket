// 배지(캔버스 키트 8절 .badge, d2 CMP-040 DeadlineBadge 등의 바탕). 서버 컴포넌트에서도 쓴다.
// 색만으로 뜻을 말하지 않도록 배지 글자에 상태를 적는다(예: '매진', '기한 1영업일 전').
import type { HTMLAttributes, ReactNode } from 'react';
import { cx } from '../../lib/cx';
import { Icon, type IconName } from '../../icons';

export type BadgeTone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger' | 'solid' | 'inverse' | 'outline';

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  size?: 'md' | 'lg';
  /** 글자 앞 아이콘(장식) */
  icon?: IconName;
  children: ReactNode;
}

export function badgeClass(tone: BadgeTone = 'neutral', size: 'md' | 'lg' = 'md'): string {
  return cx('badge', tone !== 'neutral' && `badge-${tone}`, size === 'lg' && 'badge-lg');
}

export function Badge({ tone = 'neutral', size = 'md', icon, className, children, ...rest }: BadgeProps) {
  return (
    <span className={cx(badgeClass(tone, size), className)} {...rest}>
      {icon ? <Icon name={icon} /> : null}
      {children}
    </span>
  );
}
