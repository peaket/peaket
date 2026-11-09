'use client';
// CMP-019 Dialog. 캔버스 키트 14절 .scrim + .dialog(가운데 대화상자) / .scrim.bottom + .sheet(바텀 시트) 마크업을 그대로 내고,
// 동작은 SEED 동작 부품 @seed-design/react-dialog에 맡긴다(ADR-0192 결정 2).
// - role="dialog"(기본) 또는 "alertdialog"(시간 제한 경고·위험 확인), aria-modal, 제목은 aria-labelledby, 설명은 aria-describedby.
// - SEED가 하는 것: 초점 가두기(Tab·Shift+Tab이 안에서 돈다), 열린 동안 바깥 내용을 보조기기에서 숨기기(hideOthers),
//   Esc·바깥(scrim) 누르기로 닫기(겹친 층은 맨 위만, dismissible이 거짓이면 닫지 않는다), 바탕 스크롤 막기(iOS 포함).
// - 이 부품이 하는 것: 열릴 때 초점을 initialFocus(없으면 첫 초점 가능 요소)로 옮기고(SEED 기본은 대화상자 자신),
//   닫힐 때 연 요소로 되돌린다. SEED 초점 범위는 대화상자 요소를 ref로 받아 다음 커밋에서야 효과가 돌아, 그때는 이 부품이
//   이미 안으로 초점을 옮긴 뒤다. 그래서 SEED 쪽 첫 초점은 건너뛰고, 대화상자 안 요소를 되돌릴 곳으로 기억한다.
//   되돌리기는 어떤 효과보다 먼저 도는 레이아웃 효과에서 연 요소를 기억해 이 부품이 한다(2026-11-04 재현 시험).
// - layout: dialog · sheet · auto(휴대폰 배치 md 768 미만은 시트, 그 위는 대화상자. d2 info 변형).
// - 키트의 .scrim은 보드 안 절대 위치라 화면에서는 position:fixed로 덮는다(인라인 스타일, 코드 값).
// - 모달 위에 모달을 겹치지 않는다(d2). 상태 미리보기는 open을 참으로 두고 그린다(서버에서도 열린 채로 그려진다).
import { DialogContent, DialogDescription, DialogPositioner, DialogRoot, DialogTitle } from '@seed-design/react-dialog';
import { useEffect, useId, useLayoutEffect, useRef, type CSSProperties, type ReactNode, type RefObject } from 'react';
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

function firstFocusable(root: HTMLElement): HTMLElement | undefined {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).find((el) => !el.hasAttribute('hidden') && el.getClientRects().length > 0);
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

  // 연 요소를 기억했다가 닫힐 때(또는 열린 채 사라질 때) 되돌린다. 레이아웃 효과라 초점을 옮기는 어떤 효과보다 먼저 돈다
  useLayoutEffect(() => {
    if (!open) return;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      if (trigger && document.contains(trigger)) trigger.focus();
    };
  }, [open]);

  // 열린 첫 커밋에서 initialFocus나 첫 초점 가능 요소로 옮긴다(SEED 초점 범위의 효과는 그다음 커밋에 돈다)
  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    const target = initialFocus?.current ?? (panel ? firstFocusable(panel) : undefined) ?? panel;
    target?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

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
    <DialogTitle className={sheet ? 't-lg' : 'dialog-title'} id={titleId}>
      {title}
    </DialogTitle>
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
    <DialogRoot
      open
      onOpenChange={(next) => {
        if (!next) onCloseRef.current();
      }}
      role={role}
      closeOnEscape={dismissible}
      closeOnInteractOutside={dismissible}
    >
      <DialogPositioner className={cx('scrim', sheet && 'bottom')} style={{ position: 'fixed', ...(sheet ? null : { overflowY: 'auto' }) }}>
        <DialogContent
          ref={panelRef}
          className={cx(sheet ? 'sheet' : 'dialog', className)}
          aria-labelledby={titleId}
          aria-describedby={[description ? descId : '', describedBy ?? ''].filter(Boolean).join(' ') || undefined}
          tabIndex={-1}
          style={{ ...(maxWidth && !sheet ? { maxWidth } : null), ...(sheet ? { maxHeight: '90dvh', overflowY: 'auto' } : null), ...style }}
        >
          {sheet ? <span className="sheet-handle" aria-hidden="true" /> : null}
          {head}
          {description ? (
            <DialogDescription className="t-sm" id={descId}>
              {description}
            </DialogDescription>
          ) : null}
          {children}
          {actions ? sheet ? actions : <div className="dialog-actions">{actions}</div> : null}
          {footnote ? <p className="t-xs muted">{footnote}</p> : null}
        </DialogContent>
      </DialogPositioner>
    </DialogRoot>
  );
}
