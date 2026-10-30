// CMP-018 Toast 한 장(캔버스 키트 10절 .toast). 서버 컴포넌트에서도 쓴다.
// 상태 미리보기처럼 화면에 고정해 그릴 때 이것을 쓰고, 실제로 띄우고 사라지게 할 때는 toast()와 <Toaster />를 쓴다.
// 치명적인 오류에는 쓰지 않는다(Dialog).
import type { CSSProperties, ReactNode } from 'react';
import { cx } from '../../lib/cx';
import { Icon, type IconName } from '../../icons';

export type ToastTone = 'success' | 'info' | 'error';

export const toastIcon: Record<ToastTone, IconName> = {
  success: 'check-circle',
  info: 'info',
  error: 'alert-circle',
};

export interface ToastProps {
  tone?: ToastTone;
  /** 아이콘을 바꾼다(보드의 '찜 저장'은 check) */
  icon?: IconName;
  children: ReactNode;
  /** 오른쪽 끝 행동('장바구니 보기 ›' 링크 등) */
  action?: ReactNode;
  /** 정적 미리보기면 status(기본). Toaster 안에서는 바깥 영역이 알리므로 null */
  role?: 'status' | null;
  className?: string;
  style?: CSSProperties;
}

export function Toast({ tone = 'success', icon, children, action, role = 'status', className, style }: ToastProps) {
  return (
    <div className={cx('toast', className)} role={role ?? undefined} style={style}>
      <Icon name={icon ?? toastIcon[tone]} />
      <span className="grow">{children}</span>
      {action}
    </div>
  );
}
