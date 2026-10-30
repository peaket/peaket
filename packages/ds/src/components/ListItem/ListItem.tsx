// 목록 한 줄(캔버스 키트 9절 .li·.li-title·.li-sub). 서버 컴포넌트에서도 쓴다.
// - 그냥 줄: <li class="li">(기본). 목록 밖이면 as="div".
// - 링크 줄(href): <li><a class="li" href>…</a></li> · 버튼 줄(onClick 또는 button): <li><button class="li">…</button></li>
//   (보드의 '예매 안내사항 ›' 줄). 목록 밖이면 as="div"로 바깥 <li>를 빼고 링크·버튼만 낸다.
import type { CSSProperties, ElementType, MouseEventHandler, ReactNode } from 'react';
import { cx } from '../../lib/cx';
import { Icon } from '../../icons';

export interface ListItemProps {
  title: ReactNode;
  /** 아래 보조 글(.li-sub) */
  description?: ReactNode;
  /** 앞(아이콘·아바타 등) */
  leading?: ReactNode;
  /** 뒤(배지·값·버튼 등) */
  trailing?: ReactNode;
  /** 끝에 › 표시(링크·버튼 줄) */
  chevron?: boolean;
  href?: string;
  /** 링크 요소(Next.js Link 등) */
  linkAs?: ElementType;
  onClick?: MouseEventHandler<HTMLButtonElement>;
  /** 버튼 줄로 그린다(onClick 없이 서버에서 그릴 때) */
  button?: boolean;
  /** 버튼 줄이 여는 것(aria-haspopup="dialog") */
  haspopup?: 'dialog' | 'menu';
  /** 바깥 요소. 기본 li */
  as?: 'li' | 'div';
  className?: string;
  style?: CSSProperties;
}

const buttonReset: CSSProperties = {
  width: '100%',
  border: 0,
  borderBottom: '1px solid var(--border)',
  background: 'transparent',
  cursor: 'pointer',
  textAlign: 'left',
  color: 'inherit',
};

export function ListItem({
  title,
  description,
  leading,
  trailing,
  chevron,
  href,
  linkAs: A = 'a',
  onClick,
  button = false,
  haspopup,
  as = 'li',
  className,
  style,
}: ListItemProps) {
  const body = (
    <>
      {leading}
      <span className="col grow" style={{ gap: 2 }}>
        <span className="li-title">{title}</span>
        {description ? <span className="li-sub">{description}</span> : null}
      </span>
      {trailing}
      {chevron ? <Icon name="chevron-right" className="muted" /> : null}
    </>
  );
  const Outer: ElementType = as;
  if (href !== undefined) {
    const link = (
      <A className={cx('li', className)} href={href} style={{ color: 'inherit', ...style }}>
        {body}
      </A>
    );
    return as === 'li' ? <li>{link}</li> : link;
  }
  if (onClick || button) {
    const btn = (
      <button type="button" className={cx('li', className)} style={{ ...buttonReset, ...style }} onClick={onClick} aria-haspopup={haspopup}>
        {body}
      </button>
    );
    return as === 'li' ? <li>{btn}</li> : btn;
  }
  return (
    <Outer className={cx('li', className)} style={style}>
      {body}
    </Outer>
  );
}
