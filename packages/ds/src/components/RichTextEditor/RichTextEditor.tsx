'use client';
// CMP-070 RichTextEditor — 모양만(퍼블리싱). 공연 설명 같은 서식 있는 글을 쓰는 자리다(d2 §2, d5 §6.4).
// 서식 도구 막대는 role="toolbar"이고 방향키(←→·Home·End)로 버튼 사이를 옮긴다(로빙 tabindex). 편집 영역은 textbox + aria-multiline.
// 실제 편집기(Lexical·Tiptap 중 PoC FE-T41로 고름)와 구조 문서(JSON) 저장은 붙이지 않는다. 버튼은 눌림 상태(aria-pressed)만 바꾼다.
// 처음 내용(children)은 서버 부품이 만든 React 요소로 받는다(HTML 문자열을 넣지 않는다).
import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";

export interface RichTextEditorProps {
  id: string;
  /** 라벨 요소 id(aria-labelledby) */
  labelledBy: string;
  /** 처음 보이는 내용 */
  children?: ReactNode;
  /** 편집 영역 아래 도움말 */
  hint?: ReactNode;
  /** 남은 글자 안내(예: '남은 글자 1,918자') */
  counter?: ReactNode;
  /** 도구 막대 이름 */
  toolbarLabel?: string;
  minHeight?: number;
  disabled?: boolean;
  /** 오류 문구(있으면 error 상태) */
  error?: string;
}

const TOOLS: readonly { key: string; label: string; icon?: string; toggle: boolean }[] = [
  { key: "bold", label: "굵게", toggle: true },
  { key: "italic", label: "기울임", toggle: true },
  { key: "list", label: "목록", icon: "ic-list", toggle: true },
  { key: "link", label: "링크", icon: "ic-link", toggle: false },
];

export function RichTextEditor({
  id,
  labelledBy,
  children,
  hint,
  counter,
  toolbarLabel = "서식",
  minHeight = 128,
  disabled = false,
  error,
}: RichTextEditorProps) {
  const [pressed, setPressed] = useState<Record<string, boolean>>({});
  const [focusIndex, setFocusIndex] = useState(0);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const hintId = `${id}-h`;
  const counterId = `${id}-c`;
  const errorId = `${id}-e`;
  const describedBy = [hint ? hintId : null, counter ? counterId : null, error ? errorId : null].filter(Boolean).join(" ") || undefined;

  function onToolbarKey(e: KeyboardEvent<HTMLDivElement>) {
    const last = TOOLS.length - 1;
    let next = focusIndex;
    if (e.key === "ArrowRight") next = focusIndex === last ? 0 : focusIndex + 1;
    else if (e.key === "ArrowLeft") next = focusIndex === 0 ? last : focusIndex - 1;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = last;
    else return;
    e.preventDefault();
    setFocusIndex(next);
    toolbarRef.current?.querySelectorAll<HTMLButtonElement>("button")[next]?.focus();
  }

  return (
    <div className="col" style={{ gap: 6 }}>
      <div
        className="col"
        style={{
          border: `1px solid ${error ? "var(--danger)" : "var(--border-input)"}`,
          borderRadius: "var(--r-md)",
          overflow: "hidden",
          background: disabled ? "var(--surface-disabled)" : "var(--surface)",
        }}
      >
        <div
          ref={toolbarRef}
          className="toolbar"
          role="toolbar"
          aria-label={toolbarLabel}
          aria-controls={id}
          onKeyDown={onToolbarKey}
          style={{ gap: 2, padding: "4px 6px", borderBottom: "1px solid var(--border)", background: "var(--surface-muted)" }}
        >
          {TOOLS.map((t, i) => (
            <button
              key={t.key}
              className="btn btn-ghost btn-sm"
              type="button"
              tabIndex={i === focusIndex ? 0 : -1}
              aria-pressed={t.toggle ? !!pressed[t.key] : undefined}
              disabled={disabled}
              onClick={() => {
                setFocusIndex(i);
                if (t.toggle) setPressed((p) => ({ ...p, [t.key]: !p[t.key] }));
              }}
            >
              {t.icon ? <i className={`ic ${t.icon}`} aria-hidden="true" /> : null}
              {t.label}
            </button>
          ))}
        </div>
        <div
          className="prose"
          id={id}
          role="textbox"
          aria-multiline="true"
          aria-labelledby={labelledBy}
          aria-describedby={describedBy}
          aria-invalid={error ? true : undefined}
          aria-disabled={disabled || undefined}
          contentEditable={!disabled}
          suppressContentEditableWarning
          tabIndex={0}
          style={{ minHeight, padding: "12px 14px", outlineOffset: -2 }}
        >
          {children}
        </div>
      </div>
      {error ? (
        <span className="error-msg" id={errorId}>
          <i className="ic ic-alert-circle" aria-hidden="true" />
          {error}
        </span>
      ) : null}
      {hint || counter ? (
        <div className="row between" style={{ gap: 12 }}>
          {hint ? (
            <span className="hint" id={hintId}>
              {hint}
            </span>
          ) : (
            <span />
          )}
          {counter ? (
            <span className="counter nowrap" id={counterId} aria-live="polite">
              {counter}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
