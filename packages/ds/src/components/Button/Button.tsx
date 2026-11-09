'use client';
// CMP-001 Button. 캔버스 키트 .btn 마크업을 그대로 낸다(Main.dc.html '버튼').
// - 행동을 실행한다. 화면 이동은 Link나 ButtonLink(버튼 모양 링크)를 쓴다.
// - loading: 앞에 .spinner를 두고 aria-busy="true", 누르기를 막는다.
// - 이유 있는 비활성(d2 §3.6): disabled 대신 disabledReason을 주면 aria-disabled="true"로 초점은 받고
//   누르기·Enter·Space·폼 제출은 막으며, 버튼 바로 뒤에 늘 보이는 이유 글(<p class="t-sm">)을 두고 aria-describedby로 잇는다.
//   SEED의 비활성 표시 data-disabled도 단다(ADR-0192 결정 4).
//   이유 글을 화면의 다른 곳(배너 등)에 둘 때는 그 요소의 id를 disabledReasonId로 준다(이 부품은 글을 그리지 않는다).
// - 제공자 버튼(kakao·naver·google)은 앞에 제공자 로고(.prov)를 둔다. 로고는 자리 그림이고 구현 때 제공자 배포 파일로 바꾼다.
import { forwardRef, useId, type ButtonHTMLAttributes, type MouseEvent, type ReactNode } from 'react';
import { joinIds } from '../../lib/aria';
import { cx } from '../../lib/cx';
import { Icon, type IconName } from '../../icons';
import { buttonClass, isProvider, type ButtonSize, type ButtonVariant } from './buttonClass';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** 줄 폭을 다 쓴다 */
  block?: boolean;
  /** 비동기 작업 중 */
  loading?: boolean;
  /** 레이블 앞 아이콘(장식) */
  icon?: IconName;
  /** 레이블 뒤 아이콘(장식) */
  iconEnd?: IconName;
  /** 이유 있는 비활성: 버튼 뒤에 늘 보이는 이유 글 */
  disabledReason?: ReactNode;
  /** 이유 있는 비활성: 화면의 다른 곳에 둔 이유 글의 id */
  disabledReasonId?: string;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'primary',
    size = 'md',
    block = false,
    loading = false,
    icon,
    iconEnd,
    disabledReason,
    disabledReasonId,
    type = 'button',
    className,
    onClick,
    children,
    'aria-describedby': describedBy,
    ...rest
  },
  ref,
) {
  const reasonId = `${useId()}-reason`;
  const ownReason = disabledReason !== undefined && disabledReason !== null && !disabledReasonId;
  const reasoned = ownReason || Boolean(disabledReasonId);
  const blocked = reasoned || loading;

  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    if (blocked) {
      // aria-disabled 버튼은 초점을 받으므로 누르기·Enter·Space(모두 click으로 온다)와 폼 제출을 여기서 막는다
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    onClick?.(event);
  };

  const button = (
    <button
      ref={ref}
      type={type}
      className={cx(buttonClass({ variant, size, block }), className)}
      aria-disabled={reasoned ? true : undefined}
      // SEED의 비활성 표시(d2 §3.6). SEED 부품의 recipe와 키트 .btn[aria-disabled]가 같은 비활성 모양을 쓴다
      data-disabled={reasoned ? '' : undefined}
      aria-busy={loading ? true : undefined}
      aria-describedby={joinIds(describedBy, disabledReasonId, ownReason && reasonId)}
      onClick={handleClick}
      {...rest}
    >
      {loading ? <span className="spinner" aria-hidden="true" /> : null}
      {isProvider(variant) ? <i className={`prov prov-${variant}`} aria-hidden="true" /> : null}
      {icon && !loading ? <Icon name={icon} /> : null}
      {children}
      {iconEnd ? <Icon name={iconEnd} /> : null}
    </button>
  );

  if (!ownReason) return button;
  return (
    <>
      {button}
      <p className="t-sm" id={reasonId}>
        {disabledReason}
      </p>
    </>
  );
});
