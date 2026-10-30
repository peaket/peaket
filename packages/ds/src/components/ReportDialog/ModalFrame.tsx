'use client';
// CMP-019 list·form과 CMP-075가 함께 쓰는 겹침 창 틀(보드 SCR-016 후기 전체·쓰기·신고·신고 확인 모달).
// - 휴대폰(768 미만): 화면 전체를 덮는 창. 위 56px 머리 줄에 왼쪽 닫기 아이콘과 제목(h2), 그 아래가 스크롤된다.
// - 태블릿·데스크톱(md 이상): 키트 14절 .scrim + .dialog 모양의 가운데 대화상자.
//   list는 높이를 정하고(머리 고정, 목록만 스크롤), form은 위에서 48px 띄워 바탕이 스크롤, confirm은 가운데 작은 창.
// - 초점: 열리면 제목(tabIndex -1)으로 옮긴다(안에 이미 초점이 있으면 그대로 — 오류 요약이 첫 오류로 옮긴 경우).
//   Tab·Shift+Tab을 안에서 돌리고 Esc로 onEscape(없으면 onClose)를 부른다. 열린 동안 바탕 스크롤을 막는다.
// - 같은 자리에서 창을 바꿔 여는 화면(후기 → 신고 → 확인)은 restoreFocus={false}로 두고 초점 되돌리기를 화면이 맡는다.
// ds Dialog에 전체 화면 배치가 생기면 그것으로 바꾼다. 키트 클래스는 고치지 않고 반응형 유틸로 합쳤다.
import { useEffect, useId, useRef, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { cx } from '../../lib/cx';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.getClientRects().length > 0);
}

export type ModalFrameLayout = 'list' | 'form' | 'confirm';

export interface ModalFrameProps {
  open: boolean;
  /** 닫기 아이콘·바탕 누르기가 부른다 */
  onClose: () => void;
  /** Esc가 부른다. 없으면 onClose */
  onEscape?: () => void;
  title: ReactNode;
  /** 닫기 아이콘 이름(예: '후기 신고 닫기'). hideClose면 그리지 않는다 */
  closeLabel?: string;
  hideClose?: boolean;
  role?: 'dialog' | 'alertdialog';
  describedBy?: string;
  layout?: ModalFrameLayout;
  /** md 이상 대화상자 최대 폭(px) */
  maxWidth?: number;
  /** lg(1280) 이상 최대 폭(px). 없으면 maxWidth */
  maxWidthLg?: number;
  /** list에서 md 이상 창 높이(px). 화면 높이의 85%를 넘지 않는다 */
  height?: number;
  /** list에서 lg 이상 창 높이(px). 없으면 height */
  heightLg?: number;
  /** 제목 아래 머리 글(별점 요약·안내, 쓰기 모달의 공연명). md 이상에서는 머리에 고정, 휴대폰은 본문 맨 위 */
  header?: ReactNode;
  /** 닫히면 연 요소로 초점을 되돌린다. 기본 참 */
  restoreFocus?: boolean;
  /** 스크롤 영역에 aria-busy 등 */
  busy?: boolean;
  children: ReactNode;
}

export function ModalFrame({
  open,
  onClose,
  onEscape,
  title,
  closeLabel = '닫기',
  hideClose = false,
  role = 'dialog',
  describedBy,
  layout = 'form',
  maxWidth = 600,
  maxWidthLg,
  height = 640,
  heightLg,
  header,
  restoreFocus = true,
  busy,
  children,
}: ModalFrameProps) {
  const titleId = `${useId()}-title`;
  const panelRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const escRef = useRef(onEscape ?? onClose);
  escRef.current = onEscape ?? onClose;

  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const panel = panelRef.current;
    if (panel && !panel.contains(document.activeElement)) titleRef.current?.focus({ preventScroll: true });
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prevOverflow;
      if (restoreFocus && opener && document.contains(opener)) opener.focus({ preventScroll: true });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      escRef.current();
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
    if (event.shiftKey && (active === first || active === titleRef.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const isList = layout === 'list';
  const isForm = layout === 'form';
  const style = {
    '--pk-modal-max': `${maxWidth}px`,
    '--pk-modal-max-lg': `${maxWidthLg ?? maxWidth}px`,
    '--pk-modal-h': `${height}px`,
    '--pk-modal-h-lg': `${heightLg ?? height}px`,
  } as CSSProperties;

  return (
    <div
      className={cx(
        'fixed inset-0 z-[100] flex flex-col bg-(--surface) md:bg-(--scrim) md:p-4',
        isForm ? 'md:items-center md:overflow-auto md:px-4 md:py-12' : 'md:items-center md:justify-center',
      )}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={describedBy}
        onKeyDown={onKeyDown}
        style={style}
        className={cx(
          'flex min-h-0 w-full flex-1 flex-col overflow-auto text-(--text)',
          'md:max-w-(--pk-modal-max) lg:max-w-(--pk-modal-max-lg) md:flex-none md:rounded-(--r-xl) md:bg-(--surface-raised) md:shadow-(--shadow-lg)',
          isList ? 'md:h-[min(var(--pk-modal-h),85dvh)] md:overflow-hidden lg:h-[min(var(--pk-modal-h-lg),85dvh)]' : 'md:gap-4 md:overflow-visible md:p-6',
        )}
      >
        <div className={cx('contents md:flex md:flex-none md:flex-col', isList ? 'md:gap-3 md:border-b md:border-(--border) md:px-6 md:pt-5 md:pb-4' : 'md:gap-0.5')}>
          <div
            className={cx(
              'sticky top-0 z-[1] row h-14 flex-none gap-1 border-b border-(--border) bg-(--surface)',
              hideClose ? 'px-4' : 'pr-2 pl-1',
              'md:static md:h-auto md:items-start md:justify-between md:gap-2 md:border-0 md:bg-transparent md:p-0',
            )}
          >
            {hideClose ? null : (
              <button className="icon-btn md:order-2 md:-mt-2 md:-mr-2.5" type="button" aria-label={closeLabel} onClick={onClose}>
                <i className="ic ic-close" aria-hidden="true" />
              </button>
            )}
            <h2
              ref={titleRef}
              className="t-md fw-b grow outline-none md:text-[20px] md:leading-[27px]"
              id={titleId}
              tabIndex={-1}
            >
              {title}
            </h2>
          </div>
          {header ? <div className={cx('col gap-4 px-4 pt-4 md:p-0', isList ? 'md:gap-3' : 'md:gap-0.5')}>{header}</div> : null}
        </div>
        <div
          className={cx(
            'col flex-none gap-4 px-4 pt-4 pb-8',
            layout === 'confirm' && 'gap-5 pt-5',
            isList ? 'md:min-h-0 md:flex-1 md:gap-3 md:overflow-auto md:px-6 md:pt-4 md:pb-6' : 'md:gap-4 md:p-0',
          )}
          aria-busy={busy || undefined}
        >
          {children}
        </div>
      </div>
    </div>
  );
}
