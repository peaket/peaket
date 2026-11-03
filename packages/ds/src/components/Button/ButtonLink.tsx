// 버튼 모양 링크(보드의 <a class="btn btn-ghost" href>). 화면 이동은 링크로 두고 모양만 버튼이다(d2 CMP-001·002).
// 서버 컴포넌트에서도 쓴다. 앱 라우터 링크(Next.js Link 등)는 as로 넣는다.
import type { AnchorHTMLAttributes, ElementType } from 'react';
import { cx } from '../../lib/cx';
import { Icon, type IconName } from '../../icons';
import { buttonClass, isProvider, type ButtonSize, type ButtonVariant } from './buttonClass';

export interface ButtonLinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  href: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  block?: boolean;
  icon?: IconName;
  iconEnd?: IconName;
  /** 그릴 요소(Next.js Link 등). 기본 a */
  as?: ElementType;
}

export function ButtonLink({
  variant = 'primary',
  size = 'md',
  block = false,
  icon,
  iconEnd,
  as: Comp = 'a',
  className,
  children,
  ...rest
}: ButtonLinkProps) {
  return (
    <Comp className={cx(buttonClass({ variant, size, block }), className)} {...rest}>
      {isProvider(variant) ? <i className={`prov prov-${variant}`} aria-hidden="true" /> : null}
      {icon ? <Icon name={icon} /> : null}
      {children}
      {iconEnd ? <Icon name={iconEnd} /> : null}
    </Comp>
  );
}
