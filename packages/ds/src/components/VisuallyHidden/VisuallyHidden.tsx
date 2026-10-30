// 화면에서만 숨기고 화면 낭독기는 읽는 글(키트 .sr-only, d1 §5 visually-hidden). 서버 컴포넌트에서도 쓴다.
import type { ElementType, HTMLAttributes, ReactNode } from 'react';
import { cx } from '../../lib/cx';

export interface VisuallyHiddenProps extends HTMLAttributes<HTMLElement> {
  /** 그릴 요소. 기본 span */
  as?: ElementType;
  /** 초점을 받으면 보이게 할지(styles/ds.css의 .pk-sr-only-focusable) */
  focusable?: boolean;
  children?: ReactNode;
}

export function VisuallyHidden({ as: Comp = 'span', focusable = false, className, ...props }: VisuallyHiddenProps) {
  return <Comp className={cx(focusable ? 'pk-sr-only-focusable' : 'sr-only', className)} {...props} />;
}
