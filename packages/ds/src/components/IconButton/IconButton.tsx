'use client';
// CMP-003 IconButton. 캔버스 키트 .icon-btn 마크업을 그대로 낸다.
// - label(aria-label)은 필수다. 카드 안 버튼은 대상 이름을 넣는다("LUMEN 공식 응원봉 장바구니에 담기").
// - size: md 44×44(터치 최소 44) · sm 32. variant: ghost(바탕 없음) · outline(테두리와 바탕, 카드 안).
// - pressed를 주면 켜고 끄는 버튼(aria-pressed)이다. 켜지면 pressedIcon(채운 아이콘)으로 바뀌고 이름은 그대로다.
//   outline이 켜지면 바탕 primary-subtle·테두리 primary(보드의 오픈 알림 토글).
// - count는 오른쪽 위 숫자 점(.count-dot)이다. 이름에도 숫자를 넣는다("알림함 3건").
// - 품절처럼 이유 있는 비활성은 disabledReasonId(늘 보이는 배지·글의 id)를 준다(d2 §3.6).
import { forwardRef, type ButtonHTMLAttributes, type MouseEvent } from 'react';
import { joinIds } from '../../lib/aria';
import { cx } from '../../lib/cx';
import { Icon, type IconName } from '../../icons';

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'aria-label'> {
  /** 버튼 이름(aria-label). 필수 */
  label: string;
  icon: IconName;
  /** 켜졌을 때 아이콘(ic-bell-fill 등) */
  pressedIcon?: IconName;
  /** 켜고 끄는 버튼이면 지금 상태 */
  pressed?: boolean;
  size?: 'sm' | 'md';
  variant?: 'ghost' | 'outline';
  /** 오른쪽 위 숫자 점 */
  count?: number;
  /** 이유 있는 비활성: 이유 글의 id */
  disabledReasonId?: string;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  {
    label,
    icon,
    pressedIcon,
    pressed,
    size = 'md',
    variant = 'ghost',
    count,
    disabledReasonId,
    type = 'button',
    className,
    style,
    onClick,
    'aria-describedby': describedBy,
    ...rest
  },
  ref,
) {
  const blocked = Boolean(disabledReasonId);
  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    if (blocked) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    onClick?.(event);
  };
  const pressedLook = pressed && variant === 'outline' && !blocked;
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      aria-pressed={pressed === undefined ? undefined : pressed}
      aria-disabled={blocked ? true : undefined}
      aria-describedby={joinIds(describedBy, disabledReasonId)}
      className={cx('icon-btn', size === 'sm' && 'icon-btn-sm', variant === 'outline' && 'icon-btn-outline', className)}
      style={pressedLook ? { background: 'var(--primary-subtle)', borderColor: 'var(--primary)', ...style } : style}
      onClick={handleClick}
      {...rest}
    >
      <Icon name={pressed && pressedIcon ? pressedIcon : icon} />
      {count !== undefined && count > 0 ? (
        <span className="count-dot" aria-hidden="true">
          {count > 99 ? '99+' : count}
        </span>
      ) : null}
    </button>
  );
});
