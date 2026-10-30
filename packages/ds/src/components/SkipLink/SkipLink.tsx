// 본문 바로가기 링크(CMP-065 셸의 조각, WCAG 2.4.1). 셸 맨 앞에 두고 <main id="main" tabIndex={-1}>로 보낸다.
// 보드 마크업은 <a class="sr-only" href="#main">본문 바로가기</a>다. 초점을 받으면 보이도록 .pk-skip-link(styles/ds.css)를 쓴다.
// 서버 컴포넌트에서도 쓴다.
import type { AnchorHTMLAttributes, ReactNode } from 'react';
import { cx } from '../../lib/cx';

export interface SkipLinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  /** 건너뛸 곳. 기본 "#main" */
  href?: string;
  children?: ReactNode;
}

export function SkipLink({ href = '#main', className, children = '본문 바로가기', ...props }: SkipLinkProps) {
  return (
    <a href={href} className={cx('pk-skip-link', className)} {...props}>
      {children}
    </a>
  );
}
