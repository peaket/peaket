// 로고(캔버스 키트 6절 .logo + .logo-mark: 티켓 절취선 위로 솟은 봉우리, d1 §3). 서버 컴포넌트에서도 쓴다.
// 보드 마크업: <a class="logo" href="#" aria-label="PEAKET 홈"><i class="logo-mark" aria-hidden="true"></i>PEAKET</a>
// - size: sm 22 · md 28 · lg 44(마크 한 변). tone: default(다크에서 자동으로 밝은 인디고) · neg(진한 바탕 위 흰 마크) · on-dark(라이트 화면 속 진한 바탕)
// - href를 주면 링크(이름 기본 'PEAKET 홈'), 아니면 글자 span. 앱 라우터 링크는 linkAs로 넣는다.
import type { CSSProperties, ElementType } from 'react';
import { cx } from '../../lib/cx';

export interface LogoWordmarkProps {
  size?: 'sm' | 'md' | 'lg';
  tone?: 'default' | 'neg' | 'on-dark';
  href?: string;
  /** 링크 이름. 기본 'PEAKET 홈' */
  label?: string;
  linkAs?: ElementType;
  className?: string;
  style?: CSSProperties;
}

export function LogoWordmark({ size = 'md', tone = 'default', href, label = 'PEAKET 홈', linkAs: A = 'a', className, style }: LogoWordmarkProps) {
  const cls = cx('logo', size === 'sm' && 'logo-sm', size === 'lg' && 'logo-lg', className);
  const content = (
    <>
      <i className={cx('logo-mark', tone === 'neg' && 'neg', tone === 'on-dark' && 'on-dark')} aria-hidden="true" />
      <span translate="no">PEAKET</span>
    </>
  );
  if (href !== undefined) {
    return (
      <A className={cls} href={href} aria-label={label} style={style}>
        {content}
      </A>
    );
  }
  return (
    <span className={cls} style={style}>
      {content}
    </span>
  );
}
