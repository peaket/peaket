// CMP-002 Link. 다른 주소·화면으로 옮긴다(동작 실행은 Button). 서버 컴포넌트에서도 쓴다.
// 캔버스 보드의 마크업을 그대로 낸다.
// - inline: 문장 안 밑줄 링크(.link) · more: '더 보기'류 링크(.link-more + ›) · plain: 클래스 없음(키트 a 기본 색)
// - tile: 홈 장르 바로가기(아이콘 위·이름 아래) · venue: 홈 공연장(원형 이니셜 + 이름). 아이콘·이니셜은 장식이고 이름이 링크 이름이다.
// - external: 바깥 사이트로 갈 때 rel="noopener noreferrer"와 보이는 외부 아이콘(ic-external), 화면 낭독기용 '(외부 사이트)'를 단다.
// - as: 앱 라우터 링크(Next.js Link 등). href·className·style·children을 그대로 넘긴다.
import type { AnchorHTMLAttributes, ElementType, ReactNode } from 'react';
import { cx } from '../../lib/cx';
import { initialsOf } from '../../lib/format';
import { Icon, type IconName } from '../../icons';

export type LinkVariant = 'inline' | 'more' | 'plain' | 'tile' | 'venue';

export interface LinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  href: string;
  variant?: LinkVariant;
  /** 바깥 사이트 */
  external?: boolean;
  /** 새 창으로 연다(external일 때만) */
  newTab?: boolean;
  /** tile의 아이콘(장르 아이콘 등) */
  icon?: IconName;
  /** venue의 이니셜. 없으면 글자에서 만든다 */
  initials?: string;
  as?: ElementType;
  children: ReactNode;
}

export function Link({
  variant = 'inline',
  external = false,
  newTab = false,
  icon,
  initials,
  as: Comp = 'a',
  className,
  style,
  rel,
  target,
  children,
  ...rest
}: LinkProps) {
  const ext = external ? { rel: rel ?? 'noopener noreferrer', target: newTab ? '_blank' : target } : { rel, target };
  const extMark = external ? (
    <>
      <Icon name="external" size={16} />
      <span className="sr-only">{newTab ? '(외부 사이트, 새 창)' : '(외부 사이트)'}</span>
    </>
  ) : null;

  if (variant === 'tile') {
    return (
      <Comp
        className={cx('col', className)}
        style={{ alignItems: 'center', gap: 6, color: 'inherit', textAlign: 'center', ...style }}
        {...ext}
        {...rest}
      >
        <span
          className="center"
          aria-hidden="true"
          style={{ width: 52, height: 52, borderRadius: 'var(--r-lg)', background: 'var(--surface-muted)', color: 'var(--link)' }}
        >
          {icon ? <Icon name={icon} size={24} /> : null}
        </span>
        <span className="t-xs fw-m">{children}</span>
      </Comp>
    );
  }

  if (variant === 'venue') {
    const mark = initials ?? (typeof children === 'string' ? initialsOf(children) : '');
    return (
      <Comp
        className={cx('col', className)}
        style={{ alignItems: 'center', gap: 8, width: 72, color: 'inherit', ...style }}
        {...ext}
        {...rest}
      >
        <span
          className="center t-lg"
          aria-hidden="true"
          style={{ width: 64, height: 64, borderRadius: '50%', background: 'var(--fill-weak)', color: 'var(--text-muted)' }}
        >
          {mark}
        </span>
        <span className="t-xs fw-m" style={{ textAlign: 'center' }}>
          {children}
        </span>
      </Comp>
    );
  }

  return (
    <Comp
      className={cx(variant === 'inline' && 'link', variant === 'more' && 'link-more', className)}
      style={style}
      {...ext}
      {...rest}
    >
      {children}
      {extMark}
      {variant === 'more' && !external ? <Icon name="chevron-right" /> : null}
    </Comp>
  );
}
