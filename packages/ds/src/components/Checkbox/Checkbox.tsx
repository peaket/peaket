'use client';
// 체크박스(캔버스 키트 11절 .check-row + .cb). 보드 마크업:
//   <div class="col" style="gap:6px"><label class="check-row" for><input class="cb" type="checkbox" id>글자</label>
//   <span class="error-msg" style="padding-left:32px">…</span><p class="hint" style="padding-left:32px">…</p></div>
// - 힌트·오류가 없으면 바깥 div 없이 label만 낸다. 오른쪽 끝 링크('보기 ›')는 aside로 준다(.row.between).
// - 동의 항목은 ConsentCheckbox(필수·선택을 글자로 붙인다)를 쓴다.
import { forwardRef, type ChangeEvent, type InputHTMLAttributes, type ReactNode } from 'react';
import { joinIds } from '../../lib/aria';
import { cx } from '../../lib/cx';
import { FieldError } from '../Field/Field';

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'id'> {
  id: string;
  label: ReactNode;
  /** 라벨 아래 늘 보이는 도움말 */
  hint?: ReactNode;
  error?: ReactNode;
  /** 오른쪽 끝(약관 '보기 ›' 링크 등) */
  aside?: ReactNode;
  onCheckedChange?: (checked: boolean) => void;
  showFocus?: boolean;
  /** 바깥 요소 클래스 */
  rowClassName?: string;
}

const indent = { paddingLeft: 32 } as const;

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { id, label, hint, error, aside, onCheckedChange, onChange, showFocus = false, className, rowClassName, 'aria-describedby': describedBy, ...rest },
  ref,
) {
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    onChange?.(event);
    onCheckedChange?.(event.target.checked);
  };
  const labelEl = (
    <label className={cx('check-row', !aside && !hint && !error && rowClassName)} htmlFor={id}>
      <input
        ref={ref}
        className={cx('cb', showFocus && 'is-focus', className)}
        type="checkbox"
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={joinIds(error ? errorId : undefined, hint ? hintId : undefined, describedBy)}
        onChange={handleChange}
        {...rest}
      />
      {label}
    </label>
  );
  const row = aside ? (
    <div className={cx('row between', !hint && !error && rowClassName)} style={{ alignItems: 'flex-start', gap: 12 }}>
      {labelEl}
      {aside}
    </div>
  ) : (
    labelEl
  );
  if (!hint && !error) return row;
  return (
    <div className={cx('col', rowClassName)} style={{ gap: 6 }}>
      {row}
      {error ? (
        <FieldError id={errorId} style={indent}>
          {error}
        </FieldError>
      ) : null}
      {hint ? (
        <p className="hint" id={hintId} style={indent}>
          {hint}
        </p>
      ) : null}
    </div>
  );
});
