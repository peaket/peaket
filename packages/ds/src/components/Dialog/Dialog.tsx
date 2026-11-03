'use client';
// CMP-019 Dialog. 캔버스 키트 14절 .scrim + .dialog(가운데 대화상자) / .scrim.bottom + .sheet(바텀 시트) 마크업을 그대로 낸다.
// - role="dialog"(기본) 또는 "alertdialog"(시간 제한 경고·위험 확인), aria-modal, 제목은 aria-labelledby, 설명은 aria-describedby.
// - 열리면 초점을 안으로 옮기고(initialFocus 또는 첫 초점 가능 요소) Tab·Shift+Tab을 안에서 돌린다(초점 가두기).
//   Esc와 바깥(scrim) 누르기로 닫고(dismissible), 닫히면 연 요소(트리거)로 초점을 되돌린다. 열린 동안 바탕 스크롤을 막는다.
// - layout: dialog · sheet · auto(휴대폰 배치 md 768 미만은 시트, 그 위는 대화상자. d2 info 변형).
// - 키트의 .scrim은 보드 안 절대 위치라 화면에서는 position:fixed로 덮는다(인라인 스타일, 코드 값).
// - 모달 위에 모달을 겹치지 않는다(d2). 상태 미리보기는 open을 참으로 두고 그린다(서버에서도 열린 채로 그려진다).
import {
  useEffect,
  useId,
  useRef,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { cx } from '../../lib/cx';
import { useMediaQuery } from '../../lib/hooks';
import { Icon, type IconName } from '../../icons';

export type DialogIconTone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger';

export interface DialogProps {
  open: boolean;
  /** Esc·바깥 누르기·닫기 행동이 부른다 */
  onClose: () => void;
  title: ReactNode;
  /** 제목 아래 설명(<p class="t-sm">, aria-describedby로 잇는다) */
  description?: ReactNode;
  /** 제목 위(또는 옆) 상태 아이콘(.state-icon) */
  icon?: IconName;
  iconTone?: DialogIconTone;
  /** stack: 아이콘을 제목 위에(56px) · inline: 제목 왼쪽에(44px, 관제 위험 확인) */
  iconPlacement?: 'stack' | 'inline';
  /** 제목 줄 오른쪽(타이머 등, inline일 때) */
  titleAside?: ReactNode;
  children?: ReactNode;
  /** 행동 버튼들. 대화상자는 .dialog-actions(오른쪽 정렬) 안에, 시트는 세로로 쌓는다 */
  actions?: ReactNode;
  /** 행동 아래 작은 글(.t-xs.muted) */
  footnote?: ReactNode;
  layout?: 'dialog' | 'sheet' | 'auto';
  role?: 'dialog' | 'alertdialog';
  /** 대화상자 최대 폭(px). 키트 기본 420 */
  maxWidth?: number;
  /** 열릴 때 초점을 둘 요소. 없으면 첫 초점 가능 요소(alertdialog는 행동 버튼에 두기를 권한다) */
  initialFocus?: RefObject<HTMLElement | null>;
  /** Esc·바깥 누르기로 닫힘. 기본 참 */
  dismissible?: boolean;
  /** 추가 aria-describedby id(설명 밖의 배너 등) */
  describedBy?: string;
  className?: string;
  style?: CSSProperties;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => !el.hasAttribute('hidden') && el.getClientRects().length > 0);
}

export function Dialog({
  open,
  onClose,
  title,
  description,
  icon,
  iconTone = 'neutral',
  iconPlacement = 'stack',
  titleAside,
  children,
  actions,
  footnote,
  layout = 'dialog',
  role = 'dialog',
  maxWidth,
  initialFocus,
  dismissible = true,
  describedBy,
  className,
  style,
}: DialogProps) {
  const base = useId();
  const titleId = `${base}-title`;
  const descId = `${base}-desc`;
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const wide = useMediaQuery('(min-width: 768px)', true);
  const sheet = layout === 'sheet' || (layout === 'auto' && !wide);

  // 열릴 때: 트리거 기억 → 안으로 초점 → 바탕 스크롤 막기. 닫힐 때: 되돌리기
  useEffect(() => {
    if (!open) return;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const panel = panelRef.current;
    const target = initialFocus?.current ?? (panel ? focusables(panel)[0] : undefined) ?? panel;
    target?.focus();
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prevOverflow;
      if (trigger && document.contains(trigger)) trigger.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape' && dismissible) {
      event.stopPropagation();
      onCloseRef.current();
      return;
    }
    if (event.key !== 'Tab' || !panelRef.current) return;
    const list = focusables(panelRef.current);
    if (list.length === 0) {
      event.preventDefault();
      return;
    }
    const first = list[0]!;
    const last = list[list.length - 1]!;
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === panelRef.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const onScrimDown = (event: MouseEvent<HTMLDivElement>) => {
    if (dismissible && event.target === event.currentTarget) onCloseRef.current();
  };

  const iconSize = iconPlacement === 'inline' ? 44 : 56;
  const iconEl = icon ? (
    <span
      className={cx('state-icon', iconTone !== 'neutral' && `is-${iconTone}`)}
      style={{ width: iconSize, height: iconSize, flex: 'none', ...(sheet && iconPlacement === 'stack' ? { alignSelf: 'flex-start' } : null) }}
    >
      <Icon name={icon} />
    </span>
  ) : null;
  const titleEl = (
    <h2 className={sheet ? 't-lg' : 'dialog-title'} id={titleId}>
      {title}
    </h2>
  );
  const head =
    iconPlacement === 'inline' ? (
      <div className={cx('row', titleAside ? 'between' : undefined)} style={{ gap: 12 }}>
        <div className="row" style={{ gap: 12 }}>
          {iconEl}
          {titleEl}
        </div>
        {titleAside}
      </div>
    ) : (
      <>
        {iconEl}
        {titleEl}
      </>
    );

  return (
    <div
      className={cx('scrim', sheet && 'bottom')}
      style={{ position: 'fixed', ...(sheet ? null : { overflowY: 'auto' }) }}
      onMouseDown={onScrimDown}
    >
      <div
        ref={panelRef}
        className={cx(sheet ? 'sheet' : 'dialog', className)}
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={[description ? descId : '', describedBy ?? ''].filter(Boolean).join(' ') || undefined}
        tabIndex={-1}
        style={{ ...(maxWidth && !sheet ? { maxWidth } : null), ...(sheet ? { maxHeight: '90dvh', overflowY: 'auto' } : null), ...style }}
        onKeyDown={onKeyDown}
      >
        {sheet ? <span className="sheet-handle" aria-hidden="true" /> : null}
        {head}
        {description ? (
          <p className="t-sm" id={descId}>
            {description}
          </p>
        ) : null}
        {children}
        {actions ? sheet ? actions : <div className="dialog-actions">{actions}</div> : null}
        {footnote ? <p className="t-xs muted">{footnote}</p> : null}
      </div>
    </div>
  );
}
