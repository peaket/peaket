'use client';
// CMP-005 TextArea. 보드 마크업: .field 안 .textarea와 글자 수(.counter, aria-live="polite").
// - 글자 수는 grapheme(사람이 보는 한 글자) 단위로 센다(d2 §3.1). maxLength를 주면 '남은 글자 N자', 아니면 showCount일 때 'N자'.
//   넘치면 'N자 넘었습니다'를 오류 색으로 보인다(입력을 자르지 않는다).
// - 힌트가 있으면 힌트와 글자 수를 한 줄 양 끝에 둔다(보드의 사유 입력 칸).
// - 키트에 .textarea 오류 모양이 없어 오류면 .input.is-error와 같은 테두리를 인라인으로 준다.
import { forwardRef, useState, type ChangeEvent, type TextareaHTMLAttributes } from 'react';
import { fieldIds, joinIds } from '../../lib/aria';
import { cx } from '../../lib/cx';
import { countGraphemes } from '../../lib/format';
import { FieldError, FieldLabelText, type FieldBaseProps } from '../Field/Field';

export interface TextAreaProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'id' | 'maxLength'>, FieldBaseProps {
  /** 최대 글자 수(grapheme) */
  maxLength?: number;
  /** maxLength 없이 지금 글자 수를 보인다 */
  showCount?: boolean;
  showFocus?: boolean;
  fieldClassName?: string;
}

export const TextArea = forwardRef<HTMLTextAreaElement, TextAreaProps>(function TextArea(
  {
    id,
    label,
    hint,
    error,
    optional,
    requiredMark,
    hideLabel,
    maxLength,
    showCount = false,
    showFocus = false,
    fieldClassName,
    className,
    style,
    value,
    defaultValue,
    onChange,
    'aria-describedby': describedBy,
    ...rest
  },
  ref,
) {
  const ids = fieldIds(id);
  const counterId = `${id}-count`;
  const [inner, setInner] = useState(String(defaultValue ?? ''));
  const text = value !== undefined ? String(value) : inner;
  const count = countGraphemes(text);
  const hasCounter = maxLength !== undefined || showCount;
  const over = maxLength !== undefined && count > maxLength;
  const counterText =
    maxLength === undefined ? `${count}자` : over ? `${count - maxLength}자 넘었습니다` : `남은 글자 ${maxLength - count}자`;

  const handleChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    if (value === undefined) setInner(event.target.value);
    onChange?.(event);
  };

  const counter = hasCounter ? (
    <span className={cx('counter', over && 'tx-danger')} id={counterId} aria-live="polite">
      {counterText}
    </span>
  ) : null;
  const hintEl = hint ? (
    <span className="hint" id={ids.hint}>
      {hint}
    </span>
  ) : null;
  const invalid = Boolean(error) || over;

  return (
    <div className={cx('field', fieldClassName)}>
      <label className={cx('label', hideLabel && 'sr-only')} htmlFor={id} id={ids.label}>
        <FieldLabelText label={label} optional={optional} requiredMark={requiredMark} />
      </label>
      <textarea
        ref={ref}
        id={id}
        className={cx('textarea', showFocus && 'is-focus', className)}
        style={invalid ? { borderColor: 'var(--danger)', boxShadow: '0 0 0 1px var(--danger)', ...style } : style}
        value={value}
        defaultValue={value === undefined ? defaultValue : undefined}
        onChange={handleChange}
        aria-invalid={invalid ? true : undefined}
        aria-describedby={joinIds(hint ? ids.hint : undefined, error ? ids.error : undefined, hasCounter ? counterId : undefined, describedBy)}
        {...rest}
      />
      {hintEl && counter ? (
        <div className="row between" style={{ gap: 8, alignItems: 'flex-start' }}>
          {hintEl}
          {counter}
        </div>
      ) : (
        hintEl ?? counter
      )}
      {error ? <FieldError id={ids.error}>{error}</FieldError> : null}
    </div>
  );
});
