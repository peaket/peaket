// 카드(캔버스 키트 9절 .card·.card-flat·.card-raised + .pad·.pad-lg). 서버 컴포넌트에서도 쓴다.
// 공연·티켓·상품 카드(CMP-028·072·074)는 이 상자 위에 화면이 보드 마크업대로 짠다.
import type { CSSProperties, ElementType, HTMLAttributes, ReactNode } from 'react';
import { cx } from '../../lib/cx';

export interface CardProps extends HTMLAttributes<HTMLElement> {
  /** outline(테두리) · flat(옅은 바탕) · raised(그림자) */
  variant?: 'outline' | 'flat' | 'raised';
  /** none · md(16) · lg(24) */
  padding?: 'none' | 'md' | 'lg';
  /** 고른 카드(테두리 primary) — outline만 */
  selected?: boolean;
  /** 그릴 요소. 기본 div(카드 하나가 독립된 글이면 article, 구역이면 section) */
  as?: ElementType;
  style?: CSSProperties;
  children?: ReactNode;
}

export function Card({ variant = 'outline', padding = 'md', selected = false, as: Comp = 'div', className, ...rest }: CardProps) {
  return (
    <Comp
      className={cx(
        variant === 'outline' && 'card',
        variant === 'flat' && 'card-flat',
        variant === 'raised' && 'card-raised',
        padding === 'md' && 'pad',
        padding === 'lg' && 'pad-lg',
        selected && variant === 'outline' && 'is-selected',
        className,
      )}
      {...rest}
    />
  );
}
