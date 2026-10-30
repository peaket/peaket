'use client';
// CMP-010 Radio. 보드 마크업: <fieldset class="col" style="gap:10px"><legend class="label">…</legend>
//   <label class="check-row"><input class="rd" type="radio" name>카드</label>…</fieldset>
// - 네이티브 라디오라 방향키 이동·고르기를 브라우저가 한다(radiogroup 시맨틱은 fieldset+legend).
// - orientation: vertical(세로, 사이 10) · horizontal(가로, 사이 20, 보드의 등급 고르기)
// - 오류는 묶음 아래 .error-msg, 묶음에 aria-describedby로 잇는다.
import { useId, type ChangeEvent, type CSSProperties, type ReactNode } from 'react';
import { joinIds } from '../../lib/aria';
import { cx } from '../../lib/cx';
import { useControllable } from '../../lib/hooks';
import { FieldError, FieldLabelText } from '../Field/Field';

export interface RadioOption {
  value: string;
  label: ReactNode;
  /** 라벨 아래 보조 글 */
  description?: ReactNode;
  disabled?: boolean;
}

export interface RadioGroupProps {
  name: string;
  legend: ReactNode;
  options: readonly RadioOption[];
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  orientation?: 'vertical' | 'horizontal';
  hint?: ReactNode;
  error?: ReactNode;
  optional?: boolean;
  requiredMark?: boolean;
  required?: boolean;
  disabled?: boolean;
  /** legend를 화면에서만 숨긴다 */
  hideLegend?: boolean;
  className?: string;
  style?: CSSProperties;
}

export function RadioGroup({
  name,
  legend,
  options,
  value,
  defaultValue,
  onValueChange,
  orientation = 'vertical',
  hint,
  error,
  optional,
  requiredMark,
  required,
  disabled,
  hideLegend = false,
  className,
  style,
}: RadioGroupProps) {
  const base = useId();
  const hintId = `${base}-hint`;
  const errorId = `${base}-error`;
  const [current, setCurrent] = useControllable<string | undefined>(value, defaultValue, onValueChange as ((v: string | undefined) => void) | undefined);
  const onChange = (event: ChangeEvent<HTMLInputElement>) => setCurrent(event.target.value);
  return (
    <fieldset
      className={cx('col', className)}
      style={{ gap: 10, ...style }}
      aria-describedby={joinIds(error ? errorId : undefined, hint ? hintId : undefined)}
      disabled={disabled}
    >
      <legend className={cx('label', hideLegend && 'sr-only')} style={{ marginBottom: 8 }}>
        <FieldLabelText label={legend} optional={optional} requiredMark={requiredMark} />
      </legend>
      <div className={orientation === 'horizontal' ? 'row wrap' : 'col'} style={{ gap: orientation === 'horizontal' ? 20 : 10 }}>
        {options.map((o) => {
          const input = (
            <input
              className="rd"
              type="radio"
              name={name}
              value={o.value}
              checked={current === o.value}
              disabled={o.disabled}
              required={required}
              aria-invalid={error ? true : undefined}
              onChange={onChange}
            />
          );
          return o.description ? (
            <label key={o.value} className="check-row">
              {input}
              <span className="col" style={{ gap: 2 }}>
                <span>{o.label}</span>
                <span className="hint">{o.description}</span>
              </span>
            </label>
          ) : (
            <label key={o.value} className="check-row">
              {input}
              {o.label}
            </label>
          );
        })}
      </div>
      {hint ? (
        <span className="hint" id={hintId}>
          {hint}
        </span>
      ) : null}
      {error ? <FieldError id={errorId}>{error}</FieldError> : null}
    </fieldset>
  );
}
