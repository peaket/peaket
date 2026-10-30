'use client';
// 소비자 웹의 겹침 창(CMP-019 대화상자·CMP-043 시트의 쓰임). 휴대폰(768 미만)은 아래 시트, 태블릿·데스크톱은 가운데 대화상자다
// (d5 §3.1 로그아웃 확인 "휴대폰은 아래 시트, 태블릿·데스크톱은 대화상자", §5.2 안내 모달 "sm은 바텀 시트").
// 캔버스 키트 14절 .scrim·.sheet·.dialog 모양을 반응형 유틸 하나로 합쳤다(kit.css는 고치지 않는다).
// ds의 Dialog 부품이 생기면 그것으로 바꾼다. 초점 가두기·Esc·바탕 누르기 닫기·바탕 스크롤 막기를 한다.
import { useId, useRef, type CSSProperties, type ReactNode } from "react";
import { cx } from "../../lib/cx";
import { useFocusTrap, useScrollLock } from "./focus-trap";

export type WebShellModalKind = "responsive" | "sheet" | "dialog";

export interface WebShellModalProps {
  open: boolean;
  onClose: () => void;
  /** 제목(h2). aria-labelledby로 잇는다 */
  title: ReactNode;
  /** 제목 위 줄(보드의 단계 글 '부스 재발급 1/3단계', '카카오로 다시 로그인했습니다' 등). 글이면 키트 .eyebrow로 감싸고, 요소면 그대로 그린다. 창 이름에는 넣지 않는다 */
  eyebrow?: ReactNode;
  /** 제목 위 동그란 아이콘(키트 .state-icon 안에 넣을 <i class="ic …">) */
  icon?: ReactNode;
  /** state-icon 색(is-primary·is-warning·is-danger·is-success) */
  iconTone?: "primary" | "warning" | "danger" | "success" | "neutral";
  /** 본문 설명 요소의 id(aria-describedby) */
  describedBy?: string;
  /** 'responsive'(휴대폰 시트, 그 위 대화상자) · 'sheet'(늘 시트) · 'dialog'(늘 대화상자) */
  kind?: WebShellModalKind;
  /** 대화상자 최대 폭(px, 기본 420) */
  maxWidth?: number;
  /** 제목 오른쪽 닫기 아이콘 버튼의 이름. 주면 그린다(예: '예매 안내사항 닫기') */
  closeLabel?: string;
  /** 내용이 길면 창 안에서 스크롤한다 */
  scroll?: boolean;
  /** 아래 버튼 묶음. 휴대폰 시트는 위에서 아래로 쌓고(첫 버튼이 위), 대화상자는 오른쪽 정렬 한 줄(첫 버튼이 오른쪽 끝) */
  actions?: ReactNode;
  /** 대화상자 버튼 줄을 양끝 정렬(왼쪽 글자 버튼 + 오른쪽 주 버튼) */
  actionsSpread?: boolean;
  children?: ReactNode;
}

/**
 * 겹침 창 버튼 클래스. 휴대폰 시트에서는 큰 꽉 찬 버튼, 대화상자에서는 보통 크기 버튼이다.
 * variant: 키트 버튼 변형(primary·secondary·ghost·danger·outline·text)
 */
export function webModalButtonClass(variant: "primary" | "secondary" | "ghost" | "danger" | "outline" | "text", kind: WebShellModalKind = "responsive") {
  if (variant === "text") return "btn btn-text self-center md:self-auto";
  if (kind === "dialog") return `btn btn-${variant}`;
  const base = `btn btn-${variant} btn-block`;
  const big = variant === "ghost" ? "" : "btn-lg";
  if (kind === "sheet") return cx(base, big);
  return cx(base, big, "md:inline-flex md:w-auto md:min-h-10 md:px-4 md:text-sm md:leading-[19px] md:rounded-(--r-md)");
}

const toneClass = { primary: "is-primary", warning: "is-warning", danger: "is-danger", success: "is-success", neutral: "" } as const;

export function WebShellModal({
  open,
  onClose,
  title,
  eyebrow,
  icon,
  iconTone = "neutral",
  describedBy,
  kind = "responsive",
  maxWidth = 420,
  closeLabel,
  scroll = false,
  actions,
  actionsSpread = false,
  children,
}: WebShellModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = `${useId()}-title`;
  useFocusTrap(panelRef, open, onClose);
  useScrollLock(open);
  if (!open) return null;

  const isSheetMobile = kind !== "dialog";
  const isDialogDesktop = kind !== "sheet";
  const style = { "--pk-modal-max": `${maxWidth}px` } as CSSProperties;

  return (
    <div
      className={cx(
        "scrim fixed",
        isSheetMobile && "bottom",
        kind === "responsive" && "md:items-center md:p-4",
      )}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={describedBy}
        tabIndex={-1}
        style={style}
        className={cx(
          kind === "dialog" ? "dialog max-w-(--pk-modal-max)" : "sheet",
          kind === "responsive" && "md:max-w-(--pk-modal-max) md:rounded-(--r-xl) md:p-6 md:gap-4",
          scroll && "max-h-[90dvh] overflow-auto md:max-h-[85dvh]",
        )}
      >
        {isSheetMobile && <span className={cx("sheet-handle", isDialogDesktop && "md:hidden")} aria-hidden="true" />}
        {icon ? (
          <span className={cx("state-icon", toneClass[iconTone])} style={{ width: 56, height: 56, alignSelf: "flex-start" }}>
            {icon}
          </span>
        ) : null}
        {eyebrow == null || eyebrow === false ? null : typeof eyebrow === "string" || typeof eyebrow === "number" ? (
          <span className="eyebrow">{eyebrow}</span>
        ) : (
          eyebrow
        )}
        {closeLabel ? (
          <div className="row between" style={{ alignItems: "flex-start" }}>
            <h2 className="t-lg" id={titleId}>
              {title}
            </h2>
            <button className="icon-btn" type="button" aria-label={closeLabel} onClick={onClose} style={{ marginTop: -8, marginRight: -10 }}>
              <i className="ic ic-close" aria-hidden="true" />
            </button>
          </div>
        ) : (
          <h2 className="t-lg" id={titleId}>
            {title}
          </h2>
        )}
        {children}
        {actions ? (
          <div
            className={cx(
              kind === "dialog"
                ? cx("dialog-actions", actionsSpread ? "justify-between! items-center" : "flex-row-reverse justify-start!")
                : "col gap-2",
              kind === "responsive" &&
                cx("md:flex-row-reverse md:flex-wrap md:items-center", actionsSpread ? "md:justify-between" : "md:justify-start"),
            )}
          >
            {actions}
          </div>
        ) : null}
      </div>
    </div>
  );
}
