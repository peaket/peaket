'use client';
// CMP-011 Toggle(스위치). 보드 마크업: <label class="check-row" style="align-items:center"><input class="sw" type="checkbox" role="switch">취소표 알림</label>
// - 네이티브 체크박스에 role="switch"라 켜짐 상태(aria-checked)를 브라우저가 맞춘다.
// - labelFirst: 설정 목록처럼 글자를 왼쪽, 스위치를 오른쪽 끝에 둔다(.between).
// - 힌트·이유 글(잠긴 이유 등)은 hint로 주면 아래에 두고 aria-describedby로 잇는다.
import { forwardRef, type ChangeEvent, type CSSProperties, type InputHTMLAttributes, type ReactNode } from 'react';
import { joinIds } from '../../lib/aria';
import { cx } from '../../lib/cx';

export interface ToggleProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'id' | 'role'> {
  id: string;
  label: ReactNode;
  hint?: ReactNode;
  onCheckedChange?: (checked: boolean) => void;
  labelFirst?: boolean;
  /** 바깥 label 스타일(보드의 min-height·글자 크기 등) */
  rowStyle?: CSSProperties;
  rowClassName?: string;
}

export const Toggle = forwardRef<HTMLInputElement, ToggleProps>(function Toggle(
  { id, label, hint, onCheckedChange, onChange, labelFirst = false, rowStyle, rowClassName, className, 'aria-describedby': describedBy, ...rest },
  ref,
) {
  const hintId = `${id}-hint`;
  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    onChange?.(event);
    onCheckedChange?.(event.target.checked);
  };
  const input = (
    <input
      ref={ref}
      id={id}
      className={cx('sw', className)}
      type="checkbox"
      role="switch"
      aria-describedby={joinIds(hint ? hintId : undefined, describedBy)}
      onChange={handleChange}
      {...rest}
    />
  );
  const row = (
    <label
      className={cx('check-row', labelFirst && 'between', !hint && rowClassName)}
      htmlFor={id}
      style={{ alignItems: 'center', ...rowStyle }}
    >
      {labelFirst ? (
        <>
          <span>{label}</span>
          {input}
        </>
      ) : (
        <>
          {input}
          {label}
        </>
      )}
    </label>
  );
  if (!hint) return row;
  return (
    <div className={cx('col', rowClassName)} style={{ gap: 4 }}>
      {row}
      <span className="hint" id={hintId}>
        {hint}
      </span>
    </div>
  );
});
