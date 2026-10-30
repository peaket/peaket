'use client';
// CMP-010 rating. 관람 후기 별점 1~5를 라디오 묶음으로 받는다(보드 SCR-016 후기 쓰기).
// 보드 마크업: fieldset > legend.label '별점 (필수)' > .row 안 44×44 label.center(숨긴 radio + ic-star ic-32 + sr-only 'N점')
//   + 고른 값 글자 <p class="t-sm fw-b">5점 만점에 4점</p>. 고른 값까지의 별은 primary, 나머지는 text-muted.
// - 각 별의 이름은 '1점'~'5점'. 방향키로 옮기며 고른다(네이티브 라디오). 초점이 들어온 별에 초점 링(.is-focus).
// - 오류면 별을 모두 text-muted로 두고 아래에 .error-msg, 묶음에 aria-describedby.
import { useId, useState, type CSSProperties, type ReactNode } from 'react';
import { joinIds } from '../../lib/aria';
import { cx } from '../../lib/cx';
import { useControllable } from '../../lib/hooks';
import { FieldError, FieldLabelText } from '../Field/Field';

export interface RatingProps {
  name: string;
  legend?: ReactNode;
  value?: number;
  defaultValue?: number;
  onValueChange?: (value: number) => void;
  /** 별 개수. 기본 5 */
  max?: number;
  error?: ReactNode;
  hint?: ReactNode;
  requiredMark?: boolean;
  required?: boolean;
  className?: string;
  style?: CSSProperties;
}

export function Rating({
  name,
  legend = '별점',
  value,
  defaultValue = 0,
  onValueChange,
  max = 5,
  error,
  hint,
  requiredMark = true,
  required,
  className,
  style,
}: RatingProps) {
  const base = useId();
  const errorId = `${base}-error`;
  const hintId = `${base}-hint`;
  const [current, setCurrent] = useControllable(value, defaultValue, onValueChange);
  const [focused, setFocused] = useState<number | null>(null);
  const stars = Array.from({ length: max }, (_, i) => i + 1);
  return (
    <fieldset
      className={cx('col', className)}
      style={{ gap: 4, ...style }}
      aria-describedby={joinIds(error ? errorId : undefined, hint ? hintId : undefined)}
    >
      <legend className="label" style={{ marginBottom: 4 }}>
        <FieldLabelText label={legend} requiredMark={requiredMark} />
      </legend>
      <div className="row" style={{ gap: 0, marginLeft: -6, ...(error ? { color: 'var(--text-muted)' } : null) }}>
        {stars.map((n) => {
          const id = `${base}-${n}`;
          const on = !error && current >= n;
          return (
            <label
              key={n}
              className={cx('center', focused === n && 'is-focus')}
              htmlFor={id}
              style={{
                width: 44,
                height: 44,
                cursor: 'pointer',
                borderRadius: 'var(--r-md)',
                ...(error ? null : { color: on ? 'var(--primary)' : 'var(--text-muted)' }),
              }}
            >
              <input
                className="sr-only"
                type="radio"
                name={name}
                id={id}
                value={n}
                checked={current === n}
                required={required}
                aria-invalid={error ? true : undefined}
                onChange={() => setCurrent(n)}
                onFocus={() => setFocused(n)}
                onBlur={() => setFocused(null)}
              />
              <i className="ic ic-star ic-32" aria-hidden="true" />
              <span className="sr-only">{n}점</span>
            </label>
          );
        })}
      </div>
      {error ? (
        <FieldError id={errorId}>{error}</FieldError>
      ) : current > 0 ? (
        <p className="t-sm fw-b">
          {max}점 만점에 {current}점
        </p>
      ) : null}
      {hint ? (
        <span className="hint" id={hintId}>
          {hint}
        </span>
      ) : null}
    </fieldset>
  );
}
